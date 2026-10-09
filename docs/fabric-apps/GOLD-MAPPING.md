# Gold ↔ app mapping and the Rayfin boundary

Acceptance 07-contoso/F08. The declared mapping lives in
[`apps/api/app/services/fabric_apps/mapping.py`](../../apps/api/app/services/fabric_apps/mapping.py)
and is checked by `apps/api/tests/test_rayfin_boundary.py`. Line numbers below are as of this change.

## Authority rule

- **DuckLake/dbt Gold (`contoso.gold.*`) is the analytical truth.** Only `dbt build` writes it.
- The Rayfin-style app copy (SQLite operational store + the `contoso.bronze.sfapp_*` mirror) is a
  **copy with its own provenance**, labelled `kind: "copy"`, `authoritative: false`
  (`mapping.py:25` `AUTHORITY`, `mirror.py:186` `provenance()`). It never replaces retail Gold.
- No Fabric or cloud call, no Rayfin fork, no FOIL data in this path.

## What flows where today

```text
app (SQLite)  ──mirror worker──▶  contoso.bronze.sfapp_*  ──dbt build──▶  contoso.gold.forecast_vs_actual
   ▲ writeback (finance users)        copy + _mirrored_at                 app Gold, read-only for the app
retail contoso.gold.* (monthly_sales, …)  ──╳──  app      (optional read, declared, disabled)
```

### 1. App → Bronze (mirror, `APP_TO_BRONZE`, `mapping.py:33`)

| App entity (SQLite table) | Bronze table | Columns | Transform |
|---|---|---|---|
| `Department` (`Departments`) | `contoso.bronze.sfapp_departments` | all model columns + `_mirrored_at` | `CAST` to the DuckDB type of the model column (`mirror.py:238-242`) |
| `Forecast` (`Forecasts`) | `contoso.bronze.sfapp_forecasts` | same | same |
| `Actual` (`Actuals`) | `contoso.bronze.sfapp_actuals` | same | same |

`bronze_table()` (`mirror.py:35`) reads this mapping and refuses an undeclared entity. A full batch
replaces the table (`mirror.py:139`); an incremental batch deletes and re-inserts changed ids
(`mirror.py:146-148`). Each batch is one DuckLake snapshot with commit author `fabric-app-mirror`.

### 2. Bronze → app Gold (`BRONZE_TO_APP_GOLD`, `mapping.py:47`; dbt `dbt/models/fabric_apps/gold/forecast_vs_actual.sql`)

| Gold column | Source (Bronze table.column) | Transform |
|---|---|---|
| `month` | `sfapp_forecasts.month` | group key |
| `department_code` | `sfapp_departments.code` | join on `department_id = id` |
| `department_name` | `sfapp_departments.name` | join on `department_id = id` |
| `forecast_amount` | `sfapp_forecasts.amount` | sum per department and month, `decimal(18,2)` |
| `actual_amount` | `sfapp_actuals.amount` | sum per department and month, left join, `decimal(18,2)` |
| `variance` | `sfapp_actuals.amount`, `sfapp_forecasts.amount` | `actual_amount - forecast_amount` |
| `variance_pct` | same | variance / forecast, null when forecast is 0 or actual missing |
| `last_editor` | `sfapp_forecasts.updated_by` | max over non-`seed` editors |
| `forecast_mirrored_at` | `sfapp_forecasts._mirrored_at` | max mirror time (row provenance) |
| `built_at` | none | `current_timestamp` at dbt build (Gold provenance) |

The app reads it back through the read-only SQL path (`routers/fabric_apps.py:152`), scoped by department.

### 3. Retail Gold → app (`RETAIL_GOLD_TO_APP`, `mapping.py:74`) — optional, **disabled**

| Retail Gold column | App field | Transform | Enabled |
|---|---|---|---|
| `monthly_sales.order_month` | `Actual.month` | `strftime(order_month, '%Y-%m')` | no |
| `monthly_sales.revenue` | `Actual.amount` | sum per month for the department's channel/countries | no |

Today `Actual` rows are the **synthetic seed** in `store.py:131` (`reset`), not retail Gold. Wiring this
read needs a product decision (how retail channels and countries map to `NORD`/`SOUTH`/`ONLINE`). If it is
wired, the copied rows must carry the Gold table, the DuckLake snapshot id and the read time, and stay
labelled as a copy.

### 4. Writeback

Finance users write `Forecast` (and may create rows) in the app only, through the policy-checked store
(`store.py:322` validation, `store.py:364` owner check). An app write creates **no** lake snapshot; it
reaches Bronze only at the next mirror batch, and app Gold only at the next `dbt build`. There is **no
app → retail Gold writeback** (`describe()["writeback_to_gold"] is None`); no fabric_apps code issues a
write against `contoso.gold` (tested).

## Provenance fields

| Where | Field | Meaning |
|---|---|---|
| every Bronze row | `_mirrored_at` | time of the batch that copied it (`mirror.py:241`) |
| DuckLake | snapshot id, commit `fabric-app-mirror`, message `mirror seq a..b` | one per batch; time travel via `AT (VERSION => n)` |
| `POST /mirror/run` → `mirrored.provenance`, `GET /mirror/status` → `provenance` | `kind`, `authoritative`, `authority`, `source`, `targets`, `row_provenance_column`, `commit_author`, `last_mirrored_seq`, `last_batch` (`seqs`, `full`, `snapshot_id`, `mirrored_at`, `row_mirrored_at`), `app_gold.last_build` | added by this change (`mirror.py:186`, `routers/fabric_apps.py:125`) |
| app Gold rows | `forecast_mirrored_at`, `built_at` | which mirror state and which build produced the row |
| SQLite `_rayfin_mirror` | `snapshot_id`, `gold_snapshot_id`, `gold_ok` per change seq | stage trace (`GET /trace`) |

## Stale or missing Gold

- No app Gold table yet: `GET /gold` returns `{"ready": false, "items": []}` (`routers/fabric_apps.py:165`); no row is invented.
- dbt missing: `refresh_gold` raises (`mirror.py:251`), the router answers 409.
- Bronze missing or dbt failing: `last_gold.ok` is `false` with the dbt output tail, also shown in `provenance.app_gold.last_build`.
- Stale: an app write is visible in `GET /mirror/status` as `pending` until mirrored; compare
  `provenance.last_batch.mirrored_at` with Gold `forecast_mirrored_at`/`built_at`.

## Not supported

- Retail Gold → app reads (declared, disabled, see 3).
- Any app → retail Gold write, or editing app Gold outside `dbt build`.
- Real Fabric mirroring, OneLake, SQL analytics endpoint or Entra ID (see [README](README.md), [ADR-001](ADR-001.md)).
- Per-row snapshot ids inside Bronze (use `_mirrored_at` plus DuckLake snapshots).
