// Reads a tenant's SiteDesign out of settings_json, migrating older shapes
// on the fly:
//   1. settings.design            — the new model (validated, defaults filled)
//   2. settings.theme (13 tokens) — business sites: brand=primary,
//      brandAlt=secondary, accent=gold, neutral=textBase; settings.fonts
//      → nearest type pair
//   3. settings.theme {primary, style, font} — guild sites
//   4. DEFAULT_DESIGN
// Never throws: a site must render even if settings_json is corrupt.

import { normalizeHex, tint } from "./color";
import { DEFAULT_DESIGN, siteDesignSchema } from "./tokens";
import type { SiteDesign } from "./tokens";
import { DEFAULT_TYPE_PAIR_ID, TYPE_PAIRS } from "./typePairs";

const GUILD_ACCENT = "#d9a441";
const GUILD_NEUTRAL = "#2b2118";

const GUILD_FONT_PAIR: Record<string, string> = {
  serif: "playfair-lato",
  rounded: "nunito",
  system: "system",
};

const GUILD_STYLE_SHAPE: Record<string, SiteDesign["shape"]> = {
  classic: { radius: "soft", shadow: "subtle" },
  modern: { radius: "sharp", shadow: "none" },
  warm: { radius: "round", shadow: "subtle" },
};

function clone(design: SiteDesign): SiteDesign {
  return {
    ...design,
    palette: { ...design.palette, input: { ...design.palette.input } },
    shape: { ...design.shape },
    rhythm: { ...design.rhythm },
    header: { ...design.header },
    footer: { ...design.footer },
    pattern: { ...design.pattern },
    heroPhoto: design.heroPhoto ? { ...design.heroPhoto } : undefined,
  };
}

/**
 * Closest curated pair for a heading/body FONT_OPTIONS key combination:
 * exact match, then same display face, then same body face, else default.
 */
export function nearestTypePair(heading: unknown, body: unknown): string {
  const h = typeof heading === "string" ? heading : "";
  const b = typeof body === "string" ? body : "";
  const exact = TYPE_PAIRS.find((p) => p.display === h && p.body === b);
  if (exact) return exact.id;
  const byDisplay = TYPE_PAIRS.find((p) => p.display === h);
  if (byDisplay) return byDisplay.id;
  const byBody = TYPE_PAIRS.find((p) => p.body === b);
  if (byBody) return byBody.id;
  return DEFAULT_TYPE_PAIR_ID;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function fromBusinessTheme(theme: Record<string, unknown>, fonts: unknown): SiteDesign {
  const fb = DEFAULT_DESIGN.palette.input;
  const out = clone(DEFAULT_DESIGN);
  out.palette = {
    input: {
      brand: normalizeHex(theme.primary) ?? fb.brand,
      brandAlt: normalizeHex(theme.secondary) ?? fb.brandAlt,
      accent: normalizeHex(theme.gold) ?? fb.accent,
      neutral: normalizeHex(theme.textBase) ?? fb.neutral,
    },
  };
  const f = isRecord(fonts) ? fonts : {};
  out.typePair = nearestTypePair(f.heading, f.body);
  return out;
}

function fromGuildTheme(theme: Record<string, unknown>): SiteDesign {
  const out = clone(DEFAULT_DESIGN);
  const primary = normalizeHex(theme.primary);
  if (primary) {
    out.palette = {
      input: {
        brand: primary,
        brandAlt: tint(primary, 0.35),
        accent: GUILD_ACCENT,
        neutral: GUILD_NEUTRAL,
      },
    };
  }
  const font = typeof theme.font === "string" ? theme.font : "";
  out.typePair = GUILD_FONT_PAIR[font] ?? DEFAULT_TYPE_PAIR_ID;
  const style = typeof theme.style === "string" ? theme.style : "";
  if (GUILD_STYLE_SHAPE[style]) out.shape = { ...GUILD_STYLE_SHAPE[style] };
  return out;
}

export function readSiteDesign(settingsJson: string | null | undefined): SiteDesign {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson || "{}");
  } catch {
    return clone(DEFAULT_DESIGN);
  }
  if (!isRecord(parsed)) return clone(DEFAULT_DESIGN);

  if (isRecord(parsed.design)) {
    const r = siteDesignSchema.safeParse(parsed.design);
    if (r.success) return r.data;
  }

  const theme = parsed.theme;
  if (isRecord(theme)) {
    if (typeof theme.themeColor === "string") return fromBusinessTheme(theme, parsed.fonts);
    if ("primary" in theme || "font" in theme || "style" in theme) return fromGuildTheme(theme);
  }

  return clone(DEFAULT_DESIGN);
}
