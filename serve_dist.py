#!/usr/bin/env python3
"""Simple static file server for the built dist folder."""

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PORT = 4173
DIST_DIR = Path(__file__).resolve().parent / "dist"


def main() -> None:
    if not DIST_DIR.exists():
        raise SystemExit(f"dist directory not found: {DIST_DIR}")

    handler = lambda *args, **kwargs: SimpleHTTPRequestHandler(  # noqa: E731
        *args, directory=str(DIST_DIR), **kwargs
    )
    server = ThreadingHTTPServer(("", PORT), handler)
    print(f"Serving {DIST_DIR} at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")


if __name__ == "__main__":
    main()
