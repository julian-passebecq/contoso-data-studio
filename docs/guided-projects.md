# Guided sample projects

Contoso Data Studio opens with a project library so a new workspace does not feel empty.

Each project uses the same executable product flow:

```text
Project preset
  -> deterministic Parquet sample data
  -> DuckLake Bronze
  -> dbt Silver
  -> dbt Gold
  -> DuckDB SQL
  -> KPI / Charts / lineage review
```

The **Open + prepare demo** action generates 10,000 sales rows with seed 42, loads Bronze, and runs `dbt build`. This creates a complete local case study before the learner opens the individual workbenches.

## Projects

| Project | Scenario | Level | Main Gold mart |
| --- | --- | --- | --- |
| Retail Sales 101 | `retail-baseline` | Beginner | `store_performance` |
| Online Channel Shift | `online-migration` | Intermediate | `channel_performance` |
| Margin Crisis | `margin-pressure` | Intermediate | `monthly_sales` |
| Logistics SLA Investigation | `logistics-delays` | Intermediate | `delivery_metrics` |
| FX Exposure | `currency-exposure` | Advanced | `currency_exposure` |

## Guided path

Every project uses the same seven-step learning structure:

1. Prepare the complete demo.
2. Inspect generated Parquet files in **Explore**.
3. Browse Bronze / Silver / Gold in **Lakehouse**.
4. Read the dbt DAG and test output in **Transform**.
5. Run the scenario-specific business query in **Query**.
6. Review Gold KPI output in **Charts**.
7. Review the end-to-end architecture in **Canvas**.

Tutorial progress is stored locally in the browser and can be reset without deleting generated project data.

Progress is completed from real workspace state and interactions:

- **Explore** completes after inspecting the active run's `sales.parquet`.
- **Lakehouse** completes when Bronze, Silver and Gold are present for the active project.
- **Transform** completes when dbt lineage and quality artifacts are available.
- **Query** completes after a successful query against a `contoso.gold.*` mart.
- **Charts** completes when current-scenario Gold KPIs load successfully.
- **Canvas** completes when the active project architecture has catalog or lineage state.

Automatic completion is scoped to the currently selected guided project. Manual **Mark done** controls remain as a fallback.

## Manual mode

The original **Generate** workbench remains available for ad-hoc datasets, different row counts and custom seeds. Guided projects are an onboarding layer over the same generator, DuckLake catalog and dbt project; they do not create a parallel data system.
