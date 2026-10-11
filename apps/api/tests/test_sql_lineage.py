"""Runtime lineage of Query workbench SQL, resolved by DuckDB (parser + bound EXPLAIN plan)."""
from pathlib import Path

import pytest

from app.config import Settings
from app.models import QueryResult
from app.services import sql_lineage
from app.services.ducklake import DuckLakeService

DBT_NODES = [
    {"id": "source.contoso.bronze.sales", "name": "sales", "layer": "bronze", "schema": "bronze"},
    {"id": "model.contoso.stg_sales", "name": "stg_sales", "layer": "silver", "schema": "silver"},
    {"id": "model.contoso.monthly_sales", "name": "monthly_sales", "layer": "gold", "schema": "gold"},
]


@pytest.fixture(scope="module")
def lake(tmp_path_factory: pytest.TempPathFactory) -> DuckLakeService:
    service = DuckLakeService(Settings(workspace=tmp_path_factory.mktemp("lineage")))
    service.bootstrap()
    with service.connection() as con:
        con.execute(
            "CREATE TABLE contoso.bronze.sales AS "
            "SELECT 1 AS order_id, 'web' AS channel, 10.0 AS net_revenue, 'x' AS comment"
        )
        con.execute(
            "CREATE TABLE contoso.silver.stg_sales AS "
            "SELECT 1 AS order_id, 'web' AS channel, 10.0 AS net_revenue"
        )
        con.execute(
            "CREATE TABLE contoso.gold.monthly_sales AS "
            "SELECT '2026-01' AS order_month, 'web' AS channel, 10.0 AS revenue, 4.0 AS gross_margin"
        )
    return service


def lineage_of(lake: DuckLakeService, sql: str) -> dict:
    with lake.connection(read_only=True) as con:
        return sql_lineage.resolve(con, sql, DBT_NODES)


def by_table(lineage: dict) -> dict[str, dict]:
    return {f"{r['schema']}.{r['table']}": r for r in lineage["relations"]}


def test_gold_table_resolves_layer_model_and_read_columns(lake: DuckLakeService):
    lineage = lineage_of(lake, "select channel, revenue from contoso.gold.monthly_sales where gross_margin > 0")

    assert lineage["method"] == "duckdb_parser+explain"
    assert lineage["confidence"] == "verified"
    [relation] = lineage["relations"]
    assert relation["catalog"] == "contoso"
    assert relation["layer"] == "gold"
    assert relation["dbt_model"] == "model.contoso.monthly_sales"
    # the filter column is read too; the unused order_month is not
    assert sorted(relation["columns"]) == ["channel", "gross_margin", "revenue"]
    assert relation["confidence"] == "verified"


def test_join_of_two_layers_attributes_columns_per_relation(lake: DuckLakeService):
    lineage = lineage_of(
        lake,
        "select s.order_id, b.comment from contoso.silver.stg_sales s "
        "join contoso.bronze.sales b on b.order_id = s.order_id",
    )

    relations = by_table(lineage)
    assert set(relations) == {"silver.stg_sales", "bronze.sales"}
    assert relations["silver.stg_sales"]["layer"] == "silver"
    assert relations["silver.stg_sales"]["dbt_model"] == "model.contoso.stg_sales"
    assert relations["silver.stg_sales"]["columns"] == ["order_id"]
    assert relations["bronze.sales"]["dbt_model"] == "source.contoso.bronze.sales"
    assert sorted(relations["bronze.sales"]["columns"]) == ["comment", "order_id"]
    assert lineage["confidence"] == "verified"


def test_cte_names_are_not_relations(lake: DuckLakeService):
    lineage = lineage_of(
        lake,
        "with monthly as (select order_month, revenue from contoso.gold.monthly_sales) "
        "select order_month, sum(revenue) from monthly group by 1",
    )

    assert list(by_table(lineage)) == ["gold.monthly_sales"]
    assert sorted(lineage["relations"][0]["columns"]) == ["order_month", "revenue"]
    assert lineage["confidence"] == "verified"


def test_unknown_table_is_listed_unresolved_never_guessed(lake: DuckLakeService):
    lineage = lineage_of(lake, "select * from contoso.gold.does_not_exist")

    [relation] = lineage["relations"]
    assert relation["table"] == "does_not_exist"
    assert relation["confidence"] == "unresolved"
    assert relation["columns"] == []
    assert relation["dbt_model"] is None
    assert lineage["confidence"] == "unresolved"
    assert lineage["method"] == "duckdb_parser"


def test_other_catalog_and_table_functions_are_unresolved(lake: DuckLakeService):
    lineage = lineage_of(lake, "select * from range(3)")

    [relation] = lineage["relations"]
    assert relation["table"] == "range"
    assert relation["confidence"] == "unresolved"
    assert lineage["confidence"] == "unresolved"


def test_time_travel_statement_keeps_at_clause(lake: DuckLakeService):
    snapshot = lake.snapshots(1)[0]["snapshot_id"]
    lineage = lineage_of(
        lake, f"select channel from contoso.gold.monthly_sales at (version => {snapshot})"
    )

    [relation] = lineage["relations"]
    assert relation["at"] == [{"unit": "VERSION", "value": snapshot}]
    assert relation["columns"] == ["channel"]
    assert relation["confidence"] == "verified"


def test_count_star_keeps_the_relation(lake: DuckLakeService):
    lineage = lineage_of(lake, "select count(*) from contoso.bronze.sales")

    [relation] = lineage["relations"]
    assert relation["layer"] == "bronze"
    assert relation["confidence"] == "verified"


def test_same_table_name_in_two_relations_is_inferred_without_columns(lake: DuckLakeService):
    lineage = lineage_of(
        lake,
        "select a.channel from contoso.bronze.sales a join contoso.bronze.sales b using (order_id)",
    )

    [relation] = lineage["relations"]
    assert relation["confidence"] == "verified"

    with lake.connection() as con:
        con.execute("CREATE TABLE contoso.silver.sales AS SELECT 1 AS order_id")
    try:
        lineage = lineage_of(
            lake, "select b.channel from contoso.bronze.sales b join contoso.silver.sales s using (order_id)"
        )
        relations = by_table(lineage)
        assert {r["confidence"] for r in relations.values()} == {"inferred"}
        assert all(r["columns"] == [] for r in relations.values())
        assert lineage["confidence"] == "inferred"
    finally:
        with lake.connection() as con:
            con.execute("DROP TABLE contoso.silver.sales")


def test_query_with_lineage_keeps_result_and_adds_lineage(lake: DuckLakeService):
    columns, rows, truncated, lineage = lake.query_with_lineage(
        "select channel from contoso.gold.monthly_sales;", 10, DBT_NODES
    )

    assert (columns, rows, truncated) == (["channel"], [["web"]], False)
    assert lake.query("select channel from contoso.gold.monthly_sales", 10) == (columns, rows, truncated)
    result = QueryResult(columns=columns, rows=rows, row_count=1, truncated=truncated, lineage=lineage)
    dumped = result.model_dump(by_alias=True)
    assert dumped["lineage"]["relations"][0]["schema"] == "gold"
    assert dumped["lineage"]["relations"][0]["dbt_model"] == "model.contoso.monthly_sales"


def test_show_statement_has_no_lineage_but_still_runs(lake: DuckLakeService):
    columns, _, _, lineage = lake.query_with_lineage("show tables", 10, DBT_NODES)

    assert lineage["relations"] == []
    assert lineage["confidence"] == "unresolved"
    assert lineage["method"] == "none"


def test_query_result_stays_backward_compatible():
    assert QueryResult(columns=[], rows=[], row_count=0, truncated=False).lineage is None


def test_default_disabled_optimizers_restored(lake: DuckLakeService, tmp_path: Path):
    with lake.connection(read_only=True) as con:
        before = con.execute("SELECT current_setting('disabled_optimizers')").fetchone()[0]
        sql_lineage.resolve(con, "select 1", DBT_NODES)
        after = con.execute("SELECT current_setting('disabled_optimizers')").fetchone()[0]
    assert before == after
