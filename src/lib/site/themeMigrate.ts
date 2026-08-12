// Converts between the legacy five-field SiteTheme (which guild.html reads)
// and the thirteen-token ThemeConfig the server renderer uses.
//
// Both directions matter. Expansion powers the backfill and the renderer;
// derivation keeps /public/:slug/site emitting what guild.html expects, so
// there is one stored source of truth instead of two drifting copies.

import type { SiteTheme } from "../blocks";
import type { ThemeConfig, FontsConfig } from "./theme";
import { DEFAULT_THEME, DEFAULT_FONTS, safeColor } from "./theme";

const LEGACY_FONT_MAP: Record<string, FontsConfig> = {
  system: DEFAULT_FONTS,
  serif: { heading: "lora", body: "lora" },
  rounded: { heading: "nunito", body: "nunito" },
};

// guild.html's applyTheme() also branches on theme.font and theme.style, and
// public/admin.html has live dropdowns ("Style" / "Font") that set them.
// Neither has a ThemeConfig equivalent (ThemeConfig is colors only), so they
// can't be derived from the token set the way primary/accent/headerBg can.
// deriveLegacyTheme accepts the original stored legacy object purely to pass
// these two fields through unchanged, constrained to known values.
const LEGACY_FONT_VALUES = new Set(["system", "serif", "rounded"]);
const LEGACY_STYLE_VALUES = new Set(["classic", "modern", "warm"]);

function isExpanded(v: Record<string, unknown>): boolean {
  // themeColor exists only on ThemeConfig, never on SiteTheme.
  return typeof v.themeColor === "string";
}

/** Legacy SiteTheme (or an already-expanded ThemeConfig) -> ThemeConfig. */
export function expandLegacyTheme(
  legacy: Partial<SiteTheme> | Partial<ThemeConfig> | null | undefined
): ThemeConfig {
  const src = (legacy || {}) as Record<string, unknown>;

  if (isExpanded(src)) {
    // Already migrated. Re-validate every token so an unsafe value stored by
    // an older build cannot survive, and so the backfill is idempotent.
    const out = {} as ThemeConfig;
    (Object.keys(DEFAULT_THEME) as (keyof ThemeConfig)[]).forEach((k) => {
      out[k] = safeColor(src[k], DEFAULT_THEME[k]);
    });
    return out;
  }

  // themeColor in DEFAULT_THEME is a primaryBright variant, not primary
  // itself, so it must only mirror `primary` when the legacy source actually
  // overrides it — otherwise expandLegacyTheme(null) would not equal
  // DEFAULT_THEME.
  const primaryOverride = safeColor(src.primary, "");
  const primary = primaryOverride || DEFAULT_THEME.primary;
  const accent = safeColor(src.accent, DEFAULT_THEME.accent);
  return {
    ...DEFAULT_THEME,
    primary,
    accent,
    // headerBg was the guild header surface; card is its nearest token.
    card: safeColor(src.headerBg, DEFAULT_THEME.card),
    themeColor: primaryOverride || DEFAULT_THEME.themeColor,
  };
}

/**
 * ThemeConfig -> the fields guild.html still consumes. `legacy`, when given,
 * is the tenant's original stored SiteTheme (i.e. the raw `settings.theme`
 * object, before expansion) — every field on the returned SiteTheme is
 * presence-based against it, not defaulted.
 *
 * This must be presence-based, not defaulted: `theme` (the expanded
 * ThemeConfig) always has all 13 tokens filled in from DEFAULT_THEME, so an
 * unconfigured tenant's `theme.primary` is DEFAULT_THEME.primary
 * (austinlongarm's purple, "#8a2060") even though the tenant never set
 * anything. guild.html's applyTheme() only overrides colors when
 * `theme.primary` is truthy (public/guild.html:921); if this function
 * unconditionally emitted `primary`, every guild that never opened the
 * "Theme & site navigation" panel would be repainted purple instead of
 * keeping the platform's real default brand color (`--brand` in
 * public/qh.css). So: emit a key only when `legacy` actually had it set,
 * mirroring the font/style logic below (which got this right originally).
 */
export function deriveLegacyTheme(
  theme: ThemeConfig,
  legacy?: Partial<SiteTheme> | null
): SiteTheme {
  const out: SiteTheme = {};
  if (typeof legacy?.primary === "string" && legacy.primary) {
    out.primary = safeColor(theme.primary, DEFAULT_THEME.primary);
  }
  if (typeof legacy?.accent === "string" && legacy.accent) {
    out.accent = safeColor(theme.accent, DEFAULT_THEME.accent);
  }
  if (typeof legacy?.headerBg === "string" && legacy.headerBg) {
    out.headerBg = safeColor(theme.card, DEFAULT_THEME.card);
  }
  const font = legacy?.font;
  if (typeof font === "string" && LEGACY_FONT_VALUES.has(font)) {
    out.font = font as SiteTheme["font"];
  }
  const style = legacy?.style;
  if (typeof style === "string" && LEGACY_STYLE_VALUES.has(style)) {
    out.style = style as SiteTheme["style"];
  }
  return out;
}

/** Legacy `font` enum -> FontsConfig. */
export function fontsFromLegacy(
  legacy: Partial<SiteTheme> | null | undefined
): FontsConfig {
  const key = String((legacy || {}).font || "");
  return LEGACY_FONT_MAP[key] ?? DEFAULT_FONTS;
}

/**
 * Read a tenant's theme + fonts out of settings_json, expanding legacy shapes
 * on the fly. Never throws: a business site must render even if settings_json
 * is corrupt.
 */
export function readTenantTheme(
  settingsJson: string | null | undefined
): { theme: ThemeConfig; fonts: FontsConfig } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(settingsJson || "{}") as Record<string, unknown>;
  } catch {
    return { theme: DEFAULT_THEME, fonts: DEFAULT_FONTS };
  }
  const rawTheme = (parsed.theme || {}) as Record<string, unknown>;
  const theme = expandLegacyTheme(rawTheme);
  const storedFonts = parsed.fonts as Partial<FontsConfig> | undefined;
  const fonts: FontsConfig = storedFonts?.heading && storedFonts?.body
    ? { heading: String(storedFonts.heading), body: String(storedFonts.body) }
    : fontsFromLegacy(rawTheme as Partial<SiteTheme>);
  return { theme, fonts };
}
