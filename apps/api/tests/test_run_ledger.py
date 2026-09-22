import json
from pathlib import Path

from app.config import Settings
from app.services.generator import GeneratorService


def test_run_ledger_lists_manifests_and_marks_bronze(tmp_path: Path):
    settings = Settings(workspace=tmp_path)
    service = GeneratorService(settings)
    run_dir = settings.staging_path / "20260922T120000Z-deadbeef"
    run_dir.mkdir(parents=True)
    manifest = {
        "run_id": run_dir.name,
        "scenario": "retail-baseline",
        "scenario_name": "Retail baseline",
        "created_at": "2026-09-22T12:00:00+00:00",
        "seed": 42,
        "scale": 1000,
        "row_counts": {"sales": 1000},
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    runs = service.list_runs()

    assert runs[0]["run_id"] == run_dir.name
    assert runs[0]["sales_rows"] == 1000
    assert runs[0]["bronze_loaded_at"] is None

    updated = service.mark_bronze_loaded(run_dir.name)

    assert updated["bronze_loaded_at"]
    assert service.list_runs()[0]["bronze_loaded_at"] == updated["bronze_loaded_at"]


def test_run_ledger_ignores_invalid_manifest(tmp_path: Path):
    settings = Settings(workspace=tmp_path)
    service = GeneratorService(settings)
    run_dir = settings.staging_path / "broken"
    run_dir.mkdir(parents=True)
    (run_dir / "manifest.json").write_text("{bad json", encoding="utf-8")

    assert service.list_runs() == []
