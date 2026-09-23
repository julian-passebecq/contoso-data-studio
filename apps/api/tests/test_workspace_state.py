from app.services.workspace_state import WorkspaceStateService


class FakeGenerator:
    def __init__(self, scenario: str | None):
        self.scenario = scenario

    def active_run(self):
        if self.scenario is None:
            return None
        return {"scenario": self.scenario, "run_id": "run-1"}


class FakeDuckLake:
    def __init__(self, gold_scenario: str | None):
        self.gold_scenario = gold_scenario

    def catalog(self):
        return [
            {"schema": "bronze", "name": "sales"},
            {"schema": "silver", "name": "stg_sales"},
            {"schema": "gold", "name": "monthly_sales"},
        ]

    def query(self, _sql: str, _limit: int):
        if self.gold_scenario is None:
            raise RuntimeError("Gold is not available")
        return ["scenario"], [[self.gold_scenario]], False


class FakeDbt:
    def quality(self):
        return {"summary": {"total": 12}}

    def lineage(self):
        return {"nodes": [{"id": "model.gold.monthly_sales"}], "edges": []}


def test_project_state_ready_when_gold_matches_active_scenario():
    state = WorkspaceStateService(
        FakeGenerator("margin-pressure"),
        FakeDuckLake("margin-pressure"),
        FakeDbt(),
    ).state()

    assert state["gold_current"] is True
    assert state["ready"] is True
    assert state["layers"] == {"bronze": 1, "silver": 1, "gold": 1}


def test_project_state_rejects_stale_gold_from_previous_scenario():
    state = WorkspaceStateService(
        FakeGenerator("margin-pressure"),
        FakeDuckLake("retail-baseline"),
        FakeDbt(),
    ).state()

    assert state["active_scenario"] == "margin-pressure"
    assert state["gold_scenarios"] == ["retail-baseline"]
    assert state["gold_current"] is False
    assert state["ready"] is False


def test_project_state_handles_missing_gold_without_failing():
    state = WorkspaceStateService(
        FakeGenerator("retail-baseline"),
        FakeDuckLake(None),
        FakeDbt(),
    ).state()

    assert state["gold_scenarios"] == []
    assert state["gold_current"] is False
    assert state["ready"] is False
