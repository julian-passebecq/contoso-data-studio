from __future__ import annotations

from typing import Any


class WorkspaceStateService:
    def __init__(self, generator: Any, ducklake: Any, dbt: Any):
        self.generator = generator
        self.ducklake = ducklake
        self.dbt = dbt

    def state(self) -> dict[str, Any]:
        active_run = self.generator.active_run()
        active_scenario = (
            str(active_run.get("scenario"))
            if isinstance(active_run, dict) and active_run.get("scenario")
            else None
        )

        tables = self.ducklake.catalog()
        layers = {
            layer: sum(1 for table in tables if table.get("schema") == layer)
            for layer in ("bronze", "silver", "gold")
        }

        gold_scenarios: list[str] = []
        try:
            _, rows, _ = self.ducklake.query(
                "select scenario from contoso.gold.monthly_sales group by 1 order by 1",
                20,
            )
            gold_scenarios = [str(row[0]) for row in rows if row and row[0] is not None]
        except Exception:
            gold_scenarios = []

        gold_current = bool(
            active_scenario
            and len(gold_scenarios) == 1
            and gold_scenarios[0] == active_scenario
        )

        quality = self.dbt.quality()
        lineage = self.dbt.lineage()
        quality_total = int((quality.get("summary") or {}).get("total") or 0)
        lineage_nodes = len(lineage.get("nodes") or [])

        ready = bool(
            active_scenario
            and gold_current
            and all(layers[layer] > 0 for layer in ("bronze", "silver", "gold"))
            and quality_total > 0
            and lineage_nodes > 0
        )

        return {
            "active_run": active_run,
            "active_scenario": active_scenario,
            "gold_scenarios": gold_scenarios,
            "gold_current": gold_current,
            "layers": layers,
            "quality_total": quality_total,
            "lineage_nodes": lineage_nodes,
            "ready": ready,
        }
