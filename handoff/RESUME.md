# Resume - contoso-data-studio lane 07-contoso (2026-10-09)

- Surface: Claude Code desktop, model claude-opus-5-5; native session id not exposed (null).
- Repo/worktree: `D:\PROJ\contoso-data-studio\.claude\worktrees\contoso-retail-v1`, branch `claude/contoso-retail-v1`,
  PR https://github.com/julian-passebecq/contoso-data-studio/pull/14. Qualified commit in `OUTCOME.json`; the later
  commit adds receipts/docs and makes the journey record the dbt-core version (evidence field only).
- Contracts: producer of `datapass.artifact` v1 and `datapass.concept-spec` 1.0.0, consumer pinned to
  datapass-mosaicstudio `studio-v0.8.1` (8b22d9c). Vendored copies under `vendor/datapass-artifact/` are byte-exact.
- Acceptance: all F01-F12 and UX01-UX04 recorded in `ACCEPTANCE.md` with evidence; partials are labelled there.
- Processes: none left running (journey servers on 8010/5180 stop with the script; debug servers stopped).
  `qa-evidence/` and `.qa-tmp/` are gitignored local scratch and can be deleted.
- Pending: CI on PR #14 (`ci.yml`, `qa-browser.yml` with the journey), merge by the PM/watch.py, peer findings
  in `PEER-FINDINGS.md`. No cloud, Fabric or user gate is open.
- Re-qualify: `python tools/qa_retail_journey.py --mosaic <datapass-mosaicstudio checkout>` (Windows or Linux),
  `pytest -q apps/api/tests`, web tests on Node 22. No unattended auto-resume is authorized.
