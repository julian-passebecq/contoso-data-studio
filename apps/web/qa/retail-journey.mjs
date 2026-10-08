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
let expectFailure = false;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  await (await workspaceSelect()).waitFor();
  assert.equal(await (await workspaceSelect()).inputValue(), id);
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
  await page.waitForFunction(async n => (await (await fetch("/api/exports")).json()).exports.length > n, before, { timeout: 120000 });
  await panel.locator(".exportLatest").waitFor();
  return (await api("/api/exports")).body.exports[0];
}
const REVENUE_SQL = "select scenario, round(sum(revenue),2) as revenue from contoso.gold.monthly_sales group by 1";

try {
  await page.goto(base, { waitUntil: "networkidle" });
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
    await page.getByRole("button", { name: "Build", exact: true }).waitFor({ timeout: 300000 });
    await page.waitForFunction(async () => {
      const status = await (await fetch("/api/dbt/status")).json();
      return status.latest_run && status.latest_run.results.some(r => r.unique_id.endsWith(".monthly_sales") && r.status === "error");
    }, null, { timeout: 120000 });
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
    await page.getByRole("button", { name: "Build", exact: true }).waitFor({ timeout: 300000 });
    const repaired = await exportGold();
    assert.equal(repaired.lineage.dbt_run.status, "success");
    assert.notEqual(repaired.lineage.dbt_run.invocation_id, state.workspaceA.invocation);
    const status = (await api("/api/dbt/status")).body;
    assert.ok(status.latest_run.results.every(r => r.status === "success" || r.status === "pass"));
    await snap("export-after-repair", "UX03 export after repair references the new successful dbt run");
    state.repairedExport = { exportId: repaired.export_id, invocation: repaired.lineage.dbt_run.invocation_id, path: null };
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "networkidle" });
    await nav("Charts");
    await snap("reduced-motion", "F11 reduced-motion rendering");
    await page.setViewportSize({ width: 390, height: 844 });
    await nav("Charts");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    record.phoneOverflowPx = overflow;
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
  await browser.close();
}
if (!record.ok) { console.error(record.error); process.exit(1); }
