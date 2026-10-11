// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LineageStrip, { LINEAGE_LABELS, lineageDestination, relationDetail } from "./LineageStrip";
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

  it("routes dbt models to Transform, plain lake tables to Lakehouse, unresolved nowhere", () => {
    expect(lineageDestination(LINEAGE.relations[0])).toBe("Transform");
    expect(lineageDestination(LINEAGE.relations[1])).toBe("Lakehouse");
    expect(lineageDestination(LINEAGE.relations[2])).toBeNull();
    expect(relationDetail(relation({at: [{unit: "VERSION", value: 3}]}))).toContain("AT VERSION 3");
  });

  it("lists each relation with layer and columns, and opens it from the keyboard-focusable button", () => {
    const onOpen = vi.fn();
    act(() => root.render(<LineageStrip lineage={LINEAGE} onOpen={onOpen}/>));

    expect(host.textContent).toContain(LINEAGE_LABELS.title);
    const items = host.querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("gold.monthly_sales");
    expect(items[0].textContent).toContain("2 columns");

    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("aria-label")).toContain("Open in Transform");
    act(() => buttons[1].click());
    expect(onOpen).toHaveBeenCalledWith("Lakehouse", LINEAGE.relations[1]);

    const unresolved = items[2].querySelector(".lineageStatic");
    expect(unresolved?.getAttribute("tabindex")).toBe("0");
    expect(unresolved?.getAttribute("aria-label")).toContain("unresolved");
  });

  it("uses caller labels and renders nothing without lineage", () => {
    act(() => root.render(<LineageStrip lineage={{relations: [], method: "none", confidence: "unresolved"}}
      labels={{...LINEAGE_LABELS, title: "Lit depuis", unavailable: "Pas de lignage"}}/>));
    expect(host.textContent).toContain("Lit depuis");
    expect(host.textContent).toContain("Pas de lignage");

    act(() => root.render(<LineageStrip lineage={undefined}/>));
    expect(host.textContent).toBe("");
  });
});
