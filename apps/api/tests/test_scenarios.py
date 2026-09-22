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



def test_run_detail_and_files_are_reproducible(tmp_path: Path):
    workspace = tmp_path / "workspace"
    service = GeneratorService(Settings(workspace=workspace))
    manifest = service.generate("retail-baseline", 500, 123)

    detail = service.get_run(str(manifest["run_id"]))
    files = service.run_files(str(manifest["run_id"]))

    assert detail["scenario"] == "retail-baseline"
    assert detail["seed"] == 123
    assert detail["scale"] == 500
    assert detail["row_counts"]["sales"] == 500
    assert set(files) == {"customer", "product", "store", "currency_exchange", "sales"}
    assert all(path.exists() for path in files.values())
    assert detail["integrity_tracked"] is True
    assert all(file_info["sha256"] for file_info in detail["files"].values())
    service.run_files(str(manifest["run_id"]), verify_hashes=True)
    assert all(
        str(file_info["path"]).startswith("staging/")
        for file_info in detail["files"].values()
    )


@pytest.mark.parametrize("run_id", ["../escape", "nested/run", ".", "..", ""])
def test_run_lookup_rejects_invalid_ids(tmp_path: Path, run_id: str):
    service = GeneratorService(Settings(workspace=tmp_path))

    with pytest.raises(ValueError, match="Invalid run id"):
        service.get_run(run_id)


def test_run_files_reject_manifest_escape(tmp_path: Path):
    workspace = tmp_path / "workspace"
    service = GeneratorService(Settings(workspace=workspace))
    manifest = service.generate("retail-baseline", 500, 42)
    run_id = str(manifest["run_id"])
    manifest_path = workspace / "staging" / run_id / "manifest.json"

    import json

    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    payload["files"]["sales"] = str(tmp_path / "outside.parquet")
    manifest_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="run directory"):
        service.run_files(run_id)



def test_mark_bronze_loaded_tracks_active_run_and_snapshot(tmp_path: Path):
    workspace = tmp_path / "workspace"
    service = GeneratorService(Settings(workspace=workspace))
    first = service.generate("retail-baseline", 500, 1)
    second = service.generate("online-migration", 500, 2)

    service.mark_bronze_loaded(str(first["run_id"]), 11)
    first_detail = service.get_run(str(first["run_id"]))
    assert first_detail["is_active"] is True
    assert first_detail["active_snapshot_id"] == 11

    service.mark_bronze_loaded(str(second["run_id"]), 22)
    first_detail = service.get_run(str(first["run_id"]))
    second_detail = service.get_run(str(second["run_id"]))
    active = service.active_run()

    assert first_detail["is_active"] is False
    assert second_detail["is_active"] is True
    assert second_detail["active_snapshot_id"] == 22
    assert active is not None
    assert active["run_id"] == second["run_id"]
    assert active["active_snapshot_id"] == 22

    ledger = service.list_runs(10)
    active_rows = [run for run in ledger if run["is_active"]]
    assert len(active_rows) == 1
    assert active_rows[0]["run_id"] == second["run_id"]



def test_run_hash_verification_rejects_tampered_parquet(tmp_path: Path):
    workspace = tmp_path / "workspace"
    service = GeneratorService(Settings(workspace=workspace))
    manifest = service.generate("retail-baseline", 500, 42)
    run_id = str(manifest["run_id"])
    sales = service.run_files(run_id)["sales"]

    with sales.open("ab") as handle:
        handle.write(b"tampered")

    with pytest.raises(ValueError, match="hash mismatch: sales"):
        service.run_files(run_id, verify_hashes=True)


def test_compare_runs_detects_same_parameters_and_exact_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    service = GeneratorService(Settings(workspace=workspace))
    first = service.generate("retail-baseline", 500, 77)
    second = service.generate("retail-baseline", 500, 77)

    comparison = service.compare_runs(str(first["run_id"]), str(second["run_id"]))

    assert comparison["same_parameters"] is True
    assert comparison["parameter_changes"] == {}
    assert comparison["row_count_changes"] == {}
    assert comparison["all_hashes_available"] is True
    assert comparison["exact_files_equal"] is True
    assert all(
        item["same_hash"] is True
        for item in comparison["files"].values()
    )


def test_compare_runs_detects_seed_and_scale_changes(tmp_path: Path):
    workspace = tmp_path / "workspace"
    service = GeneratorService(Settings(workspace=workspace))
    first = service.generate("retail-baseline", 500, 1)
    second = service.generate("retail-baseline", 700, 2)

    comparison = service.compare_runs(str(first["run_id"]), str(second["run_id"]))

    assert comparison["same_parameters"] is False
    assert comparison["parameter_changes"]["seed"] == {"base": 1, "target": 2}
    assert comparison["parameter_changes"]["scale"] == {"base": 500, "target": 700}
    assert comparison["row_count_changes"]["sales"]["delta"] == 200
    assert comparison["exact_files_equal"] is False


def test_compare_runs_rejects_same_run(tmp_path: Path):
    workspace = tmp_path / "workspace"
    service = GeneratorService(Settings(workspace=workspace))
    manifest = service.generate("retail-baseline", 500, 1)
    run_id = str(manifest["run_id"])

    with pytest.raises(ValueError, match="two different runs"):
        service.compare_runs(run_id, run_id)
