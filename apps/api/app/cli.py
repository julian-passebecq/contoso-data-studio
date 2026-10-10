"""``contoso-studio``: run the whole local studio (API + built web bundle) on 127.0.0.1."""
from __future__ import annotations

import argparse
import os
import sys
import webbrowser
from pathlib import Path

DESCRIPTION = """\
Run Contoso Data Studio locally: the API and the built web bundle in one process on 127.0.0.1.

Install (from the unpacked release package, whose root holds apps/, dbt/, charts/, vendor/):
  python -m venv .venv
  .venv/Scripts/pip install -e "<root>/apps/api[dbt]"     (Windows)
  .venv/bin/pip install -e "<root>/apps/api[dbt]"         (Linux / macOS)

The editable install (-e) is required: dbt models, charts and the web bundle are read from the package
root, which is found next to the installed code. CONTOSO_PROJECT_ROOT overrides it. Data goes to
<root>/workspace unless CONTOSO_WORKSPACE / CONTOSO_HOME point elsewhere; CONTOSO_WEB_DIST overrides the
bundle folder (default <root>/apps/web/dist). The server never listens on a non-loopback address.
"""


def find_project_root() -> Path | None:
    """The package root: CONTOSO_PROJECT_ROOT, else the folder holding apps/api/app (editable install)."""
    configured = os.getenv("CONTOSO_PROJECT_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    candidates = [Path(__file__).resolve().parents[3], Path.cwd().resolve()]
    for candidate in candidates:
        if (candidate / "dbt" / "dbt_project.yml").is_file():
            return candidate
    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="contoso-studio",
        description=DESCRIPTION,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--port", type=int, default=8000, help="loopback port (default 8000)")
    parser.add_argument("--project-root", help="package root (default: CONTOSO_PROJECT_ROOT or the install location)")
    parser.add_argument("--web-dist", help="built web bundle folder (default: CONTOSO_WEB_DIST or <root>/apps/web/dist)")
    parser.add_argument("--open", action="store_true", help="open the studio in the default browser once started")
    parser.add_argument("--log-level", default="info", choices=["critical", "error", "warning", "info", "debug"])
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.version:
        from app.web_dist import package_version

        print(package_version())
        return 0
    if args.project_root:
        os.environ["CONTOSO_PROJECT_ROOT"] = str(Path(args.project_root).expanduser().resolve())
    root = find_project_root()
    if root is None or not (root / "dbt" / "dbt_project.yml").is_file():
        print(
            "contoso-studio: cannot find the package root (dbt/dbt_project.yml). Install with "
            'pip install -e "<root>/apps/api[dbt]" or pass --project-root.',
            file=sys.stderr,
        )
        return 2
    os.environ["CONTOSO_PROJECT_ROOT"] = str(root)
    if args.web_dist:
        os.environ["CONTOSO_WEB_DIST"] = str(Path(args.web_dist).expanduser().resolve())
    # dbt / dct are looked up on PATH: make the ones installed next to this interpreter win.
    scripts = str(Path(sys.executable).parent)
    os.environ["PATH"] = scripts + os.pathsep + os.environ.get("PATH", "")

    import uvicorn

    url = f"http://127.0.0.1:{args.port}/"
    print(f"Contoso Data Studio on {url} (project root {root})", flush=True)
    if args.open:
        import threading

        threading.Timer(2.0, lambda: webbrowser.open(url)).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
