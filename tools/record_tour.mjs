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
 * (window.__tourTime). Real app work (project activation, queries, route loads) is awaited with
 * conditions, never sleeps. No frame is captured between a navigation click and the moment the
 * new route has settled (`<html data-route-ready>` set by the app + no API request in flight), so
 * the first captured frame of a route starts its short content-area entrance from zero.
 *
 * Camera: an optional eased zoom (CSS transform on <main>) framed on a focus group measured from
 * its bounding boxes at capture time (or, with `content`, from what it actually paints). Scale and
 * pan are solved so the whole focus stays inside the safe frame (right of the rail, below the
 * header, above the caption, with margins) and the content still covers the viewport; when no
 * scale >= MIN_ZOOM achieves both, there is no zoom. The synthetic cursor and click ripple are
 * mapped through the same transform.
 *
 * Quality gate (status FAIL when violated, details in metadata.json `checks`):
 *   - DOM, every frame: at most one route title and one route content area visible, and the
 *     visible title matches the settled route.
 *   - Pixels, every navigation transition: consecutive-frame mean abs difference (grey, 160x90)
 *     above BLEND_DIFF for more than MAX_BLEND_FRAMES frames in a row means a long blend.
 *   - DOM, every frame of every zoom (in, hold, out): no focus element outside the visible content
 *     area (and outside the safe frame at the zoom's goal keyframe), and no group element cut by
 *     an edge (fully in or fully out).
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
const HEADER = 64; // sticky app header height
const SAFE = { top: HEADER + 18, bottom: HEIGHT - 128, left: 40, right: WIDTH - 40 }; // above the lower third
const FRAMES_DIR = path.join(OUT, "frames");
const STILLS_DIR = path.join(OUT, "stills");

/** Blend detector thresholds (grey levels 0-255 on a 160x90 thumbnail). */
const BLEND_DIFF = 2.5;
const MAX_BLEND_FRAMES = 10;
const TRANSITION_WINDOW_S = 1.2;
/** Camera zooms below this scale are skipped (not worth cropping the page for). */
const MIN_ZOOM = 1.12;

/* ---------------------------------------------------------------- page-side runtime */
// Injected before the app loads. Only plain inline styles are used for the overlay so the
// overlay itself never registers Web Animations.
function tourRuntime() {
  window.__tourTime = 0;
  window.__tourInflight = 0;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (...request) => {
    window.__tourInflight += 1;
    return nativeFetch(...request).finally(() => { window.__tourInflight -= 1; });
  };
  const seen = new WeakMap();
  const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp = t => Math.max(0, Math.min(1, t));
  let overlay = null;
  const css = `
    #tour-overlay{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;overflow:hidden}
    #tour-cursor{position:absolute;left:0;top:0;width:26px;height:30px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.45));transform-origin:3px 2px}
    #tour-ripple{position:absolute;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;border:2px solid rgba(110,214,196,.95);background:rgba(110,214,196,.22)}
    #tour-caption{position:absolute;left:40px;bottom:36px;width:640px;height:74px;display:flex;align-items:stretch;
      background:rgba(12,15,20,.86);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.09);border-radius:14px;overflow:hidden;
      box-shadow:0 18px 50px rgba(0,0,0,.45)}
    #tour-caption .num{display:grid;place-items:center;width:64px;flex:0 0 64px;font-size:22px;font-weight:700;color:#04201c;
      background:linear-gradient(160deg,#7ad8c8,#38a393)}
    #tour-caption .copy{display:grid;align-content:center;gap:3px;padding:0 22px 0 18px;min-width:0}
    #tour-caption b,#tour-caption span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #tour-caption b{font-size:21px;font-weight:600;color:#f3f6f9;letter-spacing:-.01em}
    #tour-caption span{font-size:14px;color:#aab4c0}
    #tour-card{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:18px;text-align:center;color:#eef1f5;
      background:radial-gradient(700px 380px at 30% 20%,rgba(56,163,147,.35),transparent 70%),radial-gradient(640px 360px at 75% 85%,rgba(143,127,245,.28),transparent 70%),#0d1014;
      box-shadow:0 0 80px rgba(0,0,0,.6)}
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
  function visible(element) {
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2 || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < .05) return false;
    }
    return true;
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
    /** Camera: scale s around viewport point (cx, cy), then translate (tx, ty). */
    // Only the content area zooms: the transform sits on <main>, and the header and navigation
    // rail are lifted above it, so the shell never moves or gets cropped.
    camera(c) {
      const content = document.querySelector("main");
      const shell = [document.querySelector(".layout>aside"), document.querySelector(".shell>header")].filter(Boolean);
      if (!content) return;
      if (!c || (Math.abs(c.s - 1) < 1e-4 && Math.abs(c.tx) < .01 && Math.abs(c.ty) < .01)) {
        content.style.transform = "";
        content.style.transformOrigin = "";
        for (const node of shell) { node.style.zIndex = ""; node.style.position = ""; }
        return;
      }
      for (const node of shell) {
        if (getComputedStyle(node).position === "static") node.style.position = "relative";
        node.style.zIndex = "40";
      }
      content.style.transformOrigin = `${c.ox}px ${c.oy}px`;
      content.style.transform = `translate(${c.tx}px, ${c.ty}px) scale(${c.s})`;
    },
    /**
     * Screen box of an element. With `content`, the union of what it actually paints (non-blank
     * text runs, plus descendants with a background, border or replaced content), so a wide,
     * mostly empty layout box does not inflate the camera framing.
     */
    box(element, content) {
      const rect = element.getBoundingClientRect();
      if (!content) return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
      const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      const add = r => {
        if (r.width <= 0 || r.height <= 0) return;
        box.left = Math.min(box.left, r.left); box.top = Math.min(box.top, r.top);
        box.right = Math.max(box.right, r.right); box.bottom = Math.max(box.bottom, r.bottom);
      };
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = walker.currentNode; node; node = walker.nextNode()) {
        if (node.nodeType === 3) {
          if (!node.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          add(range.getBoundingClientRect());
          continue;
        }
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const background = style.backgroundColor !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(style.backgroundColor);
        const border = ["Top", "Right", "Bottom", "Left"].some(side => parseFloat(style[`border${side}Width`]) > 0 && !/rgba\([^)]*,\s*0\)$/.test(style[`border${side}Color`]));
        if (node !== element && (background || border || /^(IMG|SVG|CANVAS|VIDEO|svg)$/.test(node.tagName))) add(node.getBoundingClientRect());
      }
      return Number.isFinite(box.left) ? box : null;
    },
    /** Where the content area is really visible: right of the rail, below the header. */
    viewport() {
      const rail = document.querySelector(".layout>aside")?.getBoundingClientRect();
      const header = document.querySelector(".shell>header")?.getBoundingClientRect();
      return { left: rail ? rail.right : 0, top: header ? header.bottom : 0, right: innerWidth, bottom: innerHeight };
    },
    /**
     * Clipping check for the camera: every focus element must sit inside `frame` (or the visible
     * content area when no frame is given); a group element may be fully in or fully out of the
     * visible area, never cut by an edge.
     */
    clipped({ focus, group, content, frame }) {
      const view = window.__tour.viewport();
      const limit = frame ? { left: Math.max(frame.left, view.left), top: Math.max(frame.top, view.top), right: Math.min(frame.right, view.right), bottom: Math.min(frame.bottom, view.bottom) } : view;
      const tol = .75;
      const round = b => b && [b.left, b.top, b.right, b.bottom].map(Math.round);
      const issues = [];
      focus.forEach((element, index) => {
        const b = window.__tour.box(element, content);
        if (!b) return;
        if (b.left < limit.left - tol || b.top < limit.top - tol || b.right > limit.right + tol || b.bottom > limit.bottom + tol) {
          issues.push(`focus ${index} at ${round(b)} outside ${frame ? "safe frame" : "visible area"} ${round(limit)}`);
        }
      });
      group.forEach((element, index) => {
        const b = window.__tour.box(element, false);
        if (!b) return;
        const outside = b.right <= view.left + tol || b.left >= view.right - tol || b.bottom <= view.top + tol || b.top >= view.bottom - tol;
        const inside = b.left >= view.left - tol && b.right <= view.right + tol && b.top >= view.top - tol && b.bottom <= view.bottom + tol;
        if (!outside && !inside) issues.push(`group ${index} at ${round(b)} cut by the visible area ${round(view)}`);
      });
      return issues;
    },
    /** What a viewer would see of routes: visible titles and content areas. */
    probe() {
      const titles = [...document.querySelectorAll("[data-route-title]")].filter(visible).map(node => node.getAttribute("data-route-title"));
      const contents = [...document.querySelectorAll("[data-route]")].filter(visible).map(node => node.getAttribute("data-route"));
      return { titles, contents, ready: document.documentElement.dataset.routeReady || null };
    },
    /** Paint the overlay for one frame. */
    render(s) {
      const o = ensureOverlay();
      const cursor = o.querySelector("#tour-cursor");
      cursor.style.transform = `translate(${s.cursor.x - 3}px, ${s.cursor.y - 2}px) scale(${s.cursor.press ? .86 : 1})`;
      cursor.style.opacity = String(s.cursor.visible);
      const ripple = o.querySelector("#tour-ripple");
      if (s.ripple) {
        const p = clamp(s.ripple.p);
        ripple.style.left = `${s.ripple.x}px`;
        ripple.style.top = `${s.ripple.y}px`;
        ripple.style.transform = `scale(${.25 + (1 - Math.pow(1 - p, 3)) * .95})`;
        ripple.style.opacity = String((1 - p) * .9);
      } else ripple.style.opacity = "0";
      const caption = o.querySelector("#tour-caption");
      if (s.caption) {
        const p = ease(clamp(s.caption.p));
        caption.querySelector(".num").textContent = s.caption.num;
        caption.querySelector("b").textContent = s.caption.title;
        caption.querySelector("span").textContent = s.caption.sub;
        caption.style.opacity = String(p);
        caption.style.transform = `translateY(${(1 - p) * 18}px)`;
      } else caption.style.opacity = "0";
      const card = o.querySelector("#tour-card");
      if (s.card) {
        card.querySelector("h1").textContent = s.card.title;
        card.querySelector("p").textContent = s.card.sub;
        card.querySelector(".chips").innerHTML = (s.card.chips || []).map(c => `<i>${c}</i>`).join("");
        card.querySelector("small").textContent = s.card.note || "";
        // Opaque wipe (never a crossfade): the card slides in from below and out to the top.
        const p = ease(clamp(s.card.p));
        card.style.opacity = "1";
        card.style.transform = `translateY(${s.card.leaving ? -(1 - p) * 100 : (1 - p) * 100}%)`;
      } else card.style.opacity = "0";
    },
  };
}

/* ---------------------------------------------------------------- recorder */
const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const IDENTITY = { s: 1, tx: 0, ty: 0, cx: 0, cy: 0, ox: 0, oy: 0 };

class Tour {
  constructor(page) {
    this.page = page;
    this.frame = 0;
    this.cursor = { x: WIDTH * .62, y: HEIGHT * .58, visible: 0, press: false };
    this.ripple = null;
    this.caption = null;
    this.card = null;
    this.camera = { ...IDENTITY };
    this.scenes = [];
    this.stills = [];
    this.transitions = [];
    this.domViolations = [];
    this.zooms = [];
    this.clipViolations = [];
    this.focus = null; // active camera focus: element handles checked on every frame
  }
  get t() { return this.frame * FRAME_MS; }

  /** Content coordinates -> screen coordinates through the camera. */
  toScreen(x, y) {
    const c = this.camera;
    return { x: c.cx + c.s * (x - c.cx) + c.tx, y: c.cy + c.s * (y - c.cy) + c.ty };
  }

  /** Capture one frame. `keepIf` (checked after the capture) drops a frame whose state changed mid-capture. */
  async shoot({ keepIf } = {}) {
    const t = this.t;
    const cursor = { ...this.cursor, ...this.toScreen(this.cursor.x, this.cursor.y) };
    const ripple = this.ripple && { ...this.toScreen(this.ripple.x, this.ripple.y), p: (t - this.ripple.t0) / 560 };
    const state = {
      cursor,
      ripple,
      caption: this.caption && { ...this.caption, p: this.caption.out != null ? 1 - (t - this.caption.out) / 240 : (t - this.caption.t0) / 380 },
      card: this.card && { ...this.card, leaving: this.card.out != null, p: this.card.out != null ? 1 - (t - this.card.out) / 650 : this.card.instant ? 1 : (t - this.card.t0) / 650 },
    };
    const focus = this.focus && { focus: this.focus.focus, group: this.focus.group, content: this.focus.content, frame: this.focus.keyframe === this.frame ? this.focus.frame : null };
    const probe = await this.page.evaluate(({ t, state, camera, focus }) => new Promise(resolve => {
      window.__tour.camera(camera);
      window.__tour.step(t);
      window.__tour.render(state);
      // Two animation frames: React state from the count-up clock commits, then paint.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__tour.step(t);
        resolve({ ...window.__tour.probe(), clipped: focus ? window.__tour.clipped(focus) : [] });
      }));
    }), { t, state, camera: this.camera, focus });
    const file = path.join(FRAMES_DIR, `${String(this.frame).padStart(5, "0")}.jpg`);
    await this.page.screenshot({ path: file, type: "jpeg", quality: 92, animations: "allow", caret: "hide" });
    if (keepIf && !(await keepIf())) return false; // the next frame overwrites this file
    this.checkProbe(probe);
    if (this.focus) {
      this.focus.record.checked_frames += 1;
      if (probe.clipped.length) {
        this.focus.record.clipped_frames += 1;
        this.clipViolations.push({ frame: this.frame, zoom: this.focus.record.name, issues: probe.clipped });
      }
    }
    if (this.ripple && t - this.ripple.t0 > 600) this.ripple = null;
    if (this.caption?.out != null && t - this.caption.out > 260) this.caption = null;
    if (this.card?.out != null && t - this.card.out > 680) this.card = null;
    this.frame += 1;
    return true;
  }

  checkProbe(probe) {
    const issues = [];
    if (probe.titles.length > 1) issues.push(`${probe.titles.length} route titles visible (${probe.titles.join(", ")})`);
    if (probe.contents.length > 1) issues.push(`${probe.contents.length} route content areas visible (${probe.contents.join(", ")})`);
    if (probe.ready && probe.titles.length === 1 && probe.titles[0] !== probe.ready) issues.push(`title ${probe.titles[0]} while route ${probe.ready} is settled`);
    if (probe.contents.length === 1 && probe.titles.length === 1 && probe.contents[0] !== probe.titles[0]) issues.push(`title ${probe.titles[0]} over ${probe.contents[0]} content`);
    if (issues.length) this.domViolations.push({ frame: this.frame, issues });
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
    if (this.caption?.out != null) await this.hold(.28);
    this.caption = { ...this.pendingCaption, t0: this.t };
    this.pendingCaption = null;
  }

  cardIn(card, { instant = false } = {}) { this.card = { ...card, t0: this.t, instant }; }
  cardOut() { if (this.card) this.card.out = this.t; }

  /** Wait (real time, no frames) until no API request is in flight for two animation frames. */
  async idle(timeout = 120_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      await this.page.waitForFunction(() => window.__tourInflight === 0, null, { timeout: Math.max(1, deadline - Date.now()) });
      const still = await this.page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__tourInflight === 0)))));
      if (still) return;
    }
  }

  /** Wait until `route` has rendered (data-route-ready), its own condition holds and the network is idle. */
  async settled(route, ready) {
    await this.page.waitForFunction(name => document.documentElement.dataset.routeReady === name, route, { timeout: 120_000 });
    if (ready) await ready();
    await this.idle();
    await this.page.evaluate(() => document.fonts.ready);
  }

  async moveTo(x, y, seconds = .7) {
    const from = { x: this.cursor.x, y: this.cursor.y };
    const distance = Math.hypot(x - from.x, y - from.y);
    // Duration follows distance a little so short hops do not crawl.
    const frames = Math.max(4, Math.round(Math.min(seconds, .3 + distance / 1400) * FPS));
    for (let i = 1; i <= frames; i += 1) {
      const p = easeInOut(i / frames);
      // A gentle arc instead of a straight line reads as a human hand.
      const arc = Math.sin(Math.PI * p) * Math.min(36, distance * .07);
      this.cursor.x = from.x + (x - from.x) * p;
      this.cursor.y = from.y + (y - from.y) * p - arc;
      await this.shoot();
    }
    this.cursor.x = x;
    this.cursor.y = y;
    await this.page.mouse.move(x, y);
  }

  async target(locator) {
    await locator.waitFor({ state: "visible", timeout: 60_000 });
    await this.ensureInView(locator);
    const box = await locator.boundingBox();
    if (!box) throw new Error("Tour target has no bounding box");
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }

  /** Scroll only when the locator is outside the safe area; then align its top below the sticky header. */
  async ensureInView(locator) {
    const box = await locator.boundingBox();
    if (!box) return;
    if (box.y >= SAFE.top && box.y + Math.min(box.height, 120) <= SAFE.bottom) return;
    await this.alignTop(locator);
  }

  /** Card-aligned scroll: the element's top edge lands just below the sticky header. */
  async alignTop(locator, seconds = .9) {
    await this.zoomOut();
    const box = await locator.boundingBox();
    if (!box) return;
    const current = await this.page.evaluate(() => window.scrollY);
    const max = await this.page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    const goal = Math.round(Math.max(0, Math.min(max, current + box.y - SAFE.top)));
    await this.scrollTo(goal, seconds);
  }

  async scrollTo(goal, seconds = .9) {
    const start = await this.page.evaluate(() => window.scrollY);
    if (Math.abs(goal - start) < 2) return;
    const frames = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= frames; i += 1) {
      const y = start + (goal - start) * easeInOut(i / frames);
      await this.page.evaluate(value => window.scrollTo(0, value), y);
      await this.shoot();
    }
  }

  /**
   * Eased camera zoom framed on the focus (one locator, or the union of several), inside the
   * safe area: right of the rail, below the header, above the lower third, with margins.
   */
  async zoomTo(focus, { name = "zoom", maxScale = 1.3, seconds = .9, group = null, content = false } = {}) {
    await this.zoomOut();
    // Bounding boxes measured now, at capture time, in screen space (the camera is at identity).
    const focusHandles = (await Promise.all([focus].flat().map(locator => locator.elementHandles()))).flat();
    const groupHandles = group ? await group.elementHandles() : [];
    const geometry = await this.page.evaluate(({ elements, content }) => {
      const r = document.querySelector("main").getBoundingClientRect();
      return {
        boxes: elements.map(element => window.__tour.box(element, content)).filter(Boolean),
        doc: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        view: window.__tour.viewport(),
      };
    }, { elements: focusHandles, content });
    const { boxes, doc, view } = geometry;
    if (!boxes.length) return;
    const box = {
      left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)),
      right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom)),
    };
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    // Safe frame for the focus: inside the visible content area (right of the rail, below the
    // header), above the lower-third caption, with a margin on every side.
    const margin = 28;
    const frame = {
      left: Math.max(doc.left, view.left) + margin, right: Math.min(WIDTH, view.right) - margin,
      top: Math.max(SAFE.top, view.top) + margin / 2, bottom: SAFE.bottom - margin / 2,
    };
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    const mapped = (edge, centre, s) => centre + s * (edge - centre);
    // For scale s: the translations that keep the focus inside the frame, intersected with the
    // ones that keep the zoomed content covering its whole area (no empty band at any edge).
    const solve = s => {
      const range = (lo1, hi1, lo2, hi2, ideal) => {
        const lo = Math.max(lo1, lo2);
        const hi = Math.min(hi1, hi2);
        return lo > hi + 1e-6 ? null : Math.min(hi, Math.max(lo, ideal));
      };
      const tx = range(
        frame.left - mapped(box.left, cx, s), frame.right - mapped(box.right, cx, s),
        WIDTH - mapped(Math.max(doc.right, WIDTH), cx, s), doc.left - mapped(doc.left, cx, s),
        (frame.left + frame.right) / 2 - cx);
      const ty = range(
        frame.top - mapped(box.top, cy, s), frame.bottom - mapped(box.bottom, cy, s),
        HEIGHT - mapped(Math.max(doc.bottom, HEIGHT), cy, s), Math.max(doc.top, HEADER) - mapped(doc.top, cy, s),
        (frame.top + frame.bottom) / 2 - cy);
      return tx == null || ty == null ? null : { tx, ty };
    };
    let s = Math.min(maxScale, (frame.right - frame.left) / width, (frame.bottom - frame.top) / height);
    let shift = null;
    for (; s >= MIN_ZOOM; s -= .01) if ((shift = solve(s))) break;
    const record = {
      name, frame: this.frame, box: { w: Math.round(width), h: Math.round(height) },
      fit_scale: +Math.min((frame.right - frame.left) / width, (frame.bottom - frame.top) / height).toFixed(3),
      scale: shift ? +s.toFixed(3) : 1, used: Boolean(shift), checked_frames: 0, clipped_frames: 0,
    };
    this.zooms.push(record);
    // Too little to gain (or no framing keeps the whole focus in view): no zoom, never below 1.
    if (!shift) { record.reason = `focus ${record.box.w}x${record.box.h} fits the safe frame only at x${record.fit_scale} (< x${MIN_ZOOM})`; return; }
    const { tx, ty } = shift;
    const goal = { s, tx, ty, cx, cy, ox: cx - doc.left, oy: cy - doc.top };
    const frames = Math.round(seconds * FPS);
    // Every frame from here to the end of the zoom-out is checked for clipping; the goal keyframe
    // is also checked against the safe frame (margins, caption).
    this.focus = { focus: focusHandles, group: groupHandles, content, frame, keyframe: this.frame + frames - 1, record };
    for (let i = 1; i <= frames; i += 1) {
      const p = easeInOut(i / frames);
      this.camera = { ...goal, s: 1 + (s - 1) * p, tx: tx * p, ty: ty * p };
      await this.shoot();
    }
  }

  async zoomOut(seconds = .7) {
    const from = this.camera;
    if (from.s === 1 && from.tx === 0 && from.ty === 0) return;
    const frames = Math.round(seconds * FPS);
    for (let i = 1; i <= frames; i += 1) {
      const p = 1 - easeInOut(i / frames);
      this.camera = { ...from, s: 1 + (from.s - 1) * p, tx: from.tx * p, ty: from.ty * p };
      await this.shoot();
    }
    this.camera = { ...IDENTITY };
    this.focus = null;
    await this.page.evaluate(() => window.__tour.camera(null));
  }

  /** Move, press, click; `after` runs in real time before the next frame (nothing half-loaded is filmed). */
  async click(locator, { settle = .25, after } = {}) {
    await this.zoomOut();
    const point = await this.target(locator);
    await this.moveTo(point.x, point.y);
    this.cursor.press = true;
    await this.shoot();
    await this.page.mouse.click(point.x, point.y);
    this.cursor.press = false;
    this.ripple = { x: point.x, y: point.y, t0: this.t };
    if (after) await after();
    else await this.idle();
    await this.hold(settle);
  }

  /** Navigate with the rail; frames resume only once the new route has settled. */
  async navigate(route, button, ready, { settle = .3 } = {}) {
    const start = this.frame;
    await this.click(button, {
      settle,
      after: async () => {
        await this.settled(route, ready);
        const offset = await this.page.evaluate(() => window.scrollY);
        if (offset) console.log(`route ${route} settled at scrollY=${offset}; reset to top`);
        // A new route always starts at the top (before its first frame, so no visible jump).
        await this.page.evaluate(() => window.scrollTo(0, 0));
      },
    });
    this.transitions.push({ name: route, from_frame: start, to_frame: start + Math.round(TRANSITION_WINDOW_S * FPS) });
  }
}

/* ---------------------------------------------------------------- storyboard */
async function storyboard(tour, page) {
  const nav = name => page.locator("aside").getByRole("button", { name, exact: true });
  const workspaceReady = () => page.locator(".workspaceProjectBar select:not([disabled])").waitFor({ timeout: 300_000 });
  const retailCard = page.locator(".projectCard").filter({ hasText: "Retail Sales 101" });

  // 0 · Intro card, then an opaque wipe up reveals the live home page.
  tour.cardIn({
    title: "Contoso Data Studio",
    sub: "A local lakehouse you can learn by doing",
    chips: ["Parquet", "DuckDB", "DuckLake", "dbt", "Guided projects"],
    note: "Prototype · synthetic data · runs on your machine",
  }, { instant: true });
  await tour.hold(2.4);
  await tour.still("01-intro", "Intro card");
  tour.cardOut();
  await tour.hold(.75);

  // 1 · Portfolio
  tour.scene("01", "Pick a guided project", "Each project ships data, dbt models, quality checks and a dashboard.");
  await tour.showCaption();
  tour.cursor.visible = 1;
  await tour.hold(.5);
  await tour.click(page.locator(".groupTile").filter({ hasText: "Samples" }), { after: async () => { await retailCard.waitFor(); await tour.idle(); } });
  await tour.hold(.7);
  await tour.still("02-portfolio", "Samples portfolio with project cards");

  // 2 · Open the project: one click activates the whole lakehouse.
  tour.scene("02", "One click activates the lakehouse", "Generate Parquet → load DuckLake Bronze → dbt Silver and Gold → tests.");
  const openButton = retailCard.getByRole("button", { name: /^Open (project|dashboard)$/ });
  await tour.alignTop(retailCard);
  await tour.showCaption();
  const activationStart = tour.frame;
  let activated = false;
  const activation = (async () => {
    await page.locator(".projectOpening").waitFor({ state: "hidden", timeout: 300_000 });
    if (await page.getByRole("alert").count()) throw new Error(`Project activation failed: ${await page.getByRole("alert").first().innerText()}`);
    await tour.settled("Charts", () => page.locator(".kpiValue").first().waitFor({ timeout: 120_000 }));
    activated = true;
  });
  let work = null;
  await tour.click(openButton, {
    settle: 0,
    after: async () => {
      // The opening panel replaces the content; jump to the top before the next frame is filmed.
      await page.locator(".projectOpening").waitFor({ timeout: 30_000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      work = activation();
      work.catch(() => {});
    },
  });
  // Film the opening panel while activation runs (at most 2.6 s), never the half-loaded dashboard
  // behind it: stop as soon as the panel is gone, then wait for Charts to settle.
  const opening = async () => !activated && (await page.locator(".projectOpening").count()) > 0;
  for (let i = 0; i < Math.round(2.6 * FPS); i += 1) {
    if (!(await opening()) || !(await tour.shoot({ keepIf: opening }))) break;
  }
  await work;
  tour.transitions.push({ name: "Charts (activation)", from_frame: activationStart, to_frame: tour.frame + Math.round(TRANSITION_WINDOW_S * FPS) });
  await tour.hold(.3);

  // 3 · KPIs count up from the Gold marts, then the camera frames them.
  tour.scene("03", "Gold KPIs, straight from dbt marts", "Revenue, gross margin and units, computed locally in DuckDB.");
  await tour.showCaption();
  await tour.moveTo(WIDTH * .56, HEIGHT * .64, .6);
  await tour.hold(.9);
  const kpiCards = page.locator(".kpiGrid > *");
  // The whole KPI row is the focus (and the group that must never be cut by an edge): the camera
  // only zooms when all of it fits the safe frame, otherwise the row stays framed as laid out.
  await tour.zoomTo(kpiCards, { name: "kpis", maxScale: 1.3, group: kpiCards });
  await tour.hold(1.3);
  await tour.still("03-kpis", "Charts page: KPI cards after count-up (whole row in frame)");
  await tour.zoomOut();
  const revenueCard = page.locator("[class*='fui-Card']").filter({ hasText: "Monthly revenue" }).first();
  if (await revenueCard.count()) {
    await tour.alignTop(revenueCard, 1);
    await tour.hold(1.1);
  }
  await tour.scrollTo(0, .8);

  // 4 · Query the business question.
  tour.scene("04", "Answer the business question in SQL", "A read-only DuckDB workbench over Bronze, Silver and Gold.");
  await tour.navigate("Query", nav("Query"), () => page.locator(".sqlEditor").first().waitFor({ timeout: 60_000 }));
  await tour.showCaption();
  await tour.hold(.6);
  const run = page.getByRole("button", { name: "Run", exact: true });
  await tour.click(run, { after: async () => { await page.locator("table tbody tr").first().waitFor({ timeout: 60_000 }); await tour.idle(); } });
  await tour.hold(.4);
  const resultsCard = page.locator("[class*='fui-Card']").filter({ has: page.locator("table") }).first();
  await tour.alignTop(resultsCard, 1);
  await tour.moveTo(WIDTH * .62, HEIGHT * .42, .5);
  await tour.hold(1.2);
  await tour.still("04-query-results", "Query results table");
  await tour.scrollTo(0, .7);

  // 5 · Lineage
  tour.scene("05", "Trace lineage from Bronze to Gold", "Every Gold mart links back to its sources and its data tests.");
  await tour.navigate("Transform", nav("Transform"), () => page.locator(".dagNode").first().waitFor({ timeout: 60_000 }));
  await tour.showCaption();
  await tour.hold(.7);
  const goldNode = page.locator(".dagNode").filter({ hasText: "monthly_sales" }).first();
  await tour.click(goldNode, { after: async () => { await page.locator(".workbenchTabs").waitFor({ timeout: 60_000 }); await tour.idle(); } });
  await tour.hold(.3);
  await tour.alignTop(page.locator(".modelWorkbenchCard"));
  await tour.click(page.locator(".workbenchTabs").getByRole("button", { name: "Lineage", exact: true }),
    { after: async () => { await page.locator(".nodeLineage").waitFor({ timeout: 60_000 }); await tour.idle(); } });
  await tour.hold(.3);
  await tour.moveTo(WIDTH * .5, HEIGHT * .5, .5);
  // Frame what the lineage panel paints (labels, chips, focus node), not its wide empty columns.
  const lineage = page.locator(".nodeLineage");
  await tour.zoomTo(lineage, { name: "lineage", maxScale: 1.4, content: true, group: lineage.locator(".dependencyChip, .lineageFocus") });
  await tour.hold(1.3);
  await tour.still("05-lineage", "Transform: selected Gold model and its lineage (camera framed)");
  await tour.zoomOut();
  await tour.scrollTo(0, .7);

  // 6 · Walk the remaining stations quickly; the guide tracks progress on its own.
  tour.scene("06", "Explore files, layers and architecture", "Parquet metadata, DuckLake layers and a live lineage canvas.");
  const stations = {
    Explore: () => page.locator(".inspectPane").first().waitFor({ timeout: 60_000 }),
    Lakehouse: () => page.locator(".layer .selected").first().waitFor({ timeout: 60_000 }).catch(() => {}),
    Canvas: () => page.locator(".canvasNode").first().waitFor({ timeout: 60_000 }),
  };
  for (const [name, ready] of Object.entries(stations)) {
    await tour.navigate(name, nav(name), ready, { settle: .1 });
    if (name === "Explore") await tour.showCaption();
    await tour.hold(name === "Canvas" ? 1.6 : 1.1);
  }

  // 7 · Finish: the guide shows every step complete.
  tour.scene("07", "Guided progress tracks itself", "Seven steps, completed from real workspace activity.");
  await tour.navigate("Projects", nav("Projects"), workspaceReady);
  await tour.click(retailCard.getByRole("button", { name: "View guide", exact: true }),
    { after: async () => { await page.locator(".guidePanel").waitFor(); await tour.idle(); } });
  await tour.showCaption();
  await tour.alignTop(page.locator(".guidePanel"));
  await tour.moveTo(WIDTH * .78, HEIGHT * .3, .6);
  await tour.hold(1.8);
  await tour.still("06-guide-complete", "Guide panel with all steps complete");
  tour.caption.out = tour.t;
  tour.cursor.visible = 0;
  await tour.hold(.3);

  // Outro: the closing card wipes in over the page.
  tour.cardIn({
    title: "From raw files to decisions",
    sub: "Guided projects · lineage · quality · KPIs — all local",
    chips: ["Fabric-like theme", "Synthetic data", "Open tooling"],
    note: "Contoso Data Studio · prototype",
  });
  await tour.hold(2.6);
}

/* ---------------------------------------------------------------- ffmpeg + checks */
function findFfmpeg() {
  const candidates = [args.ffmpeg, process.env.FFMPEG_PATH, process.env.FFMPEG, "ffmpeg"];
  try { candidates.push(requireWeb("ffmpeg-static")); } catch { /* optional */ }
  for (const candidate of candidates.filter(Boolean)) {
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** Mean abs difference between consecutive frames (grey 160x90), decoded by ffmpeg from the JPEG frames. */
function frameDiffs(ffmpeg, frameCount) {
  const w = 160;
  const h = 90;
  const decode = spawnSync(ffmpeg, [
    "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(FRAMES_DIR, "%05d.jpg"),
    "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1",
  ], { maxBuffer: frameCount * w * h + 1024 * 1024 });
  if (decode.status !== 0) throw new Error(`ffmpeg frame decode failed: ${decode.stderr}`);
  const data = decode.stdout;
  const size = w * h;
  const diffs = [0];
  for (let f = 1; f * size + size <= data.length; f += 1) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) sum += Math.abs(data[f * size + i] - data[(f - 1) * size + i]);
    diffs.push(sum / size);
  }
  return diffs;
}

/** Longest run of consecutive "moving" frames inside each transition window. */
function blendCheck(diffs, transitions) {
  return transitions.map(transition => {
    let run = 0;
    let longest = 0;
    let peak = 0;
    let at = null;
    for (let f = transition.from_frame; f <= Math.min(transition.to_frame, diffs.length - 1); f += 1) {
      peak = Math.max(peak, diffs[f]);
      run = diffs[f] > BLEND_DIFF ? run + 1 : 0;
      if (run > longest) { longest = run; at = f - run + 1; }
    }
    return { ...transition, longest_motion_run: longest, run_start_frame: at, peak_diff: +peak.toFixed(2), ok: longest <= MAX_BLEND_FRAMES };
  });
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
  await tour.settled("Projects");
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
let blends = [];
const ffmpeg = status === "PASS" ? findFfmpeg() : null;
if (ffmpeg) {
  blends = blendCheck(frameDiffs(ffmpeg, tour.frame), tour.transitions);
  const file = path.join(OUT, "contoso-tour.mp4");
  const encode = spawnSync(ffmpeg, [
    "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(FRAMES_DIR, "%05d.jpg"),
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file,
  ], { encoding: "utf8" });
  if (encode.status === 0 && existsSync(file)) video = { file: path.relative(OUT, file).replaceAll("\\", "/"), bytes: (await stat(file)).size };
  else problems.push(`ffmpeg failed: ${encode.stderr}`);
} else if (status === "PASS") {
  problems.push("ffmpeg not found (--ffmpeg, $FFMPEG_PATH, $FFMPEG, PATH or ffmpeg-static); frames kept, no MP4 encoded, blend check skipped.");
}

const longBlends = blends.filter(item => !item.ok);
if (status === "PASS" && (tour.domViolations.length || longBlends.length || tour.clipViolations.length)) {
  status = "FAIL";
  for (const item of longBlends) problems.push(`long blend in transition "${item.name}": ${item.longest_motion_run} frames from ${item.run_start_frame} above ${BLEND_DIFF}`);
  for (const item of tour.domViolations.slice(0, 20)) problems.push(`frame ${item.frame}: ${item.issues.join("; ")}`);
  for (const item of tour.clipViolations.slice(0, 20)) problems.push(`frame ${item.frame} (${item.zoom}): ${item.issues.join("; ")}`);
  process.exitCode = 1;
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
  checks: {
    blend: { threshold_diff: BLEND_DIFF, max_frames: MAX_BLEND_FRAMES, window_s: TRANSITION_WINDOW_S, transitions: blends },
    dom_violations: tour.domViolations.length,
    camera_clipping: {
      checked_frames: tour.zooms.reduce((sum, zoom) => sum + zoom.checked_frames, 0),
      violations: tour.clipViolations.length,
    },
  },
  camera: tour.zooms,
  problems,
  recorded_in_s: Math.round((Date.now() - started) / 1000),
  generator: "tools/record_tour.mjs",
};
await writeFile(path.join(OUT, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(`TOUR_${status} frames=${tour.frame} duration=${metadata.duration_s}s transitions=${blends.length} long_blends=${longBlends.length} dom_violations=${tour.domViolations.length} clipped=${tour.clipViolations.length} zooms=${tour.zooms.filter(zoom => zoom.used).map(zoom => zoom.name).join(",") || "none"} video=${video ? `${video.file} ${video.bytes} bytes` : "none"}`);
