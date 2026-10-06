"""Concept spec v1 document for the Sales Forecasting app (SYNTHETIC).

Turns the compiled Rayfin model (`rayfin/generated/model.json`) plus the known local data path
(SQLite store -> mirror worker -> DuckLake Bronze -> dbt Gold -> chart) into a
`datapass.concept-spec` v1 document. The format is owned by DataPass MosaicStudio; Contoso only
consumes its published JSON Schema (vendored under `vendor/concept-spec/v1/`).

Deterministic: the same model gives the same bytes (no clock, no random ids, stable ordering).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from app.services.fabric_apps.mirror import GOLD_MODEL, bronze_table
from app.services.fabric_apps.model import MODEL_RELATIVE_PATH, AppModel

CONCEPT_ID = "contoso-sales-forecasting"
CONCEPT_FILENAME = f"{CONCEPT_ID}.concept.json"

# Evidence: repository paths (POSIX) the nodes cite.
MODEL_FILE = MODEL_RELATIVE_PATH.as_posix()
ENTITY_DIR = "apps/fabric-app-lab/rayfin/data/entities"
DAB_CONFIG = "apps/fabric-app-lab/rayfin/generated/dab-config.json"
WEB_PAGE = "apps/web/src/pages/AppsPage.tsx"
ADAPTER = "apps/web/src/fabricApps/localRayfinClient.ts"
ROUTER = "apps/api/app/routers/fabric_apps.py"
STORE = "apps/api/app/services/fabric_apps/store.py"
POLICY = "apps/api/app/services/fabric_apps/policy.py"
MIRROR = "apps/api/app/services/fabric_apps/mirror.py"
DUCKLAKE = "apps/api/app/services/ducklake.py"
DBT_MODEL = f"dbt/models/fabric_apps/gold/{GOLD_MODEL}.sql"
DBT_SOURCES = "dbt/models/fabric_apps/sources.yml"
CHART = "apps/web/src/fabricApps/MonthlyBarChart.tsx"


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _src(path: str, note: str | None = None) -> dict[str, str]:
    return {"path": path, "note": _clip(note, 200)} if note else {"path": path}


def _model_digest(model: AppModel) -> str:
    """Short hash of the model content the document was built from (newline-normalised)."""
    raw = model.source.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(raw).hexdigest()[:12]


def build_concept(model: AppModel) -> dict[str, Any]:
    entities = list(model.entities.values())  # model.json order, which is stable
    names = ", ".join(e.name for e in entities)
    tables = ", ".join(e.table for e in entities)
    bronze = ", ".join(f"bronze.{bronze_table(e)}" for e in entities)
    relations = "; ".join(
        f"{e.name}.{c.name} -> {c.references['entity']}.{c.references['field']}"
        for e in entities
        for c in e.columns
        if c.references
    )
    policies = "; ".join(
        f"{e.name} {'/'.join(r.actions)}: {r.policy_text or 'any signed-in user'}"
        for e in entities
        for r in e.roles
    )
    roles = sorted({r.role for e in entities for r in e.roles})
    entity_sources = [_src(f"{ENTITY_DIR}/{e.name}.ts", f"{e.name} entity (Rayfin decorators)") for e in entities][:4]

    layers = [
        {"id": "lake", "label": "Shared lake", "height": 0, "role": "storage",
         "description": "DuckLake catalog (local stand-in for OneLake): Bronze mirror tables and Gold marts as Parquet with snapshot history."},
        {"id": "stores", "label": "Stores", "height": 1, "role": "data",
         "description": "The app's operational SQL database and the mirrored Bronze tables."},
        {"id": "sync", "label": "Sync & transform", "height": 1.9, "role": "compute",
         "description": "The mirror worker copies committed changes to the lake; dbt builds the Gold table."},
        {"id": "service", "label": "Model & service", "height": 2.9, "role": "serving",
         "description": "The compiled Rayfin model, the data API generated from it and the read-only SQL path."},
        {"id": "app", "label": "App & report", "height": 4.1, "role": "experience",
         "description": "The editable forecast app and the forecast-vs-actual chart."},
        {"id": "people", "label": "People", "height": 5.1, "role": "users",
         "description": "Synthetic finance planners and an executive (fake local users)."},
    ]
    domains = [
        {"id": "operational", "label": "Operational app", "description": "Write path: UI, data API, model and SQL database."},
        {"id": "analytics", "label": "Analytics", "description": "Read path: mirror, Bronze, dbt Gold, SQL endpoint and chart."},
        {"id": "access", "label": "Identity & access", "placement": "side",
         "description": "Cross-cutting sign-in, roles and row policies."},
    ]
    nodes = [
        {"id": "shared-lake", "kind": "lake", "layer": "lake", "domain": "analytics", "label": "DuckLake (shared lake)",
         "description": "Single storage layer for Bronze and Gold, with one snapshot per mirror batch.",
         "sources": [_src(DUCKLAKE)]},
        {"id": "sql-db", "kind": "sql-db", "layer": "stores", "domain": "operational", "label": "Operational SQL DB",
         "description": _clip(f"SQLite stand-in for the app's SQL database. Tables: {tables}.", 600),
         "sources": [_src(STORE), _src(DAB_CONFIG, "table mapping")]},
        {"id": "bronze", "kind": "lakehouse", "layer": "stores", "domain": "analytics", "label": "Mirrored Bronze tables",
         "description": _clip(f"Read-only copies of the SQL tables in the lake: {bronze}.", 600),
         "sources": [_src(MIRROR, "bronze_table()"), _src(DBT_SOURCES)]},
        {"id": "mirror", "kind": "stream", "layer": "sync", "domain": "analytics", "label": "Mirror stream",
         "description": "Worker that copies every committed change to Bronze, on change and on a short timer.",
         "sources": [_src(MIRROR)]},
        {"id": "dbt-gold", "kind": "pipeline", "layer": "sync", "domain": "analytics", "label": "dbt Gold",
         "description": f"dbt model gold.{GOLD_MODEL}: monthly forecast vs actual with variance, built from Bronze.",
         "sources": [_src(DBT_MODEL), _src(DBT_SOURCES)]},
        {"id": "data-model", "kind": "semantic-model", "layer": "service", "domain": "operational", "label": "Rayfin data model",
         "description": _clip(f"Compiled offline from decorators. Entities: {names}. Relations: {relations or 'none'}.", 600),
         "sources": [_src(MODEL_FILE, "compiled model"), *entity_sources][:6]},
        {"id": "data-api", "kind": "api", "layer": "service", "domain": "operational", "label": "Data API",
         "description": "Local REST stand-in for the generated data API; validates every write and applies row policies.",
         "sources": [_src(ADAPTER, "local adapter (RayfinClient call shapes)"), _src(ROUTER), _src(STORE)]},
        {"id": "sql-endpoint", "kind": "endpoint", "layer": "service", "domain": "analytics", "label": "SQL endpoint",
         "description": "Read-only SQL over the lake tables (SELECT only, time travel by snapshot).",
         "sources": [_src(DUCKLAKE), _src(ROUTER, "GET /gold")]},
        {"id": "identity", "kind": "identity", "layer": "service", "domain": "access", "label": "Local identity",
         "description": _clip(f"Fake users in the X-Local-User header; roles: {', '.join(roles)}. Policies: {policies}.", 600),
         "sources": [_src(POLICY), _src(MODEL_FILE, "role declarations")]},
        {"id": "web-app", "kind": "web-app", "layer": "app", "domain": "operational", "label": "Sales Forecasting app",
         "description": "Editable forecast table with client-side validation, KPI cards and a monthly chart.",
         "sources": [_src(WEB_PAGE), _src(ADAPTER)]},
        {"id": "report", "kind": "report", "layer": "app", "domain": "analytics", "label": "Forecast vs actual",
         "description": "Monthly chart read from Gold, scoped to the user's department unless executive.",
         "sources": [_src(CHART), _src(DBT_MODEL)]},
        {"id": "planner", "kind": "user", "layer": "people", "domain": "operational", "label": "Finance planner",
         "description": "Edits forecasts for their own department (synthetic user)."},
        {"id": "executive", "kind": "user", "layer": "people", "domain": "analytics", "label": "Executive",
         "description": "Reads every department; cannot edit (synthetic user)."},
    ]
    flows = [
        {"id": "f-planner-app", "from": "planner", "to": "web-app", "kind": "control", "label": "Edit forecast"},
        {"id": "f-app-api", "from": "web-app", "to": "data-api", "kind": "data", "label": "Read / write", "direction": "both"},
        {"id": "f-model-api", "from": "data-model", "to": "data-api", "kind": "control", "label": "Defines entities"},
        {"id": "f-api-db", "from": "data-api", "to": "sql-db", "kind": "data", "label": "Rows", "direction": "both"},
        {"id": "f-db-mirror", "from": "sql-db", "to": "mirror", "kind": "data", "label": "Change feed"},
        {"id": "f-mirror-bronze", "from": "mirror", "to": "bronze", "kind": "data", "label": "Replicate"},
        {"id": "f-bronze-lake", "from": "bronze", "to": "shared-lake", "kind": "data", "label": "Bronze files"},
        {"id": "f-bronze-gold", "from": "bronze", "to": "dbt-gold", "kind": "data", "label": "Bronze"},
        {"id": "f-gold-lake", "from": "dbt-gold", "to": "shared-lake", "kind": "data", "label": "Gold table"},
        {"id": "f-mirror-gold", "from": "mirror", "to": "dbt-gold", "kind": "control", "label": "Trigger build"},
        {"id": "f-lake-endpoint", "from": "shared-lake", "to": "sql-endpoint", "kind": "data", "label": "SELECT"},
        {"id": "f-endpoint-report", "from": "sql-endpoint", "to": "report", "kind": "data", "label": "Gold rows"},
        {"id": "f-report-exec", "from": "report", "to": "executive", "kind": "data", "label": "Read"},
        {"id": "f-report-planner", "from": "report", "to": "planner", "kind": "data", "label": "Read own department"},
        {"id": "f-id-app", "from": "identity", "to": "web-app", "kind": "auth", "label": "Sign in (fake user)"},
        {"id": "f-id-api", "from": "identity", "to": "data-api", "kind": "auth", "label": "Role + row policy"},
        {"id": "f-id-endpoint", "from": "identity", "to": "sql-endpoint", "kind": "auth", "label": "Department scope"},
    ]
    return {
        "format": "datapass.concept-spec",
        "version": 1,
        "id": CONCEPT_ID,
        "title": "Sales Forecasting app (Contoso lab)",
        "subtitle": "Generated from the compiled Rayfin model and the local data path: SQL DB, mirror, DuckLake, dbt Gold.",
        "provenance": "synthetic",
        "note": _clip(
            "SYNTHETIC local lab: fake users, generated data, local stand-ins for Fabric pieces. "
            "Not a vendor reference architecture, a tenant or a measured system. "
            f"Generated from {MODEL_FILE} (sha256 {_model_digest(model)}).",
            600,
        ),
        "layers": layers,
        "domains": domains,
        "nodes": nodes,
        "flows": flows,
        "annotations": [
            {"id": "n-synthetic", "text": "SYNTHETIC: every user, row and number in this lab is generated."},
            {"id": "n-mirror", "target": "mirror", "text": "One DuckLake snapshot per batch; latency is stamped on every write."},
            {"id": "n-api", "target": "data-api", "text": "Row policies run on every call: planners edit only their own forecasts."},
            {"id": "n-report", "target": "report", "text": "Policies do not reach the lake; the Gold read applies the department scope."},
        ],
    }


def concept_bytes(model: AppModel) -> bytes:
    """Canonical serialisation: 2-space indent, UTF-8, trailing newline."""
    return (json.dumps(build_concept(model), indent=2, ensure_ascii=False) + "\n").encode("utf-8")
