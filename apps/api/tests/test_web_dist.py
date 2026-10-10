"""FR-02: the API serves the built web bundle without shadowing /api, and the CLI finds the package root."""
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import cli
from app.web_dist import install, package_version, resolve_dist

ROOT = Path(__file__).resolve().parents[3]
INDEX = '<!doctype html><html><body><div id="root"></div></body></html>'


@pytest.fixture()
def bundle(tmp_path, monkeypatch):
    monkeypatch.delenv("CONTOSO_WEB_DIST", raising=False)
    root = tmp_path / "root"
    dist = root / "apps" / "web" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX, encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('ok')", encoding="utf-8")
    (dist / "vendor" / "concept-viewer").mkdir(parents=True)
    (dist / "vendor" / "concept-viewer" / "concept-viewer.html").write_text("<html>viewer</html>", encoding="utf-8")
    (root / "vendor" / "concept-viewer").mkdir(parents=True)
    (root / "vendor" / "concept-viewer" / "only-in-repo.html").write_text("<html>repo</html>", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")

    app = FastAPI()

    @app.get("/api/ping")
    def ping():
        return {"pong": True}

    assert install(app, root) == dist.resolve()
    return TestClient(app), app


def test_static_files_and_spa_fallback(bundle):
    client, _ = bundle
    index = client.get("/")
    assert index.status_code == 200 and 'id="root"' in index.text
    assert index.headers["content-type"].startswith("text/html")
    assert client.get("/assets/app.js").text == "console.log('ok')"
    deep = client.get("/explore/gold/monthly_sales")
    assert deep.status_code == 200 and 'id="root"' in deep.text
    assert client.get("/assets/missing.js").status_code == 404
    assert client.head("/").status_code == 200


def test_api_is_never_shadowed(bundle):
    client, _ = bundle
    assert client.get("/api/ping").json() == {"pong": True}
    for method in ("get", "post"):
        response = getattr(client, method)("/api/does-not-exist")
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}
    assert client.post("/somewhere").status_code == 405


def test_concept_viewer_matches_vite_rules(bundle):
    client, _ = bundle
    viewer = client.get("/vendor/concept-viewer/concept-viewer.html")
    assert viewer.status_code == 200 and "viewer" in viewer.text
    assert viewer.headers["x-concept-viewer"] == "vendored"
    assert viewer.headers["content-type"] == "text/html; charset=utf-8"
    assert client.get("/vendor/concept-viewer/only-in-repo.html").text == "<html>repo</html>"
    assert client.get("/vendor/concept-viewer/missing.html").status_code == 404
    assert client.get("/vendor/concept-viewer/script.js").status_code == 404
    assert client.head("/vendor/concept-viewer/concept-viewer.html").headers["x-concept-viewer"] == "vendored"


def test_paths_outside_the_bundle_are_refused(bundle):
    client, _ = bundle
    assert "outside" not in client.get("/../../../secret.txt").text
    assert "outside" not in client.get("/%2e%2e/%2e%2e/%2e%2e/secret.txt").text


def test_dist_resolution(tmp_path, monkeypatch):
    monkeypatch.delenv("CONTOSO_WEB_DIST", raising=False)
    assert resolve_dist(tmp_path) is None
    other = tmp_path / "elsewhere"
    other.mkdir()
    (other / "index.html").write_text(INDEX, encoding="utf-8")
    monkeypatch.setenv("CONTOSO_WEB_DIST", str(other))
    assert resolve_dist(tmp_path) == other.resolve()
    app = FastAPI()
    monkeypatch.setenv("CONTOSO_WEB_DIST", str(tmp_path / "empty"))
    assert install(app, tmp_path) is None
    assert not any(getattr(route, "name", None) == "web" for route in app.routes)


def test_one_version_source():
    import tomllib

    pyproject = tomllib.loads((ROOT / "apps" / "api" / "pyproject.toml").read_text(encoding="utf-8"))
    assert package_version() == pyproject["project"]["version"]
    assert pyproject["project"]["scripts"]["contoso-studio"] == "app.cli:main"
    app = FastAPI(version="9.9.9")
    install(app, Path("/nonexistent-root"))
    assert app.version == package_version()


def test_cli_finds_the_package_root(monkeypatch, tmp_path):
    monkeypatch.delenv("CONTOSO_PROJECT_ROOT", raising=False)
    assert cli.find_project_root() == ROOT
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))
    assert cli.find_project_root() == tmp_path.resolve()
    help_text = cli.build_parser().format_help()
    assert "pip install -e" in help_text and "127.0.0.1" in help_text
    assert cli.main(["--project-root", str(tmp_path)]) == 2
