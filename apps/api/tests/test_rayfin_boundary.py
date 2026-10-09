"""Rayfin boundary (07-contoso/F08): DuckLake/dbt Gold stays the analytical truth, the app copy is labelled."""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from app.config import Settings
from app.services.fabric_apps import FabricAppLab, mapping, set_lab
from app.services.fabric_apps.mirror import bronze_table
from app.services.fabric_apps.model import Entity, load_model

ROOT = Path(__file__).resolve().parents[3]
BASE = "/api/fabric-apps/sales-forecasting"
ANA = {"X-Local-User": "u-ana"}
EVA = {"X-Local-User": "u-eva"}
APP_GOLD_SQL = ROOT / "dbt/models/fabric_apps/gold/forecast_vs_actual.sql"
APP_GOLD_SCHEMA = ROOT / "dbt/models/fabric_apps/gold/schema.yml"
FABRIC_SOURCES = ROOT / "dbt/models/fabric_apps/sources.yml"
SERVICES = ROOT / "apps/api/app/services/fabric_apps"
ROUTER = ROOT / "apps/api/app/routers/fabric_apps.py"


@pytest.fixture()
def lab(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTOSO_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_CATALOG", str(tmp_path / "workspace" / "lake.sqlite"))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_DATA_PATH", str(tmp_path / "workspace" / "lake.files"))
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(ROOT))
    instance = FabricAppLab(Settings.load(), start_worker=False, gold_auto=False)
    set_lab(instance)
    yield instance
    set_lab(None)


@pytest.fixture()
def client(lab):
    from app.main import app

    return TestClient(app)


def _sql_output_columns(sql: str) -> set[str]:
    """Output names of the final SELECT: `... as name` aliases and bare `alias.column` items."""
    sql = "\n" + sql
    final = sql[sql.lower().rindex("\nselect") :]
    final = final[: final.lower().index("\nfrom ")]
    names = set(re.findall(r"\bas\s+([a-z_][a-z0-9_]*)\s*,?\s*$", final, flags=re.I | re.M))
    names |= set(re.findall(r"^\s*[a-z]\.([a-z_][a-z0-9_]*)\s*,?\s*$", final, flags=re.I | re.M))
    return names


def _bronze_columns() -> dict[str, set[str]]:
    model = load_model(ROOT)
    return {
        mapping.APP_TO_BRONZE[entity.name]: set(entity.column_names) | {mapping.MIRROR_COLUMN}
        for entity in model.entities.values()
    }


# ----- (a) declared mapping matches the dbt Gold SQL and schema ------------------------------
def test_declared_bronze_mapping_covers_the_model_exactly():
    model = load_model(ROOT)
    assert set(mapping.APP_TO_BRONZE) == set(model.entities)
    for entity in model.entities.values():
        assert bronze_table(entity) == mapping.APP_TO_BRONZE[entity.name]
    sources = yaml.safe_load(FABRIC_SOURCES.read_text(encoding="utf-8"))["sources"][0]
    assert sources["schema"] == mapping.BRONZE_SCHEMA
    assert {t["name"] for t in sources["tables"]} == set(mapping.APP_TO_BRONZE.values())


def test_undeclared_entity_is_refused_by_the_mirror():
    stray = Entity(name="Budget", table="Budgets", columns=(), roles=())
    with pytest.raises(ValueError, match="no declared Bronze mapping"):
        bronze_table(stray)


def test_app_gold_lineage_columns_exist_in_dbt_model():
    sql = APP_GOLD_SQL.read_text(encoding="utf-8")
    outputs = _sql_output_columns(sql)
    declared = {item.gold_column for item in mapping.BRONZE_TO_APP_GOLD}
    assert declared == outputs, f"lineage {sorted(declared)} vs SQL {sorted(outputs)}"
    schema = yaml.safe_load(APP_GOLD_SCHEMA.read_text(encoding="utf-8"))
    model = next(m for m in schema["models"] if m["name"] == mapping.GOLD_MODEL)
    assert {c["name"] for c in model["columns"]} <= declared
    bronze = _bronze_columns()
    for item in mapping.BRONZE_TO_APP_GOLD:
        for source in item.sources:
            table, column = source.split(".")
            assert column in bronze[table], source
            assert re.search(rf"\b{column}\b", sql), source  # the dbt SQL really reads it


def test_optional_retail_gold_reads_are_declared_enabled_and_exist():
    assert mapping.RETAIL_GOLD_TO_APP, "the optional mapping must stay visible"
    model = load_model(ROOT)
    schema = yaml.safe_load((ROOT / "dbt/models/schema.yml").read_text(encoding="utf-8"))
    documented = {m["name"] for m in schema["models"]}
    for item in mapping.RETAIL_GOLD_TO_APP:
        assert item.enabled is True  # default ON (decision in GOLD-MAPPING.md section 3), env flag turns it off
        sql = (ROOT / f"dbt/models/gold/{item.gold_model}.sql").read_text(encoding="utf-8")
        assert re.search(rf"\b{item.gold_column}\b", sql), item
        assert item.gold_model in documented
        assert item.app_field in model.entity(item.app_entity).column_names
    assert mapping.describe()["writeback_to_gold"] is None


def test_mapping_doc_lists_every_declared_column():
    doc = (ROOT / "docs/fabric-apps/GOLD-MAPPING.md").read_text(encoding="utf-8")
    for item in mapping.BRONZE_TO_APP_GOLD:
        assert f"`{item.gold_column}`" in doc, item.gold_column
    for table in mapping.APP_TO_BRONZE.values():
        assert table in doc
    for item in mapping.RETAIL_GOLD_TO_APP:
        assert f"{item.gold_model}.{item.gold_column}" in doc


# ----- (b) mirrored copy carries provenance and is labelled non-authoritative ----------------
def test_mirror_output_carries_provenance(client, lab):
    batch = client.post(f"{BASE}/mirror/run").json()["mirrored"]
    provenance = batch["provenance"]
    assert provenance["kind"] == "copy" and provenance["authoritative"] is False
    assert "gold" in provenance["authority"]
    assert provenance["last_batch"]["snapshot_id"] == batch["snapshot_id"]
    assert provenance["targets"]["Forecast"] == "contoso.bronze.sfapp_forecasts"

    status = client.get(f"{BASE}/mirror/status").json()["provenance"]
    assert status["authoritative"] is False
    assert status["last_mirrored_seq"] == batch["seqs"][-1]
    assert status["row_provenance_column"] == mapping.MIRROR_COLUMN

    for table in mapping.APP_TO_BRONZE.values():
        _, rows, _ = lab.ducklake.query(
            f"select count(*), count({mapping.MIRROR_COLUMN}) from contoso.bronze.{table}", 1
        )
        assert rows[0][0] > 0 and rows[0][0] == rows[0][1], table  # every copied row is stamped


# ----- (c) missing or empty Gold fails visibly, no invented rows -----------------------------
def test_gold_read_before_any_build_is_not_ready(client):
    gold = client.get(f"{BASE}/gold", headers=EVA).json()
    assert gold == {"ready": False, "items": []}


def test_gold_refresh_without_dbt_raises(lab):
    lab.mirror.dbt_executable = None
    with pytest.raises(RuntimeError, match="dbt is not installed"):
        lab.mirror.refresh_gold()


def test_gold_build_over_missing_bronze_fails_visibly(client, lab):
    if not lab.mirror.dbt_executable:
        pytest.skip("dbt is not installed")
    lab.ducklake.bootstrap()  # empty lake, no mirror batch yet
    result = lab.mirror.refresh_gold()
    assert result["ok"] is False and result["output_tail"]
    assert lab.mirror.provenance()["app_gold"]["last_build"]["ok"] is False
    assert client.get(f"{BASE}/gold", headers=EVA).json()["items"] == []


def test_mirror_status_without_snapshots_has_no_batch(client):
    status = client.get(f"{BASE}/mirror/status").json()["provenance"]
    assert status["last_batch"] is None and status["last_mirrored_seq"] == 0


# ----- (d) writeback stays in the app; Gold is never mutated silently -------------------------
def test_writeback_does_not_touch_the_lake_until_mirrored(client, lab):
    client.post(f"{BASE}/mirror/run")
    before_snapshots = lab.ducklake.snapshots(50)
    before_gold = sorted(row["name"] for row in lab.ducklake.catalog() if row["schema"] == "gold")

    rows = client.post(f"{BASE}/data/Forecast/query", headers=ANA, json={"first": 1}).json()["items"]
    response = client.patch(
        f"{BASE}/data/Forecast", headers=ANA, json={"filter": {"id": rows[0]["id"]}, "patch": {"amount": 4242.0}}
    )
    assert response.status_code == 200, response.text

    assert lab.ducklake.snapshots(50) == before_snapshots  # no lake write on an app write
    assert sorted(row["name"] for row in lab.ducklake.catalog() if row["schema"] == "gold") == before_gold
    _, mirrored, _ = lab.ducklake.query(
        f"select amount from contoso.bronze.sfapp_forecasts where id = '{rows[0]['id']}'", 1
    )
    assert float(mirrored[0][0]) != 4242.0  # the copy lags until the next explicit batch


def test_app_code_never_writes_gold_tables():
    write = re.compile(r"\b(insert\s+into|create\s+(or\s+replace\s+)?table|delete\s+from|update|drop\s+table)\s+contoso\.gold\b", re.I)
    for path in [*SERVICES.glob("*.py"), ROUTER]:
        assert not write.search(path.read_text(encoding="utf-8")), path
    bronze_writes = re.findall(r"contoso\.(\w+)\.\{bronze_table", (SERVICES / "mirror.py").read_text(encoding="utf-8"))
    assert bronze_writes and set(bronze_writes) == {"bronze"}
