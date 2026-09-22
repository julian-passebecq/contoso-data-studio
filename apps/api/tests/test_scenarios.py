from pathlib import Path

import duckdb
import pytest

from app.config import Settings
from app.services.generator import GeneratorService


def generate(tmp_path: Path, scenario: str, scale: int = 4000) -> tuple[dict, duckdb.DuckDBPyConnection]:
    workspace = tmp_path / scenario
    workspace.mkdir(parents=True)
    manifest = GeneratorService(Settings(workspace=workspace)).generate(scenario, scale, 42)
    con = duckdb.connect(":memory:")
    return manifest, con


@pytest.mark.parametrize(
    "scenario",
    [
        "retail-baseline",
        "online-migration",
        "margin-pressure",
        "logistics-delays",
        "currency-exposure",
    ],
)
def test_all_scenarios_generate_expected_files(tmp_path: Path, scenario: str):
    manifest, con = generate(tmp_path, scenario, scale=500)
    try:
        assert manifest["scenario"] == scenario
        assert manifest["row_counts"]["sales"] == 500
        assert manifest["row_counts"]["currency_exchange"] == 120

        for name in ("customer", "product", "store", "currency_exchange", "sales"):
            path = Path(manifest["files"][name])
            assert path.exists()
            assert con.execute(
                f"select count(*) from read_parquet('{path.as_posix()}')"
            ).fetchone()[0] == manifest["row_counts"][name]

        sales = Path(manifest["files"]["sales"]).as_posix()
        columns = {
            row[0]
            for row in con.execute(
                f"describe select * from read_parquet('{sales}')"
            ).fetchall()
        }
        assert {
            "scenario",
            "delivery_days",
            "currency",
            "exchange_rate_to_usd",
            "net_revenue_local",
            "net_revenue",
        }.issubset(columns)
    finally:
        con.close()


def test_online_migration_moves_channel_share(tmp_path: Path):
    manifest, con = generate(tmp_path, "online-migration")
    try:
        sales = Path(manifest["files"]["sales"]).as_posix()
        rows = con.execute(
            f"""
            select
              extract(year from order_date)::integer as yr,
              avg(case when channel='Online' then 1.0 else 0.0 end) as online_share
            from read_parquet('{sales}')
            group by 1
            order by 1
            """
        ).fetchall()
        shares = dict(rows)
        assert shares[2024] < 0.35
        assert shares[2025] > 0.55
        assert shares[2025] - shares[2024] > 0.30
    finally:
        con.close()


def test_margin_pressure_increases_discount_and_cost(tmp_path: Path):
    manifest, con = generate(tmp_path, "margin-pressure")
    try:
        sales = Path(manifest["files"]["sales"]).as_posix()
        rows = con.execute(
            f"""
            select
              extract(year from order_date)::integer as yr,
              avg(discount_rate) as avg_discount,
              avg(unit_cost) as avg_cost
            from read_parquet('{sales}')
            group by 1
            order by 1
            """
        ).fetchall()
        metrics = {year: (discount, cost) for year, discount, cost in rows}
        assert metrics[2025][0] > metrics[2024][0] + 0.10
        assert metrics[2025][1] > metrics[2024][1] * 1.15
    finally:
        con.close()


def test_logistics_delays_hit_online_channel(tmp_path: Path):
    manifest, con = generate(tmp_path, "logistics-delays")
    try:
        sales = Path(manifest["files"]["sales"]).as_posix()
        rows = con.execute(
            f"""
            select channel, avg(delivery_days)
            from read_parquet('{sales}')
            group by 1
            """
        ).fetchall()
        delays = dict(rows)
        assert delays["Online"] > delays["Store"] + 5
    finally:
        con.close()


def test_currency_exposure_has_wider_fx_range_than_baseline(tmp_path: Path):
    baseline, con = generate(tmp_path, "retail-baseline", scale=500)
    exposure = GeneratorService(Settings(workspace=tmp_path / "currency-exposure-extra")).generate(
        "currency-exposure", 500, 42
    )
    try:
        def fx_range(manifest: dict) -> float:
            path = Path(manifest["files"]["currency_exchange"]).as_posix()
            return con.execute(
                f"select max(exchange_rate_to_usd)-min(exchange_rate_to_usd) "
                f"from read_parquet('{path}') where currency='CHF'"
            ).fetchone()[0]

        assert fx_range(exposure) > fx_range(baseline) * 2
    finally:
        con.close()
