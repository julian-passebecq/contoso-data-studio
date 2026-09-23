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
                "schema": "silver",
                "database": "contoso",
                "config": {"materialized": "table"},
                "depends_on": {
                    "nodes": ["source.contoso_data_studio.bronze.sales"]
                },
            },
            "model.contoso_data_studio.monthly_sales": {
                "name": "monthly_sales",
                "original_file_path": "models/gold/monthly_sales.sql",
                "schema": "gold",
                "database": "contoso",
                "config": {"materialized": "table"},
                "depends_on": {
                    "nodes": ["model.contoso_data_studio.stg_sales"]
                },
            },
            "test.contoso_data_studio.relationships_sales_customer_key": {
                "name": "relationships_sales_customer_key",
                "column_name": "customer_key",
                "test_metadata": {"name": "relationships"},
                "attached_node": "source.contoso_data_studio.bronze.sales",
                "depends_on": {
                    "nodes": [
                        "source.contoso_data_studio.bronze.customer",
                        "source.contoso_data_studio.bronze.sales"
                    ]
                },
            },
            "test.contoso_data_studio.not_null_source_sales_sales_key": {
                "name": "not_null_source_sales_sales_key",
                "column_name": "sales_key",
                "test_metadata": {"name": "not_null"},
                "depends_on": {
                    "nodes": ["source.contoso_data_studio.bronze.sales"]
                },
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
        "sources": {
            "source.contoso_data_studio.bronze.sales": {
                "name": "sales",
                "source_name": "bronze",
                "schema": "bronze",
                "database": "contoso",
                "original_file_path": "models/sources.yml",
            },
            "source.contoso_data_studio.bronze.customer": {
                "name": "customer",
                "source_name": "bronze",
                "schema": "bronze",
                "database": "contoso",
                "original_file_path": "models/sources.yml",
            },
        },
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
                "unique_id": "test.contoso_data_studio.relationships_sales_customer_key",
                "status": "pass",
                "failures": 0,
                "execution_time": 0.01,
                "message": None,
            },
            {
                "unique_id": "test.contoso_data_studio.not_null_source_sales_sales_key",
                "status": "pass",
                "failures": 0,
                "execution_time": 0.01,
                "message": None,
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
        "total": 4,
        "pass": 3,
        "fail": 1,
        "warn": 0,
        "error": 0,
        "skip": 0,
    }
    assert quality["by_layer"]["bronze"]["pass"] == 2
    assert quality["by_layer"]["silver"]["pass"] == 1
    assert quality["by_layer"]["gold"]["fail"] == 1

    failed = quality["tests"][0]
    assert failed["status"] == "fail"
    assert failed["layer"] == "gold"
    assert failed["model"] == "monthly_sales"
    assert failed["column_name"] == "order_month"
    assert failed["failures"] == 3

    relationship = next(
        test for test in quality["tests"]
        if test["test_type"] == "relationships"
    )
    assert relationship["layer"] == "bronze"
    assert relationship["model"] == "sales"


def test_quality_is_empty_without_dbt_artifacts(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))

    service = DbtService(Settings(workspace=tmp_path / "workspace"))
    quality = service.quality()

    assert quality["summary"]["total"] == 0
    assert quality["tests"] == []



def test_lineage_maps_manifest_sources_models_and_edges(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))
    _write_artifacts(tmp_path)

    service = DbtService(Settings(workspace=tmp_path / "workspace"))
    lineage = service.lineage()

    nodes = {node["id"]: node for node in lineage["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in lineage["edges"]}

    assert nodes["source.contoso_data_studio.bronze.sales"]["layer"] == "bronze"
    assert nodes["model.contoso_data_studio.stg_sales"]["layer"] == "silver"
    assert nodes["model.contoso_data_studio.monthly_sales"]["layer"] == "gold"
    assert nodes["model.contoso_data_studio.monthly_sales"]["materialized"] == "table"

    assert (
        "source.contoso_data_studio.bronze.sales",
        "model.contoso_data_studio.stg_sales",
    ) in edges
    assert (
        "model.contoso_data_studio.stg_sales",
        "model.contoso_data_studio.monthly_sales",
    ) in edges
    assert all(not source.startswith("test.") for source, _ in edges)


def test_lineage_is_empty_without_manifest(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))

    service = DbtService(Settings(workspace=tmp_path / "workspace"))
    lineage = service.lineage()

    assert lineage["nodes"] == []
    assert lineage["edges"] == []
