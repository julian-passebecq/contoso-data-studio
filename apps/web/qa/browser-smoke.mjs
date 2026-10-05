import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const baseURL = process.env.QA_BASE_URL || "http://127.0.0.1:5173";
await mkdir("qa-artifacts", { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

async function snap(name) {
  await page.screenshot({ path: `qa-artifacts/${name}.png`, fullPage: true });
}

try {
  await page.goto(baseURL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByText("Contoso Data Studio").waitFor();

  await page.locator('.groupTile').filter({hasText:'Samples'}).click();
  const prepare = page.getByRole("button", { name: "Open project", exact:true }).first();
  await prepare.click();
  await page.getByText("Retail Sales 101 is ready", { exact: false }).waitFor({ timeout: 180_000 });
  await page.locator('.pageTitle').getByText('Charts',{exact:true}).waitFor();
  await snap("01-project-ready");

  for (const name of ["Explore", "Lakehouse", "Transform", "Query", "Charts", "Canvas"]) {
    await page.locator("aside").getByRole("button", { name }).click();
    await page.locator(".pageTitle").getByText(name, { exact: true }).waitFor();
    await page.waitForTimeout(300);
  }

  await page.locator("aside").getByRole("button", { name: "Projects" }).click();
  await page.locator(".pageTitle").getByText("Projects", { exact: true }).waitFor();

  // Re-open the guided project and verify the product still reports the prepared state.
  await page.getByRole("button", { name: "View guide" }).first().click();
  await page.getByText("Retail Sales 101").last().waitFor();
  await page.getByText("steps complete", { exact: true }).waitFor();

  await snap("02-guided-navigation-complete");
  console.log("BROWSER_SMOKE_PASS");
} finally {
  await browser.close();
}
