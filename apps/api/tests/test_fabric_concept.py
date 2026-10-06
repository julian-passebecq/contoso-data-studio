"""Concept spec v1 document for the Sales Forecasting app: determinism, schema, semantics, API."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import jsonschema
import pytest
from fastapi.testclient import TestClient

from app.services.fabric_apps.concept import CONCEPT_FILENAME, build_concept, concept_bytes
from app.services.fabric_apps.model import MODEL_RELATIVE_PATH, load_model

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = ROOT / "vendor/concept-spec/v1/concept-spec.schema.json"
PROVENANCE = ROOT / "vendor/concept-spec/PROVENANCE.json"


def test_generator_is_deterministic(tmp_path):
    first = concept_bytes(load_model(ROOT))
    assert first == concept_bytes(load_model(ROOT))
    # Same model content elsewhere, with CRLF line endings: still the same bytes.
    copy = tmp_path / MODEL_RELATIVE_PATH
    copy.parent.mkdir(parents=True)
    copy.write_bytes((ROOT / MODEL_RELATIVE_PATH).read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
    assert concept_bytes(load_model(tmp_path)) == first
    assert first.endswith(b"\n") and b"\r" not in first


def test_model_change_changes_document(tmp_path):
    copy = tmp_path / MODEL_RELATIVE_PATH
    copy.parent.mkdir(parents=True)
    payload = json.loads((ROOT / MODEL_RELATIVE_PATH).read_text(encoding="utf-8"))
    payload["entities"] = [e for e in payload["entities"] if e["name"] != "Actual"]
    for entity in payload["entities"]:
        entity["columns"] = [c for c in entity["columns"] if not (c.get("references") or {}).get("entity") == "Actual"]
    copy.write_text(json.dumps(payload), encoding="utf-8")
    doc = build_concept(load_model(tmp_path))
    bronze = next(n for n in doc["nodes"] if n["id"] == "bronze")
    assert "sfapp_actuals" not in bronze["description"]
    assert concept_bytes(load_model(tmp_path)) != concept_bytes(load_model(ROOT))


def test_document_validates_against_vendored_schema():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    doc = build_concept(load_model(ROOT))
    jsonschema.Draft202012Validator(schema).validate(doc)
    assert doc["$schema"] == schema["$id"]
    assert doc["specVersion"] == "1.0.0"
    provenance = json.loads(PROVENANCE.read_text(encoding="utf-8"))
    assert provenance["upstream_repo"] == "julian-passebecq/datapass-mosaicstudio"
    assert len(provenance["upstream_sha"]) == 40


@pytest.mark.parametrize("record", ["vendor/concept-spec/PROVENANCE.json", "vendor/concept-viewer/PROVENANCE.json"])
def test_vendored_files_are_unchanged(record):
    provenance = json.loads((ROOT / record).read_text(encoding="utf-8"))
    data = (ROOT / provenance["vendored_path"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == provenance["sha256"], f"{provenance['vendored_path']} was modified; re-vendor it"
    assert provenance["upstream_tag"] and len(provenance["upstream_sha"]) == 40


def test_document_semantics():
    """The checks the JSON Schema cannot express (mirrors parseConceptSpec in CONCEPT_SPEC.md)."""
    doc = build_concept(load_model(ROOT))
    assert doc["provenance"] == "synthetic" and "SYNTHETIC" in doc["note"]
    ids = [x["id"] for key in ("layers", "domains", "nodes", "flows") for x in doc[key]]
    assert len(ids) == len(set(ids)), "ids must be unique across the document"
    heights = [layer["height"] for layer in doc["layers"]]
    assert all(b - a >= 0.6 for a, b in zip(heights, heights[1:]))
    layers = {layer["id"] for layer in doc["layers"]}
    domains = {d["id"] for d in doc["domains"]}
    nodes = {n["id"]: n for n in doc["nodes"]}
    placements = [d.get("placement", "main") for d in doc["domains"]]
    assert placements == sorted(placements, key=lambda p: p == "side"), "side domains come last"
    cells: dict[tuple[str, str], int] = {}
    for node in doc["nodes"]:
        assert node["layer"] in layers and node["domain"] in domains
        cells[(node["layer"], node["domain"])] = cells.get((node["layer"], node["domain"]), 0) + 1
    assert max(cells.values()) <= 3
    lakes = [n for n in doc["nodes"] if n["kind"] == "lake"]
    assert len(lakes) <= 1 and all(n["layer"] == doc["layers"][0]["id"] for n in lakes)
    for flow in doc["flows"]:
        assert flow["from"] in nodes and flow["to"] in nodes, flow
    for note in doc.get("annotations", []):
        assert note.get("target", next(iter(nodes))) in nodes
    # Layers, kinds, flow kinds and evidence the package asks for.
    assert [layer["id"] for layer in doc["layers"]] == ["lake", "stores", "sync", "service", "app", "people"]
    assert doc["domains"][-1] == {**doc["domains"][-1], "id": "access", "placement": "side"}
    kinds = {n["kind"] for n in doc["nodes"]}
    assert {"web-app", "api", "semantic-model", "sql-db", "stream", "lakehouse", "endpoint", "pipeline", "report", "identity", "lake"} <= kinds
    assert {f["kind"] for f in doc["flows"]} == {"data", "control", "auth"}
    cited = {s["path"] for n in doc["nodes"] for s in n.get("sources", [])}
    for path in (MODEL_RELATIVE_PATH.as_posix(), "apps/web/src/fabricApps/localRayfinClient.ts",
                 "dbt/models/fabric_apps/gold/forecast_vs_actual.sql"):
        assert path in cited
    missing = sorted(p for p in cited if not (ROOT / p).exists())
    assert not missing, f"evidence paths must exist: {missing}"


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTOSO_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(ROOT))
    from app.main import app

    return TestClient(app)


def test_concept_endpoint(client):
    response = client.get("/api/fabric-apps/concept")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.content == concept_bytes(load_model(ROOT))
    assert "attachment" not in response.headers.get("content-disposition", "")
    download = client.get("/api/fabric-apps/concept?download=true")
    assert download.headers["content-disposition"] == f'attachment; filename="{CONCEPT_FILENAME}"'
    assert download.content == response.content
    assert response.json()["format"] == "datapass.concept-spec"

