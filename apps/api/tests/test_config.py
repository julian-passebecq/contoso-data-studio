from pathlib import Path

from app.config import Settings


def test_default_paths_resolve_inside_repository(monkeypatch):
    monkeypatch.delenv("CONTOSO_WORKSPACE", raising=False)
    monkeypatch.delenv("CONTOSO_PROJECT_ROOT", raising=False)

    settings = Settings.load()
    expected_root = Path(__file__).resolve().parents[3]

    assert settings.project_root == expected_root
    assert settings.workspace == expected_root / "workspace"
