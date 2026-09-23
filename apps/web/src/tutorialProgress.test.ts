// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeTutorialStep,
  getSelectedProjectScenario,
  isGoldQuery,
  readTutorialProgress,
  resetTutorialProgress,
  setSelectedProjectScenario,
  setTutorialStep,
  tutorialProgressEvent,
} from "./tutorialProgress";

describe("tutorial progress", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not mutate progress when no guided project is selected", () => {
    expect(completeTutorialStep("query","retail-baseline")).toBe(false);
    expect(readTutorialProgress("retail-baseline")).toEqual({});
  });

  it("records progress for the selected scenario and emits an event", () => {
    setSelectedProjectScenario("retail-baseline");
    const listener=vi.fn();
    window.addEventListener(tutorialProgressEvent,listener);

    expect(completeTutorialStep("query","retail-baseline")).toBe(true);
    expect(readTutorialProgress("retail-baseline")).toEqual({query:true});
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(tutorialProgressEvent,listener);
  });

  it("rejects automatic progress from a different active scenario", () => {
    setSelectedProjectScenario("retail-baseline");

    expect(completeTutorialStep("query","margin-pressure")).toBe(false);
    expect(readTutorialProgress("retail-baseline")).toEqual({});
    expect(readTutorialProgress("margin-pressure")).toEqual({});
  });

  it("does not emit duplicate completion events", () => {
    setSelectedProjectScenario("retail-baseline");
    const listener=vi.fn();
    window.addEventListener(tutorialProgressEvent,listener);

    expect(setTutorialStep("charts",true,"retail-baseline")).toBe(true);
    expect(setTutorialStep("charts",true,"retail-baseline")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(tutorialProgressEvent,listener);
  });

  it("resets only the requested project progress", () => {
    setSelectedProjectScenario("retail-baseline");
    completeTutorialStep("query","retail-baseline");
    localStorage.setItem(
      "contoso-project-progress:margin-pressure",
      JSON.stringify({prepare:true}),
    );

    resetTutorialProgress("retail-baseline");

    expect(readTutorialProgress("retail-baseline")).toEqual({});
    expect(readTutorialProgress("margin-pressure")).toEqual({prepare:true});
  });

  it("tracks the selected project explicitly", () => {
    expect(getSelectedProjectScenario()).toBeNull();
    setSelectedProjectScenario("currency-exposure");
    expect(getSelectedProjectScenario()).toBe("currency-exposure");
  });

  it("recognizes Gold mart queries but not Bronze or Silver queries", () => {
    expect(isGoldQuery("select * from contoso.gold.monthly_sales")).toBe(true);
    expect(isGoldQuery("SELECT * FROM CONTOSO.GOLD.STORE_PERFORMANCE")).toBe(true);
    expect(isGoldQuery("select * from contoso.silver.stg_sales")).toBe(false);
    expect(isGoldQuery("select * from contoso.bronze.sales")).toBe(false);
  });
});
