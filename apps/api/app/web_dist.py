"""Serve the built web bundle (``apps/web/dist``) from the API process, for the local release package.

The dev setup stays as it is (``vite`` on 5173 proxying ``/api``). When a built bundle is present the API
also answers the non-API paths itself, so one loopback process is the whole app:

* ``/api/*`` is never shadowed: unknown API paths stay a JSON 404 from this handler, never ``index.html``.
* ``/vendor/concept-viewer/<name>.html`` follows ``apps/web/vite.config.ts``: same file-name rule, same
  ``X-Concept-Viewer: vendored`` header, 404 when missing (the Architecture tab then falls back to its SVG).
  The built copy in ``dist/vendor/concept-viewer`` wins, the repo ``vendor/concept-viewer`` is the fallback.
* Any other existing file under the bundle is served as is; other paths without a file extension get
  ``index.html`` (SPA fallback); a missing file with an extension is a 404.

The bundle is found from ``CONTOSO_WEB_DIST`` or ``<project root>/apps/web/dist`` (must hold index.html).
The server binds 127.0.0.1 only (see ``app.cli``).
"""
from __future__ import annotations

import os
import re
from importlib import metadata
from pathlib import Path

from fastapi import FastAPI
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.types import Receive, Scope, Send

DIST_NAME = "contoso-data-studio-api"
VIEWER_PREFIX = "/vendor/concept-viewer/"
_VIEWER_NAME = re.compile(r"^[A-Za-z0-9._-]+\.html$")


def package_version() -> str:
    """The single version source: ``apps/api/pyproject.toml`` (read from the installed metadata)."""
    try:
        return metadata.version(DIST_NAME)
    except metadata.PackageNotFoundError:
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        try:
            import tomllib

            return str(tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"])
        except (OSError, KeyError, ValueError):
            return "0.0.0+unknown"


def resolve_dist(project_root: Path) -> Path | None:
    configured = os.getenv("CONTOSO_WEB_DIST")
    candidate = Path(configured).expanduser().resolve() if configured else Path(project_root) / "apps" / "web" / "dist"
    return candidate if (candidate / "index.html").is_file() else None


class WebBundle:
    """ASGI app mounted last at ``/``: only reached when no API route matched."""

    def __init__(self, dist: Path, project_root: Path | None = None):
        self.dist = dist.resolve()
        self.viewer_dirs = [self.dist / "vendor" / "concept-viewer"]
        if project_root is not None:
            self.viewer_dirs.append(Path(project_root).resolve() / "vendor" / "concept-viewer")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        response = self.respond(scope["method"], scope["path"])
        await response(scope, receive, send)

    def respond(self, method: str, path: str) -> Response:
        if path == "/api" or path.startswith("/api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        if method not in {"GET", "HEAD"}:
            return JSONResponse({"detail": "Method Not Allowed"}, status_code=405, headers={"Allow": "GET, HEAD"})
        if path.startswith(VIEWER_PREFIX):
            return self._viewer(path[len(VIEWER_PREFIX):])
        relative = path.lstrip("/")
        if relative:
            file = self._inside(self.dist / relative)
            if file is not None and file.is_file():
                return FileResponse(file)
            if file is None or "." in relative.rsplit("/", 1)[-1]:
                return Response(status_code=404)
        return FileResponse(self.dist / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})

    def _inside(self, candidate: Path) -> Path | None:
        try:
            resolved = candidate.resolve()
        except (OSError, ValueError):
            return None
        return resolved if resolved == self.dist or self.dist in resolved.parents else None

    def _viewer(self, name: str) -> Response:
        if _VIEWER_NAME.match(name):
            for folder in self.viewer_dirs:
                file = folder / name
                if file.is_file():
                    return FileResponse(
                        file,
                        media_type="text/html; charset=utf-8",
                        headers={"X-Concept-Viewer": "vendored"},
                    )
        return Response(status_code=404)


def install(app: FastAPI, project_root: Path) -> Path | None:
    """Set the app version from the package and mount the bundle when one is found. Call after all routes."""
    app.version = package_version()
    dist = resolve_dist(project_root)
    if dist is not None:
        app.mount("/", WebBundle(dist, project_root), name="web")
    return dist
