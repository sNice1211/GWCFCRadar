#!/usr/bin/env python3
"""
Serves the rendered model files with the one header that makes them usable.

`python3 -m http.server` is almost enough, but not quite. The page lives on
github.io and the Pi answers on a tunnel, so every read is cross-origin, and a
browser refuses a cross-origin fetch unless the server says it is allowed.
Images are exempt from that rule, so the PNGs would load while latest.json and
manifest.json silently failed: the map would look broken with nothing in the
log to explain it.

    python3 pi/serve.py            # port 8080, serving ~/wxdata
    python3 pi/serve.py 9000 /srv  # or say where

Read-only by design. It answers GET and HEAD and nothing else, so pointing a
tunnel at it exposes the forecast files and no way to write to the Pi.
"""

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class CORSHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # The whole point of this file.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        # A finished run never changes, so let it cache. latest.json is the one
        # thing that does change, and it is the one thing that must not be
        # cached, or a new run would go unnoticed until the browser felt like
        # asking again.
        path = self.path.split("?")[0]
        if path.endswith("latest.json"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        elif path.endswith((".png", "manifest.json")):
            self.send_header("Cache-Control", "public, max-age=21600")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    # Anything that could change the Pi is refused rather than left to the
    # default handler, since this is reachable from the public internet.
    def do_POST(self): self.send_error(405)
    def do_PUT(self): self.send_error(405)
    def do_DELETE(self): self.send_error(405)

    def log_message(self, fmt, *args):
        # One line per request is noise when a page pulls 40 frames.
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    root = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/wxdata")
    if not os.path.isdir(root):
        print(f"no such directory: {root}")
        return 1
    handler = partial(CORSHandler, directory=root)
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"serving {root} on 127.0.0.1:{port} with CORS enabled")
    print("point the tunnel at this, not at python -m http.server")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
