#!/usr/bin/env node
/**
 * Scripted product tour of the guided flow, recorded frame by frame.
 *
 *   node tools/record_tour.mjs [--base http://127.0.0.1:5173] [--theme fabric] [--out qa/video] [--ffmpeg <path>]
 *
 * Needs the API + web dev server running (see README) and Playwright installed in apps/web
 * (`npm --prefix apps/web install --no-save playwright@1.56.1`).
 *
 * Determinism: the page runs on a virtual clock. Before every frame the recorder pauses all
 * CSS/Web animations and seeks them to the virtual time, and KPI count-ups read the same clock
 * (window.__tourTime). Real app work (project activation, queries) is awaited with conditions,
 * never sleeps; while it runs, a fixed number of "loading" frames is captured.
 *
 * Output: <out>/frames/*.jpg (30 fps, 1280x720), <out>/stills/*.png, <out>/metadata.json and,
 * when ffmpeg is available (--ffmpeg, $FFMPEG_PATH / $FFMPEG, PATH, or the optional ffmpeg-static package),
 * <out>/contoso-tour.mp4.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireWeb = createRequire(path.join(root, "apps/web/package.json"));
const { chromium } = requireWeb("playwright");

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const BASE = args.base || process.env.QA_BASE_URL || "http://127.0.0.1:5173";
const THEME = args.theme || "fabric";
const OUT = path.resolve(root, args.out || "qa/video");
const FPS = 30;
const FRAME_MS = 1000 / FPS;
const WIDTH = 1280;
const HEIGHT = 720;
const FRAMES_DIR = path.join(OUT, "frames");
const STILLS_DIR = path.join(OUT, "stills");

/* ---------------------------------------------------------------- page-side runtime */
// Injected before the app loads. Only plain inline styles are used for the overlay so the
// overlay itself never registers Web Animations.
function tourRuntime() {
  window.__tourTime = 0;
  const seen = new WeakMap();
  const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp = t => Math.max(0, Math.min(1, t));
  let overlay = null;
  const css = `
    #tour-overlay{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif}
    #tour-cursor{position:absolute;left:0;top:0;width:26px;height:30px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.45))}
    #tour-ripple{position:absolute;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;border:2px solid rgba(110,214,196,.95);background:rgba(110,214,196,.22)}
    #tour-caption{position:absolute;left:40px;bottom:36px;display:flex;align-items:stretch;gap:0;max-width:760px;
      background:rgba(12,15,20,.82);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.09);border-radius:14px;overflow:hidden;
      box-shadow:0 18px 50px rgba(0,0,0,.45)}
    #tour-caption .num{display:grid;place-items:center;min-width:64px;padding:0 14px;font-size:22px;font-weight:700;color:#04201c;
      background:linear-gradient(160deg,#7ad8c8,#38a393)}
    #tour-caption .copy{display:grid;gap:3px;padding:14px 22px 15px 18px}
    #tour-caption b{font-size:21px;font-weight:600;color:#f3f6f9;letter-spacing:-.01em}
    #tour-caption span{font-size:14px;color:#aab4c0}
    #tour-card{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:18px;text-align:center;color:#eef1f5;
      background:radial-gradient(700px 380px at 30% 20%,rgba(56,163,147,.35),transparent 70%),radial-gradient(640px 360px at 75% 85%,rgba(143,127,245,.28),transparent 70%),#0d1014}
    #tour-card .mark{width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,rgba(255,255,255,.25),transparent 55%),linear-gradient(135deg,#5cc0b0,#2a7f73 55%,#6c5fd6);
      box-shadow:0 10px 40px rgba(56,163,147,.45)}
    #tour-card h1{margin:0;font-size:52px;font-weight:650;letter-spacing:-.02em}
    #tour-card p{margin:0;font-size:20px;color:#b7c0cb}
    #tour-card .chips{display:flex;gap:10px;margin-top:6px}
    #tour-card .chips i{font-style:normal;font-size:13px;padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.14);color:#cfe9e4;background:rgba(255,255,255,.04)}
    #tour-card small{font-size:12px;color:#7f8a97;letter-spacing:.08em;text-transform:uppercase;margin-top:10px}
  `;
  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    overlay = document.createElement("div");
    overlay.id = "tour-overlay";
    overlay.innerHTML = `
      <div id="tour-card"><div class="mark"></div><h1></h1><p></p><div class="chips"></div><small></small></div>
      <div id="tour-caption"><div class="num"></div><div class="copy"><b></b><span></span></div></div>
      <div id="tour-ripple"></div>
      <svg id="tour-cursor" viewBox="0 0 26 30"><path d="M3 2 L3 24 L9 18.5 L13 27.5 L17 25.8 L13 17 L21.5 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(overlay);
    return overlay;
  }
  window.__tour = {
    /** Seek every animation in the document to virtual time t (ms). */
    step(t) {
      window.__tourTime = t;
      for (const animation of document.getAnimations()) {
        if (!seen.has(animation)) seen.set(animation, t);
        try {
          animation.pause();
          animation.currentTime = Math.max(0, t - seen.get(animation));
        } catch { /* animation removed */ }
      }
    },
    /** Paint the overlay for one frame. */
    render(s) {
      const o = ensureOverlay();
      const cursor = o.querySelector("#tour-cursor");
      cursor.style.transform = `translate(${s.cursor.x - 3}px, ${s.cursor.y - 2}px) scale(${s.cursor.press ? .88 : 1})`;
      cursor.style.opacity = String(s.cursor.visible);
      const ripple = o.querySelector("#tour-ripple");
      if (s.ripple) {
        const p = clamp(s.ripple.p);
        ripple.style.left = `${s.ripple.x}px`;
        ripple.style.top = `${s.ripple.y}px`;
        ripple.style.transform = `scale(${.25 + ease(p) * .95})`;
        ripple.style.opacity = String((1 - p) * .9);
      } else ripple.style.opacity = "0";
      const caption = o.querySelector("#tour-caption");
      if (s.caption) {
        const p = ease(clamp(s.caption.p));
        caption.querySelector(".num").textContent = s.caption.num;
        caption.querySelector("b").textContent = s.caption.title;
        caption.querySelector("span").textContent = s.caption.sub;
        caption.style.opacity = String(p);
        caption.style.transform = `translateY(${(1 - p) * 22}px)`;
      } else caption.style.opacity = "0";
      const card = o.querySelector("#tour-card");
      if (s.card) {
        card.querySelector("h1").textContent = s.card.title;
        card.querySelector("p").textContent = s.card.sub;
        card.querySelector(".chips").innerHTML = (s.card.chips || []).map(c => `<i>${c}</i>`).join("");
        card.querySelector("small").textContent = s.card.note || "";
        const p = ease(clamp(s.card.p));
        card.style.opacity = String(p);
        card.style.transform = `scale(${1.03 - .03 * p})`;
      } else card.style.opacity = "0";
    },
  };
}

/* ---------------------------------------------------------------- recorder */
const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

class Tour {
  constructor(page) {
    this.page = page;
    this.frame = 0;
    this.cursor = { x: WIDTH * .62, y: HEIGHT * .58, visible: 0, press: false };
    this.ripple = null;
    this.caption = null;
    this.card = null;
    this.scenes = [];
    this.stills = [];
  }
  get t() { return this.frame * FRAME_MS; }

  async shoot() {
    const t = this.t;
    const state = {
      cursor: this.cursor,
      ripple: this.ripple && { x: this.ripple.x, y: this.ripple.y, p: (t - this.ripple.t0) / 520 },
      caption: this.caption && { ...this.caption, p: this.caption.out != null ? 1 - (t - this.caption.out) / 260 : (t - this.caption.t0) / 420 },
      card: this.card && { ...this.card, p: this.card.out != null ? 1 - (t - this.card.out) / 450 : (t - this.card.t0) / 450 },
    };
    await this.page.evaluate(({ t, state }) => new Promise(resolve => {
      window.__tour.step(t);
      window.__tour.render(state);
      // Two animation frames: React state from the count-up clock commits, then paint.
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__tour.step(t); resolve(); }));
    }), { t, state });
    const file = path.join(FRAMES_DIR, `${String(this.frame).padStart(5, "0")}.jpg`);
    await this.page.screenshot({ path: file, type: "jpeg", quality: 92, animations: "allow", caret: "hide" });
    if (this.ripple && t - this.ripple.t0 > 560) this.ripple = null;
    if (this.caption?.out != null && t - this.caption.out > 280) this.caption = null;
    if (this.card?.out != null && t - this.card.out > 470) this.card = null;
    this.frame += 1;
  }

  async hold(seconds) {
    const frames = Math.round(seconds * FPS);
    for (let i = 0; i < frames; i += 1) await this.shoot();
  }

  async still(name, note) {
    const file = path.join(STILLS_DIR, `${name}.png`);
    await this.page.screenshot({ path: file, type: "png", animations: "allow", caret: "hide" });
    this.stills.push({ file: path.relative(OUT, file).replaceAll("\\", "/"), frame: this.frame, time_s: +(this.t / 1000).toFixed(2), note });
  }

  scene(num, title, sub) {
    if (this.caption) this.caption.out = this.t;
    this.pendingCaption = { num, title, sub };
    this.scenes.push({ num, title, sub, start_s: +(this.t / 1000).toFixed(2) });
  }

  async showCaption() {
    if (!this.pendingCaption) return;
    if (this.caption?.out != null) await this.hold(.3);
    this.caption = { ...this.pendingCaption, t0: this.t };
    this.pendingCaption = null;
  }

  async cardIn(card) { this.card = { ...card, t0: this.t }; }
  async cardOut() { if (this.card) this.card.out = this.t; }

  async moveTo(x, y, seconds = .7) {
    const from = { x: this.cursor.x, y: this.cursor.y };
    const frames = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= frames; i += 1) {
      const p = easeInOut(i / frames);
      // A gentle arc instead of a straight line reads as a human hand.
      const arc = Math.sin(Math.PI * p) * Math.min(40, Math.hypot(x - from.x, y - from.y) * .08);
      this.cursor.x = from.x + (x - from.x) * p;
      this.cursor.y = from.y + (y - from.y) * p - arc;
      await this.shoot();
    }
    await this.page.mouse.move(x, y);
  }

  async target(locator) {
    await locator.waitFor({ state: "visible", timeout: 60_000 });
    await this.ensureInView(locator);
    const box = await locator.boundingBox();
    if (!box) throw new Error("Tour target has no bounding box");
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }

  /** Smoothly scroll the window so the locator sits in the upper-middle of the viewport. */
  async ensureInView(locator, { margin = 120 } = {}) {
    const box = await locator.boundingBox();
    if (!box) return;
    if (box.y >= Math.min(margin, 70) && box.y + Math.min(box.height, HEIGHT - 260) <= HEIGHT - 150) return;
    const current = await this.page.evaluate(() => window.scrollY);
    const max = await this.page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    const goal = Math.max(0, Math.min(max, current + box.y - margin));
    await this.scrollTo(goal);
  }

  async scrollTo(goal, seconds = .9) {
    const start = await this.page.evaluate(() => window.scrollY);
    const frames = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= frames; i += 1) {
      const y = start + (goal - start) * easeInOut(i / frames);
      await this.page.evaluate(value => window.scrollTo(0, value), y);
      await this.shoot();
    }
  }

  async click(locator, { settle = .25 } = {}) {
    const point = await this.target(locator);
    await this.moveTo(point.x, point.y);
    this.cursor.press = true;
    await this.shoot();
    await this.page.mouse.click(point.x, point.y);
    this.cursor.press = false;
    this.ripple = { x: point.x, y: point.y, t0: this.t };
    await this.hold(settle);
  }

  /** Capture `seconds` of frames while real work runs, then await its completion condition. */
  async during(work, seconds) {
    const done = work();
    done.catch(() => {});
    await this.hold(seconds);
    await done;
  }
}

/* ---------------------------------------------------------------- storyboard */
async function storyboard(tour, page) {
  const nav = name => page.locator("aside").getByRole("button", { name, exact: true });
  const title = name => page.locator(".pageTitle").getByText(name, { exact: true });
  const workspaceReady = () => page.locator(".workspaceProjectBar select:not([disabled])").waitFor({ timeout: 300_000 });
  const retailCard = page.locator(".projectCard").filter({ hasText: "Retail Sales 101" });

  // 0 · Intro card over the live home page.
  await tour.cardIn({
    title: "Contoso Data Studio",
    sub: "A local lakehouse you can learn by doing",
    chips: ["Parquet", "DuckDB", "DuckLake", "dbt", "Guided projects"],
    note: "Prototype · synthetic data · runs on your machine",
  });
  await tour.hold(2.6);
  await tour.still("01-intro", "Intro card");
  await tour.cardOut();
  await tour.hold(.5);

  // 1 · Portfolio
  tour.scene("01", "Pick a guided project", "Each project ships data, dbt models, quality checks and a dashboard.");
  await tour.showCaption();
  tour.cursor.visible = 1;
  await tour.hold(.6);
  await tour.click(page.locator(".groupTile").filter({ hasText: "Samples" }));
  await retailCard.waitFor();
  await tour.hold(.8);
  await tour.still("02-portfolio", "Samples portfolio with project cards");

  // 2 · Open the project: one click activates the whole lakehouse.
  tour.scene("02", "One click activates the lakehouse", "Generate Parquet → load DuckLake Bronze → dbt Silver and Gold → tests.");
  const openButton = retailCard.getByRole("button", { name: /^Open (project|dashboard)$/ });
  await tour.ensureInView(retailCard, { margin: 90 });
  const openPoint = await tour.target(openButton);
  await tour.showCaption();
  await tour.moveTo(openPoint.x, openPoint.y);
  tour.cursor.press = true;
  await tour.shoot();
  await page.mouse.click(openPoint.x, openPoint.y);
  tour.cursor.press = false;
  tour.ripple = { x: openPoint.x, y: openPoint.y, t0: tour.t };
  await page.evaluate(() => window.scrollTo(0, 0));
  await tour.during(async () => {
    await page.locator(".projectOpening").waitFor({ state: "hidden", timeout: 300_000 });
    if (await page.getByRole("alert").count()) throw new Error(`Project activation failed: ${await page.getByRole("alert").first().innerText()}`);
    await title("Charts").waitFor();
    await page.locator(".kpiValue").first().waitFor({ timeout: 120_000 });
  }, 2.2);

  // 3 · KPIs count up from the Gold marts.
  tour.scene("03", "Gold KPIs, straight from dbt marts", "Revenue, gross margin and units, computed locally in DuckDB.");
  await tour.showCaption();
  await tour.moveTo(WIDTH * .55, HEIGHT * .62, .6);
  await tour.hold(1.6);
  await tour.still("03-kpis", "Charts page: KPI cards after count-up and bar chart");
  await tour.scrollTo(260, 1.1);
  await tour.hold(1.2);
  await tour.scrollTo(0, .8);

  // 4 · Query the business question.
  tour.scene("04", "Answer the business question in SQL", "A read-only DuckDB workbench over Bronze, Silver and Gold.");
  await tour.click(nav("Query"));
  await title("Query").waitFor();
  await tour.showCaption();
  await tour.hold(.7);
  const run = page.getByRole("button", { name: "Run", exact: true });
  const runPoint = await tour.target(run);
  await tour.moveTo(runPoint.x, runPoint.y);
  tour.cursor.press = true;
  await tour.shoot();
  await page.mouse.click(runPoint.x, runPoint.y);
  tour.cursor.press = false;
  tour.ripple = { x: runPoint.x, y: runPoint.y, t0: tour.t };
  await tour.during(() => page.locator("table tbody tr").first().waitFor({ timeout: 60_000 }), .6);
  await tour.hold(.4);
  await tour.scrollTo(300, 1);
  await tour.moveTo(WIDTH * .62, HEIGHT * .55, .5);
  await tour.hold(1.2);
  await tour.still("04-query-results", "Query results table");
  await tour.scrollTo(0, .7);

  // 5 · Lineage
  tour.scene("05", "Trace lineage from Bronze to Gold", "Every Gold mart links back to its sources and its data tests.");
  await tour.click(nav("Transform"));
  await title("Transform").waitFor();
  await page.locator(".dagNode").first().waitFor({ timeout: 60_000 });
  await tour.showCaption();
  await tour.hold(.8);
  const goldNode = page.locator(".dagNode").filter({ hasText: "monthly_sales" }).first();
  await tour.click(goldNode);
  await page.locator(".workbenchTabs").waitFor({ timeout: 60_000 });
  await tour.hold(.4);
  await tour.ensureInView(page.locator(".modelWorkbenchCard"), { margin: 80 });
  await tour.click(page.locator(".workbenchTabs").getByRole("button", { name: "Lineage", exact: true }));
  await page.locator(".nodeLineage").waitFor({ timeout: 60_000 });
  await tour.hold(.3);
  await tour.moveTo(WIDTH * .5, HEIGHT * .45, .5);
  await tour.hold(1.4);
  await tour.still("05-lineage", "Transform: dbt DAG and selected Gold model lineage");
  await tour.scrollTo(0, .7);

  // 6 · Walk the remaining stations quickly; the guide tracks progress on its own.
  tour.scene("06", "Explore files, layers and architecture", "Parquet metadata, DuckLake layers and a live lineage canvas.");
  for (const name of ["Explore", "Lakehouse", "Canvas"]) {
    await tour.click(nav(name), { settle: .1 });
    await title(name).waitFor();
    if (name === "Canvas") await page.locator(".canvasNode").first().waitFor({ timeout: 60_000 });
    if (name === "Lakehouse") await page.locator(".layer .selected").first().waitFor({ timeout: 60_000 }).catch(() => {});
    if (name === "Explore") await page.locator(".inspectPane").first().waitFor({ timeout: 60_000 });
    if (name === "Explore") await tour.showCaption();
    await tour.hold(name === "Canvas" ? 1.6 : 1.1);
  }

  // 7 · Finish: the guide shows every step complete.
  tour.scene("07", "Guided progress tracks itself", "Seven steps, completed from real workspace activity.");
  await tour.click(nav("Projects"));
  await title("Projects").waitFor();
  await workspaceReady();
  await tour.click(retailCard.getByRole("button", { name: "View guide", exact: true }));
  await page.locator(".guidePanel").waitFor();
  await tour.showCaption();
  await tour.ensureInView(page.locator(".guideHeader"), { margin: 70 });
  await tour.moveTo(WIDTH * .78, HEIGHT * .3, .6);
  await tour.hold(1.8);
  await tour.still("06-guide-complete", "Guide panel with all steps complete");
  tour.caption.out = tour.t;
  tour.cursor.visible = 0;

  // Outro
  await tour.cardIn({
    title: "From raw files to decisions",
    sub: "Guided projects · lineage · quality · KPIs — all local",
    chips: ["Fabric-like theme", "Synthetic data", "Open tooling"],
    note: "Contoso Data Studio · prototype",
  });
  await tour.hold(2.4);
}

/* ---------------------------------------------------------------- ffmpeg */
function findFfmpeg() {
  const candidates = [args.ffmpeg, process.env.FFMPEG_PATH, process.env.FFMPEG, "ffmpeg"];
  try { candidates.push(requireWeb("ffmpeg-static")); } catch { /* optional */ }
  for (const candidate of candidates.filter(Boolean)) {
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/* ---------------------------------------------------------------- main */
await rm(FRAMES_DIR, { recursive: true, force: true });
await mkdir(FRAMES_DIR, { recursive: true });
await mkdir(STILLS_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  reducedMotion: "no-preference",
  colorScheme: THEME === "fabric" ? "dark" : "light",
});
const page = await context.newPage();
const problems = [];
page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
await page.addInitScript(tourRuntime);

const tour = new Tour(page);
const started = Date.now();
let status = "PASS";
try {
  await page.goto(`${BASE}/?theme=${encodeURIComponent(THEME)}`, { waitUntil: "networkidle" });
  await page.locator(".groupSwitcher").waitFor({ timeout: 60_000 });
  await page.locator(".workspaceProjectBar select:not([disabled])").waitFor({ timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  await storyboard(tour, page);
} catch (error) {
  status = "FAIL";
  problems.push(error.stack || String(error));
  console.error(error);
  await page.screenshot({ path: path.join(OUT, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}

let video = null;
const ffmpeg = status === "PASS" ? findFfmpeg() : null;
if (ffmpeg) {
  const file = path.join(OUT, "contoso-tour.mp4");
  const encode = spawnSync(ffmpeg, [
    "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(FRAMES_DIR, "%05d.jpg"),
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file,
  ], { encoding: "utf8" });
  if (encode.status === 0 && existsSync(file)) video = { file: path.relative(OUT, file).replaceAll("\\", "/"), bytes: (await stat(file)).size };
  else problems.push(`ffmpeg failed: ${encode.stderr}`);
} else if (status === "PASS") {
  problems.push("ffmpeg not found (--ffmpeg, $FFMPEG_PATH, $FFMPEG, PATH or ffmpeg-static); frames kept, no MP4 encoded.");
}

const metadata = {
  status,
  base_url: BASE,
  theme: THEME,
  fps: FPS,
  resolution: `${WIDTH}x${HEIGHT}`,
  frames: tour.frame,
  duration_s: +(tour.frame / FPS).toFixed(2),
  video,
  scenes: tour.scenes,
  stills: tour.stills,
  problems,
  recorded_in_s: Math.round((Date.now() - started) / 1000),
  generator: "tools/record_tour.mjs",
};
await writeFile(path.join(OUT, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(`TOUR_${status} frames=${tour.frame} duration=${metadata.duration_s}s video=${video ? `${video.file} ${video.bytes} bytes` : "none"}`);
