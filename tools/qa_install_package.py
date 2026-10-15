"""Install the release zip the way install.txt says and prove it runs (FR-02), optionally on the exit journeys.

    python tools/qa_install_package.py [--zip dist/<name>.zip] [--port 21100] [--receipt dist/qa-install-receipt.json]
        [--journey] [--mosaic <datapass-mosaicstudio checkout>] [--upgrade-from <older zip>] [--keep]

Default (CI job ``package``):
1. Checks the zip against dist/SHA256SUMS, unpacks it into a fresh temp folder.
2. Creates a fresh venv there and runs ``pip install -e "<root>/apps/api[dbt]"``.
3. Starts ``contoso-studio --port <port>`` (cwd outside the package, CONTOSO_WORKSPACE / CONTOSO_HOME in
   temp folders, CONTOSO_DUCKLAKE_* / CONTOSO_PROJECT_ROOT / CONTOSO_WEB_DIST unset).
4. Checks /api/health, / (index.html), an SPA route, a bundle asset, the concept viewer and an unknown
   /api path (404, not index.html); opens project retail-baseline (generate + Bronze + dbt build) and
   queries contoso.gold.monthly_sales.
5. Stops the server, deletes the temp folder (unless --keep) and prints a JSON receipt (also written to
   --receipt). Exit code 0 only when every check passed.

Opt-in exit journeys, all against the installed package (never the checkout):
--journey   Revenue KPI (the SQL the installed Charts page uses) equals the Gold total from /api/query; exports
            the Artifact (POST /api/exports/artifact) and the Concept (GET /api/fabric-apps/concept) and saves them
            under <receipt dir>/qa-install-journey/; breaks gold/monthly_sales.sql in the unpacked package the way
            tools/qa_retail_journey.py fault-broken does, asserts dbt build fails naming the model, repairs,
            rebuilds and asserts the Gold total is unchanged; restarts the server on the same
            CONTOSO_WORKSPACE / CONTOSO_HOME and asserts the same workspace, project, Gold total and export ids;
            backs up, restores into a new workspace (existing API) and asserts equal totals and export ids.
--mosaic    (implies --journey) runs the installed package's tools/open_in_mosaic.mjs (its own pinned temp
            archive of the checkout, never touched) on that Artifact + Concept; every gate goes in the receipt.
--mosaic-release <folder>
            (implies --journey) same gates against a delivered Mosaic SDK release folder (sdk-release.json, SDK
            tar.gz, concept-viewer.html) instead of a checkout. Packages whose open_in_mosaic.mjs predates this
            option (0.3.0 and older) run this checkout's copy as the harness; the receipt says which one ran.
--upgrade-from <older zip>
            installs the older zip in its own clean venv, opens retail-baseline to Gold there, records the Gold
            total and an export id, backs up, stops; starts this package on the SAME workspace/home and asserts it
            opens with the same Gold total and export id; writes a migration journal (versions, source shas,
            relative workspace paths, files the new version changed, backup sha256). Rollback limit: starts the
            OLD package again on that workspace and records (information only, never fails the run) whether it
            opens, then asserts that restoring the old backup in the old package works.

The receipt carries the zip name/sha256, version, source sha (install.txt in the zip), python/os, every check as
PASS/FAIL, information-only results and the omissions (what was not run and why).
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
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DIST = REPO / "dist"
# Same fault as tools/qa_retail_journey.py (fault-broken phase): a comment marker + a filter on a missing column.
BROKEN_MARKER = "-- qa_retail_journey: deliberately broken"
BROKEN_ANCHOR = "from {{ ref('stg_sales') }}"
BROKEN_MODEL = Path("dbt") / "models" / "gold" / "monthly_sales.sql"
# Fallback when the installed Charts page cannot be read; kept equal to apps/web/src/pages/ChartsPage.tsx.
REVENUE_KPI_SQL = ("select round(sum(revenue),2) revenue, round(sum(gross_margin),2) gross_margin, sum(units) units "
                   "from contoso.gold.monthly_sales")
GOLD_TOTAL_SQL = "select CAST(sum(revenue) AS DECIMAL(18,2)) as total from contoso.gold.monthly_sales"
PROJECT = "retail-baseline"
MART = "monthly_sales"


# ----- pure helpers (unit-tested in apps/api/tests/test_qa_install_package.py) -----------------------------------
def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_sums(text: str) -> dict[str, str]:
    """``sha256sum`` lines -> {file name: digest}."""
    sums = {}
    for line in text.splitlines():
        if line.strip():
            digest, name = line.split(maxsplit=1)
            sums[name.strip().lstrip("*")] = digest
    return sums


def package_identity(zip_name: str, install_txt: str | None) -> dict[str, str | None]:
    """Version and source sha of a package: install.txt's first line, else the zip name."""
    match = re.match(r"Contoso Data Studio (\S+) \(([0-9a-f]{7,40})\)", (install_txt or "").strip())
    if match:
        return {"version": match.group(1), "source_sha": match.group(2), "from": "install.txt"}
    match = re.fullmatch(r"contoso-data-studio-(.+)-([0-9a-f]{7,40})\.zip", zip_name)
    if match:
        return {"version": match.group(1), "source_sha": match.group(2), "from": "zip name"}
    return {"version": None, "source_sha": None, "from": None}


def to_cents(value: object) -> int:
    """A money value from /api/query (float, int, str or Decimal) in integer cents, half-up."""
    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def kpi_revenue_sql(charts_page: str) -> str | None:
    """The SQL whose first column the Charts page shows as the "Revenue" KPI (baseline dashboard)."""
    match = re.search(r'sql:"(select round\(sum\(revenue\),2\) revenue[^"]*from contoso\.gold\.monthly_sales)"', charts_page)
    return match.group(1) if match and '{label:"Revenue"' in charts_page else None


def break_model(text: str) -> str:
    """The qa_retail_journey fault: same marker, then a filter on a column that does not exist."""
    if BROKEN_ANCHOR not in text:
        raise ValueError(f"model has no {BROKEN_ANCHOR!r} to break")
    return text.replace(BROKEN_ANCHOR, f"{BROKEN_ANCHOR} {BROKEN_MARKER}\nwhere no_such_column > 0", 1)


def failed_models(build: dict) -> list[dict[str, str]]:
    """Models a dbt build response (/api/dbt/build) reports as error, with dbt's message."""
    results = ((build or {}).get("run_results") or {}).get("results") or []
    return [{"model": str(item.get("unique_id", "")).rsplit(".", 1)[-1], "message": str(item.get("message") or "")[:500]}
            for item in results
            if str(item.get("unique_id", "")).startswith("model.") and item.get("status") == "error"]


def snapshot_tree(root: Path) -> dict[str, str]:
    """{posix path relative to root: sha256} of every file under root."""
    if not root.is_dir():
        return {}
    return {path.relative_to(root).as_posix(): sha256(path) for path in sorted(root.rglob("*")) if path.is_file()}


def diff_trees(before: dict[str, str], after: dict[str, str]) -> dict[str, list[str]]:
    return {
        "added": sorted(set(after) - set(before)),
        "removed": sorted(set(before) - set(after)),
        "modified": sorted(name for name in set(before) & set(after) if before[name] != after[name]),
    }


def overall(checks: dict[str, str]) -> str:
    return "pass" if checks and all(value == "PASS" for value in checks.values()) else "fail"


def verdict(ok: object) -> str:
    return "PASS" if ok is True else "FAIL"


# ----- processes and HTTP --------------------------------------------------------------------------------------
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


class Installed:
    """One zip unpacked + installed in its own clean venv under ``home``."""

    def __init__(self, zip_path: Path, home: Path, timings: dict[str, float], prefix: str = "") -> None:
        self.zip = zip_path
        started = time.monotonic()
        with zipfile.ZipFile(zip_path) as package:
            package.extractall(home / "unpacked")
        roots = [path for path in (home / "unpacked").iterdir() if path.is_dir()]
        if len(roots) != 1:
            raise RuntimeError(f"Expected one top folder in {zip_path.name}, found {[p.name for p in roots]}")
        self.root = roots[0]
        timings[prefix + "unpack"] = round(time.monotonic() - started, 1)
        started = time.monotonic()
        venv = home / "venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True, capture_output=True)
        bindir = venv / ("Scripts" if os.name == "nt" else "bin")
        python = bindir / ("python.exe" if os.name == "nt" else "python")
        install = subprocess.run(
            [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-q", "-e", f"{self.root / 'apps' / 'api'}[dbt]"],
            capture_output=True, text=True, timeout=1800,
        )
        if install.returncode != 0:
            raise RuntimeError(f"pip install of {zip_path.name} failed:\n" + (install.stdout + install.stderr)[-3000:])
        timings[prefix + "venv_and_pip_install"] = round(time.monotonic() - started, 1)
        self.studio = bindir / ("contoso-studio.exe" if os.name == "nt" else "contoso-studio")
        version = subprocess.run([str(self.studio), "--version"], capture_output=True, text=True, timeout=120)
        self.version = version.stdout.strip()
        install_txt = self.root / "install.txt"
        self.identity = package_identity(zip_path.name, install_txt.read_text(encoding="utf-8") if install_txt.is_file() else None)

    def describe(self) -> dict[str, object]:
        return {"zip": self.zip.name, "sha256": sha256(self.zip), "version": self.version,
                "source_sha": self.identity["source_sha"], "source_sha_from": self.identity["from"]}


class Studio:
    """``contoso-studio`` of one installed package on a data folder (workspace + home) and a loopback port."""

    def __init__(self, installed: Installed, data: Path, port: int, log_path: Path, run_dir: Path) -> None:
        self.installed, self.data, self.port, self.log_path, self.run_dir = installed, data, port, log_path, run_dir
        self.base = f"http://127.0.0.1:{port}"
        self.process: subprocess.Popen | None = None
        self._log = None

    @property
    def workspace(self) -> Path:
        return self.data / "workspace"

    @property
    def home(self) -> Path:
        return self.data / "workspaces"

    def start(self, timeout: float = 120) -> dict:
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("CONTOSO_") and key not in {"VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME"}}
        env.update({"CONTOSO_WORKSPACE": str(self.workspace), "CONTOSO_HOME": str(self.home),
                    "RAYFIN_TELEMETRY_OPTOUT": "1", "PYTHONUNBUFFERED": "1"})
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self._log = self.log_path.open("ab")
        kwargs: dict = {"cwd": self.run_dir, "env": env, "stdout": self._log, "stderr": subprocess.STDOUT}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        self.process = subprocess.Popen([str(self.installed.studio), "--port", str(self.port)], **kwargs)
        deadline = time.time() + timeout
        while time.time() < deadline and self.process.poll() is None:
            try:
                status, _, body = request("GET", f"{self.base}/api/health", timeout=5)
                if status == 200:
                    return json.loads(body)
            except OSError:
                pass
            time.sleep(1)
        raise RuntimeError(f"{self.installed.zip.name}: server did not answer /api/health")

    def stop(self) -> bool:
        if self.process is None:
            return True
        stop(self.process)
        stopped = self.process.poll() is not None
        if self._log:
            self._log.close()
            self._log = None
        self.process = None
        return stopped

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 60) -> tuple[int, dict, bytes]:
        return request(method, self.base + path, body, timeout)

    def json(self, method: str, path: str, body: dict | None = None, timeout: float = 60) -> tuple[int, dict]:
        status, _, raw = self.call(method, path, body, timeout)
        try:
            return status, json.loads(raw) if raw else {}
        except ValueError:
            return status, {"raw": raw[-2000:].decode("utf-8", "replace")}

    def rows(self, sql: str) -> list[list]:
        status, body = self.json("POST", "/api/query", {"sql": sql, "limit": 10})
        if status != 200:
            raise RuntimeError(f"query failed ({status}): {body}")
        return body["rows"]

    def gold_total_cents(self) -> int:
        return to_cents(self.rows(GOLD_TOTAL_SQL)[0][0])

    def export_ids(self) -> list[str]:
        return sorted(item["export_id"] for item in self.json("GET", "/api/exports")[1].get("exports", []))

    def open_project(self) -> dict:
        status, body = self.json("POST", f"/api/projects/{PROJECT}/open", timeout=1800)
        if status != 200:
            raise RuntimeError(f"{self.installed.zip.name}: project open failed ({status}): {str(body)[-2000:]}")
        return body

    def log_tail(self, chars: int = 3000) -> str:
        return self.log_path.read_text(encoding="utf-8", errors="replace")[-chars:] if self.log_path.is_file() else ""


# ----- default install checks (unchanged behaviour) -------------------------------------------------------------
def install_checks(studio: Studio, health: dict, checks: dict, receipt: dict, timings: dict) -> None:
    checks["health_ok"] = verdict(health.get("status") == "ok")
    checks["workspace_in_temp"] = verdict(Path(health["workspace"]).resolve() == studio.workspace.resolve())
    status, headers, body = studio.call("GET", "/")
    index = body.decode("utf-8", "replace")
    checks["root_serves_index_html"] = verdict(status == 200 and 'id="root"' in index and "text/html" in headers.get("content-type", ""))
    status, _, body = studio.call("GET", "/explore/some/route")
    checks["spa_fallback"] = verdict(status == 200 and b'id="root"' in body)
    asset = re.search(r'(?:src|href)="(/assets/[^"]+\.js)"', index)
    checks["bundle_asset"] = verdict(bool(asset) and studio.call("GET", asset.group(1))[0] == 200)
    status, headers, _ = studio.call("GET", "/vendor/concept-viewer/concept-viewer.html")
    checks["concept_viewer"] = verdict(status == 200 and headers.get("x-concept-viewer") == "vendored")
    status, _, body = studio.call("GET", "/api/does-not-exist")
    checks["unknown_api_is_404_json"] = verdict(status == 404 and b'id="root"' not in body)

    started = time.monotonic()
    opened = studio.open_project()
    timings["open_retail_baseline"] = round(time.monotonic() - started, 1)
    checks["project_open"] = verdict(bool(opened.get("state", {}).get("ready")))

    started = time.monotonic()
    rows = studio.rows("select count(*) from contoso.gold.monthly_sales")
    timings["gold_query"] = round(time.monotonic() - started, 1)
    receipt["gold_monthly_sales_rows"] = rows[0][0] if rows else None
    checks["gold_monthly_sales_count_gt_0"] = verdict(bool(rows) and rows[0][0] > 0)


# ----- A. exit journey -------------------------------------------------------------------------------------------
def save_export(studio: Studio, export_id: str, target: Path) -> Path:
    """Download one export bundle through /api/exports/{id}/{name} (what the UI links to)."""
    folder = target / export_id
    folder.mkdir(parents=True, exist_ok=True)

    def fetch(name: str) -> bytes:
        status, _, raw = studio.call("GET", f"/api/exports/{export_id}/{name}")
        if status != 200:
            raise RuntimeError(f"export file {export_id}/{name}: HTTP {status}")
        (folder / name).write_bytes(raw)
        return raw

    bundle = json.loads(fetch("contoso-export.json"))
    manifest = json.loads(fetch("manifest.json"))
    names = {bundle["artifact"]["file"], bundle["bulk_data"]["file"]}
    names.update(entry["parquet"] for entry in manifest.get("artifacts", []) if entry.get("parquet"))
    for name in sorted(names):
        fetch(name)
    return folder


def journey(studio: Studio, checks: dict, receipt: dict, out: Path) -> dict:
    info: dict[str, object] = {"out_dir": out.name}
    receipt["journey"] = info
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    charts_page = studio.installed.root / "apps" / "web" / "src" / "pages" / "ChartsPage.tsx"
    kpi_sql = kpi_revenue_sql(charts_page.read_text(encoding="utf-8")) if charts_page.is_file() else None
    info["kpi_sql_source"] = "installed apps/web/src/pages/ChartsPage.tsx"
    if kpi_sql is None:
        receipt["omissions"].append("journey: Revenue KPI SQL not found in the installed ChartsPage.tsx; used the built-in copy")
        kpi_sql, info["kpi_sql_source"] = REVENUE_KPI_SQL, "built-in copy"
    info["kpi_sql"] = kpi_sql
    kpi = to_cents(studio.rows(kpi_sql)[0][0])
    gold = studio.gold_total_cents()
    info["revenue_kpi"] = kpi / 100
    info["gold_total"] = gold / 100
    checks["journey.revenue_kpi_equals_gold_total"] = verdict(kpi == gold)

    # Exports through the same endpoints the UI uses.
    status, exported = studio.json("POST", "/api/exports/artifact", {"mart": MART}, timeout=600)
    checks["journey.export_artifact"] = verdict(status == 200 and bool(exported.get("export_id")))
    if status != 200:
        raise RuntimeError(f"artifact export failed ({status}): {exported}")
    export_id = exported["export_id"]
    bundle_dir = save_export(studio, export_id, out / "export")
    status, _, concept = studio.call("GET", "/api/fabric-apps/concept?download=true")
    concept_path = out / "contoso-sales-forecasting.concept.json"
    concept_path.write_bytes(concept)
    checks["journey.export_concept"] = verdict(status == 200 and bool(json.loads(concept or b"{}").get("id")))
    info["export_id"] = export_id
    info["artifact"] = {"dir": bundle_dir.relative_to(out).as_posix(), "file": exported["artifact"]["file"],
                        "sha256": exported["artifact"]["sha256"], "rows": exported["artifact"]["rows"]}
    info["concept"] = {"file": concept_path.name, "sha256": hashlib.sha256(concept).hexdigest()}

    # Fault: break the model in the installed package, build must fail and name it; repair; rebuild.
    model = studio.installed.root / BROKEN_MODEL
    original = model.read_text(encoding="utf-8")
    model.write_text(break_model(original), encoding="utf-8")
    try:
        status, broken = studio.json("POST", "/api/dbt/build", timeout=900)
    finally:
        model.write_text(original, encoding="utf-8")
    failed = failed_models(broken)
    named = any(item["model"] == MART for item in failed)
    useful = named and any("no_such_column" in item["message"] for item in failed if item["model"] == MART)
    info["fault"] = {"http": status, "ok": broken.get("ok"), "failed_models": failed}
    checks["journey.fault_build_fails"] = verdict(status == 200 and broken.get("ok") is False)
    checks["journey.fault_error_names_model"] = verdict(named and useful)
    status, repaired = studio.json("POST", "/api/dbt/build", timeout=900)
    checks["journey.repaired_build_ok"] = verdict(status == 200 and repaired.get("ok") is True)
    repaired_total = studio.gold_total_cents()
    info["gold_total_after_repair"] = repaired_total / 100
    checks["journey.gold_total_unchanged_after_repair"] = verdict(repaired_total == gold)

    # Restart on the same CONTOSO_WORKSPACE / CONTOSO_HOME.
    before_ids = studio.export_ids()
    workspace_id = studio.json("GET", "/api/health")[1].get("workspace_id")
    checks["journey.server_stopped_for_restart"] = verdict(studio.stop())
    health = studio.start()
    checks["journey.restart_same_workspace"] = verdict(health.get("workspace_id") == workspace_id
                                                       and Path(health["workspace"]).resolve() == studio.workspace.resolve())
    state = studio.json("GET", "/api/workspace/project-state")[1]
    checks["journey.restart_project_ready"] = verdict(state.get("ready") is True and state.get("active_scenario") == PROJECT)
    reopened = studio.open_project()
    info["reopen_resumed"] = reopened.get("resumed")
    checks["journey.restart_reopen_project"] = verdict(bool(reopened.get("state", {}).get("ready")))
    checks["journey.restart_gold_total_equal"] = verdict(studio.gold_total_cents() == gold)
    after_ids = studio.export_ids()
    checks["journey.restart_export_ids_equal"] = verdict(after_ids == before_ids and export_id in after_ids)

    # Backup -> restore into a new workspace through the existing API.
    status, backup = studio.json("POST", f"/api/workspaces/{workspace_id}/backup", timeout=600)
    checks["journey.backup"] = verdict(status == 200 and bool(backup.get("backup")))
    if status != 200:
        raise RuntimeError(f"backup failed ({status}): {backup}")
    status, restored = studio.json("POST", "/api/workspaces/restore", {"backup": backup["backup"], "name": "QA install restore"}, timeout=600)
    checks["journey.restore_new_workspace"] = verdict(status == 200 and restored.get("id") not in (None, workspace_id))
    if status != 200:
        raise RuntimeError(f"restore failed ({status}): {restored}")
    if studio.json("POST", f"/api/workspaces/{restored['id']}/activate", timeout=300)[0] != 200:
        raise RuntimeError(f"could not activate restored workspace {restored['id']}")
    restored_total = studio.gold_total_cents()
    restored_ids = studio.export_ids()
    checks["journey.restore_gold_total_equal"] = verdict(restored_total == gold)
    checks["journey.restore_export_ids_equal"] = verdict(restored_ids == after_ids)
    checks["journey.reactivate_original_workspace"] = verdict(
        studio.json("POST", f"/api/workspaces/{workspace_id}/activate", timeout=300)[0] == 200)
    info["backup"] = {"name": backup["backup"], "files": backup.get("files"), "restored_workspace": restored["id"]}
    return {"export_dir": bundle_dir, "concept": concept_path}


# ----- B. MosaicStudio gates -------------------------------------------------------------------------------------
def mosaic_tool(package_root: Path, release: bool) -> tuple[Path, str]:
    """The open_in_mosaic.mjs to run: the installed package's copy unless it is missing or (for a Mosaic SDK
    release folder) predates --mosaic-release; then this checkout's copy, as a harness only."""
    tool = package_root / "tools" / "open_in_mosaic.mjs"
    if not tool.is_file():
        return REPO / "tools" / "open_in_mosaic.mjs", "checkout (not in the package)"
    if release and "mosaic-release" not in tool.read_text(encoding="utf-8"):
        return REPO / "tools" / "open_in_mosaic.mjs", "checkout (the package's copy has no --mosaic-release)"
    return tool, "installed package"


def mosaic_gates(installed: Installed, mosaic: Path, exported: dict, port: int, out: Path, checks: dict, receipt: dict,
                 release: bool = False) -> None:
    tool, source = mosaic_tool(installed.root, release)
    if source != "installed package":
        receipt["omissions"].append(f"mosaic: ran the checkout's tools/open_in_mosaic.mjs: {source} (harness only, the "
                                    "Artifact and Concept still come from the installed package)")
    env = dict(os.environ)
    if os.name == "nt":
        # The tool runs `tar -xf C:\...`: Git Bash's GNU tar reads "C:" as a remote host, Windows' bsdtar does not.
        system32 = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
        env["PATH"] = system32 + os.pathsep + env.get("PATH", "")
    started = time.monotonic()
    completed = subprocess.run(
        ["node", str(tool), "--mosaic-release" if release else "--mosaic", str(mosaic), "--export", str(exported["export_dir"]),
         "--concept", str(exported["concept"]), "--out", str(out), "--port", str(port)],
        capture_output=True, text=True, timeout=3600, env=env,
    )
    evidence_path = out / "evidence.json"
    evidence = json.loads(evidence_path.read_text(encoding="utf-8")) if evidence_path.is_file() else {}
    gates = {name: {"status": (gate or {}).get("status") or verdict((gate or {}).get("ok")), "ok": (gate or {}).get("ok")}
             for name, gate in (evidence.get("gates") or {}).items()}
    receipt["mosaic"] = {
        "tool": source, "exit_code": completed.returncode, "seconds": round(time.monotonic() - started, 1),
        "mosaic_sha": evidence.get("mosaic_sha"), "mosaic_version": evidence.get("mosaic_version"),
        "mosaic_source": evidence.get("mosaic_source"), "mosaic_release": evidence.get("mosaic_release"),
        "result": evidence.get("result"), "gates": gates, "failures": evidence.get("failures"),
        "evidence": f"{out.name}/evidence.json",
    }
    if completed.returncode != 0 and not evidence:
        receipt["mosaic"]["stderr_tail"] = completed.stderr[-3000:]
    for name in ("structural_strict", "structural_ts", "semantic", "concept"):
        checks[f"mosaic.{name}"] = verdict((evidence.get("gates") or {}).get(name, {}).get("ok"))
    checks["mosaic.exit_code_0"] = verdict(completed.returncode == 0)


# ----- C. upgrade from an older package --------------------------------------------------------------------------
def upgrade(new: Installed, old_zip: Path, temp: Path, port: int, checks: dict, receipt: dict, timings: dict) -> None:
    info: dict[str, object] = {}
    receipt["upgrade"] = info
    old = Installed(old_zip, temp / "old", timings, prefix="old_")
    info["old"] = old.describe()
    info["new"] = new.describe()
    data = temp / "upgrade-data"
    old_studio = Studio(old, data, port, temp / "old-server.log", temp / "cwd-old")
    new_studio = Studio(new, data, port, temp / "upgrade-new-server.log", temp / "cwd-new")
    try:
        old_studio.start()
        old_studio.open_project()
        old_total = old_studio.gold_total_cents()
        status, exported = old_studio.json("POST", "/api/exports/artifact", {"mart": MART}, timeout=600)
        if status != 200:
            raise RuntimeError(f"old package export failed ({status}): {exported}")
        old_export = exported["export_id"]
        workspace_id = old_studio.json("GET", "/api/health")[1].get("workspace_id")
        status, backup = old_studio.json("POST", f"/api/workspaces/{workspace_id}/backup", timeout=600)
        if status != 200:
            raise RuntimeError(f"old package backup failed ({status}): {backup}")
        checks["upgrade.old_package_to_gold_export_backup"] = "PASS"
        old_studio.stop()
        before = snapshot_tree(data)

        new_studio.start()
        health = new_studio.json("GET", "/api/health")[1]
        state = new_studio.json("GET", "/api/workspace/project-state")[1]
        checks["upgrade.new_opens_same_workspace"] = verdict(health.get("workspace_id") == workspace_id
                                                             and state.get("active_scenario") == PROJECT)
        reopened = new_studio.open_project()
        checks["upgrade.new_project_ready"] = verdict(bool(reopened.get("state", {}).get("ready")))
        new_total = new_studio.gold_total_cents()
        checks["upgrade.gold_total_equal"] = verdict(new_total == old_total)
        checks["upgrade.old_export_listed"] = verdict(old_export in new_studio.export_ids())
        new_studio.stop()
        after = snapshot_tree(data)
        log_lines = [line for line in new_studio.log_tail(200_000).splitlines() if re.search(r"migrat|upgrad|adopt", line, re.I)]
        backup_file = data / "workspaces" / "_backups" / backup["backup"]
        info["journal"] = {
            "old": {"version": old.version, "source_sha": old.identity["source_sha"]},
            "new": {"version": new.version, "source_sha": new.identity["source_sha"]},
            "workspace": {"root": "upgrade-data", "workspace": "upgrade-data/workspace", "home": "upgrade-data/workspaces",
                          "workspace_id": workspace_id},
            "gold_total": {"old": old_total / 100, "new": new_total / 100},
            "export_id": old_export,
            "open_resumed": reopened.get("resumed"),
            "files_changed_by_new_version": diff_trees(before, after),
            "migration_log": log_lines[:50] or "none logged (no schema or state migration between these versions)",
            "backup": {"name": backup["backup"], "path": f"upgrade-data/workspaces/_backups/{backup['backup']}",
                       "sha256": sha256(backup_file) if backup_file.is_file() else None, "files": backup.get("files")},
        }

        # Rollback limit: the old package on the workspace the new one touched (information only).
        rollback: dict[str, object] = {}
        info["rollback"] = rollback
        try:
            old_studio.start()
            state = old_studio.json("GET", "/api/workspace/project-state")[1]
            total = old_studio.gold_total_cents()
            opens = state.get("ready") is True and total == old_total
            rollback["old_opens_touched_workspace"] = verdict(opens)
            rollback["detail"] = {"ready": state.get("ready"), "gold_total": total / 100}
        except Exception as exc:  # recorded, never fatal
            rollback["old_opens_touched_workspace"] = "FAIL"
            rollback["detail"] = str(exc)[-1000:]
            old_studio.stop()
            old_studio.start()
        receipt["information"]["upgrade.rollback_old_opens_touched_workspace"] = rollback["old_opens_touched_workspace"]
        status, restored = old_studio.json("POST", "/api/workspaces/restore", {"backup": backup["backup"], "name": "Rollback restore"}, timeout=600)
        ok = status == 200 and bool(restored.get("id"))
        if ok:
            old_studio.json("POST", f"/api/workspaces/{restored['id']}/activate", timeout=300)
            ok = old_studio.gold_total_cents() == old_total and old_export in old_studio.export_ids()
        checks["upgrade.rollback_restore_old_backup_in_old_package"] = verdict(ok)
        rollback["restored_workspace"] = restored.get("id") if status == 200 else None
        rollback["limit"] = (
            "Rollback = start the old package and restore the backup taken with it into a new workspace. Opening the "
            "workspace the new version touched with the old package is recorded above as information, not promised."
        )
    finally:
        old_studio.stop()
        new_studio.stop()
        for studio, name in ((old_studio, "old"), (new_studio, "new")):
            if overall(checks) != "pass":
                receipt.setdefault("server_log_tails", {})[f"upgrade_{name}"] = studio.log_tail()


# ----- main ------------------------------------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zip", help="package zip (default: the one named in dist/SHA256SUMS)")
    parser.add_argument("--port", type=int, default=21100)
    parser.add_argument("--receipt", default=str(DIST / "qa-install-receipt.json"))
    parser.add_argument("--keep", action="store_true", help="keep the temp folder for inspection")
    parser.add_argument("--journey", action="store_true", help="A: KPI = Gold, exports, fault/repair, restart, backup/restore")
    parser.add_argument("--mosaic", help="B: datapass-mosaicstudio checkout (read-only); implies --journey")
    parser.add_argument("--mosaic-release", help="B: delivered Mosaic SDK release folder instead of a checkout; implies --journey")
    parser.add_argument("--mosaic-port", type=int, help="loopback port for the Mosaic host (default --port + 1)")
    parser.add_argument("--upgrade-from", help="C: older package zip to upgrade from on the same workspace")
    args = parser.parse_args()
    if args.mosaic and args.mosaic_release:
        parser.error("pass --mosaic or --mosaic-release, not both")
    run_journey = args.journey or bool(args.mosaic) or bool(args.mosaic_release)

    sums = parse_sums((DIST / "SHA256SUMS").read_text(encoding="utf-8")) if (DIST / "SHA256SUMS").is_file() else {}
    zip_path = Path(args.zip).resolve() if args.zip else (DIST / next(iter(sums), "missing.zip"))
    receipt_path = Path(args.receipt).resolve()
    timings: dict[str, float] = {}
    checks: dict[str, str] = {}
    receipt: dict[str, object] = {
        "package": zip_path.name,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "os": platform.platform(),
        "python": platform.python_version(),
        "port": args.port,
        "flags": {"journey": run_journey, "mosaic": bool(args.mosaic), "mosaic_release": bool(args.mosaic_release), "upgrade_from": Path(args.upgrade_from).name if args.upgrade_from else None},
        "timings_s": timings,
        "checks": checks,
        "information": {},
        "omissions": [],
    }
    omissions: list[str] = receipt["omissions"]  # type: ignore[assignment]
    if not run_journey:
        omissions.append("journey (A) not run: pass --journey")
    if not args.mosaic and not args.mosaic_release:
        omissions.append("Mosaic gates (B) not run: pass --mosaic <datapass-mosaicstudio checkout>")
    if not args.upgrade_from:
        omissions.append("upgrade (C) not run: pass --upgrade-from <older zip>")
    temp = Path(tempfile.mkdtemp(prefix="contoso-qa-install-"))
    studio: Studio | None = None
    result = "fail"

    try:
        if not zip_path.is_file():
            raise RuntimeError(f"Package not found: {zip_path} (run tools/package_release.py first)")
        receipt["bytes"] = zip_path.stat().st_size
        receipt["sha256"] = sha256(zip_path)
        expected = sums.get(zip_path.name)
        if expected:
            checks["sha256_matches_SHA256SUMS"] = verdict(expected == receipt["sha256"])
            if expected != receipt["sha256"]:
                raise RuntimeError("Zip does not match dist/SHA256SUMS")
        else:
            omissions.append(f"sha256 not compared: {zip_path.name} is not listed in dist/SHA256SUMS")

        installed = Installed(zip_path, temp, timings)
        checks["web_bundle_in_zip"] = verdict((installed.root / "apps" / "web" / "dist" / "index.html").is_file())
        checks["install_txt_in_zip"] = verdict((installed.root / "install.txt").is_file())
        checks["console_script_installed"] = verdict(installed.studio.is_file())
        receipt["version"] = installed.version
        receipt["source_sha"] = installed.identity["source_sha"]
        receipt["source_sha_from"] = installed.identity["from"]

        studio = Studio(installed, temp / "data", args.port, temp / "server.log", temp / "cwd")
        started = time.monotonic()
        health = studio.start()
        timings["server_start"] = round(time.monotonic() - started, 1)
        install_checks(studio, health, checks, receipt, timings)

        exported = None
        if run_journey:
            started = time.monotonic()
            exported = journey(studio, checks, receipt, receipt_path.parent / "qa-install-journey")
            timings["journey"] = round(time.monotonic() - started, 1)
        checks["server_stopped"] = verdict(studio.stop())

        if (args.mosaic or args.mosaic_release) and exported:
            mosaic_gates(installed, Path(args.mosaic or args.mosaic_release).resolve(), exported, args.mosaic_port or args.port + 1,
                         receipt_path.parent / "qa-install-mosaic", checks, receipt, release=bool(args.mosaic_release))
        if args.upgrade_from:
            started = time.monotonic()
            upgrade(installed, Path(args.upgrade_from).resolve(), temp, args.port, checks, receipt, timings)
            timings["upgrade"] = round(time.monotonic() - started, 1)

        result = overall(checks)
    except Exception as exc:  # the receipt always says why
        receipt["error"] = str(exc)[-6000:]
    finally:
        if studio is not None:
            if studio.process is not None:
                checks["server_stopped"] = verdict(studio.stop())
            if result != "pass":
                receipt["server_log_tail"] = studio.log_tail()
        if args.keep:
            receipt["temp_dir"] = str(temp)
        else:
            shutil.rmtree(temp, ignore_errors=True)
    receipt["result"] = result
    receipt["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    text = json.dumps(receipt, indent=2)
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if result == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
