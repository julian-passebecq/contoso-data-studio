"""Per-Gold-model last-build report: a FOIL build rebuilds only models/foil, and the report says so."""
import json
from pathlib import Path
from types import SimpleNamespace

from app.config import Settings
from app.services.dbt_runner import BUILD_LEDGER, DbtService

PROJECT = "contoso_data_studio"
RETAIL_GOLD = ["monthly_sales", "store_performance"]
FOIL_GOLD = ["foil_project_summary"]


def _service(tmp_path: Path, monkeypatch, foil: dict) -> DbtService:
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))
    models = tmp_path / "dbt" / "models"
    for relative in ("silver/stg_sales", "gold/monthly_sales", "gold/store_performance",
                     "foil/silver/foil_cashflows", "foil/gold/foil_project_summary",
                     "fabric_apps/gold/forecast_vs_actual"):
        path = models / f"{relative}.sql"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("select 1", encoding="utf-8")
    service = DbtService(Settings(workspace=tmp_path / "workspace"))
    monkeypatch.setattr(DbtService, "_foil_active", lambda self: foil["active"])
    monkeypatch.setattr("app.services.dbt_runner.shutil.which", lambda _: "/usr/bin/dbt")
    return service


def _write_run_results(service: DbtService, invocation: str, generated_at: str, names: list[str]) -> None:
    target = service.settings.dbt_target_path
    target.mkdir(parents=True, exist_ok=True)
    (target / "run_results.json").write_text(json.dumps({
        "metadata": {"generated_at": generated_at, "invocation_id": invocation},
        "elapsed_time": 0.1,
        "results": [
            {"unique_id": f"model.{PROJECT}.{name}", "status": "success", "execution_time": 0.1}
            for name in names
        ],
    }), encoding="utf-8")


def _fake_dbt(service: DbtService, monkeypatch, runs: list[tuple[str, str, list[str]]]) -> dict:
    """Each call of dbt writes the next (invocation_id, generated_at, models) of `runs`."""
    captured: dict = {"args": []}

    def fake_run(args, **kwargs):
        captured["args"].append(args)
        invocation, generated_at, names = runs[len(captured["args"]) - 1]
        _write_run_results(service, invocation, generated_at, names)
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr("app.services.dbt_runner.subprocess.run", fake_run)
    return captured


def _by_name(report: dict) -> dict:
    return {row["name"]: row for row in report["models"]}


def test_retail_build_then_foil_build_keeps_retail_last_build_and_marks_it_not_rebuilt(tmp_path, monkeypatch):
    foil = {"active": False}
    service = _service(tmp_path, monkeypatch, foil)
    captured = _fake_dbt(service, monkeypatch, [
        ("aaaaaaaa-1111-2222-3333-444444444444", "2026-10-12T08:00:00Z", ["stg_sales", *RETAIL_GOLD]),
        ("bbbbbbbb-1111-2222-3333-444444444444", "2026-10-12T09:00:00Z", ["foil_cashflows", *FOIL_GOLD]),
    ])

    assert service.run("build")["ok"] is True
    retail = _by_name(service.gold_builds())
    assert retail["monthly_sales"]["last_build"]["short_id"] == "aaaaaaaa"
    assert retail["monthly_sales"]["rebuilt_by_latest"] is True
    assert retail["foil_project_summary"]["last_build"] is None
    assert retail["foil_project_summary"]["rebuilt_by_latest"] is False

    foil["active"] = True
    assert service.run("build")["ok"] is True
    assert captured["args"][1][captured["args"][1].index("--select") + 1] == "path:models/foil"

    report = service.gold_builds()
    rows = _by_name(report)
    assert report["foil_active"] is True
    assert report["latest_build"]["short_id"] == "bbbbbbbb"
    assert report["latest_build"]["scope"] == "foil"
    assert report["latest_build"]["command"] == "build"
    for name in RETAIL_GOLD:
        row = rows[name]
        assert row["scope"] == "retail"
        assert row["in_active_project"] is False
        assert row["rebuilt_by_latest"] is False
        assert row["latest_build_status"] is None
        # Its last successful build is still the retail one, with its own invocation and time.
        assert row["last_build"]["invocation_id"] == "aaaaaaaa-1111-2222-3333-444444444444"
        assert row["last_build"]["generated_at"] == "2026-10-12T08:00:00Z"
        assert row["last_build"]["scope"] == "retail"
    summary = rows["foil_project_summary"]
    assert summary["rebuilt_by_latest"] is True
    assert summary["in_active_project"] is True
    assert summary["last_build"]["short_id"] == "bbbbbbbb"
    assert rows["forecast_vs_actual"]["scope"] == "app_lab"
    assert rows["forecast_vs_actual"]["last_build"] is None
    # Silver is not in the Gold report.
    assert "stg_sales" not in rows and "foil_cashflows" not in rows


def test_dbt_test_does_not_count_as_a_build(tmp_path, monkeypatch):
    service = _service(tmp_path, monkeypatch, {"active": False})
    _fake_dbt(service, monkeypatch, [
        ("aaaaaaaa-0000-0000-0000-000000000000", "2026-10-12T08:00:00Z", RETAIL_GOLD),
        ("cccccccc-0000-0000-0000-000000000000", "2026-10-12T10:00:00Z", RETAIL_GOLD),
    ])
    service.run("build")
    service.run("test")  # fake writes model rows, but a test run never stamps a build

    rows = _by_name(service.gold_builds())
    assert rows["monthly_sales"]["last_build"]["short_id"] == "aaaaaaaa"
    ledger = json.loads((service.settings.dbt_target_path / BUILD_LEDGER).read_text(encoding="utf-8"))
    assert ledger["latest_build"]["invocation_id"].startswith("aaaaaaaa")


def test_run_results_without_ledger_are_reported_as_latest_build(tmp_path, monkeypatch):
    service = _service(tmp_path, monkeypatch, {"active": False})
    _write_run_results(service, "dddddddd-0000-0000-0000-000000000000", "2026-10-11T08:00:00Z", ["monthly_sales"])

    report = service.gold_builds()
    rows = _by_name(report)
    assert report["latest_build"]["short_id"] == "dddddddd"
    assert report["latest_build"]["command"] is None
    assert rows["monthly_sales"]["rebuilt_by_latest"] is True
    assert rows["store_performance"]["rebuilt_by_latest"] is False
    assert rows["store_performance"]["last_build"] is None
