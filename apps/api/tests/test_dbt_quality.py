import json
from pathlib import Path

from app.config import Settings
from app.services.dbt_runner import DbtService


def _write_artifacts(root: Path) -> None:
    target = root / "dbt" / "target"
    target.mkdir(parents=True)

    manifest = {
        "nodes": {
            "model.contoso_data_studio.stg_sales": {
                "name": "stg_sales",
                "original_file_path": "models/silver/stg_sales.sql",
            },
            "model.contoso_data_studio.monthly_sales": {
                "name": "monthly_sales",
                "original_file_path": "models/gold/monthly_sales.sql",
            },
            "test.contoso_data_studio.not_null_stg_sales_sales_key": {
                "name": "not_null_stg_sales_sales_key",
                "column_name": "sales_key",
                "test_metadata": {"name": "not_null"},
                "depends_on": {
                    "nodes": ["model.contoso_data_studio.stg_sales"]
                },
            },
            "test.contoso_data_studio.not_null_monthly_sales_order_month": {
                "name": "not_null_monthly_sales_order_month",
                "column_name": "order_month",
                "test_metadata": {"name": "not_null"},
                "depends_on": {
                    "nodes": ["model.contoso_data_studio.monthly_sales"]
                },
            },
        },
        "sources": {},
    }
    run_results = {
        "metadata": {"generated_at": "2026-09-22T15:00:00Z"},
        "results": [
            {
                "unique_id": "model.contoso_data_studio.stg_sales",
                "status": "success",
                "execution_time": 0.1,
            },
            {
                "unique_id": "test.contoso_data_studio.not_null_stg_sales_sales_key",
                "status": "pass",
                "failures": 0,
                "execution_time": 0.02,
                "message": None,
            },
            {
                "unique_id": "test.contoso_data_studio.not_null_monthly_sales_order_month",
                "status": "fail",
                "failures": 3,
                "execution_time": 0.03,
                "message": "Got 3 results",
            },
        ],
    }
    (target / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (target / "run_results.json").write_text(json.dumps(run_results), encoding="utf-8")


def test_quality_maps_tests_to_layers_and_models(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))
    _write_artifacts(tmp_path)

    service = DbtService(Settings(workspace=tmp_path / "workspace"))
    quality = service.quality()

    assert quality["generated_at"] == "2026-09-22T15:00:00Z"
    assert quality["summary"] == {
        "total": 2,
        "pass": 1,
        "fail": 1,
        "warn": 0,
        "error": 0,
        "skip": 0,
    }
    assert quality["by_layer"]["silver"]["pass"] == 1
    assert quality["by_layer"]["gold"]["fail"] == 1

    failed = quality["tests"][0]
    assert failed["status"] == "fail"
    assert failed["layer"] == "gold"
    assert failed["model"] == "monthly_sales"
    assert failed["column_name"] == "order_month"
    assert failed["failures"] == 3


def test_quality_is_empty_without_dbt_artifacts(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))

    service = DbtService(Settings(workspace=tmp_path / "workspace"))
    quality = service.quality()

    assert quality["summary"]["total"] == 0
    assert quality["tests"] == []
