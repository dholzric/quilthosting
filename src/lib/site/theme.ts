// Theme token model, ported from austinlongarm (src/lib/theme-css.ts +
// config-defaults.ts). Thirteen tokens; twelve become CSS custom properties
// and themeColor drives the <meta name="theme-color"> tag.

import { resolveFont } from "./fonts";

export interface ThemeConfig {
  primary: string;
  primaryBright: string;
  primaryDark: string;
  secondary: string;
  secondaryBright: string;
  accent: string;
  accentBright: string;
  gold: string;
  bg: string;
  card: string;
  textBase: string;
  textMuted: string;
  themeColor: string;
}

export interface FontsConfig {
  /** key into FONT_OPTIONS */
  heading: string;
  /** key into FONT_OPTIONS */
  body: string;
}

export const DEFAULT_THEME: ThemeConfig = {
  primary: "#8a2060",
  primaryBright: "#c060a0",
  primaryDark: "#6a1048",
  secondary: "#6a4060",
  secondaryBright: "#e090c8",
  accent: "#a04080",
  accentBright: "#f0c8e0",
  gold: "#f0c060",
  bg: "#fcf6fa",
  card: "#fdf4f8",
  textBase: "#2a2530",
  textMuted: "#504852",
  themeColor: "#c060a0",
};

export const DEFAULT_FONTS: FontsConfig = { heading: "fraunces", body: "inter" };

const COLOR_VAR: Partial<Record<keyof ThemeConfig, string>> = {
  primary: "--color-primary",
  primaryBright: "--color-primary-bright",
  primaryDark: "--color-primary-dark",
  secondary: "--color-secondary",
  secondaryBright: "--color-secondary-bright",
  accent: "--color-accent",
  accentBright: "--color-accent-bright",
  gold: "--color-gold",
  bg: "--color-bg",
  card: "--color-card",
  textBase: "--color-text-base",
  textMuted: "--color-text-muted",
};

// Hex (#rgb..#rrggbbaa) or rgb()/rgba()/hsl()/hsla() over a safe charset.
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$|^(?:rgb|hsl)a?\([0-9.,%\s/]+\)$/;

/**
 * Return value only if it is a safe CSS color, else the fallback. Theme values
 * are owner-authored but reach an inline <style> block, so a value like
 * "red}</style><script>" must never pass through.
 */
export function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_COLOR.test(value.trim())
    ? value.trim()
    : fallback;
}

/** ":root" declaration body (no selector, no braces). All colors sanitised. */
export function buildRootVars(theme: ThemeConfig, fonts: FontsConfig): string {
  const parts: string[] = [];
  (Object.keys(COLOR_VAR) as (keyof ThemeConfig)[]).forEach((k) => {
    const cssVar = COLOR_VAR[k];
    if (!cssVar) return;
    parts.push(`${cssVar}:${safeColor(theme?.[k], DEFAULT_THEME[k])}`);
  });
  parts.push(`--font-display:${resolveFont(fonts?.heading).cssStack}`);
  parts.push(`--font-sans:${resolveFont(fonts?.body).cssStack}`);
  return parts.join(";");
}
