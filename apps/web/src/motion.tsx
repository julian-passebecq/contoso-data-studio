import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    /** Set by tools/record_tour.mjs: a virtual clock (ms) so recorded frames are deterministic. */
    __tourTime?: number;
  }
}

export function motionNow() {
  return typeof window !== "undefined" && typeof window.__tourTime === "number"
    ? window.__tourTime
    : performance.now();
}

export function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type NumericParts = { prefix: string; value: number; decimals: number; grouped: boolean; suffix: string };

/** Splits "€1,234.5k" into prefix "€", value 1234.5, suffix "k"; null when the text holds no number. */
export function parseNumericText(text: string): NumericParts | null {
  const match = /^(.*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s.exec(text);
  if (!match) return null;
  const [, prefix, raw, suffix] = match;
  // Locale formats we cannot round-trip (e.g. "1 234,5 €") are shown without animation.
  if (/\d/.test(prefix) || /\d/.test(suffix)) return null;
  const grouped = raw.includes(",");
  const plain = raw.replace(/,/g, "");
  const value = Number(plain);
  if (!Number.isFinite(value)) return null;
  const decimals = plain.includes(".") ? plain.split(".")[1].length : 0;
  return { prefix, value, decimals, grouped, suffix };
}

export function formatNumericParts(parts: NumericParts, value: number) {
  const body = parts.grouped
    ? value.toLocaleString("en-US", { minimumFractionDigits: parts.decimals, maximumFractionDigits: parts.decimals })
    : value.toFixed(parts.decimals);
  return `${parts.prefix}${body}${parts.suffix}`;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Counts a KPI up from zero to its final text. The final text is always rendered once
 * the animation ends (and immediately with prefers-reduced-motion or non-numeric values).
 */
export function CountUp({ value, duration = 900, className }: { value: string; duration?: number; className?: string }) {
  const parts = parseNumericText(value);
  const [display, setDisplay] = useState(() => (parts && !prefersReducedMotion() ? formatNumericParts(parts, 0) : value));
  const frame = useRef(0);

  useEffect(() => {
    const parsed = parseNumericText(value);
    if (!parsed || prefersReducedMotion()) { setDisplay(value); return; }
    const start = motionNow();
    const tick = () => {
      const progress = Math.min(1, Math.max(0, (motionNow() - start) / duration));
      if (progress >= 1) { setDisplay(value); return; }
      setDisplay(formatNumericParts(parsed, parsed.value * easeOutCubic(progress)));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, duration]);

  return <span className={className} aria-label={value}>{display}</span>;
}

export function SkeletonBlock({ width = "100%", height = 14, radius = 6 }: { width?: number | string; height?: number; radius?: number }) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius }} />;
}

export function SkeletonCards({ count = 3, label = "Loading" }: { count?: number; label?: string }) {
  return <div className="skeletonCards" role="status" aria-label={label}>
    {Array.from({ length: count }, (_, index) => <div className="skeletonCard" key={index}>
      <SkeletonBlock width="45%" height={11} />
      <SkeletonBlock width="70%" height={26} />
      <SkeletonBlock width="55%" height={10} />
    </div>)}
  </div>;
}

export function SkeletonTable({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return <div className="skeletonTable" role="status" aria-label="Running query">
    {Array.from({ length: rows }, (_, row) => <div className="skeletonRow" key={row}>
      {Array.from({ length: columns }, (_, column) => <SkeletonBlock key={column} height={row === 0 ? 12 : 10} width={`${60 + ((row * 7 + column * 13) % 35)}%`} />)}
    </div>)}
  </div>;
}

export function PageSkeleton({ label = "Loading" }: { label?: string }) {
  return <div className="pageSkeleton" role="status" aria-label={label}>
    <SkeletonBlock width="32%" height={22} />
    <SkeletonBlock width="58%" height={12} />
    <SkeletonCards count={3} label={label} />
  </div>;
}
