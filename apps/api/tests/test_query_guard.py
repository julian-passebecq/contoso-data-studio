from pathlib import Path

import pytest

from app.config import Settings
from app.services.ducklake import DuckLakeService


@pytest.mark.parametrize(
    "sql",
    [
        "drop table contoso.bronze.sales",
        "delete from contoso.bronze.sales",
        "create table x as select 1",
        "select 1; select 2",
        "pragma threads=8",
    ],
)
def test_query_workbench_rejects_mutating_or_multiple_statements(tmp_path: Path, sql: str):
    service = DuckLakeService(Settings(workspace=tmp_path))

    with pytest.raises(ValueError):
        service.query(sql, 100)


def test_query_workbench_rejects_empty_sql(tmp_path: Path):
    service = DuckLakeService(Settings(workspace=tmp_path))

    with pytest.raises(ValueError, match="SQL is empty"):
        service.query("   ", 100)


def test_time_travel_rejects_unknown_schema_without_opening_catalog(tmp_path: Path):
    service = DuckLakeService(Settings(workspace=tmp_path))

    with pytest.raises(ValueError, match="Schema must be"):
        service.preview_at_snapshot("private", "sales", 1, 100)


def test_time_travel_rejects_negative_snapshot_without_opening_catalog(tmp_path: Path):
    service = DuckLakeService(Settings(workspace=tmp_path))

    with pytest.raises(ValueError, match="non-negative"):
        service.preview_at_snapshot("bronze", "sales", -1, 100)
