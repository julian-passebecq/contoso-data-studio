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
