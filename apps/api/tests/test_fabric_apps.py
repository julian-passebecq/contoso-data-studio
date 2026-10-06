"""Fabric-style Sales Forecasting app: role policies, validation and mirroring."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.services.fabric_apps import FabricAppLab, set_lab
from app.services.fabric_apps.model import MODEL_RELATIVE_PATH, load_model
from app.services.fabric_apps.policy import evaluate

ROOT = Path(__file__).resolve().parents[3]
BASE = "/api/fabric-apps/sales-forecasting"
ANA = {"X-Local-User": "u-ana"}  # finance, NORD
BEN = {"X-Local-User": "u-ben"}  # finance, SOUTH
EVA = {"X-Local-User": "u-eva"}  # executive


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


def _forecasts(client, headers, **body):
    response = client.post(f"{BASE}/data/Forecast/query", headers=headers, json=body)
    assert response.status_code == 200, response.text
    return response.json()["items"]


def _first_forecast(client, headers, code):
    rows = _forecasts(client, headers, select=["id", "month", "amount", "owner_email", "department.code"], first=-1)
    return next(row for row in rows if row["department.code"] == code)


# ----- model compiled by @microsoft/rayfin-core --------------------------------------------
def test_model_json_comes_from_rayfin_decorators():
    model = load_model(ROOT)
    assert set(model.entities) == {"Department", "Forecast", "Actual"}
    forecast = model.entity("forecasts")  # Learn-article plural accessor
    assert forecast.name == "Forecast"
    assert forecast.column("id").db_type == "UNIQUEIDENTIFIER"
    assert forecast.column("department_id").references == {"entity": "Department", "field": "id"}
    texts = {r.policy_text for r in forecast.roles}
    assert "(@claims.role eq 'finance') and (@claims.email eq @item.owner_email)" in texts
    dab = json.loads((ROOT / MODEL_RELATIVE_PATH).with_name("dab-config.json").read_text(encoding="utf-8"))
    assert dab["entities"]["Forecast"]["source"] == "Forecasts"


def test_policy_ast_evaluation():
    model = load_model(ROOT)
    write = next(r for r in model.entity("Forecast").roles if "update" in r.actions).policy
    item = {"owner_email": "ana.finance@contoso.test"}
    assert evaluate(write, {"role": "finance", "email": "ana.finance@contoso.test"}, item)
    assert not evaluate(write, {"role": "finance", "email": "ben.finance@contoso.test"}, item)
    assert not evaluate(write, {"role": "executive", "email": "ana.finance@contoso.test"}, item)


# ----- policies on every call ---------------------------------------------------------------
def test_unknown_user_is_rejected(client):
    assert client.post(f"{BASE}/data/Forecast/query", json={}).status_code == 401
    assert client.post(f"{BASE}/data/Forecast/query", headers={"X-Local-User": "nobody"}, json={}).status_code == 401


def test_row_policy_scopes_reads_by_department(client):
    everything = _forecasts(client, EVA, first=-1)
    assert len(everything) == 36
    mine = _forecasts(client, ANA, first=-1, select=["id", "department.code"])
    assert len(mine) == 12
    assert {row["department.code"] for row in mine} == {"NORD"}
    actuals = client.post(f"{BASE}/data/actuals/query", headers=BEN, json={"first": -1}).json()["items"]
    assert len(actuals) == 9 and {row["owner_email"] for row in actuals} == {"ben.finance@contoso.test"}


def test_executive_cannot_write(client):
    target = _first_forecast(client, EVA, "NORD")
    response = client.patch(f"{BASE}/data/Forecast", headers=EVA, json={"filter": {"id": target["id"]}, "patch": {"amount": 1}})
    assert response.status_code == 403
    department = client.post(f"{BASE}/data/Department/query", headers=EVA, json={"where": {"code": {"eq": "NORD"}}}).json()["items"][0]
    created = client.post(
        f"{BASE}/data/Forecast",
        headers=EVA,
        json={"department": {"id": department["id"]}, "month": "2027-01", "amount": 5, "owner_email": department["finance_owner_email"]},
    )
    assert created.status_code == 403


def test_finance_limited_to_its_department(client):
    other = _first_forecast(client, EVA, "SOUTH")
    response = client.patch(f"{BASE}/data/Forecast", headers=ANA, json={"filter": {"id": other["id"]}, "patch": {"amount": 1}})
    assert response.status_code == 404  # not even visible to Ana
    assert client.get(f"{BASE}/data/Forecast/{other['id']}", headers=ANA).status_code == 404

    own = _first_forecast(client, ANA, "NORD")
    south = client.post(f"{BASE}/data/Department/query", headers=ANA, json={"where": {"code": {"eq": "SOUTH"}}}).json()["items"][0]
    moved = client.patch(
        f"{BASE}/data/Forecast",
        headers=ANA,
        json={"filter": {"id": own["id"]}, "patch": {"department": {"id": south["id"]}, "owner_email": south["finance_owner_email"]}},
    )
    assert moved.status_code == 403  # policy re-checked on the new row image

    ok = client.patch(
        f"{BASE}/data/Forecast",
        headers=ANA,
        json={"filter": {"id": own["id"]}, "patch": {"amount": 123456.789, "updated_by": "ana.finance@contoso.test"}},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["amount"] == 123456.79


def test_finance_can_create_in_own_department_only(client):
    nord = client.post(f"{BASE}/data/Department/query", headers=ANA, json={"where": {"code": {"eq": "NORD"}}}).json()["items"][0]
    body = {"department": {"id": nord["id"]}, "month": "2027-01", "amount": 1000, "owner_email": nord["finance_owner_email"]}
    assert client.post(f"{BASE}/data/Forecast", headers=ANA, json=body).status_code == 200
    assert client.post(f"{BASE}/data/Forecast", headers=BEN, json=body).status_code == 403


@pytest.mark.parametrize(
    "patch, message",
    [
        ({"amount": -5}, "at least"),
        ({"amount": "abc"}, "number"),
        ({"month": "2026-13"}, "format"),
        ({"note": "x" * 201}, "longer"),
        ({"owner_email": "ben.finance@contoso.test"}, "owner_email"),
        ({"unknown": 1}, "Unknown field"),
    ],
)
def test_writeback_validation(client, patch, message):
    own = _first_forecast(client, ANA, "NORD")
    response = client.patch(f"{BASE}/data/Forecast", headers=ANA, json={"filter": {"id": own["id"]}, "patch": patch})
    assert response.status_code == 422
    assert message in response.json()["detail"]


# ----- mirror to DuckLake Bronze ------------------------------------------------------------
def test_mirror_copies_changes_with_latency_and_history(client, lab):
    first = client.post(f"{BASE}/mirror/run").json()["mirrored"]
    assert first["full"] is True
    _, rows, _ = lab.ducklake.query("select count(*) from contoso.bronze.sfapp_forecasts", 1)
    assert rows[0][0] == 36

    own = _first_forecast(client, ANA, "NORD")
    response = client.patch(
        f"{BASE}/data/Forecast", headers=ANA, json={"filter": {"id": own["id"]}, "patch": {"amount": 777.0, "updated_by": "ana"}}
    )
    seq = response.json()["_seq"]
    assert client.get(f"{BASE}/mirror/status").json()["pending"] >= 1

    second = client.post(f"{BASE}/mirror/run").json()["mirrored"]
    assert second["full"] is False and seq in second["seqs"]
    assert second["snapshot_id"] > first["snapshot_id"]
    _, rows, _ = lab.ducklake.query(f"select amount from contoso.bronze.sfapp_forecasts where id = '{own['id']}'", 1)
    assert float(rows[0][0]) == 777.0
    _, rows, _ = lab.ducklake.query("select count(*) from contoso.bronze.sfapp_forecasts", 1)
    assert rows[0][0] == 36  # upsert, no duplicates

    trace = client.get(f"{BASE}/trace", params={"seq": seq}).json()["trace"]
    assert trace["mirror"]["latency_ms"] >= 0
    assert trace["mirror"]["endpoint_at"]
    status = client.get(f"{BASE}/mirror/status").json()
    assert status["stats"]["count"] >= 1 and status["pending"] == 0

    versions = client.get(f"{BASE}/history/{own['id']}").json()["versions"]
    amounts = [v["amount"] for v in versions]
    assert 777.0 in [float(a) for a in amounts if a is not None]
    assert any(a is not None and float(a) != 777.0 for a in amounts)  # older version kept


def test_mirror_is_idempotent_when_nothing_changed(client):
    client.post(f"{BASE}/mirror/run")
    assert client.post(f"{BASE}/mirror/run").json()["mirrored"] is None


def test_gold_forecast_vs_actual(client, lab):
    if not lab.mirror.dbt_executable:
        pytest.skip("dbt is not installed")
    own = _first_forecast(client, ANA, "NORD")
    client.patch(f"{BASE}/data/Forecast", headers=ANA, json={"filter": {"id": own["id"]}, "patch": {"amount": 1000.0}})
    client.post(f"{BASE}/mirror/run", params={"gold": "true"})
    gold = client.get(f"{BASE}/gold", headers=EVA).json()
    assert gold["ready"], lab.mirror.last_gold
    assert len(gold["items"]) == 36
    row = next(r for r in gold["items"] if r["department_code"] == "NORD" and r["month"] == own["month"])
    assert float(row["forecast_amount"]) == 1000.0
    assert float(row["variance"]) == pytest.approx(float(row["actual_amount"]) - 1000.0)
    finance_view = client.get(f"{BASE}/gold", headers=BEN).json()["items"]
    assert {r["department_code"] for r in finance_view} == {"SOUTH"}
