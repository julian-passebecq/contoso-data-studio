from pathlib import Path

import pytest

from app.config import Settings
from app.services.charts import ChartsService
from app.services.ducklake import DuckLakeService
from app.services.explorer import ExplorerService


def test_query_rejects_multiple_statements(tmp_path: Path):
    service = DuckLakeService(Settings(workspace=tmp_path))
    with pytest.raises(ValueError, match="one SQL statement"):
        service.query("select 1; drop table x", 10)


@pytest.mark.parametrize(
    "sql",
    [
        "create table x as select 1",
        "drop table x",
        "insert into x values (1)",
        "attach 'other.duckdb' as other",
    ],
)
def test_query_rejects_mutating_and_admin_sql(tmp_path: Path, sql: str):
    service = DuckLakeService(Settings(workspace=tmp_path))
    with pytest.raises(ValueError):
        service.query(sql, 10)


def test_explorer_rejects_path_escape(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.csv"
    outside.write_text("a\n1\n", encoding="utf-8")

    service = ExplorerService(Settings(workspace=workspace))
    with pytest.raises(ValueError, match="inside the Contoso workspace"):
        service.inspect("../outside.csv")


def test_explorer_lists_only_supported_workspace_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    staging = workspace / "staging" / "run-1"
    staging.mkdir(parents=True)
    (staging / "sales.csv").write_text("id\n1\n", encoding="utf-8")
    (staging / "notes.txt").write_text("ignore", encoding="utf-8")

    service = ExplorerService(Settings(workspace=workspace))
    files = service.list_files()

    assert [item["name"] for item in files] == ["sales.csv"]
    assert files[0]["format"] == "CSV"


def test_charts_rejects_board_path_escape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "project"
    charts = project / "charts"
    workspace = project / "workspace"
    charts.mkdir(parents=True)
    workspace.mkdir()
    outside = project / "outside.yml"
    outside.write_text("title: outside\n", encoding="utf-8")

    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(project))
    service = ChartsService(Settings(workspace=workspace))

    with pytest.raises(ValueError, match="inside charts"):
        service._board_path("../outside.yml")
