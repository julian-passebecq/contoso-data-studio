"""Workspace isolation, backup/restore and datapass.artifact export (07-contoso F07, F10; UX03, UX04)."""
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

import duckdb
import pytest

from app import config
from app.config import Settings
from app.services.dbt_runner import DbtService
from app.services.ducklake import DuckLakeService
from app.services.exports import ExportError, ExportService, dpa
from app.services.generator import GeneratorService
from app.services.workspaces import WorkspaceError, WorkspaceRegistry

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = ROOT / "vendor" / "datapass-artifact" / "artifact.schema.json"
needs_dbt = pytest.mark.skipif(shutil.which("dbt") is None, reason="dbt CLI not on PATH")


@pytest.fixture
def registry(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(ROOT))
    monkeypatch.setenv("CONTOSO_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("CONTOSO_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("CONTOSO_DUCKLAKE_CATALOG", raising=False)
    monkeypatch.delenv("CONTOSO_DUCKLAKE_DATA_PATH", raising=False)
    yield WorkspaceRegistry()
    config.set_active(None)


def _services(settings):
    generator, ducklake = GeneratorService(settings), DuckLakeService(settings)
    dbt = DbtService(settings)
    return generator, ducklake, dbt, ExportService(settings, generator, ducklake, dbt)


def _prepare(settings, scenario, scale=1_500, seed=7):
    generator, ducklake, dbt, exports = _services(settings)
    manifest = generator.generate(scenario, scale, seed)
    run_id = str(manifest["run_id"])
    ducklake.load_parquet_to_bronze(generator.run_files(run_id, verify_hashes=True))
    generator.mark_bronze_loaded(run_id, int(ducklake.snapshots(1)[0]["snapshot_id"]))
    build = dbt.run("build")
    assert build["ok"], build["output"][-3000:]
    return generator, ducklake, dbt, exports


def _gold_scenarios(ducklake):
    _, rows, _ = ducklake.query("select distinct scenario from contoso.gold.monthly_sales order by 1", 10)
    return [row[0] for row in rows]


def test_default_workspace_is_adopted_in_place(registry, tmp_path):
    legacy = tmp_path / "workspace"
    (legacy / "keep.txt").write_text("user data", encoding="utf-8")
    listing = registry.list()
    assert listing["active"] == "default"
    default = listing["workspaces"][0]
    assert default["id"] == "default" and Path(default["path"]) == legacy.resolve()
    assert (legacy / "keep.txt").read_text(encoding="utf-8") == "user data"
    assert Settings.load().workspace == legacy.resolve()


def test_create_validates_names_and_never_overwrites(registry):
    created = registry.create("Retail Lab A")
    assert created.workspace_id == "retail-lab-a"
    with pytest.raises(WorkspaceError):
        registry.create("retail lab a")
    for bad in ["", "  ", "!!!", "default"]:
        with pytest.raises(WorkspaceError):
            registry.create(bad)
    # Display names are free text; the folder is always a safe slug inside the workspaces home.
    escaped = registry.create("../escape")
    assert escaped.workspace.parent == registry.home.resolve() and escaped.workspace_id == "escape"
    with pytest.raises(WorkspaceError):
        registry.settings_for("..")
    with pytest.raises(WorkspaceError):
        registry.activate("missing-one")


def test_named_workspace_paths_ignore_default_env_overrides(registry, monkeypatch, tmp_path):
    monkeypatch.setenv("CONTOSO_DUCKLAKE_CATALOG", str(tmp_path / "ci.sqlite"))
    named = registry.create("Isolated")
    assert named.catalog_path == named.workspace / "contoso.ducklake.sqlite"
    assert named.dbt_target_path == named.workspace / "dbt-target"
    env = named.dbt_env()
    assert env["CONTOSO_DUCKLAKE_CATALOG"] == str(named.catalog_path)
    assert env["DBT_TARGET_PATH"] == str(named.dbt_target_path)
    assert Settings.default().catalog_path == (tmp_path / "ci.sqlite").resolve()


def test_activation_is_remembered_across_restart(registry):
    registry.create("Second")
    registry.activate("second")
    assert Settings.load().workspace_id == "second"
    config.set_active(None)  # simulate a new API process
    fresh = WorkspaceRegistry()
    assert fresh.remembered_id() == "second"
    assert fresh.activate(fresh.remembered_id(), remember=False).workspace_id == "second"


def test_restore_rejects_unsafe_archives(registry):
    registry.backups.mkdir(parents=True, exist_ok=True)
    evil = registry.backups / "evil.zip"
    with zipfile.ZipFile(evil, "w") as archive:
        archive.writestr("backup.json", json.dumps({"format": "contoso.workspace-backup", "version": 1}))
        archive.writestr("workspace/../../escape.txt", "x")
    with pytest.raises(WorkspaceError):
        registry.restore("evil.zip", "Evil")
    assert not (registry.home / "evil").exists()
    foreign = registry.backups / "foreign.zip"
    with zipfile.ZipFile(foreign, "w") as archive:
        archive.writestr("readme.txt", "not a backup")
    with pytest.raises(WorkspaceError):
        registry.restore("foreign.zip", "Foreign")
    with pytest.raises(WorkspaceError):
        registry.restore("../foreign.zip", "Foreign")


def test_export_refuses_without_successful_run(registry):
    settings = registry.create("No Run")
    generator, ducklake, dbt, exports = _services(settings)
    ducklake.bootstrap()
    with pytest.raises(ExportError):
        exports.export("monthly_sales")
    settings.dbt_target_path.mkdir(parents=True)
    (settings.dbt_target_path / "run_results.json").write_text(json.dumps({
        "metadata": {"invocation_id": "x"},
        "results": [{"unique_id": "model.contoso_data_studio.monthly_sales", "status": "error"}],
    }))
    exports.gold_tables = lambda: ["monthly_sales"]
    with pytest.raises(ExportError, match="status 'error'"):
        exports.export("monthly_sales")
    with pytest.raises(ExportError):
        exports.export("monthly_sales; drop table x")


@needs_dbt
def test_two_workspaces_stay_isolated_and_export_backup_restore(registry):
    a = registry.create("Workspace A")
    b = registry.create("Workspace B")
    gen_a, lake_a, dbt_a, exports_a = _prepare(a, "online-migration")
    gen_b, lake_b, dbt_b, _ = _prepare(b, "logistics-delays")

    # Separate catalogs, staging runs, dbt artifacts and Gold results.
    assert _gold_scenarios(lake_a) == ["online-migration"]
    assert _gold_scenarios(lake_b) == ["logistics-delays"]
    assert a.catalog_path != b.catalog_path and a.catalog_path.is_file() and b.catalog_path.is_file()
    assert {r["run_id"] for r in gen_a.list_runs(10)}.isdisjoint({r["run_id"] for r in gen_b.list_runs(10)})
    assert (a.dbt_target_path / "run_results.json").is_file() and (b.dbt_target_path / "run_results.json").is_file()
    assert not (Settings.default().catalog_path).exists() or _default_has_no_gold()

    # Export from A: a valid datapass.artifact plus bulk Parquet, without recomputation.
    snapshots_before = lake_a.snapshots(1)[0]["snapshot_id"]
    result = exports_a.export("monthly_sales")
    out = Path(result["path"])
    artifact_path = out / result["artifact"]["file"]
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    dpa.validate(artifact)
    jsonschema = pytest.importorskip("jsonschema")
    # Upstream drift (studio-v0.8.1): docs/contracts/artifact.schema.json predates the additive lineage
    # fields that artifact.ts and the Python mirror accept. Check the base contract without them.
    base = {**artifact, "provenance": {k: v for k, v in artifact["provenance"].items()
                                       if k in {"kind", "source", "runId"}}}
    jsonschema.validate(base, json.loads(SCHEMA.read_text(encoding="utf-8")))
    assert lake_a.snapshots(1)[0]["snapshot_id"] == snapshots_before  # no write, no rebuild
    assert artifact["provenance"]["kind"] == "synthetic"
    inputs = {item["id"]: item.get("value") for item in artifact["provenance"]["inputs"]}
    assert inputs["scenario"] == "online-migration" and inputs["seed"] == 7
    run_results = json.loads((a.dbt_target_path / "run_results.json").read_text(encoding="utf-8"))
    assert inputs["dbtInvocation"] == run_results["metadata"]["invocation_id"]
    assert artifact["provenance"]["inputHash"] == dpa.input_hash(artifact["provenance"]["inputs"])
    units = {c["id"]: c.get("unit") for c in artifact["payload"]["columns"]}
    assert units["revenue"] == "USD" and units["gross_margin_rate"] == "ratio"
    assert {r["kind"] for r in artifact["representations"]} >= {"table", "chart", "json"}

    receipt = json.loads((out / "contoso-export.json").read_text(encoding="utf-8"))
    bulk = out / receipt["bulk_data"]["file"]
    assert hashlib.sha256(bulk.read_bytes()).hexdigest() == receipt["bulk_data"]["sha256"]
    full_rows = duckdb.sql(f"select count(*) from read_parquet('{bulk.as_posix()}')").fetchone()[0]
    _, gold_count, _ = lake_a.query("select count(*) from contoso.gold.monthly_sales", 1)
    assert full_rows == gold_count[0][0] == receipt["artifact"]["total_rows"]
    revenue_artifact = round(sum(r["revenue"] for r in artifact["payload"]["rows"]), 2)
    _, gold_revenue, _ = lake_a.query("select round(sum(revenue),2) from contoso.gold.monthly_sales", 1)
    assert receipt["artifact"]["truncated"] is False and revenue_artifact == pytest.approx(float(gold_revenue[0][0]))
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["artifacts"][0]["sha256"] == receipt["artifact"]["sha256"]
    assert exports_a.file(result["export_id"], "contoso-export.json").is_file()
    with pytest.raises(ExportError):
        exports_a.file(result["export_id"], "../../workspace.json")
    assert _services(b)[3].list() == []  # B never sees A's exports

    # Backup A, restore as a new workspace C, and reopen its Gold after "restart".
    backup = registry.backup("workspace-a")
    restored = registry.restore(backup["backup"], "Workspace C")
    # The restored copy must be self-contained: remove A's data files before reading C.
    moved = a.data_path.with_name("moved-away")
    a.data_path.rename(moved)
    config.set_active(None)
    c = WorkspaceRegistry().activate(restored.workspace_id)
    gen_c, lake_c, _, _ = _services(c)
    assert _gold_scenarios(lake_c) == ["online-migration"]
    _, restored_revenue, _ = lake_c.query("select round(sum(revenue),2) from contoso.gold.monthly_sales", 1)
    assert restored_revenue == gold_revenue
    active = gen_c.active_run()
    assert active and gen_c.run_files(str(active["run_id"]), verify_hashes=True)
    moved.rename(a.data_path)
    # Reloading Bronze after the last dbt build makes Gold stale: export must refuse to credit the new run.
    rerun = gen_b.generate("logistics-delays", 1_000, 99)
    lake_b.load_parquet_to_bronze(gen_b.run_files(str(rerun["run_id"]), verify_hashes=True))
    gen_b.mark_bronze_loaded(str(rerun["run_id"]), int(lake_b.snapshots(1)[0]["snapshot_id"]))
    with pytest.raises(ExportError, match="older than the active generator run"):
        _services(b)[3].export("monthly_sales")
    # Restoring never touched A.
    assert _gold_scenarios(lake_a) == ["online-migration"]


def _default_has_no_gold():
    try:
        return "gold" not in {row["schema"] for row in DuckLakeService(Settings.default()).catalog()}
    except Exception:
        return True


def test_switch_gate_waits_for_requests_and_times_out():
    import threading
    from app.main import _WorkspaceGate

    gate = _WorkspaceGate()
    gate.enter()
    assert gate.exclusive(timeout=0.05) is False  # a request is still in flight
    released = threading.Timer(0.1, gate.leave)
    released.start()
    assert gate.exclusive(timeout=5) is True
    entered = threading.Event()
    worker = threading.Thread(target=lambda: (gate.enter(), entered.set()))
    worker.start()
    assert not entered.wait(0.1)  # new requests wait while the switch rebinds
    gate.release()
    assert entered.wait(5)
    gate.leave()
