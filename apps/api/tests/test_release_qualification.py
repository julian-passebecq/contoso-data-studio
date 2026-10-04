from pathlib import Path

from app.config import Settings
from app.services.charts import ChartsService
from app.services.dbt_runner import DbtService
from app.services.ducklake import DuckLakeService
from app.services.explorer import ExplorerService
from app.services.generator import GeneratorService
from app.services.workspace_state import WorkspaceStateService


def _settings(monkeypatch, tmp_path: Path) -> Settings:
    project_root = Path(__file__).resolve().parents[3]
    workspace = tmp_path / "workspace"
    catalog = workspace / "contoso.ducklake.sqlite"
    data_path = workspace / "contoso.ducklake.files"

    monkeypatch.setenv("CONTOSO_WORKSPACE", str(workspace))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_CATALOG", str(catalog))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_DATA_PATH", str(data_path))
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(project_root))
    return Settings.load()


def _generate_and_activate(
    generator: GeneratorService,
    ducklake: DuckLakeService,
    scenario: str,
    scale: int = 10_000,
    seed: int = 42,
) -> dict:
    manifest = generator.generate(scenario, scale, seed)
    run_id = str(manifest["run_id"])
    files = generator.run_files(run_id, verify_hashes=True)
    ducklake.load_parquet_to_bronze(files)
    snapshot = ducklake.snapshots(1)
    snapshot_id = int(snapshot[0]["snapshot_id"]) if snapshot else None
    generator.mark_bronze_loaded(run_id, snapshot_id)
    return generator.get_run(run_id)


def test_v1_guided_project_release_smoke(monkeypatch, tmp_path: Path):
    """Qualify the documented v1 guided-project flow on a clean workspace."""
    settings = _settings(monkeypatch, tmp_path)
    generator = GeneratorService(settings)
    ducklake = DuckLakeService(settings)
    explorer = ExplorerService(settings)
    dbt = DbtService(settings)
    charts = ChartsService(settings)
    state = WorkspaceStateService(generator, ducklake, dbt)

    # 1) Generate the exact beginner project recipe and load Bronze.
    retail = _generate_and_activate(generator, ducklake, "retail-baseline")
    assert retail["scenario"] == "retail-baseline"
    assert retail["seed"] == 42
    assert retail["scale"] == 10_000
    assert retail["row_counts"]["sales"] == 10_000
    assert retail["is_active"] is True
    assert retail["integrity_tracked"] is True

    # 2) Exercise the Parquet Explorer against the active run's sales artifact.
    sales_path = str(retail["files"]["sales"]["path"])
    inspected = explorer.inspect(sales_path, limit=25)
    assert inspected["metadata"]["format"] == "Parquet"
    assert inspected["metadata"]["row_count"] == 10_000
    assert inspected["metadata"]["num_row_groups"] >= 1
    assert len(inspected["rows"]) == 25
    assert {
        "sales_key",
        "order_date",
        "customer_key",
        "product_key",
        "store_key",
        "scenario",
        "net_revenue",
    }.issubset(set(inspected["columns"]))

    # 3) Confirm the generated five-table Bronze contract.
    bronze = {
        row["name"]
        for row in ducklake.catalog()
        if row["schema"] == "bronze"
    }
    assert bronze == {
        "customer",
        "currency_exchange",
        "product",
        "sales",
        "store",
    }

    # 4) Build dbt Silver + Gold exactly as the guided project does.
    build = dbt.run("build")
    assert build["ok"] is True, build["output"]

    # 5) Confirm analytical layers and quality/lineage artifacts.
    catalog = ducklake.catalog()
    silver = {row["name"] for row in catalog if row["schema"] == "silver"}
    gold = {row["name"] for row in catalog if row["schema"] == "gold"}
    assert "stg_sales" in silver
    assert {
        "monthly_sales",
        "channel_performance",
        "delivery_metrics",
        "currency_exposure",
        "product_performance",
        "store_performance",
    }.issubset(gold)

    quality = dbt.quality()
    assert quality["summary"]["total"] >= 30
    assert quality["summary"]["fail"] == 0
    assert quality["summary"]["error"] == 0

    lineage = dbt.lineage()
    assert lineage["nodes"]
    assert lineage["edges"]

    # 6) Run the beginner project's representative Gold query.
    columns, rows, truncated = ducklake.query(
        """
        select
          store_country as country,
          round(sum(revenue), 2) as revenue,
          round(sum(gross_margin), 2) as gross_margin,
          round(sum(gross_margin) / nullif(sum(revenue), 0), 4) as margin_rate
        from contoso.gold.store_performance
        group by 1
        order by revenue desc
        """,
        100,
    )
    assert columns == ["country", "revenue", "gross_margin", "margin_rate"]
    assert rows
    assert truncated is False

    # 7) Check the Charts contract and the complete project readiness projection.
    board = charts.board("executive-sales.yml")
    assert board["queries"]
    assert board["charts"]

    ready = state.state()
    assert ready["active_scenario"] == "retail-baseline"
    assert ready["gold_current"] is True
    assert ready["ready"] is True
    assert all(ready["layers"][layer] > 0 for layer in ("bronze", "silver", "gold"))

    # 8) Explicitly qualify stale-state protection: switching the active
    # scenario must invalidate old Gold until dbt is rebuilt for that scenario.
    margin = _generate_and_activate(generator, ducklake, "margin-pressure")
    assert margin["scenario"] == "margin-pressure"
    stale = state.state()
    assert stale["active_scenario"] == "margin-pressure"
    assert stale["gold_current"] is False
    assert stale["ready"] is False

    rebuilt = dbt.run("build")
    assert rebuilt["ok"] is True, rebuilt["output"]

    refreshed = state.state()
    assert refreshed["active_scenario"] == "margin-pressure"
    assert refreshed["gold_scenarios"] == ["margin-pressure"]
    assert refreshed["gold_current"] is True
    assert refreshed["ready"] is True
