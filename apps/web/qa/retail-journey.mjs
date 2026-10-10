// Real browser journey for the retail product (07-contoso UX01-UX04, F11). Driven phase by phase by
// tools/qa_retail_journey.py, which owns the API/web processes, restarts and fault injection.
//
//   node qa/retail-journey.mjs <phase> <state.json>
//
// Every phase reads and extends the shared state file and leaves screenshots in QA_EVIDENCE_DIR.
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const [phase, statePath] = process.argv.slice(2);
const base = process.env.QA_BASE_URL || "http://127.0.0.1:5180";
const dir = process.env.QA_EVIDENCE_DIR || "qa-artifacts/retail-journey";
await mkdir(dir, { recursive: true });
let state = {};
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch { state = {}; }
state.phases ??= {};
const record = { checks: [], exceptions: [], httpErrors: [], allowedHttpErrors: [] };
// The api-down phase starts with the API stopped: every /api error there is the expected state.
let expectFailure = phase === "api-down";

const browser = await chromium.launch();
// One browser profile across phases (like a real user): browser-side history survives an API restart.
const storagePath = `${statePath}.storage.json`;
let storageState;
try { storageState = JSON.parse(await readFile(storagePath, "utf8")); } catch { storageState = undefined; }
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState });
const page = await context.newPage();
page.on("pageerror", e => record.exceptions.push(e.message));
page.on("response", r => {
  if (r.status() >= 400) (expectFailure ? record.allowedHttpErrors : record.httpErrors).push({ url: r.url(), status: r.status() });
});

async function api(path, init) {
  const response = await page.request.fetch(`${base}${path}`, init);
  return { status: response.status(), body: await response.json().catch(() => null) };
}
async function settle() { await page.locator("[data-route-ready]").first().waitFor({ state: "attached", timeout: 180000 }).catch(() => {}); }
async function ready() { await page.locator(".workspaceProjectBar select:not([disabled])").waitFor({ timeout: 300000 }); }
async function nav(name) {
  await page.locator("aside").getByRole("button", { name, exact: true }).click();
  await page.locator(".pageTitle").getByText(name, { exact: true }).waitFor();
  await settle();
}
async function snap(name, check) {
  await page.screenshot({ path: `${dir}/${phase}-${name}.png`, fullPage: true });
  record.checks.push(check ?? name);
  console.log(`[${phase}] ${check ?? name}`);
}
async function workspaceSelect() { return page.getByRole("combobox", { name: "Local workspace", exact: true }); }
async function createWorkspace(name) {
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("New workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await dialog.getByText(`Workspace ${name} created.`).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}
async function switchWorkspace(id) {
  const select = await workspaceSelect();
  await Promise.all([page.waitForEvent("load"), select.selectOption(id)]);
  await page.getByText("Contoso Data Studio").first().waitFor();
  await page.waitForFunction(value => document.querySelector('select[aria-label="Local workspace"]')?.value === value, id, { timeout: 60000 });
  assert.equal((await api("/api/health")).body.workspace_id, id);
}
async function openProject(scenario) {
  await ready();
  await page.getByRole("combobox", { name: "Switch project", exact: true }).selectOption(scenario);
  await ready();
  await page.locator(".pageTitle").getByText("Charts", { exact: true }).waitFor({ timeout: 300000 });
  const projectState = (await api("/api/workspace/project-state")).body;
  assert.equal(projectState.active_scenario, scenario);
  assert.equal(projectState.ready, true);
  return projectState;
}
async function runQuery(sql) {
  await nav("Query");
  await page.locator("textarea").fill(sql);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator("table tbody tr").first().waitFor({ timeout: 60000 });
  assert.equal(await page.locator(".errorText").count(), 0);
  return (await api("/api/query", { method: "POST", data: { sql, limit: 10 } })).body.rows;
}
async function exportGold() {
  await nav("Charts");
  const panel = page.locator(".exportPanel");
  await panel.scrollIntoViewIfNeeded();
  await panel.getByRole("combobox", { name: "Gold table to export" }).selectOption("monthly_sales");
  const before = (await api("/api/exports")).body.exports.length;
  await panel.getByRole("button", { name: "Export artifact" }).click();
  for (let i = 0; (await api("/api/exports")).body.exports.length <= before; i++) {
    if (i > 240) throw new Error("export did not appear within 120 s");
    await page.waitForTimeout(500);
  }
  await panel.locator(".exportLatest").waitFor();
  return (await api("/api/exports")).body.exports[0];
}
const REVENUE_SQL = "select scenario, round(sum(revenue),2) as revenue from contoso.gold.monthly_sales group by 1";
const RETAIL_GOLD = "contoso.gold.monthly_sales_by_country";
const EXECUTIVE = { "X-Local-User": "u-eva" };
function note(check) { record.checks.push(check); console.log(`[${phase}] ${check}`); }
async function sql(statement, limit = 5000) {
  const result = await api("/api/query", { method: "POST", data: { sql: statement, limit } });
  assert.equal(result.status, 200, `query failed (${result.status}): ${JSON.stringify(result.body)} for ${statement}`);
  assert.equal(result.body.truncated, false, `query truncated: ${statement}`);
  return result.body.rows;
}
async function latestSnapshot() {
  const result = await api("/api/lakehouse/snapshots?limit=1");
  assert.equal(result.status, 200);
  return Number(result.body.snapshots[0].snapshot_id);
}
const cents = value => Math.round(Number(value) * 100);
// Content digest of retail Gold at one snapshot: equal digests = identical rows (no writeback).
async function goldFingerprint(snapshot) {
  const [row] = await sql(
    `select count(*) as row_count, CAST(sum(revenue) AS DECIMAL(18,2)) as revenue, ` +
    `md5(string_agg(concat_ws('|', scenario, order_month, channel, store_country, sales_lines, revenue), ';' ` +
    `ORDER BY scenario, order_month, channel, store_country)) as digest from ${RETAIL_GOLD} AT (VERSION => ${snapshot})`);
  return { snapshot, rows: Number(row[0]), revenue: String(row[1]), digest: row[2] };
}
async function exportIds() { return (await api("/api/exports")).body.exports.map(e => e.export_id).sort(); }
async function openManage() {
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("list", { name: "Workspaces" }).waitFor();
  return dialog;
}

try {
  await page.goto(base, { waitUntil: phase === "api-down" ? "load" : "networkidle" });
  await page.getByText("Contoso Data Studio").first().waitFor();

  if (phase === "build") {
    // UX01 + UX04: two isolated workspaces, each prepared through the real UI and pipeline.
    await createWorkspace("Journey A");
    await createWorkspace("Journey B");
    await switchWorkspace("journey-a");
    const a = await openProject("retail-baseline");
    await snap("a-charts", "UX01 workspace A: Retail baseline prepared to Gold (generate, Bronze, dbt build, quality)");
    await nav("Explore");
    await page.locator(".inspectPane").getByText("Parquet · 10,000 rows", { exact: true }).waitFor({ timeout: 60000 });
    await snap("a-parquet", "UX01 Parquet metadata and actual row count inspected");
    await nav("Lakehouse");
    await page.locator(".layer .selected").waitFor();
    await snap("a-lakehouse", "UX01 Bronze/Silver/Gold catalog visible");
    await nav("Transform");
    await page.locator(".dagNode").first().waitFor();
    await snap("a-transform", "UX01 dbt lineage and run results visible");
    const revenueA = await runQuery(REVENUE_SQL);
    assert.equal(revenueA[0][0], "retail-baseline");
    await snap("a-query", "UX01 Gold queried through read-only SQL");
    const exportA = await exportGold();
    assert.equal(exportA.lineage.dbt_run.status, "success");
    assert.equal(exportA.lineage.generator_run.scenario, "retail-baseline");
    await snap("a-export", "UX02 datapass.artifact export from the UI with lineage receipt");
    await nav("Apps");
    await page.getByRole("tab", { name: "Architecture" }).click();
    await page.locator("iframe, .conceptFallback, svg").first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    await snap("a-architecture", "UX02 architecture concept in the embedded viewer");

    await switchWorkspace("journey-b");
    assert.equal(await page.locator(".queryHistory button, .historyList button").count(), 0);
    await openProject("online-migration");
    await nav("Query");
    assert.equal(await page.getByText("No queries run yet.").count(), 1, "workspace B must not show A's query history");
    const revenueB = await runQuery(REVENUE_SQL);
    assert.equal(revenueB[0][0], "online-migration");
    assert.equal((await api("/api/exports")).body.exports.length, 0, "workspace B must not list A's exports");
    await snap("b-query", "UX04 workspace B has its own Gold, history and exports");
    state.workspaceA = { scenario: a.active_scenario, revenue: revenueA[0][1], exportId: exportA.export_id, invocation: exportA.lineage.dbt_run.invocation_id };
    state.workspaceB = { revenue: revenueB[0][1] };
  }

  if (phase === "reopen") {
    // UX01: after an API restart the remembered workspace and its catalog reopen without regeneration.
    assert.equal((await api("/api/health")).body.workspace_id, "journey-b");
    await switchWorkspace("journey-a");
    const projectState = (await api("/api/workspace/project-state")).body;
    assert.equal(projectState.active_scenario, "retail-baseline");
    assert.equal(projectState.ready, true);
    await nav("Query");
    assert.equal(await page.getByText("No queries run yet.").count(), 0, "workspace A keeps its query history");
    const revenue = await runQuery(REVENUE_SQL);
    assert.equal(revenue[0][1], state.workspaceA.revenue);
    assert.equal((await api("/api/exports")).body.exports[0].export_id, state.workspaceA.exportId);
    await snap("a-reopened", "UX01 catalog, Gold result, history and exports reopened after API restart");
    await nav("Charts");
    await page.locator(".kpiGrid").waitFor();
    await snap("a-charts-reopened", "UX01 chart over reopened Gold");
  }

  if (phase === "fault-broken") {
    // UX03: the orchestrator broke gold/monthly_sales.sql in the fixture copy.
    await nav("Transform");
    expectFailure = true;
    await page.getByRole("button", { name: "Build", exact: true }).click();
    await page.getByRole("button", { name: "Building...", exact: true }).waitFor({ state: "detached", timeout: 300000 });
    for (let i = 0; ; i++) {
      const status = (await api("/api/dbt/status")).body;
      if (status.latest_run?.results.some(r => r.unique_id.endsWith(".monthly_sales") && r.status === "error")) break;
      if (i > 240) throw new Error("failed monthly_sales run not reported within 120 s");
      await page.waitForTimeout(500);
    }
    await snap("transform-failed", "UX03 failed dbt build visible with model error");
    await nav("Charts");
    await page.locator(".exportPanel").getByRole("button", { name: "Export artifact" }).click();
    await page.locator(".exportPanel [role=alert]").getByText("status 'error'", { exact: false }).waitFor({ timeout: 60000 });
    await snap("export-refused", "UX03 export refused while the latest model run failed");
    expectFailure = false;
  }

  if (phase === "fault-repaired") {
    await nav("Transform");
    await page.getByRole("button", { name: "Build", exact: true }).click();
    await page.getByRole("button", { name: "Building...", exact: true }).waitFor({ state: "detached", timeout: 300000 });
    const repaired = await exportGold();
    assert.equal(repaired.lineage.dbt_run.status, "success");
    assert.notEqual(repaired.lineage.dbt_run.invocation_id, state.workspaceA.invocation);
    const status = (await api("/api/dbt/status")).body;
    assert.ok(status.latest_run.results.every(r => r.status === "success" || r.status === "pass"));
    await snap("export-after-repair", "UX03 export after repair references the new successful dbt run");
    state.repairedExport = { exportId: repaired.export_id, invocation: repaired.lineage.dbt_run.invocation_id, path: null };
  }

  if (phase === "mapping") {
    // FR-02: optional retail Gold -> app read (GOLD-MAPPING.md section 3) on the repaired journey-a Gold.
    assert.equal((await api("/api/health")).body.workspace_id, "journey-a");
    const before = await latestSnapshot();
    const read = await api("/api/fabric-apps/sales-forecasting/retail-actuals", { headers: EXECUTIVE });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const actuals = read.body;
    assert.equal(actuals.enabled, true);
    assert.equal(actuals.ready, true, actuals.error);
    assert.deepEqual(actuals.unmapped, []);
    assert.equal(actuals.provenance.kind, "copy");
    assert.equal(actuals.provenance.authoritative, false);
    const snapshot = Number(actuals.provenance.snapshot_id);
    assert.ok(Number.isInteger(snapshot) && snapshot >= before, `provenance snapshot ${snapshot} vs latest ${before}`);
    const perDepartment = {};
    for (const code of ["ONLINE", "NORD", "SOUTH"]) {
      const items = actuals.items.filter(item => item.department_code === code);
      assert.ok(items.length > 0, `department ${code} has no retail actuals`);
      perDepartment[code] = { items: items.length, amount: items.reduce((sum, item) => sum + cents(item.amount), 0) / 100 };
    }
    assert.ok(actuals.items.every(item => item.department_code in perDepartment), "unexpected department code");
    const appCents = actuals.items.reduce((sum, item) => sum + cents(item.amount), 0);

    // Same snapshot, same per-group rounding as the app read: CAST(sum(revenue) AS DECIMAL(18,2)) per Gold group.
    const [[groups, goldTotal]] = await sql(
      `select count(*) as group_count, sum(amount) as total from (select CAST(sum(revenue) AS DECIMAL(18,2)) as amount ` +
      `from ${RETAIL_GOLD} AT (VERSION => ${snapshot}) group by scenario, order_month, channel, store_country)`);
    const goldCents = cents(goldTotal);
    const diffCents = Math.abs(appCents - goldCents);
    assert.ok(diffCents <= Number(groups), `app total ${appCents / 100} vs Gold total ${goldCents / 100} (${groups} groups)`);

    // Every (channel, store_country) pair in Gold lands in exactly one department of the served mapping.
    const departments = actuals.provenance.departments;
    const pairs = await sql(`select channel, store_country, count(*) as months from ${RETAIL_GOLD} AT (VERSION => ${snapshot}) group by 1, 2 order by 1, 2`);
    const coverage = pairs.map(([channel, country, months]) => {
      const matches = Object.entries(departments)
        .filter(([, slice]) => slice.channel === channel && (!slice.countries || slice.countries.includes(country)))
        .map(([code]) => code);
      return { channel, store_country: country, gold_rows: Number(months), departments: matches };
    });
    for (const pair of coverage) assert.equal(pair.departments.length, 1, `${pair.channel}/${pair.store_country} maps to ${pair.departments}`);

    // No writeback: retail Gold content is identical before and after the read. The app-lab mirror writes its own
    // bronze.sfapp_* snapshots meanwhile, so the global latest snapshot id may move; Gold must not.
    await page.waitForTimeout(3000);
    const after = await latestSnapshot();
    const fingerprintBefore = await goldFingerprint(before);
    const fingerprintAfter = await goldFingerprint(after);
    assert.deepEqual({ ...fingerprintAfter, snapshot: 0 }, { ...fingerprintBefore, snapshot: 0 }, "retail Gold changed during the app read");
    let compare = null;
    if (after !== before) {
      const result = await api(`/api/lakehouse/compare?schema=gold&table=monthly_sales_by_country&base=${before}&target=${after}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.base.row_count, result.body.target.row_count);
      compare = { base: result.body.base, target: result.body.target };
    }
    const later = (await api("/api/lakehouse/snapshots?limit=50")).body.snapshots
      .filter(s => Number(s.snapshot_id) > before)
      .map(s => ({ snapshot_id: s.snapshot_id, changes: s.changes, commit_message: s.commit_message }));
    note(`FR-02 retail actuals: ONLINE/NORD/SOUTH non-empty, unmapped [], copy + non-authoritative, app total ${appCents / 100} = Gold ${goldCents / 100} at snapshot #${snapshot}`);
    note(`FR-02 ${coverage.length} Gold (channel, store_country) pairs each map to exactly one department`);
    note(`FR-02 no Gold writeback: monthly_sales_by_country digest equal at snapshots #${before} and #${after}`);
    state.mapping = {
      snapshot, items: actuals.items.length, perDepartment, appTotal: appCents / 100, goldTotal: goldCents / 100,
      goldGroups: Number(groups), diffCents, coverage, departments,
      noWriteback: { before: fingerprintBefore, after: fingerprintAfter, compare, snapshotsSinceRead: later },
    };
  }

  if (phase === "backup") {
    // FR-02: back up workspace journey-a from the UI (Manage -> Back up); the orchestrator then restarts the API.
    assert.equal((await api("/api/health")).body.workspace_id, "journey-a");
    const ids = await exportIds();
    assert.ok(ids.includes(state.workspaceA.exportId) && ids.includes(state.repairedExport.exportId), `journey-a exports: ${ids}`);
    const dialog = await openManage();
    const row = dialog.getByRole("list", { name: "Workspaces" }).getByRole("listitem").filter({ has: page.locator("b", { hasText: /^Journey A$/ }) });
    await row.getByRole("button", { name: "Back up", exact: true }).click();
    const notice = dialog.getByText(/^Backup journey-a-\S+\.zip written/);
    await notice.waitFor({ timeout: 300000 });
    const backup = (await notice.textContent()).match(/^Backup (\S+\.zip) written/)[1];
    assert.ok((await api("/api/workspaces")).body.backups.some(item => item.backup === backup), `backup ${backup} not listed`);
    await snap("backup", `FR-02 workspace journey-a backed up from the UI (${backup})`);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    state.backup = { backup, exportIds: ids };
  }

  if (phase === "restore") {
    // FR-02: after an API restart, restore the backup as a NEW workspace and prove it holds the same Gold and exports.
    assert.equal((await api("/api/health")).body.workspace_id, "journey-a");
    const name = "Journey A restored";
    const dialog = await openManage();
    await dialog.getByLabel("Name for the restored workspace").fill(name);
    const row = dialog.getByRole("list", { name: "Backups" }).getByRole("listitem").filter({ hasText: state.backup.backup });
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await dialog.getByText(`Restored into new workspace ${name}.`, { exact: false }).waitFor({ timeout: 300000 });
    await snap("restore", `FR-02 backup ${state.backup.backup} restored as new workspace "${name}" after API restart`);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const restored = (await api("/api/workspaces")).body.workspaces.find(item => item.name === name);
    assert.ok(restored, `restored workspace ${name} not listed`);
    assert.notEqual(restored.id, "journey-a");
    assert.equal(restored.restored_from?.backup, state.backup.backup);
    await switchWorkspace(restored.id);
    const revenue = await runQuery(REVENUE_SQL);
    assert.equal(revenue[0][0], "retail-baseline");
    assert.equal(revenue[0][1], state.workspaceA.revenue);
    const ids = await exportIds();
    assert.deepEqual(ids, state.backup.exportIds);
    assert.ok(ids.includes(state.workspaceA.exportId) && ids.includes(state.repairedExport.exportId));
    await snap("restored-query", `FR-02 restored workspace ${restored.id}: Gold revenue ${revenue[0][1]} and ${ids.length} export ids equal journey-a`);
    await switchWorkspace("journey-a");
    assert.deepEqual(await exportIds(), state.backup.exportIds);
    note("FR-02 switched back to journey-a after the restore check");
    state.restore = { workspace: restored.id, name, backup: state.backup.backup, revenue: revenue[0][1], exportIds: ids };
  }

  if (phase === "api-down") {
    // F11: the orchestrator stopped the API before this phase.
    expectFailure = true;
    await page.getByRole("alert").getByText("The local API is not reachable", { exact: false }).waitFor({ timeout: 30000 });
    await snap("api-down", "F11 disconnected API shown with recovery command");
  }

  if (phase === "ux") {
    // F11: keyboard operation, reduced motion and phone width on the reopened product.
    await page.keyboard.press("Tab");
    let focused = "";
    for (let i = 0; i < 25 && !/Projects|Query/.test(focused); i++) {
      await page.keyboard.press("Tab");
      focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    }
    assert.match(focused, /Projects|Query/);
    await page.keyboard.press("Enter");
    await settle();
    await snap("keyboard", "F11 navigation reachable and operable by keyboard");
    await nav("Generate");
    await page.locator(".scenarioLibrary button").first().waitFor();
    await snap("generate", "F01 Generate view with scenario library, seed and scale");
    await nav("Query");
    expectFailure = true;
    await page.locator("textarea").fill("select no_such_column from contoso.gold.monthly_sales");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.locator(".errorText").filter({ hasText: /no_such_column/i }).first().waitFor({ timeout: 30000 });
    await snap("query-error", "F04 failed query shows the database error");
    await page.locator("textarea").fill("drop table contoso.gold.monthly_sales");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.locator(".errorText").filter({ hasText: /read-only|not allowed/i }).first().waitFor({ timeout: 30000 });
    await snap("query-denied", "F04 mutating SQL denied by the read-only workbench");
    expectFailure = false;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "networkidle" });
    await nav("Charts");
    await page.locator(".kpiGrid").waitFor({ timeout: 60000 });
    await snap("reduced-motion", "F11 reduced-motion rendering");
    await page.setViewportSize({ width: 390, height: 844 });
    await nav("Charts");
    await page.locator(".kpiGrid").waitFor({ timeout: 60000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    record.phoneOverflowPx = overflow;
    assert.ok(overflow <= 1, `page overflows the 390px phone viewport by ${overflow}px`);
    await snap("phone", `F11 phone width 390px (horizontal overflow ${overflow}px)`);
  }

  assert.deepEqual(record.exceptions, []);
  assert.deepEqual(record.httpErrors, []);
  record.ok = true;
} catch (error) {
  record.ok = false;
  record.error = String(error?.stack ?? error);
  await page.screenshot({ path: `${dir}/${phase}-failure.png`, fullPage: true }).catch(() => {});
} finally {
  state.phases[phase] = record;
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await context.storageState({ path: storagePath }).catch(() => {});
  await browser.close();
}
if (!record.ok) { console.error(record.error); process.exit(1); }
