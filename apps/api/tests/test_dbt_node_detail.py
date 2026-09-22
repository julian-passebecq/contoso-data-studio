import json
from pathlib import Path

import pytest

from app.config import Settings
from app.services.dbt_runner import DbtService


def _project(tmp_path: Path, monkeypatch) -> DbtService:
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))
    dbt = tmp_path / "dbt"
    target = dbt / "target"
    model_dir = dbt / "models" / "silver"
    target.mkdir(parents=True)
    model_dir.mkdir(parents=True)
    (model_dir / "stg_sales.sql").write_text(
        "select * from {{ source('bronze','sales') }}\n",
        encoding="utf-8",
    )

    manifest = {
        "metadata": {"generated_at": "2026-09-22T20:00:00Z"},
        "sources": {
            "source.contoso_data_studio.bronze.sales": {
                "name": "sales",
                "schema": "bronze",
                "database": "contoso",
                "original_file_path": "models/sources.yml",
                "columns": {
                    "sales_key": {"description": "Primary key", "data_type": "BIGINT"}
                },
            }
        },
        "nodes": {
            "model.contoso_data_studio.stg_sales": {
                "name": "stg_sales",
                "schema": "silver",
                "database": "contoso",
                "relation_name": '"contoso"."silver"."stg_sales"',
                "original_file_path": "models/silver/stg_sales.sql",
                "raw_code": "select * from {{ source('bronze','sales') }}",
                "compiled_code": "select * from contoso.bronze.sales",
                "config": {"materialized": "table"},
                "depends_on": {
                    "nodes": ["source.contoso_data_studio.bronze.sales"]
                },
                "columns": {
                    "sales_key": {"description": "Primary key", "data_type": "BIGINT"}
                },
            },
            "model.contoso_data_studio.monthly_sales": {
                "name": "monthly_sales",
                "schema": "gold",
                "database": "contoso",
                "original_file_path": "models/gold/monthly_sales.sql",
                "config": {"materialized": "table"},
                "depends_on": {
                    "nodes": ["model.contoso_data_studio.stg_sales"]
                },
            },
            "test.contoso_data_studio.not_null_stg_sales_sales_key": {
                "name": "not_null_stg_sales_sales_key",
                "column_name": "sales_key",
                "test_metadata": {"name": "not_null"},
                "attached_node": "model.contoso_data_studio.stg_sales",
                "depends_on": {
                    "nodes": ["model.contoso_data_studio.stg_sales"]
                },
            },
        },
    }
    run_results = {
        "metadata": {"generated_at": "2026-09-22T20:00:00Z"},
        "results": [
            {
                "unique_id": "test.contoso_data_studio.not_null_stg_sales_sales_key",
                "status": "pass",
                "failures": 0,
                "execution_time": 0.01,
                "message": None,
            }
        ],
    }
    (target / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (target / "run_results.json").write_text(json.dumps(run_results), encoding="utf-8")
    return DbtService(Settings(workspace=tmp_path / "workspace"))


def test_node_detail_returns_sql_dependencies_tests_and_relation(tmp_path: Path, monkeypatch):
    service = _project(tmp_path, monkeypatch)

    detail = service.node_detail("model.contoso_data_studio.stg_sales")

    assert detail["name"] == "stg_sales"
    assert detail["layer"] == "silver"
    assert detail["materialized"] == "table"
    assert detail["source_code"].startswith("select * from {{ source")
    assert detail["compiled_code"] == "select * from contoso.bronze.sales"
    assert detail["physical_query"] == "select * from contoso.silver.stg_sales limit 100;"
    assert detail["upstream"] == [{
        "id": "source.contoso_data_studio.bronze.sales",
        "name": "sales",
        "layer": "bronze",
        "resource_type": "source",
    }]
    assert detail["downstream"] == [{
        "id": "model.contoso_data_studio.monthly_sales",
        "name": "monthly_sales",
        "layer": "gold",
        "resource_type": "model",
    }]
    assert detail["tests"][0]["test_type"] == "not_null"
    assert detail["tests"][0]["status"] == "pass"
    assert detail["columns"][0] == {
        "name": "sales_key",
        "description": "Primary key",
        "data_type": "BIGINT",
    }


def test_node_detail_supports_sources(tmp_path: Path, monkeypatch):
    service = _project(tmp_path, monkeypatch)

    detail = service.node_detail("source.contoso_data_studio.bronze.sales")

    assert detail["resource_type"] == "source"
    assert detail["layer"] == "bronze"
    assert detail["materialized"] == "source"
    assert detail["physical_query"] == "select * from contoso.bronze.sales limit 100;"
    assert detail["downstream"][0]["name"] == "stg_sales"


def test_node_detail_rejects_unknown_node(tmp_path: Path, monkeypatch):
    service = _project(tmp_path, monkeypatch)

    with pytest.raises(ValueError, match="Unknown dbt node"):
        service.node_detail("model.contoso_data_studio.missing")
