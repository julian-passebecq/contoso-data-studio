import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.services.dbt_runner import DbtService


def _service(tmp_path: Path, monkeypatch) -> DbtService:
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))
    model_dir = tmp_path / "dbt" / "models" / "silver"
    model_dir.mkdir(parents=True)
    (model_dir / "stg_sales.sql").write_text("select 1", encoding="utf-8")
    app_dir = tmp_path / "dbt" / "models" / "fabric_apps" / "gold"
    app_dir.mkdir(parents=True)
    (app_dir / "forecast_vs_actual.sql").write_text(
        "{{ config(enabled=var('fabric_apps_enabled', false)) }} select 1", encoding="utf-8"
    )
    service = DbtService(Settings(workspace=tmp_path / "workspace"))
    monkeypatch.setattr(DbtService, "_foil_active", lambda self: False)
    monkeypatch.setattr("app.services.dbt_runner.shutil.which", lambda _: "/usr/bin/dbt")
    return service


def _write_run_results(service: DbtService, generated_at: str, node_ids: list[str]) -> None:
    target = service.settings.dbt_target_path
    target.mkdir(parents=True, exist_ok=True)
    (target / "run_results.json").write_text(json.dumps({
        "metadata": {"generated_at": generated_at},
        "elapsed_time": 0.1,
        "results": [{"unique_id": node, "status": "success", "execution_time": 0.1} for node in node_ids],
    }), encoding="utf-8")


def _fake_dbt(service: DbtService, monkeypatch, node_ids: list[str] | None, returncode: int = 0) -> dict:
    """node_ids=None: dbt writes no run_results at all."""
    captured: dict = {"calls": 0}

    def fake_run(args, **kwargs):
        captured["calls"] += 1
        captured["args"] = args
        if node_ids is not None:
            _write_run_results(service, f"2026-10-12T00:00:0{captured['calls']}Z", node_ids)
        return SimpleNamespace(returncode=returncode, stdout="ok", stderr="")

    monkeypatch.setattr("app.services.dbt_runner.subprocess.run", fake_run)
    return captured


def test_selected_model_run_adds_validated_dbt_select_args(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    captured = _fake_dbt(service, monkeypatch, ["model.contoso_data_studio.stg_sales"])

    result = service.run("build", "stg_sales")

    assert result["ok"] is True
    assert result["warning"] is None
    assert result["nodes_executed"] == 1
    assert result["selector"] == "stg_sales"
    assert captured["args"][-2:] == ["--select", "stg_sales"]
    assert "--vars" not in captured["args"]


def test_selected_model_run_rejects_unknown_selector(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)

    with pytest.raises(ValueError, match="Unknown dbt model selector"):
        service.run("test", "missing_model")


def test_parse_rejects_model_selector(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)

    with pytest.raises(ValueError, match="does not accept a model selector"):
        service.run("parse", "stg_sales")


def test_build_that_executes_zero_nodes_is_not_reported_as_success(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    _fake_dbt(service, monkeypatch, [])  # dbt "Nothing to do": exit 0, empty run_results

    result = service.run("build", "stg_sales")

    assert result["exit_code"] == 0
    assert result["ok"] is False
    assert result["nodes_executed"] == 0
    assert "executed 0 nodes" in result["warning"]
    assert "--select stg_sales" in result["warning"]


def test_stale_run_results_are_not_shown_as_the_new_run(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    _write_run_results(service, "2026-01-01T00:00:00Z", ["model.contoso_data_studio.stg_sales"])
    _fake_dbt(service, monkeypatch, None)  # dbt wrote nothing new

    result = service.run("build", "stg_sales")

    assert result["ok"] is False
    assert result["nodes_executed"] == 0
    assert result["run_results"]["results"] == []


def test_app_lab_model_is_listed_as_app_lab(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)

    models = {model["name"]: model for model in service.status()["models"]}

    assert models["forecast_vs_actual"].get("app_lab") is True
    assert "app_lab" not in models["stg_sales"]


def test_app_lab_model_refused_when_lab_not_enabled(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    captured = _fake_dbt(service, monkeypatch, [])

    with pytest.raises(ValueError, match="lab is not enabled"):
        service.run("build", "forecast_vs_actual")
    assert captured["calls"] == 0


def test_app_lab_model_build_passes_fabric_apps_var(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    store = service.settings.workspace / "fabric-apps" / "sales-forecasting.sqlite"
    store.parent.mkdir(parents=True)
    store.write_bytes(b"")
    captured = _fake_dbt(service, monkeypatch, ["model.contoso_data_studio.forecast_vs_actual"])

    result = service.run("build", "forecast_vs_actual")

    assert result["ok"] is True
    args = captured["args"]
    assert args[args.index("--select") + 1] == "forecast_vs_actual"
    assert json.loads(args[args.index("--vars") + 1]) == {"fabric_apps_enabled": True}


def test_foil_build_keeps_foil_var_and_path_selector(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    monkeypatch.setattr(DbtService, "_foil_active", lambda self: True)
    captured = _fake_dbt(service, monkeypatch, ["model.contoso_data_studio.foil_cashflows"])

    result = service.run("build")

    assert result["ok"] is True
    args = captured["args"]
    assert args[args.index("--select") + 1] == "path:models/foil"
    assert json.loads(args[args.index("--vars") + 1]) == {"foil_enabled": True}
