// Architecture tab concept smoke: by default the vendored standalone viewer renders the generated
// concept spec v1 document (embed handshake load/ready, options layered + fit + embed chrome, the whole
// layer cake inside the frame); `?conceptViewer=0` falls back to the static
// SVG; the download button serves the same bytes as the API. Writes 2 captures to qa-artifacts/.
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";

const baseURL = process.env.QA_BASE_URL || "http://127.0.0.1:5173";
await mkdir("qa-artifacts", { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1300 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));

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

  // 1. Default: the embedded viewer accepts the document and draws its nodes.
  await openArchitecture();
  await page.locator('.faConcept[data-viewer="ready"][data-viewer-result="ok"]').waitFor({ timeout: 30_000 });
  const warnings = await page.locator(".faConcept").getAttribute("data-viewer-warnings");
  if (warnings !== "0") throw new Error(`viewer reported ${warnings} warning(s) for the generated spec`);
  const iframe = page.locator("iframe.faConceptFrame");
  if ((await iframe.getAttribute("sandbox")) !== "allow-scripts") throw new Error("viewer iframe must be sandboxed (allow-scripts only)");
  const viewer = page.frameLocator("iframe.faConceptFrame");
  const root = viewer.locator(`[data-testid="concept-viewer"][data-spec="${spec.id}"]`);
  await root.waitFor({ state: "attached", timeout: 30_000 });
  // Options applied: layer cake, fit, embed chrome (no example gallery, no open/URL/paste inside the app).
  for (const [attr, value] of [["data-view", "layered"], ["data-fit", "true"], ["data-chrome", "embed"]]) {
    if ((await root.getAttribute(attr)) !== value) throw new Error(`viewer ${attr}=${await root.getAttribute(attr)}, expected ${value}`);
  }
  if (await viewer.getByRole("navigation", { name: "Examples" }).count()) throw new Error("embed chrome must hide the example gallery");
  for (const name of ["Open file", "URL", "Paste"]) {
    if (await viewer.getByRole("button", { name, exact: true }).count()) throw new Error(`embed chrome must hide ${name}`);
  }
  for (const node of spec.nodes) {
    await viewer.locator(`[data-testid="concept-layered"] [data-node="${node.id}"]`).first().waitFor({ state: "attached", timeout: 10_000 });
  }
  await viewer.locator(`[data-testid="concept-layered"] [data-node="web-app"]`).first().waitFor({ state: "visible", timeout: 10_000 });
  await iframe.scrollIntoViewIfNeeded();
  // The whole diagram is inside the frame (no corner zoom).
  const frameBox = await iframe.boundingBox();
  const svgBox = await viewer.locator('[data-testid="concept-layered"] svg').first().boundingBox();
  if (!frameBox || !svgBox) throw new Error("viewer frame or diagram has no box");
  if (svgBox.x < frameBox.x - 1 || svgBox.y < frameBox.y - 1 || svgBox.x + svgBox.width > frameBox.x + frameBox.width + 1
    || svgBox.y + svgBox.height > frameBox.y + frameBox.height + 1) {
    throw new Error(`diagram ${JSON.stringify(svgBox)} is not inside the frame ${JSON.stringify(frameBox)}`);
  }
  await page.screenshot({ path: "qa-artifacts/concept-01-viewer.png", fullPage: true });

  // 2. Opt-out: static SVG fallback, no iframe; the download equals the API document.
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
  await page.screenshot({ path: "qa-artifacts/concept-02-fallback-download.png", fullPage: true });

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("CONCEPT_SMOKE_PASS viewer=ready");
} finally {
  await browser.close();
}
