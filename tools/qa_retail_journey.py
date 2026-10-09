"""Run the real local retail journey (07-contoso UX01-UX04, F11, F12) and write evidence.

    python tools/qa_retail_journey.py [--out qa-evidence/retail-journey] [--api-port 8010] [--web-port 5180]

What it does, against an exact committed revision:
1. ``git archive HEAD`` into a disposable fixture (the user's own workspace is never touched).
2. Builds the production web bundle and serves it with ``vite preview`` (proxying /api) on loopback.
3. Starts the API from the fixture on loopback with fixture-local workspace/home folders.
4. Drives ``apps/web/qa/retail-journey.mjs`` phases: build -> (API restart) reopen -> fault-broken
   -> (repair) fault-repaired -> api-down -> ux, then validates the latest export and the concept
   document with MosaicStudio's own validators when a Mosaic checkout is given.

Requires: the API environment on PATH (python with apps/api[dev,dbt] installed, dbt), Node 22 LTS and
``npm --prefix apps/web install`` plus ``playwright`` with Chromium. Only processes it starts are stopped.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WEB = REPO / "apps" / "web"
BROKEN_MARKER = "-- qa_retail_journey: deliberately broken"


def run(cmd: list[str], cwd: Path, env: dict | None = None, check: bool = True, timeout: int = 900) -> subprocess.CompletedProcess:
    shell = os.name == "nt" and cmd[0] in {"npm", "npx"}
    return subprocess.run(cmd, cwd=cwd, env=env, check=check, timeout=timeout, capture_output=True, text=True, shell=shell)


def wait_http(url: str, seconds: int = 120) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status < 500:
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f"Timed out waiting for {url}")


def stop(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()


def spawn(cmd: list[str], cwd: Path, env: dict, log: Path) -> subprocess.Popen:
    handle = log.open("ab")
    kwargs: dict = {"cwd": cwd, "env": env, "stdout": handle, "stderr": subprocess.STDOUT}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        kwargs["shell"] = cmd[0] in {"npm", "npx"}
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(cmd, **kwargs)


def version(cmd: list[str]) -> str | None:
    try:
        return run(cmd, REPO, check=False, timeout=60).stdout.strip().splitlines()[0]
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(REPO / "qa-evidence" / "retail-journey"))
    parser.add_argument("--api-port", type=int, default=8010)
    parser.add_argument("--web-port", type=int, default=5180)
    parser.add_argument("--mosaic", default=os.getenv("MOSAIC_CHECKOUT"), help="datapass-mosaicstudio checkout (read-only)")
    parser.add_argument("--mosaic-ref", default="studio-v0.8.1")
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()

    sha = run(["git", "rev-parse", "HEAD"], REPO).stdout.strip()
    dirty = run(["git", "status", "--porcelain", "--untracked-files=no"], REPO).stdout.strip()
    if dirty and not args.allow_dirty:
        print("Working tree has uncommitted tracked changes; commit first (evidence is tied to HEAD).", file=sys.stderr)
        return 2

    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    screenshots = out / "screenshots"
    screenshots.mkdir(parents=True)
    fixture = out / "fixture"
    archive = out / "head.tar"
    archive.write_bytes(subprocess.run(["git", "archive", "--format=tar", "HEAD"], cwd=REPO, capture_output=True, check=True).stdout)
    with tarfile.open(archive) as tar:
        tar.extractall(fixture, filter="data")
    archive.unlink()

    env = {**os.environ}
    for name in ("CONTOSO_DUCKLAKE_CATALOG", "CONTOSO_DUCKLAKE_DATA_PATH"):
        env.pop(name, None)
    env.update({
        "CONTOSO_PROJECT_ROOT": str(fixture),
        "CONTOSO_WORKSPACE": str(fixture / "workspace"),
        "CONTOSO_HOME": str(fixture / "workspaces"),
        "RAYFIN_TELEMETRY_OPTOUT": "1",
    })
    api_url = f"http://127.0.0.1:{args.api_port}"
    web_url = f"http://127.0.0.1:{args.web_port}"
    web_env = {**os.environ, "CONTOSO_API_URL": api_url}
    browser_env = {**os.environ, "QA_BASE_URL": web_url, "QA_EVIDENCE_DIR": str(screenshots)}
    state_path = out / "journey-state.json"
    evidence: dict = {
        "format": "contoso.journey-evidence",
        "version": 1,
        "source_commit": sha,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "os": f"{platform.system()} {platform.release()} ({platform.version()})",
        "machine": platform.machine(),
        "python": sys.version.split()[0],
        "node": version(["node", "--version"]),
        "dbt": version([sys.executable, "-c", "from importlib.metadata import version; print(version('dbt-core'))"]),
        "web_mode": "production build served by vite preview",
        "phases": [],
    }

    api = web = None
    model = fixture / "dbt" / "models" / "gold" / "monthly_sales.sql"

    def start_api() -> subprocess.Popen:
        process = spawn([sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", str(fixture / "apps" / "api"),
                         "--host", "127.0.0.1", "--port", str(args.api_port)], fixture, env, out / "api.log")
        wait_http(f"{api_url}/api/health")
        return process

    def phase(name: str) -> None:
        started = time.time()
        completed = run(["node", "qa/retail-journey.mjs", name, str(state_path)], WEB, env=browser_env, check=False, timeout=1800)
        (out / f"phase-{name}.log").write_text(completed.stdout + completed.stderr, encoding="utf-8")
        evidence["phases"].append({"phase": name, "ok": completed.returncode == 0, "seconds": round(time.time() - started, 1)})
        if completed.returncode != 0:
            raise RuntimeError(f"phase {name} failed:\n{completed.stdout[-2000:]}\n{completed.stderr[-4000:]}")

    try:
        build = run(["npm", "run", "build"], WEB, env=web_env, check=False, timeout=900)
        (out / "web-build.log").write_text(build.stdout + build.stderr, encoding="utf-8")
        if build.returncode != 0:
            raise RuntimeError("web build failed")
        web = spawn(["npx", "vite", "preview", "--host", "127.0.0.1", "--port", str(args.web_port), "--strictPort"], WEB, web_env, out / "web.log")
        api = start_api()
        wait_http(web_url)

        phase("build")
        stop(api)
        api = start_api()
        phase("reopen")

        original = model.read_text(encoding="utf-8")
        model.write_text(original.replace("from {{ ref('stg_sales') }}", f"from {{{{ ref('stg_sales') }}}} {BROKEN_MARKER}\nwhere no_such_column > 0"), encoding="utf-8")
        try:
            phase("fault-broken")
        finally:
            model.write_text(original, encoding="utf-8")
        phase("fault-repaired")

        stop(api)
        api = None
        phase("api-down")
        api = start_api()
        phase("ux")

        state = json.loads(state_path.read_text(encoding="utf-8"))
        exports_root = fixture / "workspaces" / "journey-a" / "exports"
        latest = exports_root / state["repairedExport"]["exportId"]
        evidence["latest_export"] = json.loads((latest / "contoso-export.json").read_text(encoding="utf-8"))
        shutil.copytree(latest, out / "export", dirs_exist_ok=True)
        concept = out / "contoso-sales-forecasting.concept.json"
        with urllib.request.urlopen(f"{api_url}/api/fabric-apps/concept") as response:
            concept.write_bytes(response.read())
        if args.mosaic:
            check = run(["node", str(REPO / "tools" / "validate_with_mosaic.mjs"), "--mosaic", args.mosaic, "--ref", args.mosaic_ref,
                         "--export", str(out / "export"), "--concept", str(concept)], REPO, check=False, timeout=600)
            (out / "mosaic-validation.log").write_text(check.stdout + check.stderr, encoding="utf-8")
            evidence["mosaic_validation"] = json.loads(check.stdout) if check.returncode == 0 else {"ok": False, "stderr": check.stderr[-3000:]}
            if check.returncode != 0:
                raise RuntimeError("Mosaic validation failed")
        else:
            evidence["mosaic_validation"] = "NOT_RUN (no --mosaic checkout given)"
        evidence["journey"] = state
        evidence["result"] = "PASS"
        return 0
    except Exception as exc:  # noqa: BLE001 - evidence must record any failure
        evidence["result"] = "FAIL"
        evidence["error"] = str(exc)[-6000:]
        print(evidence["error"], file=sys.stderr)
        return 1
    finally:
        stop(api)
        stop(web)
        evidence["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        (out / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        print(json.dumps({k: evidence.get(k) for k in ("result", "source_commit", "os", "phases")}, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
