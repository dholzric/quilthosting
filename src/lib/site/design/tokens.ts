// The site design model: four palette inputs plus type, shape, rhythm,
// header, footer, and pattern choices. deriveRoles() turns the inputs into
// the role colours the stylesheet uses and nudges them until every text
// pairing passes WCAG AA; buildDesignVars() flattens a design into the
// `--qh-*` custom properties public/qh-site.css is written against.

import { z } from "zod";
import { FONT_OPTIONS, buildFontsHref } from "../fonts";
import { bestInk, contrastRatio, hexToOklch, normalizeHex, oklchToHex, tint } from "./color";
import { paletteById, PALETTE_GROUNDS } from "./palettes";
import type { PaletteGround, PaletteInput } from "./palettes";
import { DEFAULT_TYPE_PAIR_ID, TYPE_PAIRS, typePairById } from "./typePairs";

export type { PaletteGround, PaletteInput } from "./palettes";

export type Roles = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  ink: string;
  inkMuted: string;
  border: string;
  primary: string;
  onPrimary: string;
  primaryHover: string;
  accent: string;
  onAccent: string;
  dark: string;
  onDark: string;
  tint: string;
};

export const ROLE_KEYS: readonly (keyof Roles)[] = [
  "bg", "surface", "surfaceAlt", "ink", "inkMuted", "border",
  "primary", "onPrimary", "primaryHover", "accent", "onAccent",
  "dark", "onDark", "tint",
];

// Kept in sync with PatternId in ./patterns.ts (defined locally so this
// module has no dependency on the pattern art).
export type PatternId = "none" | "nine-patch" | "flying-geese" | "log-cabin" | "churn-dash" | "bear-paw";
export const PATTERN_IDS: readonly PatternId[] = [
  "none", "nine-patch", "flying-geese", "log-cabin", "churn-dash", "bear-paw",
];

export type SiteDesign = {
  palette: { id?: string; input: PaletteInput; ground?: PaletteGround };
  typePair: string;
  scale: "compact" | "comfortable" | "editorial";
  shape: { radius: "sharp" | "soft" | "round"; shadow: "none" | "subtle" | "lifted" };
  rhythm: { spacing: "tight" | "normal" | "airy"; container: "narrow" | "normal" | "wide" };
  header: { variant: "left" | "centered" | "split"; sticky: boolean; cta: "join" | "quote" | "donate" | "none"; overlayHero: boolean };
  footer: { variant: "simple" | "columns" | "meeting" };
  pattern: { id: PatternId; opacity: number };
};

const DEFAULT_PALETTE_ID = "heritage-madder";

export const DEFAULT_DESIGN: SiteDesign = {
  palette: { id: DEFAULT_PALETTE_ID, input: { ...(paletteById(DEFAULT_PALETTE_ID) as NonNullable<ReturnType<typeof paletteById>>).input } },
  typePair: DEFAULT_TYPE_PAIR_ID,
  scale: "comfortable",
  shape: { radius: "soft", shadow: "subtle" },
  rhythm: { spacing: "normal", container: "normal" },
  header: { variant: "left", sticky: true, cta: "join", overlayHero: false },
  footer: { variant: "columns" },
  pattern: { id: "none", opacity: 0.08 },
};

// ---------------------------------------------------------------------------
// Schema (used by readSiteDesign and by the tenants PATCH validation)

const hexSchema = z
  .string()
  .transform((v, ctx) => {
    const h = normalizeHex(v);
    if (!h) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a hex colour like #9b2c2c" });
      return z.NEVER;
    }
    return h;
  });

const paletteInputSchema = z.object({
  brand: hexSchema,
  brandAlt: hexSchema,
  accent: hexSchema,
  neutral: hexSchema,
});

const paletteSchema = z
  .object({
    id: z.string().max(60).optional(),
    input: paletteInputSchema.optional(),
    ground: z.enum(["paper", "cream", "tinted", "deep"]).optional(),
  })
  .transform((v, ctx) => {
    const lib = v.id ? paletteById(v.id) : null;
    if (v.id && !lib && !v.input) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: `Unknown palette "${v.id}"` });
      return z.NEVER;
    }
    const input = v.input ?? lib?.input;
    if (!input) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: "Palette needs an id from the library or four input colours" });
      return z.NEVER;
    }
    const out: SiteDesign["palette"] = { input: { ...input } };
    if (lib) out.id = lib.id;
    // Page tone: what the tenant chose, else what the library palette was
    // authored with, else paper (the tone every palette used to derive).
    const ground = v.ground ?? lib?.ground;
    if (ground && ground !== "paper") out.ground = ground;
    return out;
  });

const typePairSchema = z
  .string()
  .refine((v) => TYPE_PAIRS.some((p) => p.id === v), { message: "Unknown type pair" });

export const siteDesignSchema: z.ZodType<SiteDesign, z.ZodTypeDef, unknown> = z.object({
  palette: paletteSchema.default({ id: DEFAULT_PALETTE_ID }),
  typePair: typePairSchema.default(DEFAULT_DESIGN.typePair),
  scale: z.enum(["compact", "comfortable", "editorial"]).default(DEFAULT_DESIGN.scale),
  shape: z
    .object({
      radius: z.enum(["sharp", "soft", "round"]).default(DEFAULT_DESIGN.shape.radius),
      shadow: z.enum(["none", "subtle", "lifted"]).default(DEFAULT_DESIGN.shape.shadow),
    })
    .default({}),
  rhythm: z
    .object({
      spacing: z.enum(["tight", "normal", "airy"]).default(DEFAULT_DESIGN.rhythm.spacing),
      container: z.enum(["narrow", "normal", "wide"]).default(DEFAULT_DESIGN.rhythm.container),
    })
    .default({}),
  header: z
    .object({
      variant: z.enum(["left", "centered", "split"]).default(DEFAULT_DESIGN.header.variant),
      sticky: z.boolean().default(DEFAULT_DESIGN.header.sticky),
      cta: z.enum(["join", "quote", "donate", "none"]).default(DEFAULT_DESIGN.header.cta),
      overlayHero: z.boolean().default(DEFAULT_DESIGN.header.overlayHero),
    })
    .default({}),
  footer: z
    .object({
      variant: z.enum(["simple", "columns", "meeting"]).default(DEFAULT_DESIGN.footer.variant),
    })
    .default({}),
  pattern: z
    .object({
      id: z.enum(["none", "nine-patch", "flying-geese", "log-cabin", "churn-dash", "bear-paw"]).default("none"),
      opacity: z.number().min(0).max(1).default(DEFAULT_DESIGN.pattern.opacity),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// Role derivation

const NUDGE_STEP = 0.02;

/**
 * Page lightness per ground, and the chroma the ground carries.
 *
 * `paper` reproduces the single ground every light palette used to get
 * (bg 0.985 at the neutral's own chroma), so a palette that stays on paper
 * renders exactly as before. The other three lower the page and raise its
 * chroma, which is what makes two palettes look like two different sites
 * rather than the same site with a different button.
 *
 * Surfaces keep the offsets they have always had relative to the page —
 * surface +0.012, surfaceAlt −0.035, border −0.105, the tint band −0.045 —
 * so bands, cards and rules stay in the same relationship at every tone.
 * `chroma: null` means "use the neutral's own", which is what paper did.
 */
const GROUND_TONE: Record<PaletteGround, { l: number; chroma: number | null }> = {
  paper: { l: 0.985, chroma: null },
  cream: { l: 0.962, chroma: 0.012 },
  tinted: { l: 0.942, chroma: 0.022 },
  deep: { l: 0.908, chroma: 0.03 },
};

const SURFACE_OFFSET = 0.01;
const SURFACE_ALT_OFFSET = -0.035;
const BORDER_OFFSET = -0.105;
const TINT_OFFSET = -0.045;

/** The neutral at lightness `l`, carrying `chroma` (or its own when null). */
function groundTone(hex: string, l: number, chroma: number | null): string {
  const own = hexToOklch(hex);
  return oklchToHex(l, chroma === null ? own.c : chroma, own.h);
}
const NUDGE_MAX = 25;

function safeHex(value: string, fallback: string): string {
  return normalizeHex(value) ?? fallback;
}

/**
 * Move `hex` in lightness, one step at a time, until `check` passes or the
 * step budget runs out. `direction` is +1 (lighter) or -1 (darker); pass a
 * function to re-decide the direction after each step.
 */
function nudge(
  hex: string,
  check: (candidate: string) => boolean,
  direction: number | ((candidate: string) => number)
): string {
  let cur = hex;
  for (let i = 0; i < NUDGE_MAX && !check(cur); i++) {
    const { l, c, h } = hexToOklch(cur);
    const dir = typeof direction === "function" ? direction(cur) : direction;
    const next = oklchToHex(l + dir * NUDGE_STEP, c, h);
    if (next === cur) break; // pinned at the lightness limit
    cur = next;
  }
  return cur;
}

/**
 * A button/link colour: must read as a colour against `bg` (>= 3:1) and
 * carry AA text (>= 4.5:1 for whichever ink suits it). Moving away from the
 * background satisfies both on a light ground (white ink on a darkened
 * colour) and on a dark ground (near-black ink on a lightened colour).
 */
function fitInteractive(hex: string, bg: string, dark: boolean): { color: string; on: "#111111" | "#ffffff" } {
  const away = dark ? 1 : -1;
  const color = nudge(
    hex,
    (c) => contrastRatio(c, bg) >= 3 && contrastRatio(bestInk(c), c) >= 4.5,
    (c) => (contrastRatio(c, bg) < 3 ? away : bestInk(c) === "#ffffff" ? -1 : 1)
  );
  return { color, on: bestInk(color) };
}

/** Text colour: keep at least 4.5:1 on `bg`, moving away from it if needed. */
function fitText(hex: string, bg: string, dark: boolean): string {
  return nudge(hex, (c) => contrastRatio(c, bg) >= 4.5, dark ? 1 : -1);
}

/**
 * The page tone a design renders at: the tenant's own choice, else the tone
 * its library palette was authored with. A dark palette has no ground.
 */
export function designGround(design: { palette: { id?: string; ground?: PaletteGround } }): PaletteGround {
  if (design.palette.ground) return design.palette.ground;
  const lib = design.palette.id ? paletteById(design.palette.id) : null;
  return lib?.ground ?? "paper";
}

export function deriveRoles(input: PaletteInput, dark = false, ground: PaletteGround = "paper"): Roles {
  const fb = DEFAULT_DESIGN.palette.input;
  const brand = safeHex(input?.brand, fb.brand);
  const brandAlt = safeHex(input?.brandAlt, fb.brandAlt);
  const accentIn = safeHex(input?.accent, fb.accent);
  const neutral = safeHex(input?.neutral, fb.neutral);

  // A dark palette inverts the page and ignores the ground; a light one takes
  // its page lightness and chroma from the ground, and every other surface
  // keeps its usual distance from the page.
  const tone = GROUND_TONE[ground] ?? GROUND_TONE.paper;
  const bg = dark ? tint(neutral, 0.16) : groundTone(neutral, tone.l, tone.chroma);
  const surface = dark
    ? tint(neutral, 0.21)
    : groundTone(neutral, Math.min(tone.l + SURFACE_OFFSET, 0.999), tone.chroma);
  const surfaceAlt = dark
    ? tint(neutral, 0.26)
    : groundTone(neutral, tone.l + SURFACE_ALT_OFFSET, tone.chroma);
  const border = dark
    ? tint(neutral, 0.3)
    : groundTone(neutral, tone.l + BORDER_OFFSET, tone.chroma);
  // Text must clear AA on every light surface it can sit on; surfaceAlt is
  // the darkest of them on a light palette and the lightest on a dark one.
  const inkFloor = dark ? bg : surfaceAlt;
  const ink = fitText(tint(neutral, dark ? 0.93 : 0.2), inkFloor, dark);
  const inkMuted = fitText(tint(neutral, dark ? 0.7 : 0.45), inkFloor, dark);

  const primaryFit = fitInteractive(brand, bg, dark);
  const primary = primaryFit.color;
  const { l: pl, c: pc, h: ph } = hexToOklch(primary);
  const primaryHover = nudge(
    oklchToHex(pl + (dark ? 0.08 : -0.08), pc, ph),
    (c) => contrastRatio(primaryFit.on, c) >= 4.5,
    primaryFit.on === "#ffffff" ? -1 : 1
  );

  const accentFit = fitInteractive(accentIn, bg, dark);

  const darkRole = tint(brandAlt, 0.22);
  const tintRole = fitTint(wash(brand, dark ? 0.3 : tone.l + TINT_OFFSET), ink, dark);

  return {
    bg,
    surface,
    surfaceAlt,
    ink,
    inkMuted,
    border,
    primary,
    onPrimary: primaryFit.on,
    primaryHover,
    accent: accentFit.color,
    onAccent: accentFit.on,
    dark: darkRole,
    onDark: bestInk(darkRole),
    tint: tintRole,
  };
}

const WASH_MAX_CHROMA = 0.06;

/**
 * A pale wash of `hex` at lightness `l`. Unlike tint(), chroma is capped:
 * a saturated teal or emerald at L 0.94 with full chroma is neon, and the
 * wash sits behind body copy.
 */
function wash(hex: string, l: number): string {
  const { c, h } = hexToOklch(hex);
  return oklchToHex(l, Math.min(c, WASH_MAX_CHROMA), h);
}

/** The soft brand wash behind cards must still carry body text. */
function fitTint(hex: string, ink: string, dark: boolean): string {
  return nudge(hex, (c) => contrastRatio(ink, c) >= 4.5, dark ? -1 : 1);
}

// ---------------------------------------------------------------------------
// CSS variables

const SYSTEM_STACK = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

const SCALE_RATIO: Record<SiteDesign["scale"], number> = {
  compact: 1.2,
  comfortable: 1.25,
  editorial: 1.333,
};

const RADIUS: Record<SiteDesign["shape"]["radius"], string> = {
  sharp: "0",
  soft: "0.5rem",
  round: "1rem",
};

const SHADOW: Record<SiteDesign["shape"]["shadow"], string> = {
  none: "none",
  subtle: "0 1px 2px rgba(0,0,0,0.06),0 4px 12px rgba(0,0,0,0.06)",
  lifted: "0 2px 4px rgba(0,0,0,0.08),0 14px 32px rgba(0,0,0,0.14)",
};

const SECTION_Y: Record<SiteDesign["rhythm"]["spacing"], string> = {
  tight: "2.5rem",
  normal: "4rem",
  airy: "6rem",
};

const CONTAINER: Record<SiteDesign["rhythm"]["container"], string> = {
  narrow: "44rem",
  normal: "64rem",
  wide: "80rem",
};

function fontStack(key: string): string {
  if (key === "system") return SYSTEM_STACK;
  return FONT_OPTIONS[key]?.cssStack ?? FONT_OPTIONS.inter.cssStack;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function trimNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function pick<K extends string>(table: Record<K, string>, key: unknown, fallback: K): string {
  return typeof key === "string" && key in table ? table[key as K] : table[fallback];
}

/**
 * ":root"-style declaration body, no selector or braces. Every value comes
 * from a closed table or a normalised hex, so tenant-authored settings can
 * never break out of the inline <style> it lands in.
 */
export function buildDesignVars(design: SiteDesign): string {
  const d = design ?? DEFAULT_DESIGN;
  const palette = d.palette ?? DEFAULT_DESIGN.palette;
  const dark = !!(palette.id && paletteById(palette.id)?.dark);
  const roles = deriveRoles(palette.input, dark, designGround(design));
  const pair = typePairById(String(d.typePair ?? ""));
  const ratio = typeof d.scale === "string" && d.scale in SCALE_RATIO ? SCALE_RATIO[d.scale] : SCALE_RATIO.comfortable;

  const parts: string[] = [];
  for (const role of ROLE_KEYS) parts.push(`--qh-${kebab(role)}:${roles[role]}`);
  parts.push(`--qh-font-display:${fontStack(pair.display)}`);
  parts.push(`--qh-font-body:${fontStack(pair.body)}`);
  parts.push(`--qh-scale:${trimNum(ratio)}`);
  for (let i = 1; i <= 6; i++) parts.push(`--qh-fs-${i}:${trimNum(Math.pow(ratio, i - 1))}rem`);
  parts.push(`--qh-radius:${pick(RADIUS, d.shape?.radius, "soft")}`);
  parts.push(`--qh-shadow:${pick(SHADOW, d.shape?.shadow, "subtle")}`);
  parts.push(`--qh-section-y:${pick(SECTION_Y, d.rhythm?.spacing, "normal")}`);
  parts.push(`--qh-container:${pick(CONTAINER, d.rhythm?.container, "normal")}`);
  const opacity = typeof d.pattern?.opacity === "number" && isFinite(d.pattern.opacity)
    ? Math.min(1, Math.max(0, d.pattern.opacity))
    : DEFAULT_DESIGN.pattern.opacity;
  parts.push(`--qh-pattern-opacity:${trimNum(opacity)}`);
  return parts.join(";");
}

/** Google Fonts stylesheet URL for the design's type pair; null for system. */
export function designFontsHref(design: SiteDesign): string | null {
  const pair = typePairById(String(design?.typePair ?? ""));
  if (pair.display === "system" && pair.body === "system") return null;
  const display = pair.display === "system" ? pair.body : pair.display;
  const body = pair.body === "system" ? pair.display : pair.body;
  return buildFontsHref(display, body);
}

/** True when the design's palette is one of the library's dark entries. */
export function isDarkDesign(design: SiteDesign): boolean {
  const id = design?.palette?.id;
  return !!(id && paletteById(id)?.dark);
}
