"""Install the release zip the way install.txt says and prove it runs (FR-02).

    python tools/qa_install_package.py [--zip dist/<name>.zip] [--port 21100] [--receipt dist/qa-install-receipt.json]

1. Checks the zip against dist/SHA256SUMS, unpacks it into a fresh temp folder.
2. Creates a fresh venv there and runs ``pip install -e "<root>/apps/api[dbt]"``.
3. Starts ``contoso-studio --port <port>`` (cwd outside the package, CONTOSO_WORKSPACE / CONTOSO_HOME in
   temp folders, CONTOSO_DUCKLAKE_* / CONTOSO_PROJECT_ROOT / CONTOSO_WEB_DIST unset).
4. Checks /api/health, / (index.html), an SPA route, a bundle asset, the concept viewer and an unknown
   /api path (404, not index.html); opens project retail-baseline (generate + Bronze + dbt build) and
   queries contoso.gold.monthly_sales.
5. Stops the server, deletes the temp folder (unless --keep) and prints a JSON receipt (also written to
   --receipt). Exit code 0 only when every check passed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DIST = REPO / "dist"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request(method: str, url: str, body: dict | None = None, timeout: float = 30) -> tuple[int, dict, bytes]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def stop(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zip", help="package zip (default: the one named in dist/SHA256SUMS)")
    parser.add_argument("--port", type=int, default=21100)
    parser.add_argument("--receipt", default=str(DIST / "qa-install-receipt.json"))
    parser.add_argument("--keep", action="store_true", help="keep the temp folder for inspection")
    args = parser.parse_args()

    sums = {}
    if (DIST / "SHA256SUMS").is_file():
        for line in (DIST / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
            if line.strip():
                digest, name = line.split(maxsplit=1)
                sums[name.strip().lstrip("*")] = digest
    zip_path = Path(args.zip).resolve() if args.zip else (DIST / next(iter(sums), "missing.zip"))
    timings: dict[str, float] = {}
    checks: dict[str, object] = {}
    receipt: dict[str, object] = {
        "package": zip_path.name,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "os": platform.platform(),
        "python": platform.python_version(),
        "port": args.port,
        "timings_s": timings,
        "checks": checks,
    }
    temp = Path(tempfile.mkdtemp(prefix="contoso-qa-install-"))
    process: subprocess.Popen | None = None
    log_path = temp / "server.log"
    result = "fail"

    def step(name: str, started: float) -> None:
        timings[name] = round(time.monotonic() - started, 1)

    try:
        if not zip_path.is_file():
            raise RuntimeError(f"Package not found: {zip_path} (run tools/package_release.py first)")
        receipt["bytes"] = zip_path.stat().st_size
        receipt["sha256"] = sha256(zip_path)
        expected = sums.get(zip_path.name)
        checks["sha256_matches_SHA256SUMS"] = expected == receipt["sha256"] if expected else None
        if expected and expected != receipt["sha256"]:
            raise RuntimeError("Zip does not match dist/SHA256SUMS")

        started = time.monotonic()
        with zipfile.ZipFile(zip_path) as package:
            package.extractall(temp / "unpacked")
        roots = [path for path in (temp / "unpacked").iterdir() if path.is_dir()]
        if len(roots) != 1:
            raise RuntimeError(f"Expected one top folder in the zip, found {[p.name for p in roots]}")
        root = roots[0]
        checks["web_bundle_in_zip"] = (root / "apps" / "web" / "dist" / "index.html").is_file()
        checks["install_txt_in_zip"] = (root / "install.txt").is_file()
        step("unpack", started)

        started = time.monotonic()
        venv = temp / "venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True, capture_output=True)
        bindir = venv / ("Scripts" if os.name == "nt" else "bin")
        python = bindir / ("python.exe" if os.name == "nt" else "python")
        install = subprocess.run(
            [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-q", "-e", f"{root / 'apps' / 'api'}[dbt]"],
            capture_output=True, text=True, timeout=1800,
        )
        if install.returncode != 0:
            raise RuntimeError("pip install failed:\n" + (install.stdout + install.stderr)[-3000:])
        step("venv_and_pip_install", started)
        studio = bindir / ("contoso-studio.exe" if os.name == "nt" else "contoso-studio")
        checks["console_script_installed"] = studio.is_file()
        version = subprocess.run([str(studio), "--version"], capture_output=True, text=True, timeout=120)
        receipt["version"] = version.stdout.strip()

        env = {key: value for key, value in os.environ.items()
               if not key.startswith("CONTOSO_") and key not in {"VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME"}}
        env.update({
            "CONTOSO_WORKSPACE": str(temp / "data" / "workspace"),
            "CONTOSO_HOME": str(temp / "data" / "workspaces"),
            "RAYFIN_TELEMETRY_OPTOUT": "1",
            "PYTHONUNBUFFERED": "1",
        })
        run_dir = temp / "cwd"
        run_dir.mkdir()
        started = time.monotonic()
        log_handle = log_path.open("ab")
        kwargs: dict = {"cwd": run_dir, "env": env, "stdout": log_handle, "stderr": subprocess.STDOUT}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        process = subprocess.Popen([str(studio), "--port", str(args.port)], **kwargs)
        base = f"http://127.0.0.1:{args.port}"
        health = None
        deadline = time.time() + 120
        while time.time() < deadline and process.poll() is None:
            try:
                status, _, body = request("GET", f"{base}/api/health", timeout=5)
                if status == 200:
                    health = json.loads(body)
                    break
            except OSError:
                pass
            time.sleep(1)
        if health is None:
            raise RuntimeError("Server did not answer /api/health")
        step("server_start", started)
        checks["health_ok"] = health.get("status") == "ok"
        checks["workspace_in_temp"] = Path(health["workspace"]).resolve() == (temp / "data" / "workspace").resolve()

        status, headers, body = request("GET", f"{base}/")
        index = body.decode("utf-8", "replace")
        checks["root_serves_index_html"] = status == 200 and 'id="root"' in index and "text/html" in headers.get("content-type", "")
        status, _, body = request("GET", f"{base}/explore/some/route")
        checks["spa_fallback"] = status == 200 and b'id="root"' in body
        asset = re.search(r'(?:src|href)="(/assets/[^"]+\.js)"', index)
        checks["bundle_asset"] = bool(asset) and request("GET", base + asset.group(1))[0] == 200
        status, headers, _ = request("GET", f"{base}/vendor/concept-viewer/concept-viewer.html")
        checks["concept_viewer"] = status == 200 and headers.get("x-concept-viewer") == "vendored"
        status, _, body = request("GET", f"{base}/api/does-not-exist")
        checks["unknown_api_is_404_json"] = status == 404 and b'id="root"' not in body

        started = time.monotonic()
        status, _, body = request("POST", f"{base}/api/projects/retail-baseline/open", timeout=1800)
        step("open_retail_baseline", started)
        opened = json.loads(body) if body else {}
        checks["project_open"] = status == 200 and bool(opened.get("state", {}).get("ready"))
        if status != 200:
            raise RuntimeError(f"Project open failed ({status}): {body[-2000:].decode('utf-8', 'replace')}")

        started = time.monotonic()
        status, _, body = request("POST", f"{base}/api/query", {"sql": "select count(*) from contoso.gold.monthly_sales", "limit": 10})
        step("gold_query", started)
        rows = json.loads(body).get("rows") if status == 200 else None
        receipt["gold_monthly_sales_rows"] = rows[0][0] if rows else None
        checks["gold_monthly_sales_count_gt_0"] = bool(rows) and rows[0][0] > 0

        result = "pass" if all(value is not False for value in checks.values()) else "fail"
    except Exception as exc:  # the receipt always says why
        receipt["error"] = str(exc)
    finally:
        if process is not None:
            stop(process)
            checks["server_stopped"] = process.poll() is not None
            log_handle.close()
        if result != "pass" and log_path.is_file():
            receipt["server_log_tail"] = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
        if args.keep:
            receipt["temp_dir"] = str(temp)
        else:
            shutil.rmtree(temp, ignore_errors=True)
    receipt["result"] = result
    receipt["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    text = json.dumps(receipt, indent=2)
    Path(args.receipt).parent.mkdir(parents=True, exist_ok=True)
    Path(args.receipt).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if result == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
