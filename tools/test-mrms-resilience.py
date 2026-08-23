#!/usr/bin/env python3
"""One bad MRMS product must not take the pass down with it.

    python3 tools/test-mrms-resilience.py

Three bugs live here, all of the same shape: a failure that was thought of in
advance was handled, and everything else escaped.

  1. spec["floor"] on a product that has no floor raised KeyError, outside the
     only try in the loop, so it left build_mrms entirely. Forty-three of the
     hundred and twenty-nine products had no floor. The symptom was a short
     menu, not an error.
  2. The pass cursor was computed from the walk position, which had stopped
     matching the product name some time ago, because the walk order is
     rearranged twice before it is used.
  3. The never-built queue keyed off "last", which the failure path also
     stamps, so one failed attempt cost a product its priority.

Read off the source rather than run against NOAA: what is being checked is the
shape of the code, and a network test would pass on a good day and fail on a
bad one for reasons that have nothing to do with any of this.
"""

import ast
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_PATH = os.path.join(ROOT, "pi", "radar_pipeline.py")
src = io.open(SRC_PATH, encoding="utf-8").read()
tree = ast.parse(src)

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


def func(name):
    for n in ast.walk(tree):
        if isinstance(n, ast.FunctionDef) and n.name == name:
            return n
    return None


build = func("build_mrms")
assert build is not None, "build_mrms not found"


print("\n1. the missing floor cannot crash a pass")
# Every subscript of a spec, anywhere in build_mrms.
subs = set()
for n in ast.walk(build):
    if (isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name)
            and n.value.id == "spec" and isinstance(n.slice, ast.Constant)):
        subs.add(n.slice.value)
ok("floor is no longer read as a required key", "floor" not in subs,
   f"spec[...] reads {sorted(subs)}")
ok("it is read with a default instead",
   'spec.get("floor")' in ast.get_source_segment(src, build))

# And the catalogue really does contain products without one, so this is a
# live path rather than a defensive nicety.
cat = None
for n in tree.body:
    if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "MRMS_PRODUCTS":
        ns = {t.targets[0].id: t.value.value for t in tree.body
              if isinstance(t, ast.Assign)
              and getattr(t.targets[0], "id", "").endswith("_BASE")
              and isinstance(t.value, ast.Constant)}
        cat = eval(ast.get_source_segment(src, n.value), {"__builtins__": {}}, ns)
assert cat, "MRMS_PRODUCTS not found"
floorless = [k for k, v in cat.items() if "floor" not in v]
ok("and the catalogue really does have products without one",
   len(floorless) > 0, f"{len(floorless)} of {len(cat)}")


print("\n2. the guard covers building a product, not just downloading it")
# The per-product loop, and the try inside it.
loop = None
for n in ast.walk(build):
    if isinstance(n, ast.For) and isinstance(n.iter, ast.Call) \
            and getattr(n.iter.func, "id", "") == "enumerate":
        loop = n
tries = [n for n in loop.body if isinstance(n, ast.Try)]
ok("there is exactly one try wrapping the product", len(tries) == 1, str(len(tries)))

guarded = ast.dump(tries[0]) if tries else ""
# The three steps after the download that used to sit outside it.
ok("the decode is inside it", "nanmax" in guarded)
ok("the palette lookup is inside it", "lut_for" in guarded)
ok("and so is writing the PNG", "fromarray" in guarded and "save" in guarded)
ok("the failure is logged with its reason",
   any("mrms {name}: {failed}" in (ast.get_source_segment(src, n) or "")
       for n in ast.walk(loop)))
ok("and the loop continues to the next product",
   any(isinstance(n, ast.Continue) for n in ast.walk(loop)))


print("\n3. the cursor names the product the pass stopped on")
seg = ast.get_source_segment(src, build)
ok("it is taken from the catalogue's own order", "order.index(name)" in seg)
ok("not from the position in the rearranged walk",
   "(start + i) % len(names)" not in seg)


print("\n4. the walk order, run for real")
walk_src = ast.get_source_segment(src, func("_mrms_walk_order"))
ok("the ordering is its own function, so it can be read on its own",
   walk_src is not None)
ns = {}
exec(walk_src, ns)
walk = ns["_mrms_walk_order"]

order = ["a", "b", "c", "d", "e"]
built = {k: {"built": "2026-01-01T00:00:00+00:00"} for k in order}

ok("with nothing to do it starts at the top",
   walk(order, dict(built)) == order, str(walk(order, dict(built))))

st = dict(built, __cursor__={"at": 2})
ok("it resumes where the last pass stopped",
   walk(order, st) == ["c", "d", "e", "a", "b"], str(walk(order, st)))

st = dict(built, __cursor__={"at": 99})
ok("a cursor past the end wraps instead of losing the pass",
   walk(order, st) == walk(order, dict(built, __cursor__={"at": 99 % 5})),
   str(walk(order, st)))

# The bug: a product that has never been built jumps the queue.
st = dict(built, __cursor__={"at": 2})
del st["a"]
ok("a never-built product goes first, wherever the cursor is",
   walk(order, st)[0] == "a", str(walk(order, st)))
ok("and the rest keep their rotation behind it",
   walk(order, st) == ["a", "c", "d", "e", "b"], str(walk(order, st)))

# The regression that mattered: a failed attempt stamps "last" too, so
# keying off that would send this product back to the slow lane.
st = dict(built, __cursor__={"at": 2})
st["a"] = {"last": "2026-01-01T00:00:00+00:00", "fails": 3}
ok("a product that has only ever FAILED still counts as never built",
   walk(order, st)[0] == "a", str(walk(order, st)))

st = dict(built, __cursor__={"at": 0})
del st["b"], st["d"]
got = walk(order, st)
ok("several never-built products all come first",
   set(got[:2]) == {"b", "d"}, str(got))
ok("nothing is dropped and nothing is duplicated",
   sorted(got) == sorted(order) and len(got) == len(order), str(got))
ok("an empty catalogue is not a crash", walk([], {}) == [])


print("\n5. the success path records that a build happened")
ok('"built" is stamped only where a product really built',
   '"built": now.isoformat()' in seg)
fail_arm = seg[seg.index("if failed is not None:"):]
ok("and the failure path does not stamp it",
   '"built"' not in fail_arm.split("continue")[0])


print("\n6. MRMS cannot eat the radar's timer window")
secs = None
for n in tree.body:
    if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "MRMS_PASS_SECS":
        seg2 = ast.get_source_segment(src, n.value)
        import re
        m = re.search(r'"(\d+)"', seg2)
        secs = float(m.group(1)) if m else None
# The timer fires every five minutes and the radar frames are built on the
# same one. A pass allowed more than half of it starves the thing that matters.
ok("a pass is capped at half the five minute window", secs is not None and secs <= 150,
   str(secs))


print("\n7. the manifest tells the truth even when it is empty")
ok("it is written unconditionally",
   'if man["products"]:\n        write_json' not in src)
ok("because an empty one is honest and a stale one 404s",
   'write_json(os.path.join(out, "mrms.json"), man)' in seg)


print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
