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


@pytest.mark.parametrize(
    "sql",
    [
        "select 'drop table x' as message",
        "select 'semi;colon' as message",
        'select 1 as "delete"',
        "select 1 -- drop table ignored",
        "select /* delete from x */ 1",
    ],
)
def test_query_policy_ignores_keywords_inside_literals_identifiers_and_comments(
    tmp_path: Path, sql: str
):
    service = DuckLakeService(Settings(workspace=tmp_path))
    policy = __import__("app.services.ducklake", fromlist=["_policy_sql"])._policy_sql(sql)

    assert not __import__("app.services.ducklake", fromlist=["FORBIDDEN_SQL"]).FORBIDDEN_SQL.search(policy)
    assert ";" not in policy
