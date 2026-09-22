# Architecture

Contoso Data Studio is a local-first analytical lab:

```text
Scenario -> Generate -> Inspect -> Bronze -> Transform -> Silver -> Gold -> Query -> Chart
```

## Modules

| Module | Responsibility |
| --- | --- |
| Generate | deterministic business scenarios |
| Lakehouse | DuckLake schemas, tables, files, snapshots |
| Transform | dbt models, tests, lineage, runs |
| Query | DuckDB SQL workbench |
| Explore | Parquet / JSON / CSV / XLSX inspection |
| Charts | dbt Charts boards |
| Canvas | lineage / architecture / notes |

## Layer contract

**Bronze**: source-shaped generated data.

**Silver**: cleaned, typed reusable business entities.

**Gold**: purpose-built marts and KPI tables.

## Planned scenarios

1. Retail baseline
2. Online migration
3. Margin pressure
4. Logistics delays
5. Currency exposure
6. Demand shock / recovery

## Licensing boundary

Do not vendor GPL viewer implementations. Rebuild file-inspection UX through DuckDB and our own React UI.
