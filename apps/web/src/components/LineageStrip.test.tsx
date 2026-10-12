// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LineageStrip, { LINEAGE_LABELS, lineageDestination, lineageIntents, relationDetail } from "./LineageStrip";
import type { LineageRelation, QueryLineage } from "../types";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

function relation(overrides: Partial<LineageRelation>): LineageRelation {
  return {
    catalog: "contoso", schema: "gold", table: "monthly_sales", layer: "gold",
    dbt_model: "model.contoso.monthly_sales", columns: ["channel", "revenue"], at: [],
    confidence: "verified", note: "Scan of the bound DuckDB plan", ...overrides,
  };
}

const LINEAGE: QueryLineage = {
  method: "duckdb_parser+explain",
  confidence: "unresolved",
  relations: [
    relation({}),
    relation({schema: "bronze", table: "sales", layer: "bronze", dbt_model: null, columns: ["order_id"]}),
    relation({catalog: null, schema: null, table: "read_parquet", layer: null, dbt_model: null, columns: [], confidence: "unresolved", note: "Table function"}),
  ],
};

describe("Query 'Reads from' lineage strip", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("deep-links lake tables to their exact Lakehouse table, dbt models also to Transform, unresolved nowhere", () => {
    expect(lineageIntents(LINEAGE.relations[0])).toEqual({
      primary: {page: "Lakehouse", schema: "gold", table: "monthly_sales"},
      model: {page: "Transform", nodeId: "model.contoso.monthly_sales"},
    });
    expect(lineageIntents(LINEAGE.relations[1])).toEqual({
      primary: {page: "Lakehouse", schema: "bronze", table: "sales"}, model: null,
    });
    expect(lineageIntents(LINEAGE.relations[2])).toEqual({primary: null, model: null});
    // A dbt model outside the lake layers still opens its node in Transform.
    expect(lineageIntents(relation({layer: null}))).toEqual({
      primary: {page: "Transform", nodeId: "model.contoso.monthly_sales"}, model: null,
    });
    // A partly resolved relation keeps its links; only "unresolved" disables them.
    expect(lineageDestination(relation({confidence: "inferred"}))).toBe("Lakehouse");
    expect(lineageDestination(relation({confidence: "unresolved"}))).toBeNull();
    expect(relationDetail(relation({at: [{unit: "VERSION", value: 3}]}))).toContain("AT VERSION 3");
  });

  it("lists each relation and sends the exact table or model as the navigation intent", () => {
    const onOpen = vi.fn();
    act(() => root.render(<LineageStrip lineage={LINEAGE} onOpen={onOpen}/>));

    expect(host.textContent).toContain(LINEAGE_LABELS.title);
    const items = host.querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("gold.monthly_sales");
    expect(items[0].textContent).toContain("2 columns");

    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute("aria-label")).toContain("Open in Lakehouse");
    expect(buttons[1].textContent).toBe(LINEAGE_LABELS.openModel);
    expect(buttons[1].getAttribute("aria-label")).toContain("Open dbt model in Transform");
    expect(items[1].querySelectorAll("button")).toHaveLength(1);

    act(() => buttons[0].click());
    expect(onOpen).toHaveBeenLastCalledWith({page: "Lakehouse", schema: "gold", table: "monthly_sales"}, LINEAGE.relations[0]);
    act(() => buttons[1].click());
    expect(onOpen).toHaveBeenLastCalledWith({page: "Transform", nodeId: "model.contoso.monthly_sales"}, LINEAGE.relations[0]);
    act(() => buttons[2].click());
    expect(onOpen).toHaveBeenLastCalledWith({page: "Lakehouse", schema: "bronze", table: "sales"}, LINEAGE.relations[1]);
    expect(onOpen).toHaveBeenCalledTimes(3);

    const unresolved = items[2].querySelector(".lineageStatic");
    expect(unresolved?.getAttribute("tabindex")).toBe("0");
    expect(unresolved?.getAttribute("aria-label")).toContain("unresolved");
    expect(unresolved?.getAttribute("aria-label")).toContain("Table function");
    expect(items[2].querySelector("button")).toBeNull();
  });

  it("uses caller labels and renders nothing without lineage", () => {
    act(() => root.render(<LineageStrip lineage={{relations: [], method: "none", confidence: "unresolved"}}
      labels={{...LINEAGE_LABELS, title: "Lit depuis", unavailable: "Pas de lignage"}}/>));
    expect(host.textContent).toContain("Lit depuis");
    expect(host.textContent).toContain("Pas de lignage");

    act(() => root.render(<LineageStrip lineage={LINEAGE} onOpen={() => {}}
      labels={{...LINEAGE_LABELS, openModel: "Ouvrir le modèle"}}/>));
    expect(host.querySelector(".lineageModelLink")?.textContent).toBe("Ouvrir le modèle");

    act(() => root.render(<LineageStrip lineage={undefined}/>));
    expect(host.textContent).toBe("");
  });
});
