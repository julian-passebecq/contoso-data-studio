"""Pure helpers of tools/package_release.py (the install package builder)."""
from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("package_release", REPO / "tools" / "package_release.py")
pkg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pkg)


def test_handoff_files_are_not_shipped():
    name = "contoso-data-studio-0.3.1-abc1234"
    assert not pkg.shipped(f"{name}/handoff/", name)
    assert not pkg.shipped(f"{name}/handoff/OUTCOME.json", name)
    assert not pkg.shipped(f"{name}/handoff/evidence/e2e-05-2026-10-11.json", name)


def test_product_files_are_shipped():
    name = "contoso-data-studio-0.3.1-abc1234"
    for path in ("README.md", "apps/api/pyproject.toml", "docs/guide/README.md", "tools/handoff_notes.py", "docs/handoff/x.md"):
        assert pkg.shipped(f"{name}/{path}", name)
