// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LakehousePage, { currentPreviewSql, findCatalogTable } from "./LakehousePage";
import TransformPage from "./TransformPage";
import type { CatalogTable } from "../types";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const SUMMARY = {total: 0, pass: 0, fail: 0, warn: 0, error: 0, skip: 0};
const QUALITY = {generated_at: null, summary: SUMMARY, by_layer: {}, tests: []};
const PROJECT_STATE = {
  active_run: null, active_scenario: "retail-baseline", gold_scenarios: [], gold_current: false,
  layers: {bronze: 1, silver: 1, gold: 1}, quality_total: 0, ready: true,
};
const TABLES: CatalogTable[] = [
  {schema: "bronze", name: "sales", type: "BASE TABLE"},
  {schema: "silver", name: "sales", type: "BASE TABLE"},
  {schema: "gold", name: "monthly_sales", type: "BASE TABLE"},
];

type Call = {url: string; body: unknown};

/** Answers each API path with a fixed synthetic payload and records every call. */
function mockApi(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({url, body: init?.body ? JSON.parse(String(init.body)) : undefined});
    const path = url.split("?")[0];
    const payload = path in routes ? routes[path] : null;
    return new Response(JSON.stringify(payload ?? {detail: `no route ${path}`}), {status: payload === null ? 404 : 200});
  }));
  return calls;
}

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

describe("deep links from Query lineage", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it("builds a quoted, read-only preview statement and finds the exact catalog table", () => {
    expect(currentPreviewSql({schema: "silver", name: 'odd"name', type: "BASE TABLE"}))
      .toBe('select *\nfrom contoso."silver"."odd""name"\nlimit 100;');
    expect(findCatalogTable(TABLES, {schema: "silver", table: "sales"})).toBe(TABLES[1]);
    expect(findCatalogTable(TABLES, {schema: "gold", table: "sales"})).toBeNull();
    expect(findCatalogTable(TABLES, null)).toBeNull();
  });

  it("Lakehouse opens with the requested table selected and its current preview and columns shown", async () => {
    const calls = mockApi({
      "/api/lakehouse/catalog": {tables: TABLES},
      "/api/lakehouse/snapshots": {snapshots: []},
      "/api/dbt/quality": QUALITY,
      "/api/workspace/project-state": PROJECT_STATE,
      "/api/query": {columns: ["order_id", "amount"], rows: [[1, 9.5]], row_count: 1, truncated: false},
    });
    await act(async () => root.render(<LakehousePage initialTable={{schema: "silver", table: "sales"}}/>));
    await settle();

    const selected = host.querySelectorAll<HTMLButtonElement>(".tableItemButton.selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("aria-pressed")).toBe("true");
    expect(selected[0].closest("section")?.textContent).toContain("SILVER");
    expect(document.activeElement).toBe(selected[0]);

    const query = calls.find(call => call.url === "/api/query");
    expect(query?.body).toEqual({sql: currentPreviewSql(TABLES[1]), limit: 100});
    expect(host.textContent).toContain("Table preview");
    expect(host.textContent).toContain("silver.sales · current version · 2 columns");
    expect(host.textContent).toContain("order_id");
    expect(host.textContent).toContain("amount");
  });

  it("Lakehouse keeps its default selection and says so when the requested table is missing", async () => {
    const calls = mockApi({
      "/api/lakehouse/catalog": {tables: TABLES},
      "/api/lakehouse/snapshots": {snapshots: []},
      "/api/dbt/quality": QUALITY,
      "/api/workspace/project-state": PROJECT_STATE,
    });
    await act(async () => root.render(<LakehousePage initialTable={{schema: "gold", table: "gone"}}/>));
    await settle();

    expect(host.textContent).toContain("gold.gone is not in the DuckLake catalog.");
    expect(host.querySelector(".tableItemButton.selected")?.textContent).toContain("monthly_sales");
    expect(calls.some(call => call.url === "/api/query")).toBe(false);
    expect(host.textContent).not.toContain("Table preview");
  });

  it("Transform opens the requested dbt node in the model workbench", async () => {
    const node = {
      id: "model.contoso_data_studio.monthly_sales", name: "monthly_sales", resource_type: "model", layer: "gold",
      path: "models/gold/monthly_sales.sql", schema: "gold", database: "contoso", relation_name: "contoso.gold.monthly_sales",
      materialized: "table", source_code: "select 1 as synthetic", compiled_code: null, physical_query: null,
      upstream: [], downstream: [], tests: [], columns: [],
    };
    const calls = mockApi({
      "/api/dbt/status": {available: true, executable: null, project_dir: "dbt", models: [], latest_run: null, quality: QUALITY},
      "/api/dbt/lineage": {nodes: [{id: node.id, name: node.name, resource_type: "model", layer: "gold", path: node.path,
        schema: "gold", database: "contoso", materialized: "table"}], edges: []},
      "/api/workspace/project-state": PROJECT_STATE,
      "/api/dbt/node": node,
    });
    await act(async () => root.render(<TransformPage onBuilt={() => {}} onOpenQuery={() => {}} initialNodeId={node.id}/>));
    await settle();

    expect(calls.some(call => call.url === `/api/dbt/node?unique_id=${encodeURIComponent(node.id)}`)).toBe(true);
    const workbench = host.querySelector(".modelWorkbenchCard");
    expect(workbench?.textContent).toContain("monthly_sales");
    expect(workbench?.textContent).toContain("select 1 as synthetic");
    const dagNode = host.querySelector<HTMLButtonElement>(".dagNode.selected");
    expect(dagNode?.getAttribute("aria-pressed")).toBe("true");
  });

  it("Transform without an initial node leaves the workbench empty", async () => {
    const calls = mockApi({
      "/api/dbt/status": {available: true, executable: null, project_dir: "dbt", models: [], latest_run: null, quality: QUALITY},
      "/api/dbt/lineage": {nodes: [], edges: []},
      "/api/workspace/project-state": PROJECT_STATE,
    });
    await act(async () => root.render(<TransformPage onBuilt={() => {}} onOpenQuery={() => {}}/>));
    await settle();
    expect(calls.some(call => call.url.startsWith("/api/dbt/node"))).toBe(false);
    expect(host.textContent).toContain("Click a node in the DAG.");
  });
});
