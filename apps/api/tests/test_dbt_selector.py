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
    return DbtService(Settings(workspace=tmp_path / "workspace"))


def test_selected_model_run_adds_validated_dbt_select_args(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    monkeypatch.setattr("app.services.dbt_runner.shutil.which", lambda _: "/usr/bin/dbt")
    captured = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr("app.services.dbt_runner.subprocess.run", fake_run)

    result = service.run("build", "stg_sales")

    assert result["ok"] is True
    assert result["selector"] == "stg_sales"
    assert captured["args"][-2:] == ["--select", "stg_sales"]


def test_selected_model_run_rejects_unknown_selector(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    monkeypatch.setattr("app.services.dbt_runner.shutil.which", lambda _: "/usr/bin/dbt")

    with pytest.raises(ValueError, match="Unknown dbt model selector"):
        service.run("test", "missing_model")


def test_parse_rejects_model_selector(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    monkeypatch.setattr("app.services.dbt_runner.shutil.which", lambda _: "/usr/bin/dbt")

    with pytest.raises(ValueError, match="does not accept a model selector"):
        service.run("parse", "stg_sales")
