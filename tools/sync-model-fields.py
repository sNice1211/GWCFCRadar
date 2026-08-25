#!/usr/bin/env python3
"""
Write the page's model field tables from the Pi's, so they cannot drift.

    python3 tools/sync-model-fields.py           # rewrite index.html in place
    python3 tools/sync-model-fields.py --check   # fail if it is out of date

There are three tables in index.html that have to agree with pi/gfs_pipeline.py
exactly: which fields exist, what colour ramp painted each one, and over what
range. If a range moves on the Pi and not on the page, every Inspector reading
of that field silently becomes a wrong number, and nothing anywhere errors.

Seventy five fields is far too many to keep in step by hand, so the page's
tables are generated from the Pi's. The labels, units and groups live here,
because they are the one part the Pi has no opinion about.
"""

import argparse
import importlib.util
import os
import re
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "index.html")

for _n in ("eccodes", "numpy", "PIL", "PIL.Image", "requests"):
    try:
        __import__(_n)
    except ImportError:
        _m = types.ModuleType(_n)
        _m.__getattr__ = lambda k: types.SimpleNamespace()
        sys.modules[_n] = _m

_spec = importlib.util.spec_from_file_location(
    "gp", os.path.join(ROOT, "pi", "gfs_pipeline.py"))
gp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gp)

DEG = "\\u00b0"

# key: (group, label, unit)
#
# The label is what someone reads off a button, so it says the level and the
# quantity in the words a forecast is written in, not the GRIB variable name.
# "Instability" told you nothing; "Lifted Index" is what it is called.
# The order here is the order the buttons appear in.
META = [
    # ── Temperature and moisture at the ground ──────────────────────────────
    ("t2m",     "Surface",     "Temperature (2m)",        DEG + "C"),
    ("apt",     "Surface",     "Feels Like (2m)",         DEG + "C"),
    ("tmax",    "Surface",     "High Temperature (2m)",   DEG + "C"),
    ("tmin",    "Surface",     "Low Temperature (2m)",    DEG + "C"),
    ("d2m",     "Surface",     "Dew Point (2m)",          DEG + "C"),
    ("rh2m",    "Surface",     "Relative Humidity (2m)",  "%"),
    ("mslp",    "Surface",     "Sea Level Pressure",      "hPa"),
    ("pres",    "Surface",     "Surface Pressure",        "hPa"),
    ("skt",     "Surface",     "Skin Temperature (ground/sea)", DEG + "C"),
    ("soilt",   "Surface",     "Soil Temperature (top 10cm)", DEG + "C"),
    ("soilm",   "Surface",     "Soil Moisture (top 10cm)", "% vol"),
    ("dswrf",   "Surface",     "Incoming Solar",          "W/m2"),
    ("olr",     "Surface",     "Outgoing Infrared (satellite look)", "W/m2"),

    # ── Wind ────────────────────────────────────────────────────────────────
    ("wind",    "Wind",        "Wind Speed (10m)",        "kt"),
    ("gust",    "Wind",        "Wind Gust",               "kt"),
    ("wdir",    "Wind",        "Wind Direction (10m)",    "deg"),
    ("wind80",  "Wind",        "Wind Speed (80m, hub height)", "kt"),
    ("wind925", "Wind",        "Wind 925mb",              "kt"),
    ("wind850", "Wind",        "Wind 850mb (low level jet)", "kt"),
    ("wind700", "Wind",        "Wind 700mb",              "kt"),
    ("wind500", "Wind",        "Wind 500mb",              "kt"),
    ("wind300", "Wind",        "Wind 300mb",              "kt"),
    ("wind250", "Wind",        "Wind 250mb (jet stream)", "kt"),

    # ── Precipitation ───────────────────────────────────────────────────────
    ("apcp",    "Precipitation", "Precipitation Total",   "mm"),
    ("prate",   "Precipitation", "Rain Rate",             "mm/h"),
    ("refc",    "Precipitation", "Composite Reflectivity", "dBZ"),
    ("refd1km", "Precipitation", "Reflectivity (1km up)", "dBZ"),
    ("refd4km", "Precipitation", "Reflectivity (4km up)", "dBZ"),
    ("cpofp",   "Precipitation", "Percent Falling Frozen", "%"),
    ("frozr",   "Precipitation", "Sleet and Graupel Total", "mm"),
    ("snowacc", "Precipitation", "Snowfall Total",        "cm"),
    ("snod",    "Precipitation", "Snow Depth on Ground",  "cm"),
    ("weasd",   "Precipitation", "Snow Water Equivalent", "mm"),
    ("frzlvl",  "Precipitation", "Freezing Level Height", "m"),

    # ── Cloud and visibility ────────────────────────────────────────────────
    ("tcc",     "Cloud & Visibility", "Total Cloud Cover", "%"),
    ("lcdc",    "Cloud & Visibility", "Low Cloud Cover",   "%"),
    ("mcdc",    "Cloud & Visibility", "Mid Cloud Cover",   "%"),
    ("hcdc",    "Cloud & Visibility", "High Cloud Cover",  "%"),
    ("ceil",    "Cloud & Visibility", "Cloud Ceiling Height", "m"),
    ("cldbase", "Cloud & Visibility", "Cloud Base Height",  "m"),
    ("cldtop",  "Cloud & Visibility", "Cloud Top Height",   "m"),
    ("satir",   "Cloud & Visibility", "Simulated Satellite Infrared", DEG + "C"),
    ("vis",     "Cloud & Visibility", "Surface Visibility", "km"),
    ("hpbl",    "Cloud & Visibility", "Mixing Height",     "m"),

    # ── Severe weather ──────────────────────────────────────────────────────
    ("cape",    "Severe",      "CAPE (storm fuel)",       "J/kg"),
    ("cin",     "Severe",      "Convective Inhibition (the cap)", "J/kg"),
    ("lftx",    "Severe",      "Lifted Index",            "K"),
    ("hlcy",    "Severe",      "Storm Relative Helicity (0-3km)", "m2/s2"),
    ("uphl",    "Severe",      "Updraft Helicity (2-5km)", "m2/s2"),
    ("shear06", "Severe",      "Bulk Shear (0-6km)",      "kt"),
    ("ltng",    "Severe",      "Lightning Flash Rate",    "/km2/5min"),
    ("hail",    "Severe",      "Hail Size",               "mm"),
    ("vil",     "Severe",      "Vertically Integrated Liquid", "kg/m2"),
    ("tcoli",   "Severe",      "Vertically Integrated Ice", "kg/m2"),
    ("echotop", "Severe",      "Echo Top Height",         "km"),

    # ── Upper air ───────────────────────────────────────────────────────────
    ("gh850",   "Upper Air",   "850mb Height",            "dam"),
    ("gh700",   "Upper Air",   "700mb Height",            "dam"),
    ("gh500",   "Upper Air",   "500mb Height (steering flow)", "dam"),
    ("gh300",   "Upper Air",   "300mb Height",            "dam"),
    ("t925",    "Upper Air",   "925mb Temperature",       DEG + "C"),
    ("t850",    "Upper Air",   "850mb Temperature (air mass)", DEG + "C"),
    ("t700",    "Upper Air",   "700mb Temperature",       DEG + "C"),
    ("t500",    "Upper Air",   "500mb Temperature",       DEG + "C"),
    ("d850",    "Upper Air",   "850mb Dew Point",         DEG + "C"),
    ("rh850",   "Upper Air",   "850mb Humidity",          "%"),
    ("rh700",   "Upper Air",   "700mb Humidity",          "%"),
    ("rh500",   "Upper Air",   "500mb Humidity",          "%"),
    ("vort500", "Upper Air",   "500mb Vorticity (spin)",  "1e-5/s"),
    ("w700",    "Upper Air",   "700mb Vertical Motion",   "ubar/s"),

    # ── Tropical ────────────────────────────────────────────────────────────
    ("pwat",    "Tropical",    "Precipitable Water",      "mm"),
    ("shear",   "Tropical",    "Deep Layer Shear (850-200mb)", "kt"),
    ("sst",     "Tropical",    "Sea Surface Temperature", DEG + "C"),
    ("surge",   "Tropical",    "Storm Surge",             "m"),

    # ── Marine ──────────────────────────────────────────────────────────────
    ("swh",     "Marine",      "Significant Wave Height", "m"),
    ("perpw",   "Marine",      "Peak Wave Period",        "s"),
    ("wvhgt",   "Marine",      "Wind Wave Height",        "m"),
    ("wvper",   "Marine",      "Wind Wave Period",        "s"),
    ("swell",   "Marine",      "Swell Height",            "m"),
    ("swper",   "Marine",      "Swell Period",            "s"),
    ("swell2",  "Marine",      "Secondary Swell Height",  "m"),
    ("swper2",  "Marine",      "Secondary Swell Period",  "s"),
    ("dirpw",   "Marine",      "Wave Direction",          "deg"),
    ("swell3",  "Marine",      "Third Swell Height",      "m"),
    ("swper3",  "Marine",      "Third Swell Period",      "s"),
    ("swdir",   "Marine",      "Swell Direction",         "deg"),
    ("swdir2",  "Marine",      "Secondary Swell Direction", "deg"),
    ("wvdir",   "Marine",      "Wind Wave Direction",     "deg"),
    ("icec",    "Marine",      "Sea Ice Cover",           "%"),

    # ── Air quality ─────────────────────────────────────────────────────────
    ("ozone",   "Air Quality", "Surface Ozone",           "ppb"),
    ("pm25",    "Air Quality", "Fine Particulate (PM2.5)", "ug/m3"),
    ("smoke",   "Air Quality", "Surface Smoke",           "ug/m3"),
    ("colmd",   "Air Quality", "Column Smoke and Dust",   "mg/m2"),
    ("pm10",    "Air Quality", "Coarse Particulate (PM10)", "ug/m3"),
    ("aod",     "Air Quality", "Aerosol Optical Depth",   ""),
    ("sctaod",  "Air Quality", "Scattering Aerosol Depth", ""),
    ("ssalb",   "Air Quality", "Single Scattering Albedo", ""),
    ("asyf",    "Air Quality", "Aerosol Asymmetry Factor", ""),
]


def js_ramp_table():
    lines = []
    for name, stops in gp.RAMPS.items():
        body = ",".join(
            "[%s,[%d,%d,%d]]" % (repr(round(p, 4)).rstrip("0").rstrip(".")
                                 if p not in (0, 1) else str(int(p)), *rgb)
            for p, rgb in stops)
        lines.append(f"  {name}: [{body}],")
    return "\n".join(lines)


def js_fields():
    lines = []
    for key, group, label, unit in META:
        lines.append(
            f"  {{ id: '{key}', label: '{label}', unit: '{unit}',"
            f" group: '{group}' }},")
    return "\n".join(lines)


def js_scales():
    lines = []
    for key, _g, _l, _u in META:
        spec = gp.FIELDS[key]
        lo, hi = spec["range"]
        lines.append(f"  {key}: {{ ramp: '{spec['ramp']}',"
                     f" lo: {lo}, hi: {hi} }},")
    return "\n".join(lines)


BANNER = ("// GENERATED by tools/sync-model-fields.py from pi/gfs_pipeline.py.\n"
          "// Labels, units and groups live in that script; ramps and ranges\n"
          "// come from the Pi itself, so a scale cannot move on one side\n"
          "// only. Edit the script and re-run it, not this block.")


def build():
    return (
        f"const HD_FIELDS = [\n{js_fields()}\n];",
        f"const HD_INSP_RAMPS = {{\n{js_ramp_table()}\n}};",
        f"const HD_INSP_SCALES = {{\n{js_scales()}\n}};",
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    missing = [k for k, *_ in META if k not in gp.FIELDS]
    extra = [k for k in gp.FIELDS if k not in {m[0] for m in META}]
    if missing:
        print("labelled but not in the Pi's field table: " + ", ".join(missing))
        return 1
    if extra:
        print("in the Pi's field table but unlabelled: " + ", ".join(extra))
        return 1

    html = open(HTML, encoding="utf-8").read()
    fields, ramps, scales = build()
    out = html
    for name, block in (("HD_FIELDS", fields), ("HD_INSP_RAMPS", ramps),
                        ("HD_INSP_SCALES", scales)):
        # Found by index rather than by regular expression. A pattern that
        # spans an optional comment block and then a lazy body backtracks
        # catastrophically across a fifty thousand line file: this hung
        # outright rather than being slow, which took a while to recognise as
        # the regex and not the network.
        head = f"const {name} = "
        start = out.find(head)
        if start < 0:
            print(f"could not find {name} in index.html")
            return 1
        opener = out[start + len(head)]
        closer = {"[": "\n];", "{": "\n};"}[opener]
        end = out.find(closer, start)
        if end < 0:
            print(f"could not find the end of {name} in index.html")
            return 1
        end += len(closer)
        # Swallow a banner already sitting above it, so re-running does not
        # stack a second copy of the comment on every pass.
        while True:
            prev = out.rfind("\n", 0, start - 1)
            line = out[prev + 1:start].strip()
            if line.startswith("//") and ("GENERATED by tools/sync-model-fields"
                                          in line or start != end):
                if not line.startswith("//"):
                    break
                start = prev + 1
                if "GENERATED by tools/sync-model-fields" in line:
                    break
            else:
                break
        out = out[:start] + BANNER + "\n" + block + out[end:]

    if args.check:
        if out != html:
            print("index.html is out of date, run without --check")
            return 1
        print(f"index.html is in step: {len(META)} fields, "
              f"{len(gp.RAMPS)} ramps")
        return 0

    open(HTML, "w", encoding="utf-8").write(out)
    print(f"wrote {len(META)} fields, {len(gp.RAMPS)} ramps into index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
