import { describe, expect, it, vi } from "vitest";

import { buildPlanRows, computeKpis, dataPathStages, monthlySeries, validateAmount, validateNote } from "./forecastLogic";
import { LocalRayfinClient, LocalRayfinError } from "./localRayfinClient";
import type { Actual, Department, Forecast, LocalUser, Trace } from "./types";

const ana: LocalUser = { id: "u-ana", display_name: "Ana", email: "ana.finance@contoso.test", role: "finance", department_code: "NORD" };
const dept: Department = { id: "d1", code: "NORD", name: "Nordic", finance_owner_email: ana.email };
const forecast = (month: string, amount: number): Forecast => ({
  id: `f-${month}`, department_id: "d1", month, amount, note: null, owner_email: ana.email, updated_by: null, updated_at: null,
});
const actual = (month: string, amount: number): Actual => ({ id: `a-${month}`, department_id: "d1", month, amount, owner_email: ana.email });

function okFetch(payload: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
}

describe("validateAmount", () => {
  it("accepts plain and comma decimals", () => {
    expect(validateAmount("1200.5")).toEqual({ ok: true, value: 1200.5 });
    expect(validateAmount(" 1 200,25 ")).toEqual({ ok: true, value: 1200.25 });
  });
  it.each([
    ["", "required"],
    ["abc", "number"],
    ["-1", "at least 0"],
    ["100000001", "at most"],
    ["1.234", "2 decimals"],
  ])("rejects %s", (raw, message) => {
    const result = validateAmount(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
  it("limits notes to 200 characters", () => {
    expect(validateNote("x".repeat(200))).toBeNull();
    expect(validateNote("x".repeat(201))).toContain("200");
  });
});

describe("plan rows, KPIs and Gold series", () => {
  const rows = buildPlanRows([dept], [forecast("2026-02", 200), forecast("2026-01", 100), forecast("2026-12", 300)], [actual("2026-01", 110), actual("2026-02", 180)]);

  it("joins actuals and computes variance", () => {
    expect(rows.map(r => r.month)).toEqual(["2026-01", "2026-02", "2026-12"]);
    expect(rows[0]).toMatchObject({ departmentCode: "NORD", forecast: 100, actual: 110, variance: 10 });
    expect(rows[0].variancePct).toBeCloseTo(0.1);
    expect(rows[2]).toMatchObject({ actual: null, variance: null, variancePct: null });
  });

  it("computes year-to-date KPIs on closed months only", () => {
    expect(computeKpis(rows)).toMatchObject({ forecastYear: 600, forecastYtd: 300, actualYtd: 290, varianceYtd: -10, monthsWithActuals: 2 });
  });

  it("sums departments per month from Gold", () => {
    const series = monthlySeries([
      { month: "2026-01", department_code: "A", department_name: "A", forecast_amount: "100.00", actual_amount: "90.00", variance: null, variance_pct: null, last_editor: null, built_at: "" },
      { month: "2026-01", department_code: "B", department_name: "B", forecast_amount: 50, actual_amount: null, variance: null, variance_pct: null, last_editor: null, built_at: "" },
      { month: "2026-12", department_code: "A", department_name: "A", forecast_amount: 10, actual_amount: null, variance: null, variance_pct: null, last_editor: null, built_at: "" },
    ]);
    expect(series).toEqual([{ month: "2026-01", forecast: 150, actual: 90 }, { month: "2026-12", forecast: 10, actual: null }]);
  });
});

describe("data path strip", () => {
  const change = { seq: 7, entity: "Forecast", row_id: "f", op: "update", committed_at: "2026-10-06T10:00:00.000Z", actor: ana.email, summary: "Forecast amount=1" };

  it("is idle before any write", () => {
    expect(dataPathStages(null, null).every(s => s.state === "idle")).toBe(true);
  });

  it("marks stages done in order with elapsed time", () => {
    const trace: Trace = {
      change,
      mirror: { seq: 7, mirrored_at: "2026-10-06T10:00:00.120Z", latency_ms: 120, snapshot_id: 12, endpoint_at: "2026-10-06T10:00:00.150Z", gold_at: null, gold_snapshot_id: null, gold_ok: null },
    };
    const stages = dataPathStages(trace, null);
    expect(stages.map(s => s.state)).toEqual(["done", "done", "done", "pending", "pending"]);
    expect(stages[1].deltaMs).toBe(120);
    expect(stages[1].detail).toContain("snapshot 12");
    const finished = dataPathStages({ ...trace, mirror: { ...trace.mirror!, gold_at: "2026-10-06T10:00:04.000Z", gold_ok: 1, gold_snapshot_id: 13 } }, "2026-10-06T10:00:04.300Z");
    expect(finished.map(s => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(finished[4].deltaMs).toBe(300);
  });

  it("shows a failed Gold build", () => {
    const stages = dataPathStages({ change, mirror: { seq: 7, mirrored_at: change.committed_at, latency_ms: 1, snapshot_id: 1, endpoint_at: change.committed_at, gold_at: change.committed_at, gold_snapshot_id: null, gold_ok: 0 } }, null);
    expect(stages[3].state).toBe("failed");
    expect(stages[4].state).toBe("pending");
  });
});

describe("LocalRayfinClient", () => {
  it("sends the Rayfin query shape with the fake user header", async () => {
    const fetcher = okFetch({ items: [{ id: "1" }] });
    const client = new LocalRayfinClient(ana, fetcher as unknown as typeof fetch);
    const rows = await client.data.Forecast.select(["id", "amount"]).where({ month: { eq: "2026-01" } }).orderBy({ month: "asc" }).first(5).execute();
    expect(rows).toEqual([{ id: "1" }]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/fabric-apps/sales-forecasting/data/Forecast/query");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Local-User"]).toBe("u-ana");
    expect(JSON.parse(String(init.body))).toEqual({ select: ["id", "amount"], where: { month: { eq: "2026-01" } }, orderBy: { month: "asc" }, first: 5 });
  });

  it("supports the plural query() shape and update(filter, patch)", async () => {
    const fetcher = okFetch({ items: [] });
    const client = new LocalRayfinClient(ana, fetcher as unknown as typeof fetch);
    await client.data.forecasts.query().select(["id"]).execute();
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toContain("/data/Forecast/query");
    await client.data.Forecast.update({ id: "f1" }, { amount: 5 });
    const [url, init] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/fabric-apps/sales-forecasting/data/Forecast");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ filter: { id: "f1" }, patch: { amount: 5 } });
    expect(client.auth.getSession()).toMatchObject({ isAuthenticated: true, user: { email: ana.email, role: "finance" } });
  });

  it("surfaces policy denials as errors with status", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ detail: "eva may not update this Forecast" }), { status: 403 }));
    const client = new LocalRayfinClient(ana, fetcher as unknown as typeof fetch);
    await expect(client.data.Forecast.update({ id: "f1" }, { amount: 1 })).rejects.toMatchObject({ status: 403, message: "eva may not update this Forecast" });
    await expect(client.data.Forecast.findById("x")).rejects.toBeInstanceOf(LocalRayfinError);
  });
});
