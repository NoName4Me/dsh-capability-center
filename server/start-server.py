#!/usr/bin/env python3
"""Read-only intranet distribution server for DSH Capability Center."""

from __future__ import annotations

import argparse
import mimetypes
import os
import posixpath
import socket
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
PACKAGES = ROOT / "packages"
CORE = ROOT / "core"
REQUIRED_FILES = (
    ROOT / "catalog.json",
    ROOT / "core-release-index.json",
    ROOT / "artifact-manifest.json",
    ROOT / "publication-registry.json",
    ROOT / "index.html",
    ROOT / "README.md",
)


class CapabilityCenterServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "CapabilityCenterDistribution/0.2"

    def log_message(self, fmt: str, *args: object) -> None:
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def _headers(
        self,
        status: int,
        length: int,
        content_type: str,
        *,
        cache: str,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        )
        self.end_headers()

    def _send(
        self,
        status: int,
        body: bytes = b"",
        content_type: str = "text/plain; charset=utf-8",
        *,
        cache: str = "no-store",
    ) -> None:
        self._headers(status, len(body), content_type, cache=cache)
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, (message + "\n").encode("utf-8"))

    def _method_not_allowed(self) -> None:
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", "GET, HEAD")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        try:
            path = unquote(urlsplit(self.path).path, errors="strict")
        except UnicodeError:
            self._error(HTTPStatus.BAD_REQUEST, "Invalid URL encoding")
            return
        if (
            not path.startswith("/")
            or "\\" in path
            or "\x00" in path
            or "\r" in path
            or "\n" in path
            or posixpath.normpath(path) != path
            or "//" in path
        ):
            self._error(HTTPStatus.BAD_REQUEST, "Invalid path")
            return

        named = {
            "/": (ROOT / "index.html", "text/html; charset=utf-8"),
            "/index.html": (ROOT / "index.html", "text/html; charset=utf-8"),
            "/catalog.json": (ROOT / "catalog.json", "application/json; charset=utf-8"),
            "/core-release-index.json": (
                ROOT / "core-release-index.json",
                "application/json; charset=utf-8",
            ),
            "/artifact-manifest.json": (
                ROOT / "artifact-manifest.json",
                "application/json; charset=utf-8",
            ),
            "/publication-registry.json": (
                ROOT / "publication-registry.json",
                "application/json; charset=utf-8",
            ),
            "/README.md": (ROOT / "README.md", "text/markdown; charset=utf-8"),
        }
        if path in named:
            target, content_type = named[path]
            self._send_file(target, content_type, immutable=False)
            return

        for prefix, directory in (("/packages/", PACKAGES), ("/core/", CORE)):
            if not path.startswith(prefix):
                continue
            name = path[len(prefix):]
            if (
                not name
                or "/" in name
                or name.startswith(".")
                or name != Path(name).name
            ):
                self._error(HTTPStatus.NOT_FOUND, "Not found")
                return
            self._send_file(
                directory / name,
                self._content_type(name),
                immutable=True,
            )
            return

        self._error(HTTPStatus.NOT_FOUND, "Not found")

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        self._method_not_allowed()

    def do_PUT(self) -> None:  # noqa: N802
        self._method_not_allowed()

    def do_DELETE(self) -> None:  # noqa: N802
        self._method_not_allowed()

    def do_PATCH(self) -> None:  # noqa: N802
        self._method_not_allowed()

    @staticmethod
    def _content_type(name: str) -> str:
        if name.endswith(".json"):
            return "application/json; charset=utf-8"
        if name.endswith(".tgz"):
            return "application/gzip"
        if name.endswith(".whl") or name.endswith(".zip"):
            return "application/zip"
        return mimetypes.guess_type(name)[0] or "application/octet-stream"

    def _send_file(
        self,
        path: Path,
        content_type: str,
        *,
        immutable: bool,
    ) -> None:
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(ROOT)
            if not resolved.is_file() or resolved.is_symlink():
                raise FileNotFoundError
            size = resolved.stat().st_size
            cache = (
                "public, max-age=31536000, immutable"
                if immutable
                else "no-store"
            )
            self._headers(HTTPStatus.OK, size, content_type, cache=cache)
            if self.command == "HEAD":
                return
            with resolved.open("rb") as handle:
                while True:
                    chunk = handle.read(128 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (FileNotFoundError, IsADirectoryError, PermissionError):
            self._error(HTTPStatus.NOT_FOUND, "Not found")
        except ValueError:
            self._error(HTTPStatus.FORBIDDEN, "Forbidden path")


def find_bootstrap() -> Path | None:
    candidates = sorted(PACKAGES.glob("capability-center-*.tgz"))
    return candidates[-1] if candidates else None


def advertised_host(bind_host: str) -> str:
    if bind_host not in ("0.0.0.0", "::"):
        return bind_host
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return "分发服务器IP"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host",
        default=os.environ.get("CAPABILITY_CENTER_HOST", "0.0.0.0"),
        help="bind address (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("CAPABILITY_CENTER_PORT", "8765")),
        help="TCP port (default: 8765)",
    )
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        print("ERROR: --port must be between 0 and 65535.")
        return 2
    missing = [str(path.relative_to(ROOT)) for path in REQUIRED_FILES if not path.is_file()]
    if missing or not PACKAGES.is_dir() or not CORE.is_dir():
        print("ERROR: incomplete distribution: %s" % ", ".join(missing or ["packages/ or core/"]))
        return 2

    server = CapabilityCenterServer((args.host, args.port), Handler)
    display_host = advertised_host(args.host)
    base = "http://%s:%d/" % (display_host, server.server_port)
    print("Serving %s" % ROOT, flush=True)
    print("Distribution URL: %s" % base, flush=True)
    bootstrap = find_bootstrap()
    if bootstrap is not None:
        print("Initial plugin URL: %spackages/%s" % (base, bootstrap.name), flush=True)
    print("Read-only server. Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
