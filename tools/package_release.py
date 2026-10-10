"""Build the local install package (FR-02) from a clean committed tree.

    python tools/package_release.py [--skip-npm-install]

Writes, under dist/ (gitignored):
* contoso-data-studio-<version>-<shortsha>.zip: ``git archive HEAD`` + the built ``apps/web/dist`` +
  install.txt, all under one top folder of the same name;
* SHA256SUMS (``sha256sum -c`` format) and install.txt (Windows and Linux commands).

The version comes from apps/api/pyproject.toml (the single version source). A dirty tree (tracked changes
or untracked files that are not ignored) is refused, so the zip always matches one commit.
Prints a JSON summary (name, bytes, sha256, version, commit).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tomllib
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WEB = REPO / "apps" / "web"
OUT = REPO / "dist"

INSTALL_TXT = """\
Contoso Data Studio {version} ({commit})
Local install: everything runs on 127.0.0.1, data stays in <root>/workspace.
Needs Python 3.12 (3.11+). Node is not needed: the web bundle is prebuilt in apps/web/dist.

Windows (PowerShell)
  Expand-Archive {name}.zip -DestinationPath .
  cd {name}
  py -3.12 -m venv .venv
  .venv\\Scripts\\pip install -e "apps/api[dbt]"
  .venv\\Scripts\\contoso-studio --port 8000 --open

Linux / macOS
  unzip {name}.zip
  cd {name}
  python3.12 -m venv .venv
  .venv/bin/pip install -e "apps/api[dbt]"
  .venv/bin/contoso-studio --port 8000

Then open http://127.0.0.1:8000/ and open the "retail-baseline" project.
The install must stay editable (-e): dbt models, charts and the web bundle are read from this folder.
Options: contoso-studio --help (CONTOSO_WORKSPACE, CONTOSO_HOME, CONTOSO_PROJECT_ROOT, CONTOSO_WEB_DIST).
Check the download: compare SHA256SUMS with  sha256sum {name}.zip  /  Get-FileHash {name}.zip
"""


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO, check=True, capture_output=True, text=True).stdout.strip()


def npm(*args: str) -> None:
    subprocess.run(["npm", *args], cwd=WEB, check=True, shell=os.name == "nt")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-npm-install", action="store_true", help="reuse apps/web/node_modules as is")
    args = parser.parse_args()

    dirty = git("status", "--porcelain")
    if dirty:
        print("Refusing to package a dirty tree (commit or remove these first):\n" + dirty, file=sys.stderr)
        return 2
    commit = git("rev-parse", "HEAD")
    short = commit[:7]
    stamp = datetime.fromtimestamp(int(git("show", "-s", "--format=%ct", "HEAD")), tz=timezone.utc)
    version = tomllib.loads((REPO / "apps" / "api" / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    name = f"contoso-data-studio-{version}-{short}"

    if not args.skip_npm_install or not (WEB / "node_modules").is_dir():
        npm("install", "--no-audit", "--no-fund")
    built = WEB / "dist"
    if built.exists():
        shutil.rmtree(built)
    npm("run", "build")
    if not (built / "index.html").is_file():
        print("npm run build did not produce apps/web/dist/index.html", file=sys.stderr)
        return 1

    OUT.mkdir(exist_ok=True)
    install_txt = INSTALL_TXT.format(version=version, commit=short, name=name)
    (OUT / "install.txt").write_text(install_txt, encoding="utf-8", newline="\n")

    source = subprocess.run(
        ["git", "archive", "--format=zip", f"--prefix={name}/", "HEAD"], cwd=REPO, check=True, capture_output=True
    ).stdout
    zip_path = OUT / f"{name}.zip"
    date_time = stamp.timetuple()[:6]

    def add(target: zipfile.ZipFile, arcname: str, data: bytes) -> None:
        info = zipfile.ZipInfo(arcname, date_time=date_time)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        target.writestr(info, data)

    with zipfile.ZipFile(io.BytesIO(source)) as archived, zipfile.ZipFile(zip_path, "w") as package:
        for item in archived.infolist():
            package.writestr(item, archived.read(item))
        for file in sorted(path for path in built.rglob("*") if path.is_file()):
            add(package, f"{name}/apps/web/dist/{file.relative_to(built).as_posix()}", file.read_bytes())
        add(package, f"{name}/install.txt", install_txt.encode("utf-8"))

    digest = sha256(zip_path)
    (OUT / "SHA256SUMS").write_text(f"{digest}  {zip_path.name}\n", encoding="utf-8", newline="\n")
    summary = {
        "zip": zip_path.name,
        "bytes": zip_path.stat().st_size,
        "sha256": digest,
        "version": version,
        "commit": commit,
        "web_files": sum(1 for path in built.rglob("*") if path.is_file()),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
