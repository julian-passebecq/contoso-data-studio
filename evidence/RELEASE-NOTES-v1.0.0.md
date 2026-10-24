Contoso Data Studio v1.0.0 is the **qualified local V1** of the synthetic Contoso retail data lab.

The local workflow is:

**Guided project → Generate → Parquet Explorer → DuckLake Bronze → dbt Silver/Gold → SQL, lineage, quality and charts → Canvas.**

### Included in local V1

- Deterministic Contoso retail project generation with persisted Parquet artifacts.
- Parquet exploration with sample data, schema, metadata, column statistics and row-group inspection.
- Persistent DuckLake Bronze tables with independent-process reopen and snapshot/time-travel inspection.
- dbt Silver transformations and six Gold marts: monthly_sales, channel_performance, delivery_metrics, currency_exposure, product_performance and store_performance.
- Read-only SQL against real Gold data.
- dbt model lineage, model inspection and data-quality results.
- Gold KPI charts, the Executive Sales board contract and dbt Charts board validation.
- Canvas showing the end-to-end local architecture and dependencies.
- The Retail Sales 101 guided project, with all 7/7 steps completing and progress persisting after reload.
- Stale Gold protection when changing the active scenario, with readiness restored after rebuilding.

### Qualification

Qualified revision: `c63446b122038735e400a4129a6eb540bfda8101`.

- 79 Python/API tests passed.
- 7 frontend tests passed; web typecheck and production build passed.
- The 10,000-row, seed-42 Retail Baseline flow passed through Parquet, persistent DuckLake, dbt Silver/Gold and analytical queries.
- 70 quality checks passed, with 0 failures and 0 errors.
- Stale Gold rejection and rebuilt scenario readiness passed.
- Windows Chromium qualification passed for Projects, Explore, Lakehouse, Transform, Query, Charts and Canvas, including guided progress persisting at 7/7 after reload.
- [Main CI run 37214660014](https://github.com/julian-passebecq/contoso-data-studio/actions/runs/37214660014) succeeded for this revision.

### Scope and known non-blocking issues

This release qualifies the local Python/FastAPI and React/TypeScript workflow. It makes no cloud/provider production-readiness claim.

Known non-blocking issues are two moderate npm audit findings in development dependencies, a Keyborg development diagnostic, and minor responsive/layout polish. No P0/P1 issue was found during qualification.

### Getting started

Use the repository's [local setup instructions](https://github.com/julian-passebecq/contoso-data-studio/blob/v1.0.0/README.md). The qualified Windows baseline used Python 3.12 and Node.js 22. API/web component version metadata is preserved exactly as qualified; `v1.0.0` identifies this product release.

GitHub's automatically generated source ZIP and tarball are available. No installer or custom binary assets are published because the repository does not define a canonical packaging mechanism.
