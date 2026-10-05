import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.services.ducklake import DuckLakeService
from app.services.generator import GeneratorService
from app.services.projects import ProjectBusyError, ProjectService


class BuildStub:
    def __init__(self, root):
        self.root, self.calls, self.ok, self.fail = root, 0, True, 0

    def run(self, command):
        assert command == "build"
        self.calls += 1
        target = self.root / "target"
        target.mkdir(exist_ok=True)
        (target / "run_results.json").write_text(json.dumps({"build": self.calls}))
        return {"ok": self.ok, "output": "build diagnostic"}

    def quality(self):
        return {"summary": {"total": 25, "fail": self.fail, "error": 0}}


def service(monkeypatch, tmp_path):
    root = Path(__file__).resolve().parents[3]
    workspace = tmp_path / "workspace"
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(root))
    monkeypatch.setenv("CONTOSO_WORKSPACE", str(workspace))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_CATALOG", str(workspace / "lake.sqlite"))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_DATA_PATH", str(workspace / "lake.files"))
    settings = Settings.load()
    # Keep build artefacts isolated from the running desktop app.
    settings.dbt_path.mkdir(exist_ok=True)
    generator = GeneratorService(settings)
    dbt = BuildStub(tmp_path)

    class State:
        def state(self):
            active = generator.active_run()
            return {"active_run": active, "active_scenario": active["scenario"] if active else None, "ready": bool(active)}

    projects = ProjectService(generator, DuckLakeService(settings), dbt, State())
    # A minimal isolated source fingerprint is sufficient to test receipt invalidation.
    monkeypatch.setattr(projects, "_signature", lambda: json.dumps({"active": generator.active_run(), "build": dbt.calls}, sort_keys=True))
    return projects, generator, dbt


def test_open_reuses_saved_runs_and_resumes_only_current_build(monkeypatch, tmp_path):
    projects, generator, dbt = service(monkeypatch, tmp_path)
    first = projects.open("foil-energy-risk")
    first_id = first["state"]["active_run"]["run_id"]
    assert first["generated"] and not first["resumed"] and dbt.calls == 1
    resumed = projects.open("foil-energy-risk")
    assert resumed["resumed"] and dbt.calls == 1
    projects.open("retail-baseline")
    returned = projects.open("foil-energy-risk")
    assert not returned["generated"] and not returned["resumed"] and dbt.calls == 3
    assert returned["state"]["active_run"]["run_id"] == first_id
    assert len(generator.list_runs()) == 2


def test_open_rejects_tampered_data_and_failed_builds(monkeypatch, tmp_path):
    projects, generator, dbt = service(monkeypatch, tmp_path)
    projects.open("foil-sensitivity")
    dbt.fail = 1
    with pytest.raises(RuntimeError, match="quality"):
        projects.open("foil-sensitivity")
    dbt.fail = 0
    dbt.ok = False
    projects.receipt.unlink()
    with pytest.raises(RuntimeError, match="build failed"):
        projects.open("foil-sensitivity")
    dbt.ok = True
    run = generator.active_run()
    path = generator.run_files(run["run_id"])["foil_trials"]
    with path.open("ab") as handle:
        handle.write(b"tampered")
    with pytest.raises(ValueError, match="hash mismatch"):
        projects.open("foil-sensitivity")


def test_open_unknown_or_concurrent_project_is_rejected(monkeypatch, tmp_path):
    projects, _, _ = service(monkeypatch, tmp_path)
    with pytest.raises(ValueError, match="Unknown"):
        projects.open("not-a-project")
    projects._lock.acquire()
    try:
        with pytest.raises(ProjectBusyError):
            projects.open("foil-energy-risk")
    finally:
        projects._lock.release()


def test_readiness_receipt_changes_with_model_results_and_active_snapshot(tmp_path):
    dbt_root = tmp_path / "dbt"
    (dbt_root / "models").mkdir(parents=True)
    (dbt_root / "target").mkdir()
    active = {"run_id": "run-1", "active_snapshot_id": 10}
    generator = SimpleNamespace(settings=SimpleNamespace(workspace=tmp_path, dbt_path=dbt_root), active_run=lambda: active)
    projects = ProjectService(generator, None, None, None)
    before = projects._signature()
    (dbt_root / "models/test.sql").write_text("select 1")
    model_changed = projects._signature()
    assert model_changed != before
    (dbt_root / "target/run_results.json").write_text('{"status":"pass"}')
    results_changed = projects._signature()
    assert results_changed != model_changed
    active["active_snapshot_id"] = 11
    assert projects._signature() != results_changed
