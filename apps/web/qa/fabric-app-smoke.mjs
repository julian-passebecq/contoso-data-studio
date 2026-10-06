// Fabric-style app smoke: edit a forecast as finance, follow it to the Gold chart, then check
// the executive view is read only. Writes 2 captures to qa-artifacts/.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const baseURL = process.env.QA_BASE_URL || "http://127.0.0.1:5173";
const APP = "/api/fabric-apps/sales-forecasting";
await mkdir("qa-artifacts", { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const t0 = Date.now();
const log = message => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`);

try {
  // Deterministic synthetic data, mirrored and built into Gold before the UI opens.
  await page.request.post(`${baseURL}${APP}/reset`);
  await page.request.post(`${baseURL}${APP}/mirror/run?gold=true`, { timeout: 300_000 });
  log("reset + Gold built");

  await page.goto(baseURL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator("aside").getByRole("button", { name: "Apps" }).click();
  await page.getByText("Sales Forecasting", { exact: true }).waitFor();
  await page.getByLabel("Role switcher").selectOption("u-ana");
  const input = page.getByLabel("Forecast NORD 2026-03");
  await input.waitFor({ timeout: 30_000 });

  // Client-side validation blocks a bad value before any call.
  await input.fill("-12");
  await page.locator('tr[data-row="NORD-2026-03"]').getByRole("button", { name: "Save" }).click();
  await page.getByRole("alert").filter({ hasText: "at least 0" }).waitFor();

  const value = 654321;
  await input.fill(String(value));
  await page.getByLabel("Note NORD 2026-03").fill("Smoke test campaign uplift");
  await page.locator('tr[data-row="NORD-2026-03"]').getByRole("button", { name: "Save" }).click();
  log("forecast saved");

  // The write travels SQL DB -> mirror -> endpoint -> Gold -> chart.
  await page.locator('.faStage.done[data-stage="chart"]').waitFor({ timeout: 240_000 });
  log("data path complete");
  await page.locator('g[data-month="2026-03"]').hover();
  await page.locator(".faTooltip").getByText("Forecast 654,321", { exact: false }).waitFor({ timeout: 10_000 });
  await page.locator(".faSide th").getByText("Amount", { exact: true }).waitFor({ timeout: 60_000 });
  const latency = await page.locator('.faStage[data-stage="mirror"] > span').innerText();
  log(`mirror stage: ${latency}`);
  await page.screenshot({ path: "qa-artifacts/fabric-app-01-finance-writeback.png", fullPage: true });

  // Executive: every department, no inputs (policy: read only).
  await page.getByLabel("Role switcher").selectOption("u-eva");
  await page.locator('tr[data-row="SOUTH-2026-01"]').waitFor({ timeout: 30_000 });
  if (await page.locator(".faTable input").count()) throw new Error("Executive view must be read only");
  const rows = await page.locator(".faTable tbody tr").count();
  if (rows !== 36) throw new Error(`Executive should see 36 forecast rows, saw ${rows}`);
  const visible = await page.request.post(`${baseURL}${APP}/data/Forecast/query`, {
    headers: { "X-Local-User": "u-eva" }, data: { select: ["id"], first: 1 },
  });
  const [{ id }] = (await visible.json()).items;
  const denied = await page.request.patch(`${baseURL}${APP}/data/Forecast`, {
    headers: { "X-Local-User": "u-eva" },
    data: { filter: { id }, patch: { amount: 1 } },
  });
  if (denied.status() !== 403) throw new Error(`Executive write should be 403, got ${denied.status()}`);
  await page.locator('g[data-month="2026-03"]').hover();
  await page.screenshot({ path: "qa-artifacts/fabric-app-02-executive-readonly.png", fullPage: true });

  console.log("FABRIC_APP_SMOKE_PASS");
} finally {
  await browser.close();
}
