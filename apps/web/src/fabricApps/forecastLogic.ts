// Pure helpers for the Sales Forecasting app. Portable as-is to a Fabric App.
import type { Actual, Department, Forecast, GoldRow, Trace } from "./types";

export const AMOUNT_MAX = 100_000_000;

export interface PlanRow {
  forecastId: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  ownerEmail: string;
  month: string;
  forecast: number;
  actual: number | null;
  variance: number | null;
  variancePct: number | null;
  note: string | null;
  updatedBy: string | null;
}

/** Mirrors the @decimal({ min: 0, max: 100000000, scale: 2 }) rule on Forecast.amount. */
export function validateAmount(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (!text) return { ok: false, error: "Amount is required" };
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, error: "Enter a number" };
  const value = Number(text);
  if (value < 0) return { ok: false, error: "Amount must be at least 0" };
  if (value > AMOUNT_MAX) return { ok: false, error: "Amount must be at most 100,000,000" };
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: "At most 2 decimals" };
  return { ok: true, value };
}

export function validateNote(raw: string): string | null {
  return raw.length > 200 ? "Note is longer than 200 characters" : null;
}

export function buildPlanRows(departments: Department[], forecasts: Forecast[], actuals: Actual[]): PlanRow[] {
  const byDept = new Map(departments.map(d => [d.id, d]));
  const actualByKey = new Map(actuals.map(a => [`${a.department_id}|${a.month}`, Number(a.amount)]));
  return forecasts
    .map(f => {
      const dept = byDept.get(f.department_id);
      const actual = actualByKey.get(`${f.department_id}|${f.month}`) ?? null;
      const forecast = Number(f.amount);
      const variance = actual === null ? null : round2(actual - forecast);
      return {
        forecastId: f.id,
        departmentId: f.department_id,
        departmentCode: dept?.code ?? "?",
        departmentName: dept?.name ?? "Unknown",
        ownerEmail: f.owner_email,
        month: f.month,
        forecast,
        actual,
        variance,
        variancePct: actual === null || forecast === 0 ? null : (actual - forecast) / forecast,
        note: f.note,
        updatedBy: f.updated_by,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || a.departmentCode.localeCompare(b.departmentCode));
}

export interface Kpis {
  forecastYear: number;
  forecastYtd: number;
  actualYtd: number;
  varianceYtd: number;
  variancePct: number | null;
  monthsWithActuals: number;
}

export function computeKpis(rows: PlanRow[]): Kpis {
  const closed = rows.filter(r => r.actual !== null);
  const forecastYtd = sum(closed.map(r => r.forecast));
  const actualYtd = sum(closed.map(r => r.actual ?? 0));
  return {
    forecastYear: round2(sum(rows.map(r => r.forecast))),
    forecastYtd: round2(forecastYtd),
    actualYtd: round2(actualYtd),
    varianceYtd: round2(actualYtd - forecastYtd),
    variancePct: forecastYtd ? (actualYtd - forecastYtd) / forecastYtd : null,
    monthsWithActuals: new Set(closed.map(r => r.month)).size,
  };
}

export interface MonthBar {
  month: string;
  forecast: number;
  actual: number | null;
}

/** Gold rows -> one bar pair per month (departments summed). */
export function monthlySeries(gold: GoldRow[]): MonthBar[] {
  const months = new Map<string, MonthBar>();
  for (const row of gold) {
    const bar = months.get(row.month) ?? { month: row.month, forecast: 0, actual: null };
    bar.forecast = round2(bar.forecast + Number(row.forecast_amount));
    if (row.actual_amount !== null && row.actual_amount !== undefined) bar.actual = round2((bar.actual ?? 0) + Number(row.actual_amount));
    months.set(row.month, bar);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export type StageState = "done" | "pending" | "failed" | "idle";

export interface PathStage {
  key: "sql" | "mirror" | "endpoint" | "gold" | "chart";
  label: string;
  detail: string;
  at: string | null;
  state: StageState;
  deltaMs: number | null;
}

/** The "data path" strip: SQL DB -> mirror -> SQL endpoint -> Gold -> chart, with elapsed time per hop. */
export function dataPathStages(trace: Trace | null, chartAt: string | null): PathStage[] {
  const change = trace?.change ?? null;
  const mirror = trace?.mirror ?? null;
  const goldFailed = mirror?.gold_ok === 0;
  const raw: Array<Omit<PathStage, "state" | "deltaMs">> = [
    { key: "sql", label: "SQL DB", detail: change ? `seq ${change.seq} · ${change.summary ?? change.op}` : "no write yet", at: change?.committed_at ?? null },
    { key: "mirror", label: "Mirror → Bronze", detail: mirror?.snapshot_id != null ? `DuckLake snapshot ${mirror.snapshot_id} · ${mirror.latency_ms} ms` : "waiting", at: mirror?.mirrored_at ?? null },
    { key: "endpoint", label: "SQL endpoint", detail: "read-only query sees the row", at: mirror?.endpoint_at ?? null },
    { key: "gold", label: "Gold (dbt)", detail: goldFailed ? "dbt build failed" : mirror?.gold_snapshot_id != null ? `forecast_vs_actual · snapshot ${mirror.gold_snapshot_id}` : "forecast_vs_actual", at: mirror?.gold_at ?? null },
    { key: "chart", label: "Chart", detail: "monthly bars re-read from Gold", at: chartAt },
  ];
  let previous: string | null = null;
  let blocked = !change;
  return raw.map(stage => {
    let state: StageState;
    if (!change) state = "idle";
    else if (stage.key === "gold" && goldFailed) state = "failed";
    else if (stage.at && !blocked) state = "done";
    else state = "pending";
    if (state !== "done") blocked = true;
    const deltaMs = state === "done" && previous && stage.at ? Math.max(0, Date.parse(stage.at) - Date.parse(previous)) : null;
    if (state === "done") previous = stage.at;
    return { ...stage, state, deltaMs };
  });
}

export function formatMoney(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "–";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "–";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return "–";
  const date = new Date(iso);
  return `${date.toLocaleTimeString("en-GB", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
