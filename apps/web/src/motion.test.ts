// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { formatNumericParts, parseNumericText } from "./motion";
import { resolveInitialTheme } from "./theme";

describe("KPI count-up parsing", () => {
  it("round-trips currency, percentages and units", () => {
    for (const text of ["$1,234,567", "38.2%", "4.7 days", "+1.5 pp", "12"]) {
      const parts = parseNumericText(text);
      expect(parts).not.toBeNull();
      expect(formatNumericParts(parts!, parts!.value)).toBe(text);
    }
  });

  it("starts from zero with the same shape", () => {
    expect(formatNumericParts(parseNumericText("$1,234")!, 0)).toBe("$0");
    expect(formatNumericParts(parseNumericText("38.2%")!, 0)).toBe("0.0%");
  });

  it("skips text it cannot round-trip", () => {
    expect(parseNumericText("GBP")).toBeNull();
    expect(parseNumericText("1 234,5 €")).toBeNull();
  });
});

describe("theme resolution", () => {
  it("keeps the default theme unless asked", () => {
    localStorage.removeItem("contoso-theme");
    expect(resolveInitialTheme("")).toBe("default");
  });

  it("accepts ?theme=fabric and remembers it", () => {
    expect(resolveInitialTheme("?theme=fabric")).toBe("fabric");
    expect(resolveInitialTheme("")).toBe("fabric");
    expect(resolveInitialTheme("?theme=default")).toBe("default");
    expect(resolveInitialTheme("?theme=unknown")).toBe("default");
  });
});
