"""Optional retail Gold -> app read (GOLD-MAPPING.md section 3): configured slice, labelled copy, Gold untouched."""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from app.config import Settings
from app.services.dbt_runner import DbtService
from app.services.fabric_apps import FabricAppLab, mapping, set_lab
from app.services.fabric_apps.model import load_model
from app.services.fabric_apps.retail import read_retail_actuals, retail_actuals_sql
from app.services.fabric_apps.store import DEPARTMENTS
from app.services.generator import GeneratorService

ROOT = Path(__file__).resolve().parents[3]
BASE = "/api/fabric-apps/sales-forecasting"
ANA = {"X-Local-User": "u-ana"}  # finance, NORD
EVA = {"X-Local-User": "u-eva"}  # executive
GOLD_SQL = ROOT / f"dbt/models/gold/{mapping.RETAIL_GOLD_MODEL}.sql"


def _generator_countries() -> list[str]:
    source = (ROOT / "apps/api/app/services/generator.py").read_text(encoding="utf-8")
    store_block = source[source.index("AS store_name") :]
    return re.findall(r"'([^']+)'", re.search(r"\[([^\]]+)\]\[1\+\(i%5\)\] AS country", store_block).group(1))


@pytest.fixture()
def lab(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTOSO_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_CATALOG", str(tmp_path / "workspace" / "lake.sqlite"))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_DATA_PATH", str(tmp_path / "workspace" / "lake.files"))
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(ROOT))
    monkeypatch.delenv(mapping.RETAIL_GOLD_TO_APP_ENV, raising=False)
    instance = FabricAppLab(Settings.load(), start_worker=False, gold_auto=False)
    set_lab(instance)
    yield instance
    set_lab(None)


@pytest.fixture()
def client(lab):
    from app.main import app

    return TestClient(app)


GOLD_ROWS = [
    # scenario, order_month, channel, store_country, sales_lines, revenue
    ("retail-baseline", "2025-01-01", "Online", "France", 3, 100.50),
    ("retail-baseline", "2025-01-01", "Online", "Norway", 1, 20.00),
    ("retail-baseline", "2025-01-01", "Store", "Norway", 2, 10.00),
    ("retail-baseline", "2025-01-01", "Store", "Germany", 2, 30.00),
    ("retail-baseline", "2025-01-01", "Store", "United Kingdom", 1, 5.25),
    ("retail-baseline", "2025-01-01", "Store", "France", 4, 40.00),
    ("retail-baseline", "2025-01-01", "Store", "Switzerland", 1, 2.00),
    ("retail-baseline", "2025-02-01", "Store", "Atlantis", 1, 9.99),
]


def _seed_retail_gold(lab, rows=GOLD_ROWS) -> None:
    """Test fixture only: stands in for `dbt build` of the retail Gold model."""
    lab.ducklake.bootstrap()
    with lab.ducklake.connection() as con:
        con.execute(
            f"CREATE TABLE contoso.gold.{mapping.RETAIL_GOLD_MODEL} (scenario VARCHAR, order_month DATE, channel VARCHAR, "
            "store_country VARCHAR, sales_lines BIGINT, revenue DECIMAL(18,2))"
        )
        con.executemany(f"INSERT INTO contoso.gold.{mapping.RETAIL_GOLD_MODEL} VALUES (?,?,?,?,?,?)", rows)


# ----- configuration -----------------------------------------------------------------------
def test_departments_cover_the_app_and_partition_the_generated_data():
    assert set(mapping.RETAIL_DEPARTMENTS) == {code for code, *_ in DEPARTMENTS}
    countries = _generator_countries()
    assert len(countries) == 5
    for channel in ("Online", "Store"):
        for country in countries:
            owners = [
                code
                for code, item in mapping.RETAIL_DEPARTMENTS.items()
                if item.channel == channel and (item.countries is None or country in item.countries)
            ]
            assert len(owners) == 1, (channel, country, owners)
    for item in mapping.RETAIL_DEPARTMENTS.values():
        assert set(item.countries or ()) <= set(countries), item


def test_flag_defaults_on_and_env_turns_it_off(monkeypatch):
    monkeypatch.delenv(mapping.RETAIL_GOLD_TO_APP_ENV, raising=False)
    assert mapping.retail_gold_to_app_enabled() is True
    assert all(item.enabled for item in mapping.RETAIL_GOLD_TO_APP)
    monkeypatch.setenv(mapping.RETAIL_GOLD_TO_APP_ENV, "0")
    assert mapping.retail_gold_to_app_enabled() is False


def test_declared_reads_match_the_dbt_model_and_app_fields():
    sql = GOLD_SQL.read_text(encoding="utf-8")
    final = sql[sql.lower().rindex("select") : sql.lower().index("\nfrom ")]
    outputs = set(re.findall(r"\bas\s+([a-z_]+)\s*,?\s*$", final, flags=re.M)) | set(
        re.findall(r"^\s*([a-z_]+)\s*,?\s*$", final, flags=re.M)
    )
    schema = yaml.safe_load((ROOT / "dbt/models/schema.yml").read_text(encoding="utf-8"))
    assert mapping.RETAIL_GOLD_MODEL in {m["name"] for m in schema["models"]}
    model = load_model(ROOT)
    for item in mapping.RETAIL_GOLD_TO_APP:
        assert item.gold_model == mapping.RETAIL_GOLD_MODEL
        assert item.gold_column in outputs, item
        assert item.app_field in model.entity(item.app_entity).column_names, item
    assert {"scenario", "order_month", "channel", "store_country", "revenue", "sales_lines"} <= outputs
    assert f"AT (VERSION => 7)" in retail_actuals_sql(7)


# ----- the read ----------------------------------------------------------------------------
def test_read_before_gold_is_built_is_not_ready(client):
    body = client.get(f"{BASE}/retail-actuals", headers=EVA).json()
    assert body["enabled"] is True and body["ready"] is False and body["items"] == []
    assert body["provenance"]["authoritative"] is False


def test_read_folds_gold_into_departments_as_a_labelled_copy(client, lab):
    _seed_retail_gold(lab)
    snapshots_before = lab.ducklake.snapshots(50)
    actuals_before = client.post(f"{BASE}/data/Actual/query", headers=EVA, json={"first": -1}).json()["items"]

    body = client.get(f"{BASE}/retail-actuals", headers=EVA).json()
    assert body["ready"] is True
    amounts = {(i["department_code"], i["month"]): i["amount"] for i in body["items"]}
    assert amounts == {("ONLINE", "2025-01"): 120.50, ("NORD", "2025-01"): 45.25, ("SOUTH", "2025-01"): 42.00}
    lines = {i["department_code"]: i["sales_lines"] for i in body["items"]}
    assert lines == {"ONLINE": 4, "NORD": 5, "SOUTH": 5}
    assert body["unmapped"] == [{"channel": "Store", "store_country": "Atlantis", "amount": 9.99, "sales_lines": 1}]

    provenance = body["provenance"]
    assert provenance["kind"] == "copy" and provenance["authoritative"] is False
    assert provenance["source"] == f"contoso.gold.{mapping.RETAIL_GOLD_MODEL}"
    assert provenance["snapshot_id"] == int(snapshots_before[0]["snapshot_id"])
    assert provenance["read_at"] and provenance["departments"]["NORD"]["countries"] == ["Norway", "Germany", "United Kingdom"]
    for item in body["items"]:
        assert item["_provenance"] == {
            "gold_table": provenance["source"], "snapshot_id": provenance["snapshot_id"], "read_at": provenance["read_at"]
        }

    # Gold stays the truth: the read creates no snapshot and leaves the app's own Actual rows alone.
    assert lab.ducklake.snapshots(50) == snapshots_before
    assert client.post(f"{BASE}/data/Actual/query", headers=EVA, json={"first": -1}).json()["items"] == actuals_before


def test_read_is_scoped_to_the_finance_users_department(client, lab):
    _seed_retail_gold(lab)
    body = client.get(f"{BASE}/retail-actuals", headers=ANA).json()
    assert body["items"] and {i["department_code"] for i in body["items"]} == {"NORD"}
    assert client.get(f"{BASE}/retail-actuals").status_code == 401


def test_read_is_off_when_the_flag_is_off(client, lab, monkeypatch):
    _seed_retail_gold(lab)
    monkeypatch.setenv(mapping.RETAIL_GOLD_TO_APP_ENV, "0")
    body = client.get(f"{BASE}/retail-actuals", headers=EVA).json()
    assert body["enabled"] is False and body["ready"] is False and body["items"] == []
    assert not any(read["enabled"] for read in mapping.describe()["retail_gold_to_app"])


def test_read_over_real_dbt_build(lab):
    dbt = DbtService(lab.settings)
    if not dbt.executable:
        pytest.skip("dbt is not installed")
    manifest = GeneratorService(lab.settings).generate("retail-baseline", 2000, 42)
    lab.ducklake.load_parquet_to_bronze({name: Path(path) for name, path in manifest["files"].items()})
    build = dbt.run("build")
    assert build["ok"] is True, build["output"][-3000:]

    body = read_retail_actuals(lab.ducklake)
    assert body["ready"] is True and body["unmapped"] == []
    assert {i["department_code"] for i in body["items"]} == set(mapping.RETAIL_DEPARTMENTS)
    _, rows, _ = lab.ducklake.query(f"select sum(revenue) from contoso.gold.{mapping.RETAIL_GOLD_MODEL}", 1)
    assert round(sum(i["amount"] for i in body["items"]), 2) == pytest.approx(float(rows[0][0]), abs=0.05)
