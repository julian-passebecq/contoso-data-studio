"""HTTP transport for the local Fabric-style app (LOCAL ONLY, NOT RAYFIN API).

In Fabric, RayfinClient talks GraphQL to Data API Builder with an Entra ID token. Locally the web
client posts the same query shape (select/where/orderBy/first) here, and the fake user travels in
the `X-Local-User` header. Policies are enforced in the store on every call.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.config import Settings
from app.services.fabric_apps import APP_SLUG, get_lab
from app.services.fabric_apps.concept import CONCEPT_FILENAME, concept_bytes
from app.services.fabric_apps.mirror import GOLD_MODEL, bronze_table
from app.services.fabric_apps.model import load_model
from app.services.fabric_apps.policy import LocalUser, PolicyDenied
from app.services.fabric_apps.store import USERS, NotFound, ValidationError, user_by_id

router = APIRouter(prefix=f"/api/fabric-apps/{APP_SLUG}", tags=["fabric-apps"])
concept_router = APIRouter(prefix="/api/fabric-apps", tags=["fabric-apps"])


@concept_router.get("/concept")
def concept(download: bool = Query(default=False)):
    """Concept spec v1 document (SYNTHETIC) generated from the compiled model; same model, same bytes.

    Reads model.json directly so it never starts the lab's mirror worker.
    """
    body = concept_bytes(load_model(Settings.load().project_root))
    headers = {"Content-Disposition": f'attachment; filename="{CONCEPT_FILENAME}"'} if download else {}
    return Response(content=body, media_type="application/json", headers=headers)


class QueryBody(BaseModel):
    select: list[str] | None = None
    where: dict[str, Any] | None = None
    orderBy: dict[str, str] | None = None
    first: int = Field(default=100, ge=-1, le=100_000)


class UpdateBody(BaseModel):
    filter: dict[str, Any]
    patch: dict[str, Any]


def _user(header: str | None) -> LocalUser:
    try:
        return user_by_id(header)
    except PolicyDenied as exc:
        raise HTTPException(401, detail=str(exc)) from exc


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except PolicyDenied as exc:
        raise HTTPException(403, detail=str(exc)) from exc
    except NotFound as exc:
        raise HTTPException(404, detail=str(exc)) from exc
    except (ValidationError, ValueError) as exc:
        raise HTTPException(422, detail=str(exc)) from exc


@router.get("/users")
def users():
    return {"users": [user.as_dict() for user in USERS]}


@router.get("/model")
def model():
    lab = get_lab()
    return {
        "entities": lab.model.summary(),
        "source": "apps/fabric-app-lab/rayfin/generated/model.json",
        "bronze_tables": {e.name: f"contoso.bronze.{bronze_table(e)}" for e in lab.model.entities.values()},
        "gold_table": f"contoso.gold.{GOLD_MODEL}",
    }


@router.post("/data/{entity}/query")
def query(entity: str, body: QueryBody, x_local_user: str | None = Header(default=None)):
    user = _user(x_local_user)
    rows = _call(get_lab().store.query, entity, user, body.select, body.where, body.orderBy, body.first)
    return {"items": rows}


@router.get("/data/{entity}/{row_id}")
def find_by_id(entity: str, row_id: str, x_local_user: str | None = Header(default=None)):
    user = _user(x_local_user)
    return _call(get_lab().store.find_by_id, entity, user, row_id)


@router.post("/data/{entity}")
def create(entity: str, body: dict[str, Any], x_local_user: str | None = Header(default=None)):
    user = _user(x_local_user)
    lab = get_lab()
    row = _call(lab.store.create, entity, user, body)
    lab.mirror.notify()
    return row


@router.patch("/data/{entity}")
def update(entity: str, body: UpdateBody, x_local_user: str | None = Header(default=None)):
    user = _user(x_local_user)
    lab = get_lab()
    row = _call(lab.store.update, entity, user, body.filter, body.patch)
    lab.mirror.notify()
    return row


@router.get("/mirror/status")
def mirror_status():
    lab = get_lab()
    stats = lab.store.latency_stats(30)
    return {
        **stats,
        "mode": f"on change + every {lab.mirror.interval:g}s",
        "gold_auto": lab.mirror.gold_auto,
        "last_error": lab.mirror.last_error,
        "last_gold": lab.mirror.last_gold,
        "snapshots": lab.mirror.snapshots(12),
    }


@router.post("/mirror/run")
def mirror_run(gold: bool = Query(default=False)):
    """Force a mirror batch now (used by tests and the 'Sync now' button)."""
    lab = get_lab()
    try:
        result = lab.mirror.run_once(gold=gold)
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc
    if result:
        result["entities"] = sorted(result["entities"])
    return {"mirrored": result}


@router.post("/gold/refresh")
def gold_refresh():
    lab = get_lab()
    try:
        return lab.mirror.refresh_gold()
    except RuntimeError as exc:
        raise HTTPException(409, detail=str(exc)) from exc


@router.get("/gold")
def gold(x_local_user: str | None = Header(default=None)):
    """Gold rows for the chart, read through the read-only SQL path.

    Rayfin policies do not reach OneLake; in Fabric the semantic model's RLS does this job.
    Locally we apply the same department scope so the role switcher shows the effect end to end.
    """
    user = _user(x_local_user)
    lab = get_lab()
    try:
        columns, rows, _ = lab.ducklake.query(
            f"SELECT * FROM contoso.gold.{GOLD_MODEL} ORDER BY month, department_code", 5000
        )
    except Exception:
        return {"ready": False, "items": []}
    items = [dict(zip(columns, row)) for row in rows]
    if user.app_role != "executive":
        items = [item for item in items if item.get("department_code") == user.department_code]
    return {"ready": True, "items": items, "last_gold": lab.mirror.last_gold}


@router.get("/trace")
def trace(seq: int | None = Query(default=None, ge=1)):
    lab = get_lab()
    return {"trace": lab.store.trace(seq)}


@router.get("/history/{forecast_id}")
def history(forecast_id: str, limit: int = Query(default=8, ge=1, le=30)):
    return {"versions": _call(get_lab().mirror.row_history, forecast_id, limit)}


@router.post("/reset")
def reset():
    lab = get_lab()
    lab.store.reset()
    lab.mirror.notify()
    return {"status": "reset"}
