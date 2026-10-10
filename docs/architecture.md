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

## Workspaces

`WorkspaceRegistry` (`apps/api/app/services/workspaces.py`) resolves the active workspace; `Settings.load()` returns it
everywhere. A workspace owns `contoso.ducklake.sqlite`, `contoso.ducklake.files/`, `staging/`, `imports/`, `exports/`,
`fabric-apps/` and (named workspaces) `dbt-target/`. dbt and dct always receive the workspace's absolute catalog/data
paths and target path through `Settings.dbt_env()`. The legacy `workspace/` folder is the `default` workspace and keeps
`dbt/target` for compatibility. Switching waits for the current catalog lock (dbt/project open), rebinds every service
and resets the app lab.

## Result exports

`ExportService` (`apps/api/app/services/exports.py`) turns a built Gold table into a `datapass.artifact` v1 bundle with
the vendored MosaicStudio writer (`vendor/datapass-artifact`, pinned studio-v0.8.1). It is a view, not a computation:
no dbt or generator run; a failed or missing latest model run blocks the export. Contract note: the published
`artifact.schema.json` at studio-v0.8.1 predates the additive lineage fields (`producer`, `inputs`, `inputHash`) that
Mosaic's TypeScript validator accepts; Contoso validates against the TypeScript validator and the Python mirror.
Since MosaicStudio `f3a02bc` (#46) the published schema declares those fields: `tools/open_in_mosaic.mjs` checks the
export strictly against it (required gate), next to the TypeScript, semantic and concept-viewer gates, and opens the
bundle in Mosaic's UI. The vendored copies under `vendor/` stay at studio-v0.8.1.

## Primary workbenches

| Page | Current responsibility |
| --- | --- |
| Projects | guided case-study launcher; prepares deterministic sample data through dbt Gold |\n| Generate | manual scenario generation with custom row count and seed |
| Lakehouse | browse Bronze / Silver / Gold catalog state |
| Transform | inspect dbt DAG, run `build` / `test`, inspect `run_results.json` |
| Query | read-only DuckDB SQL against the attached DuckLake catalog |
| Explore | inspect generated/imported Parquet, JSON, CSV and XLSX |
| Charts | preview Gold KPIs and validate the dbt Charts board |
| Canvas | catalog-driven lineage/architecture whiteboard and local notes |
| Apps | Fabric-style operational app lab and the Architecture concept (vendored concept viewer) |

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

## Scenario library

The v1 project library exposes five implemented deterministic scenarios:

1. **Retail baseline** — general revenue, margin, channel and country analysis
2. **Online migration** — channel-share shift and store cannibalization
3. **Margin pressure** — discounting and cost inflation
4. **Logistics delays** — fulfilment time and service-level degradation
5. **Currency exposure** — FX volatility and normalized revenue

A guided scenario provides:

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

1. richer Silver/Gold dimensional model and referential-integrity tests
2. richer file-import controls and file lifecycle in `workspace/imports`
3. additional business scenarios such as demand shock / recovery
4. automatic tutorial progress signals from workspace state
5. richer Canvas edges derived from dbt manifest lineage
6. optional desktop packaging once the local web workflow is stable
