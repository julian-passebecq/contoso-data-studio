from pathlib import Path

import pytest

from app.config import Settings
from app.services.charts import ChartsService


def _service(tmp_path: Path, monkeypatch) -> ChartsService:
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))
    charts = tmp_path / "charts"
    charts.mkdir()
    (charts / "executive.yml").write_text(
        """
title: Executive Sales
notes: Gold KPI board
source: db
queries:
  totals:
    sql: |
      select sum(revenue) revenue
      from contoso.gold.monthly_sales
charts:
  revenue:
    label: Revenue
    query: queries.totals
    type: kpi
    value: revenue
  trend:
    title: Monthly revenue
    query: queries.totals
    type: line
    x: order_month
    y: revenue
rows:
  - cols: [revenue]
  - trend
""".strip(),
        encoding="utf-8",
    )
    return ChartsService(Settings(workspace=tmp_path / "workspace"))


def test_board_returns_queries_charts_and_layout(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)

    board = service.board("executive.yml")

    assert board["title"] == "Executive Sales"
    assert board["notes"] == "Gold KPI board"
    assert board["source"] == "db"
    assert board["queries"][0]["name"] == "totals"
    assert "contoso.gold.monthly_sales" in board["queries"][0]["sql"]
    assert board["charts"][0]["name"] == "revenue"
    assert board["charts"][0]["type"] == "kpi"
    assert board["rows"] == [{"cols": ["revenue"]}, "trend"]


def test_board_rejects_path_escape(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)

    with pytest.raises(ValueError, match="inside charts"):
        service.board("../outside.yml")


def test_board_rejects_non_mapping_yaml(tmp_path: Path, monkeypatch):
    service = _service(tmp_path, monkeypatch)
    (tmp_path / "charts" / "bad.yml").write_text("- one\n- two\n", encoding="utf-8")

    with pytest.raises(ValueError, match="object at the root"):
        service.board("bad.yml")
