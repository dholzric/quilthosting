// Curated palette library for the Design panel. Each entry is four brand
// inputs; every role colour (bg, ink, primary, ...) is derived from them by
// deriveRoles() in ./tokens.ts, which also enforces WCAG AA. palettes.test.ts
// runs that derivation over every entry, so a new palette that cannot be
// made accessible fails the build rather than shipping.
//
// Hex values were chosen by eye for the family names in the spec (section
// 4.2); they are inputs, not what the page shows — see deriveRoles.

export type PaletteInput = {
  brand: string;
  brandAlt: string;
  accent: string;
  neutral: string;
};

export type PaletteFamily =
  | "heritage"
  | "modern"
  | "naturals"
  | "jewel"
  | "soft"
  | "seasonal"
  | "dark";

export type PaletteDef = {
  id: string;
  name: string;
  family: PaletteFamily;
  input: PaletteInput;
  /** Dark palettes derive a dark bg and light ink. */
  dark?: boolean;
};

export const PALETTE_FAMILIES: readonly PaletteFamily[] = [
  "heritage", "modern", "naturals", "jewel", "soft", "seasonal", "dark",
];

export const PALETTE_FAMILY_LABELS: Record<PaletteFamily, string> = {
  heritage: "Heritage",
  modern: "Modern",
  naturals: "Naturals",
  jewel: "Jewel",
  soft: "Soft",
  seasonal: "Seasonal",
  dark: "Dark",
};

function p(
  id: string,
  name: string,
  family: PaletteFamily,
  brand: string,
  brandAlt: string,
  accent: string,
  neutral: string,
  dark?: boolean
): PaletteDef {
  const def: PaletteDef = { id, name, family, input: { brand, brandAlt, accent, neutral } };
  if (dark) def.dark = true;
  return def;
}

export const PALETTES: PaletteDef[] = [
  // Heritage — traditional quilt dyes: madder, indigo, wheat, walnut.
  p("heritage-madder", "Madder", "heritage", "#9b2c2c", "#2f3e5c", "#d9a441", "#2b2118"),
  p("heritage-indigo", "Indigo", "heritage", "#2c3e6b", "#8b3a3a", "#c98f2c", "#1f2430"),
  p("heritage-wheat", "Wheat", "heritage", "#8a6a2a", "#5b4a2e", "#b8452f", "#3a3226"),
  p("heritage-walnut", "Walnut", "heritage", "#5c3d2e", "#8a6a4f", "#c97b3a", "#2a221c"),

  // Modern — saturated brand + a single punchy accent.
  p("modern-indigo-mustard", "Indigo & Mustard", "modern", "#3f3fbf", "#1f1f4d", "#e0b62a", "#1e1e2a"),
  p("modern-charcoal-coral", "Charcoal & Coral", "modern", "#2e2e33", "#4a4a55", "#ff6f59", "#202024"),
  p("modern-slate-lime", "Slate & Lime", "modern", "#475569", "#1e293b", "#a3c644", "#1f2933"),

  // Naturals — plant and earth tones.
  p("naturals-sage", "Sage", "naturals", "#5f8265", "#3f5a45", "#c8a165", "#2c302a"),
  p("naturals-clay", "Clay", "naturals", "#b5623a", "#6f3f2b", "#d9b45a", "#2f2621"),
  p("naturals-linen", "Linen", "naturals", "#7a6a58", "#4d4238", "#a8563a", "#3a342e"),
  p("naturals-moss", "Moss", "naturals", "#4f6b2f", "#2f4020", "#d4a92a", "#24291d"),

  // Jewel — deep saturated stones with gold.
  p("jewel-garnet", "Garnet", "jewel", "#7a1f3d", "#3a0f22", "#d4a24c", "#241a1e"),
  p("jewel-sapphire", "Sapphire", "jewel", "#1f3f8a", "#102452", "#e0b23a", "#1a1f2e"),
  p("jewel-emerald", "Emerald", "jewel", "#1c6b4a", "#0f3f2c", "#d9b24a", "#172520"),
  p("jewel-amethyst", "Amethyst", "jewel", "#6a3d9a", "#3a1f5c", "#e0a83a", "#211a2a"),

  // Soft — gentle mid-tones; the derived bg stays warm and pale.
  p("soft-blush", "Blush", "soft", "#b85c7a", "#7a3a52", "#d9a441", "#3a2c33"),
  p("soft-sky", "Sky", "soft", "#3f7fb5", "#2a5680", "#e0a040", "#253340"),
  p("soft-lavender", "Lavender", "soft", "#7b6bb5", "#4d4080", "#d9a441", "#2d2a3a"),
  p("soft-butter", "Butter", "soft", "#b58a2a", "#7a5c1a", "#6b8fb5", "#3a3320"),

  // Seasonal — show and retreat themes.
  p("seasonal-harvest", "Harvest", "seasonal", "#b5551f", "#5c2e14", "#e0b62a", "#2e2119"),
  p("seasonal-winter", "Winter", "seasonal", "#2f5f8a", "#1d3a55", "#9bb8d0", "#1e2a33"),
  p("seasonal-spring", "Spring", "seasonal", "#5a9a4a", "#2f5a2a", "#e08ab0", "#23301f"),
  p("seasonal-summer", "Summer", "seasonal", "#1f8a8a", "#145a5a", "#f2b134", "#1c2a2a"),

  // Dark — light brand on a dark ground; bg/ink are inverted by deriveRoles.
  p("dark-charcoal-gold", "Charcoal & Gold", "dark", "#d9a441", "#2a2a2e", "#7fc8c0", "#26262b", true),
  p("dark-ink-rose", "Ink & Rose", "dark", "#e08aa8", "#1a1f33", "#f0c97a", "#1c2030", true),
  p("dark-forest-cream", "Forest & Cream", "dark", "#f0e6c8", "#1f3a2c", "#c8a860", "#182420", true),
];

const BY_ID: Map<string, PaletteDef> = new Map(PALETTES.map((d) => [d.id, d]));

export function paletteById(id: string): PaletteDef | null {
  return BY_ID.get(id) ?? null;
}
