// Architecture tab concept smoke: the download button serves the generated concept spec v1 file,
// the static SVG is the fallback when the viewer flag is off, and the flag on shows the embedded
// viewer (or, until it is vendored, a notice plus the fallback). Writes 2 captures to qa-artifacts/.
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";

const baseURL = process.env.QA_BASE_URL || "http://127.0.0.1:5173";
await mkdir("qa-artifacts", { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });

async function openArchitecture(query = "") {
  await page.goto(`${baseURL}/${query}`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator("aside").getByRole("button", { name: "Apps" }).click();
  await page.getByRole("tab", { name: "Architecture" }).click();
  await page.locator(".faConceptSummary").getByText("SYNTHETIC").waitFor({ timeout: 30_000 });
}

try {
  const api = await page.request.get(`${baseURL}/api/fabric-apps/concept`);
  if (!api.ok()) throw new Error(`concept endpoint ${api.status()}`);
  const body = await api.text();
  const spec = JSON.parse(body);
  if (spec.format !== "datapass.concept-spec" || spec.provenance !== "synthetic") throw new Error("not a synthetic concept spec");

  // 1. Flag off: static SVG fallback + download button.
  await openArchitecture("?conceptViewer=0");
  if ((await page.locator(".faConcept").getAttribute("data-viewer")) !== "off") throw new Error("viewer flag should be off");
  await page.locator('.faArch g[data-layer="auth"]').waitFor();
  if (await page.locator(".faConceptFrame").count()) throw new Error("no iframe when the flag is off");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download concept file" }).click(),
  ]);
  if (download.suggestedFilename() !== "contoso-sales-forecasting.concept.json") throw new Error(`filename ${download.suggestedFilename()}`);
  const saved = await readFile(await download.path(), "utf-8");
  if (saved !== body) throw new Error("downloaded file differs from the API document");
  await page.screenshot({ path: "qa-artifacts/concept-01-fallback-download.png", fullPage: true });

  // 2. Flag on: embedded viewer when vendored, otherwise the notice and the fallback.
  await openArchitecture("?conceptViewer=1");
  await page.locator('.faConcept[data-viewer="ready"], .faConcept[data-viewer="missing"]').waitFor({ timeout: 15_000 });
  const state = await page.locator(".faConcept").getAttribute("data-viewer");
  if (state === "ready") {
    await page.locator("iframe.faConceptFrame[sandbox='allow-scripts']").waitFor();
  } else {
    await page.getByRole("note").filter({ hasText: "not vendored yet" }).waitFor();
    await page.locator('.faArch g[data-layer="lake"]').waitFor();
  }
  await page.screenshot({ path: "qa-artifacts/concept-02-flag-on.png", fullPage: true });
  console.log(`CONCEPT_SMOKE_PASS viewer=${state}`);
} finally {
  await browser.close();
}
