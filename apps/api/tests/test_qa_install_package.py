"""Pure helpers of tools/qa_install_package.py (the install / exit-journey qualification script)."""
from __future__ import annotations

import importlib.util
from decimal import Decimal
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("qa_install_package", REPO / "tools" / "qa_install_package.py")
qa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qa)


def test_parse_sums_reads_sha256sum_lines():
    text = "abc123  contoso-data-studio-0.2.0-8a429c3.zip\n\ndef456 *other.zip\n"
    assert qa.parse_sums(text) == {"contoso-data-studio-0.2.0-8a429c3.zip": "abc123", "other.zip": "def456"}


def test_package_identity_prefers_install_txt_then_zip_name():
    install = "Contoso Data Studio 0.2.0 (fe83dbd)\nLocal install: ..."
    assert qa.package_identity("whatever.zip", install) == {"version": "0.2.0", "source_sha": "fe83dbd", "from": "install.txt"}
    assert qa.package_identity("contoso-data-studio-0.3.0-8a429c3.zip", None) == {
        "version": "0.3.0", "source_sha": "8a429c3", "from": "zip name"}
    assert qa.package_identity("other.zip", "") == {"version": None, "source_sha": None, "from": None}


@pytest.mark.parametrize("value, cents", [(1234.5, 123450), ("1234.56", 123456), (Decimal("0.005"), 1), (7, 700), (12.345, 1235)])
def test_to_cents_is_half_up_and_type_agnostic(value, cents):
    assert qa.to_cents(value) == cents


def test_kpi_revenue_sql_matches_the_shipped_charts_page():
    page = (REPO / "apps" / "web" / "src" / "pages" / "ChartsPage.tsx").read_text(encoding="utf-8")
    assert qa.kpi_revenue_sql(page) == qa.REVENUE_KPI_SQL
    assert qa.kpi_revenue_sql("no kpis here") is None


def test_break_model_is_the_retail_journey_fault_and_needs_the_anchor():
    original = "select 1\nfrom {{ ref('stg_sales') }}\ngroup by 1\n"
    broken = qa.break_model(original)
    assert qa.BROKEN_MARKER in broken and "where no_such_column > 0" in broken
    assert broken.replace(f" {qa.BROKEN_MARKER}\nwhere no_such_column > 0", "") == original
    with pytest.raises(ValueError):
        qa.break_model("select 1")
    shipped = (REPO / qa.BROKEN_MODEL).read_text(encoding="utf-8")
    assert qa.BROKEN_ANCHOR in shipped
    # Same mechanism as tools/qa_retail_journey.py.
    assert qa.BROKEN_MARKER in (REPO / "tools" / "qa_retail_journey.py").read_text(encoding="utf-8")


def test_failed_models_lists_model_errors_only():
    build = {"ok": False, "run_results": {"results": [
        {"unique_id": "model.contoso.monthly_sales", "status": "error", "message": "Binder Error: no_such_column"},
        {"unique_id": "model.contoso.stg_sales", "status": "success", "message": "OK"},
        {"unique_id": "test.contoso.not_null", "status": "error", "message": "x"},
    ]}}
    assert qa.failed_models(build) == [{"model": "monthly_sales", "message": "Binder Error: no_such_column"}]
    assert qa.failed_models({}) == []


def test_snapshot_and_diff_trees(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "keep.txt").write_text("same")
    (tmp_path / "change.txt").write_text("v1")
    (tmp_path / "gone.txt").write_text("x")
    before = qa.snapshot_tree(tmp_path)
    assert set(before) == {"a/keep.txt", "change.txt", "gone.txt"}
    (tmp_path / "change.txt").write_text("v2")
    (tmp_path / "gone.txt").unlink()
    (tmp_path / "new.txt").write_text("n")
    assert qa.diff_trees(before, qa.snapshot_tree(tmp_path)) == {
        "added": ["new.txt"], "removed": ["gone.txt"], "modified": ["change.txt"]}
    assert qa.snapshot_tree(tmp_path / "missing") == {}


def test_overall_needs_every_check_pass():
    assert qa.overall({"a": "PASS", "b": "PASS"}) == "pass"
    assert qa.overall({"a": "PASS", "b": "FAIL"}) == "fail"
    assert qa.overall({}) == "fail"
    assert qa.verdict(True) == "PASS" and qa.verdict(1) == "FAIL" and qa.verdict(None) == "FAIL"


def test_mosaic_tool_prefers_the_package_copy_and_falls_back_for_release_mode(tmp_path):
    tools = tmp_path / "tools"
    assert qa.mosaic_tool(tmp_path, release=False) == (qa.REPO / "tools" / "open_in_mosaic.mjs", "checkout (not in the package)")
    tools.mkdir()
    (tools / "open_in_mosaic.mjs").write_text("// --mosaic <checkout> only\n", encoding="utf-8")
    assert qa.mosaic_tool(tmp_path, release=False) == (tools / "open_in_mosaic.mjs", "installed package")
    tool, source = qa.mosaic_tool(tmp_path, release=True)
    assert tool == qa.REPO / "tools" / "open_in_mosaic.mjs" and "no --mosaic-release" in source
    (tools / "open_in_mosaic.mjs").write_text("// --mosaic-release <folder>\n", encoding="utf-8")
    assert qa.mosaic_tool(tmp_path, release=True) == (tools / "open_in_mosaic.mjs", "installed package")


def test_checkout_open_in_mosaic_supports_release_mode():
    assert "--mosaic-release" in (qa.REPO / "tools" / "open_in_mosaic.mjs").read_text(encoding="utf-8")


# The shipped mapping (app.services.fabric_apps.mapping.describe()["retail_departments"]) as served in provenance.
SERVED_DEPARTMENTS = {
    "ONLINE": {"channel": "Online", "countries": None},
    "NORD": {"channel": "Store", "countries": ["Norway", "Germany", "United Kingdom"]},
    "SOUTH": {"channel": "Store", "countries": ["France", "Switzerland"]},
}
GOLD_PAIRS = [["Online", "France", 12], ["Online", "Norway", 12], ["Store", "France", 12], ["Store", "Germany", 12],
              ["Store", "Switzerland", 12], ["Store", "Atlantis", 1]]


def test_items_cents_sums_amounts_half_up():
    assert qa.items_cents([{"amount": 10.005}, {"amount": "0.10"}, {"amount": 3}]) == 1311
    assert qa.items_cents([]) == 0


def test_department_coverage_finds_zero_one_or_many_departments():
    coverage = {(item["channel"], item["store_country"]): item["departments"]
                for item in qa.department_coverage(GOLD_PAIRS, SERVED_DEPARTMENTS)}
    assert coverage[("Online", "France")] == ["ONLINE"] and coverage[("Store", "Germany")] == ["NORD"]
    assert coverage[("Store", "Switzerland")] == ["SOUTH"] and coverage[("Store", "Atlantis")] == []
    overlapping = {**SERVED_DEPARTMENTS, "ALL_STORES": {"channel": "Store", "countries": None}}
    assert qa.department_coverage([["Store", "France", 1]], overlapping)[0]["departments"] == ["SOUTH", "ALL_STORES"]


def test_dropped_pairs_are_those_only_the_left_out_department_maps():
    assert qa.dropped_pairs(SERVED_DEPARTMENTS, "SOUTH", GOLD_PAIRS) == [("Store", "France"), ("Store", "Switzerland")]
    assert qa.dropped_pairs(SERVED_DEPARTMENTS, "NONE", GOLD_PAIRS) == []


def test_unmapped_probe_and_ui_phases_exist_in_the_checkout():
    assert "mapping.RETAIL_DEPARTMENTS = " in qa.UNMAPPED_PROBE and "read_retail_actuals" in qa.UNMAPPED_PROBE
    journey = (REPO / "apps" / "web" / "qa" / "retail-journey.mjs").read_text(encoding="utf-8")
    for phase in ("ux", "api-stop", "export-refused"):
        assert f'phase === "{phase}"' in journey
    assert qa.API_DOWN_TEXT in (REPO / "apps" / "web" / "src" / "api.ts").read_text(encoding="utf-8")
