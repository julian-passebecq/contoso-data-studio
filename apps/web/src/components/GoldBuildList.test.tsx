// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import GoldBuildList, { GOLD_BUILD_LABELS, formatBuildTime, goldBuildNote } from "./GoldBuildList";
import type { DbtBuildRef, GoldBuildReport, GoldModelBuild } from "../types";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const RETAIL_BUILD: DbtBuildRef = {
  invocation_id: "aaaaaaaa-1111", short_id: "aaaaaaaa", generated_at: "2026-10-12T08:00:00Z",
  command: "build", selector: null, scope: "retail",
};
const FOIL_BUILD: DbtBuildRef = {
  invocation_id: "bbbbbbbb-2222", short_id: "bbbbbbbb", generated_at: "2026-10-12T09:30:00Z",
  command: "build", selector: null, scope: "foil",
};

function model(overrides: Partial<GoldModelBuild>): GoldModelBuild {
  return {
    name: "monthly_sales", path: "models/gold/monthly_sales.sql", unique_id: "model.contoso_data_studio.monthly_sales",
    scope: "retail", in_active_project: false, last_build: RETAIL_BUILD, latest_build_status: null,
    rebuilt_by_latest: false, ...overrides,
  };
}

// Retail Gold after a FOIL build: kept its retail build, not rebuilt by the FOIL run.
const AFTER_FOIL_BUILD: GoldBuildReport = {
  foil_active: true,
  latest_build: FOIL_BUILD,
  models: [
    model({}),
    model({
      name: "foil_project_summary", path: "models/foil/gold/foil_project_summary.sql",
      unique_id: "model.contoso_data_studio.foil_project_summary", scope: "foil", in_active_project: true,
      last_build: FOIL_BUILD, latest_build_status: "success", rebuilt_by_latest: true,
    }),
  ],
};

describe("Gold build notes", () => {
  it("formats build times deterministically in UTC", () => {
    expect(formatBuildTime("2026-10-12T08:00:00.123456Z")).toBe("2026-10-12 08:00 UTC");
    expect(formatBuildTime(null)).toBe("time unknown");
  });

  it("marks retail Gold as not rebuilt after a FOIL build and keeps its last build", () => {
    const result = goldBuildNote(AFTER_FOIL_BUILD.models[0], FOIL_BUILD);
    expect(result.note).toBe("last built 2026-10-12 08:00 UTC (run aaaaaaaa)");
    expect(result.marker).toBe("not rebuilt by this run");
    expect(result.markerDetail).toContain("FOIL project");
  });

  it("shows no marker for a model the latest build rebuilt", () => {
    const result = goldBuildNote(AFTER_FOIL_BUILD.models[1], FOIL_BUILD);
    expect(result.note).toBe("last built 2026-10-12 09:30 UTC (run bbbbbbbb)");
    expect(result.marker).toBeNull();
  });

  it("reports a failed model and a model never built", () => {
    expect(goldBuildNote(model({latest_build_status: "error"}), RETAIL_BUILD).marker).toBe("error in this run");
    expect(goldBuildNote(model({last_build: null}), null)).toEqual({note: "never built", marker: null, markerDetail: null});
  });

  it("uses overridden labels", () => {
    const labels = {...GOLD_BUILD_LABELS, notRebuilt: "kept from an earlier run"};
    expect(goldBuildNote(AFTER_FOIL_BUILD.models[0], FOIL_BUILD, labels).marker).toBe("kept from an earlier run");
  });
});

describe("GoldBuildList", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders the marker only on the model the FOIL build did not rebuild", () => {
    act(() => root.render(<GoldBuildList report={AFTER_FOIL_BUILD}/>));

    expect(host.textContent).toContain("Latest build: dbt build (FOIL project: path:models/foil only) · 2026-10-12 09:30 UTC · run bbbbbbbb");
    const rows = [...host.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-rebuilt")).toBe("no");
    expect(rows[0].textContent).toContain("last built 2026-10-12 08:00 UTC (run aaaaaaaa)");
    expect(rows[0].querySelector(".goldBuildMarker")?.textContent).toBe("not rebuilt by this run");
    expect(rows[1].getAttribute("data-rebuilt")).toBe("yes");
    expect(rows[1].querySelector(".goldBuildMarker")).toBeNull();
  });

  it("says when no build is recorded", () => {
    act(() => root.render(<GoldBuildList report={{foil_active: false, latest_build: null, models: [model({last_build: null})]}}/>));
    expect(host.textContent).toContain("No dbt build recorded yet.");
    expect(host.textContent).toContain("never built");
    expect(host.querySelector(".goldBuildMarker")).toBeNull();
  });
});
