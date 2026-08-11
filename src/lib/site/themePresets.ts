// Theme presets
// Named starting points for the admin theme picker. Ported from
// austinlongarm src/lib/theme-presets.ts.

import type { ThemeConfig } from "./theme";
import { DEFAULT_THEME } from "./theme";

export const THEME_PRESETS: { name: string; theme: ThemeConfig }[] = [
  { name: "Berry (default)", theme: DEFAULT_THEME },
  {
    name: "Ocean",
    theme: {
      ...DEFAULT_THEME,
      primary: "#1f6f8b", primaryBright: "#2a9d8f", primaryDark: "#14505c",
      secondary: "#3d5a6c", secondaryBright: "#8ecae6", accent: "#457b9d",
      accentBright: "#cfe8ef", gold: "#e9c46a", themeColor: "#2a9d8f",
    },
  },
  {
    name: "Forest",
    theme: {
      ...DEFAULT_THEME,
      primary: "#2d6a4f", primaryBright: "#40916c", primaryDark: "#1b4332",
      secondary: "#52796f", secondaryBright: "#95d5b2", accent: "#588157",
      accentBright: "#d8f3dc", gold: "#e9c46a", themeColor: "#40916c",
    },
  },
  {
    name: "Charcoal",
    theme: {
      ...DEFAULT_THEME,
      primary: "#3a3a3c", primaryBright: "#5a5a5e", primaryDark: "#1f1f21",
      secondary: "#55555a", secondaryBright: "#9a9aa2", accent: "#6b6b70",
      accentBright: "#e2e2e6", gold: "#d4a017", bg: "#f6f6f7", card: "#ffffff",
      themeColor: "#3a3a3c",
    },
  },
];

export function presetByName(name: string): ThemeConfig | null {
  return THEME_PRESETS.find((p) => p.name === name)?.theme ?? null;
}
