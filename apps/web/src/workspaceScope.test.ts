// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { activeWorkspaceId, rememberWorkspaceId, scopedKey } from "./workspaceScope";
import { readTutorialProgress, writeTutorialProgress } from "./tutorialProgress";

describe("workspace-scoped browser state", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the original keys for the default workspace (no data loss on upgrade)", () => {
    expect(activeWorkspaceId()).toBe("default");
    expect(scopedKey("contoso-query-history")).toBe("contoso-query-history");
  });

  it("separates history and progress between named workspaces", () => {
    expect(rememberWorkspaceId("retail-a")).toBe(true);
    expect(rememberWorkspaceId("retail-a")).toBe(false);
    localStorage.setItem(scopedKey("contoso-query-history"), "[\"select 1\"]");
    writeTutorialProgress("retail-baseline", { prepare: true });

    rememberWorkspaceId("retail-b");
    expect(localStorage.getItem(scopedKey("contoso-query-history"))).toBeNull();
    expect(readTutorialProgress("retail-baseline")).toEqual({});

    rememberWorkspaceId("retail-a");
    expect(localStorage.getItem(scopedKey("contoso-query-history"))).toBe("[\"select 1\"]");
    expect(readTutorialProgress("retail-baseline")).toEqual({ prepare: true });
  });
});
