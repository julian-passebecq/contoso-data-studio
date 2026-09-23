# Architecture

Contoso Data Studio is a **local-first synthetic data engineering lab**. Its product boundary is:

```text
Generate -> Inspect -> DuckLake Bronze -> dbt Silver -> dbt Gold -> Query / Charts
                                      \-> lineage Canvas
```

The app deliberately stops before semantic-model/DAX execution.

## Runtime topology

```text
React + Fluent UI 2 (Vite)
        |
        | HTTP / localhost
        v
FastAPI
  |------ GeneratorService ------> staging/<run-id>/*.parquet
  |------ ExplorerService -------> Parquet / JSON / CSV / XLSX
  |------ DuckLakeService -------> workspace/contoso.ducklake.sqlite
  |------ DbtService ------------> dbt CLI / dbt-duckdb
  \------ ChartsService ---------> optional isolated dct CLI

DuckDB is the local query/compute engine.
DuckLake owns managed analytical table storage. SQLite stores the local DuckLake metadata catalog so separate API/dbt clients can reconnect to the same lakehouse; managed table data remains Parquet.
```

## Primary workbenches

| Page | Current responsibility |
| --- | --- |
| Generate | deterministic Retail Baseline generation; future scenario presets |
| Lakehouse | browse Bronze / Silver / Gold catalog state |
| Transform | inspect dbt DAG, run `build` / `test`, inspect `run_results.json` |
| Query | read-only DuckDB SQL against the attached DuckLake catalog |
| Explore | inspect generated/imported Parquet, JSON, CSV and XLSX |
| Charts | preview Gold KPIs and validate the dbt Charts board |
| Canvas | catalog-driven lineage/architecture whiteboard and local notes |

## Data layers

### Staging

Immutable output of one generator run:

```text
workspace/staging/<run-id>/
  customer.parquet
  product.parquet
  store.parquet
  sales.parquet
  manifest.json
```

### Bronze

Source-shaped copies inside DuckLake:

```text
contoso.bronze.customer
contoso.bronze.product
contoso.bronze.store
contoso.bronze.sales
```

### Silver

Cleaned reusable dbt models. The first model is:

```text
contoso.silver.stg_sales
```

### Gold

Business-facing marts/KPIs. The first mart is:

```text
contoso.gold.monthly_sales
```

## Tool/process boundaries

### DuckLake

Use the official DuckDB DuckLake extension. The local metadata catalog is SQLite because this app has multiple local clients (FastAPI and dbt); dbt runs DuckLake work with one thread to avoid concurrent staging-relation issues. Do not fork DuckLake for application logic.

### dbt

`dbt-duckdb==1.11.0` is an optional API environment dependency. FastAPI invokes the local dbt CLI synchronously and reads `target/run_results.json`.

### dbt Charts

dbt Charts is kept in a **separate tool environment**:

```bash
uv tool install dbt-charts --with dbt-duckdb==1.11.0
```

The repository owns auditable YAML boards; `dct serve` remains the canonical live renderer. The React Charts page is a lightweight Gold-data preview and control/status surface, not a dbt Charts reimplementation.

## Safety boundaries

- Explorer paths are resolved and constrained inside `workspace/`.
- dbt Charts board validation is constrained inside `charts/`.
- Query accepts one read-only SQL statement and rejects mutating/admin commands.
- Generated/imported files are local; no cloud service is required.
- GPL DuckSQL/ParquetViewer source is not vendored. Their useful UX is recreated through DuckDB APIs.

## Scenario roadmap

1. **Retail baseline** — implemented
2. Online migration
3. Margin pressure
4. Logistics delays
5. Currency exposure
6. Demand shock / recovery

A scenario should provide:

```text
generator preset
business brief
expected questions/KPIs
dbt starter models
dbt data tests
Gold output contract
dbt Charts board
```

## Next engineering slices

1. run ledger + generator manifest history
2. DuckLake snapshot/time-travel browser
3. richer Silver/Gold dimensional model and referential-integrity tests
4. richer file-import controls and file lifecycle in `workspace/imports`
5. additional business scenarios
6. richer Canvas edges derived from dbt manifest lineage
7. optional desktop packaging once the local web workflow is stable
