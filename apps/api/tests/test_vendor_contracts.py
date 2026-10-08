"""Vendored peer contracts are unchanged copies of a pinned MosaicStudio tag (07-contoso F06, F07)."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_artifact_contract_matches_provenance():
    provenance = json.loads((ROOT / "vendor/datapass-artifact/PROVENANCE.json").read_text(encoding="utf-8"))
    assert provenance["upstream_tag"] == "studio-v0.8.1"
    for item in provenance["files"]:
        assert _sha(ROOT / item["vendored_path"]) == item["sha256"], item["vendored_path"]


def test_concept_contract_and_viewer_match_provenance():
    for folder, path in (("concept-spec", "vendor/concept-spec/v1/concept-spec.schema.json"),
                         ("concept-viewer", "vendor/concept-viewer/concept-viewer.html")):
        provenance = json.loads((ROOT / "vendor" / folder / "PROVENANCE.json").read_text(encoding="utf-8"))
        assert provenance["vendored_path"] == path
        assert _sha(ROOT / path) == provenance["sha256"]


def test_export_service_uses_the_vendored_writer():
    from app.services import exports

    assert Path(exports.dpa.__file__).resolve() == (ROOT / "vendor/datapass-artifact/datapass_artifact.py").resolve()
    assert exports.dpa.FORMAT == "datapass.artifact" and exports.dpa.VERSION == 1
