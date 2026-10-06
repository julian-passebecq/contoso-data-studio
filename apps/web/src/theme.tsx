import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  FluentProvider,
  createDarkTheme,
  webLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

/**
 * Theme options. "default" is the original light workbench and stays the default.
 * "fabric" is a Fabric-like dark theme: Fluent 2 tokens with our own deep-slate surfaces
 * and a teal brand ramp (no Microsoft palette values, logos or branding are used).
 */
export type ThemeChoice = "default" | "fabric";

export const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string }> = [
  { value: "default", label: "Default" },
  { value: "fabric", label: "Fabric-like" },
];

const STORAGE_KEY = "contoso-theme";

function isChoice(value: string | null | undefined): value is ThemeChoice {
  return value === "default" || value === "fabric";
}

/** URL (?theme=fabric) wins and is remembered; otherwise the saved setting; otherwise default. */
export function resolveInitialTheme(search = typeof window !== "undefined" ? window.location.search : ""): ThemeChoice {
  const fromUrl = new URLSearchParams(search).get("theme");
  if (isChoice(fromUrl)) {
    try { localStorage.setItem(STORAGE_KEY, fromUrl); } catch { /* storage unavailable */ }
    return fromUrl;
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isChoice(saved)) return saved;
  } catch { /* storage unavailable */ }
  return "default";
}

// Own teal ramp (10 = darkest, 160 = lightest), tuned for contrast on deep slate surfaces.
const fabricBrand: BrandVariants = {
  10: "#020807",
  20: "#0b1d1b",
  30: "#0d302c",
  40: "#0c3f3a",
  50: "#0a4f48",
  60: "#075f57",
  70: "#057066",
  80: "#0b8f78",
  90: "#13a389",
  100: "#38a393",
  110: "#52b3a3",
  120: "#6cc2b3",
  130: "#88d1c3",
  140: "#a5dfd3",
  150: "#c3ece4",
  160: "#e1f7f2",
};

export const fabricTheme: Theme = {
  ...createDarkTheme(fabricBrand),
  colorNeutralBackground1: "#1c2027",
  colorNeutralBackground1Hover: "#242932",
  colorNeutralBackground1Pressed: "#161a20",
  colorNeutralBackground2: "#171b21",
  colorNeutralBackground3: "#13161b",
  colorNeutralForeground1: "#eef1f5",
  colorNeutralForeground2: "#c4cad3",
  colorNeutralForeground3: "#98a1ad",
  colorNeutralStroke1: "#343a45",
  colorNeutralStroke2: "#2a2f38",
  colorBrandForeground1: "#3fd8bb",
  colorBrandForegroundLink: "#3fd8bb",
  colorCompoundBrandStroke: "#38a393",
  borderRadiusMedium: "6px",
  borderRadiusLarge: "10px",
  borderRadiusXLarge: "14px",
  fontFamilyBase: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, -apple-system, sans-serif",
  shadow4: "0 2px 6px rgba(0,0,0,.35), 0 0 1px rgba(0,0,0,.4)",
  shadow8: "0 6px 16px rgba(0,0,0,.4), 0 0 1px rgba(0,0,0,.45)",
};

type ThemeContextValue = { theme: ThemeChoice; setTheme: (next: ThemeChoice) => void };
const ThemeContext = createContext<ThemeContextValue>({ theme: "default", setTheme: () => {} });

export function useThemeChoice() {
  return useContext(ThemeContext);
}

export function ThemeRoot({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(() => resolveInitialTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "fabric" ? "dark" : "light";
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme: next => {
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
      setThemeState(next);
    },
  }), [theme]);

  return <ThemeContext.Provider value={value}>
    <FluentProvider theme={theme === "fabric" ? fabricTheme : webLightTheme} className="themeRoot">
      {children}
    </FluentProvider>
  </ThemeContext.Provider>;
}
