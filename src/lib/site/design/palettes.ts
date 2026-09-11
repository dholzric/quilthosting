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
  | "mono"
  | "naturals"
  | "jewel"
  | "soft"
  | "seasonal"
  | "dark";

/**
 * How much tone the PAGE carries, independent of the brand colour.
 *
 * Every light palette used to derive the same near-white ground, so twenty
 * three of them differed only in the colour of the buttons: the library was
 * varied and the sites were not. The ground is the axis that fixes that —
 * `paper` is the old behaviour, and each step down puts more of the palette's
 * own hue into the page itself. deriveRoles() re-fits text and buttons for
 * whichever ground is chosen, so a darker page stays AA.
 */
export type PaletteGround = "paper" | "cream" | "tinted" | "deep";

export const PALETTE_GROUNDS: readonly PaletteGround[] = ["paper", "cream", "tinted", "deep"];

export const PALETTE_GROUND_LABELS: Record<PaletteGround, string> = {
  paper: "Paper",
  cream: "Cream",
  tinted: "Tinted",
  deep: "Deep",
};

/** One line each, for the Design panel's page-tone control. */
export const PALETTE_GROUND_HINTS: Record<PaletteGround, string> = {
  paper: "Near-white. Crisp and quiet; the colour is in the type and buttons.",
  cream: "A warm off-white page, the way most printed things look.",
  tinted: "The page itself carries the palette's colour, softly.",
  deep: "A full-strength coloured page. Bold, and still readable.",
};

export type PaletteDef = {
  id: string;
  name: string;
  family: PaletteFamily;
  input: PaletteInput;
  /** Page tone. Omitted means "paper" — a near-white page. */
  ground?: PaletteGround;
  /** Dark palettes derive a dark bg and light ink; ground does not apply. */
  dark?: boolean;
};

export const PALETTE_FAMILIES: readonly PaletteFamily[] = [
  "heritage", "modern", "mono", "naturals", "jewel", "soft", "seasonal", "dark",
];

export const PALETTE_FAMILY_LABELS: Record<PaletteFamily, string> = {
  heritage: "Heritage",
  modern: "Modern",
  mono: "Black & white",
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
  ground: PaletteGround | "night" = "paper"
): PaletteDef {
  const def: PaletteDef = { id, name, family, input: { brand, brandAlt, accent, neutral } };
  if (ground === "night") def.dark = true;
  else if (ground !== "paper") def.ground = ground;
  return def;
}

export const PALETTES: PaletteDef[] = [
  // Signature collection — palettes composed around original textile imagery.
  p("signature-oat-ink", "Oat & Printer's Ink", "mono", "#292923", "#25251f", "#9a6435", "#40372b", "cream"),
  p("signature-vermilion", "Vermilion & Cobalt", "modern", "#ba3526", "#253b83", "#e6bb4a", "#352d29", "paper"),
  p("signature-midnight", "Indigo & Ivory", "dark", "#e9dcc4", "#122532", "#9cabb5", "#172735", "night"),
  p("signature-terracotta", "Terracotta & Cream", "naturals", "#93412e", "#344737", "#b18035", "#41372c", "cream"),
  p("signature-mulberry-paper", "Mulberry & Paper", "heritage", "#733b52", "#3f2933", "#a8723b", "#423631", "cream"),
  p("signature-blackbird", "Blackbird", "dark", "#e8e2d8", "#17191b", "#d3e438", "#181a1c", "night"),
  p("signature-ridge-blue", "Ridge Blue", "heritage", "#355d85", "#263f59", "#a97843", "#303842", "cream"),
  p("signature-sunroom", "Sunroom", "soft", "#d84e2f", "#8e3157", "#5b70cf", "#3e3038", "paper"),
  p("signature-redwork", "Redwork", "heritage", "#a2242e", "#681a24", "#a8875b", "#3c302d", "paper"),
  p("signature-exhibition", "Exhibition", "modern", "#2547a9", "#b72c2f", "#e4ad31", "#242938", "paper"),
  p("signature-mending", "Mending", "naturals", "#41677a", "#6f3d2c", "#c09336", "#343a33", "tinted"),
  p("signature-pattern-house", "Pattern House", "modern", "#285442", "#9a4537", "#819db5", "#2d352f", "cream"),
  p("signature-night-bloom", "Night Bloom", "dark", "#eadde8", "#3b203d", "#c3973e", "#211922", "night"),
  p("signature-lake-effect", "Lake Effect", "heritage", "#294c69", "#172c3d", "#b6483e", "#313a40", "cream"),
  p("signature-citrus-press", "Citrus Press", "modern", "#d94f32", "#466b3b", "#e2b72f", "#40352e", "paper"),
  p("signature-quilt-camp", "Quilt Camp", "naturals", "#31533e", "#6f3b27", "#c08c45", "#39342c", "tinted"),
  p("signature-modern-heirloom", "Modern Heirloom", "soft", "#7e4b52", "#49383a", "#a78969", "#403a37", "cream"),
  p("signature-selvage-club", "Selvage Club", "modern", "#234f91", "#c33b32", "#e0af2f", "#2c2b2a", "paper"),
  p("signature-needle-pine", "Needle & Pine", "dark", "#e6ded0", "#1f3b31", "#b86f3d", "#1d2b26", "night"),
  p("signature-studio-grid", "Studio Grid", "mono", "#161616", "#3944a5", "#e8c53d", "#252525", "paper"),
  p("signature-story-cloth", "Story Cloth", "heritage", "#3a5068", "#7b452b", "#c39345", "#3c342d", "cream"),
  p("signature-holiday-house", "Holiday House", "seasonal", "#31523d", "#7f2832", "#bf9a50", "#37332d", "cream"),
  // Heritage — traditional quilt dyes: madder, indigo, wheat, walnut.
  p("heritage-madder", "Madder", "heritage", "#9b2c2c", "#2f3e5c", "#d9a441", "#2b2118", "cream"),
  p("heritage-indigo", "Indigo", "heritage", "#2c3e6b", "#8b3a3a", "#c98f2c", "#1f2430"),
  p("heritage-wheat", "Wheat", "heritage", "#8a6a2a", "#5b4a2e", "#b8452f", "#3a3226", "cream"),
  p("heritage-walnut", "Walnut", "heritage", "#5c3d2e", "#8a6a4f", "#c97b3a", "#2a221c", "tinted"),
  p("heritage-turkey-red", "Turkey Red", "heritage", "#a32b25", "#3c2a24", "#2f6b5c", "#33231e", "tinted"),

  // Modern — saturated brand + a single punchy accent.
  p("modern-indigo-mustard", "Indigo & Mustard", "modern", "#3f3fbf", "#1f1f4d", "#e0b62a", "#1e1e2a"),
  p("modern-charcoal-coral", "Charcoal & Coral", "modern", "#2e2e33", "#4a4a55", "#ff6f59", "#202024"),
  p("modern-slate-lime", "Slate & Lime", "modern", "#475569", "#1e293b", "#a3c644", "#1f2933"),
  p("modern-electric", "Electric", "modern", "#1d4ed8", "#0b1b3f", "#f43f7f", "#1a2030"),
  p("modern-oat-ink", "Oat & Ink", "modern", "#1f2937", "#4b5563", "#c2410c", "#39332a", "cream"),

  // Black & white — the page is the design; one colour does the work.
  p("mono-ink-paper", "Ink & Paper", "mono", "#141414", "#3d3d3d", "#c2352b", "#161616"),
  p("mono-newsprint", "Newsprint", "mono", "#22201d", "#57534e", "#b45309", "#3a352f", "cream"),
  p("mono-blueprint", "Blueprint", "mono", "#1e3a5f", "#0f2136", "#7c8ea3", "#22303f", "deep"),

  // Naturals — plant and earth tones.
  p("naturals-sage", "Sage", "naturals", "#5f8265", "#3f5a45", "#c8a165", "#2c302a", "tinted"),
  p("naturals-clay", "Clay", "naturals", "#b5623a", "#6f3f2b", "#d9b45a", "#2f2621", "cream"),
  p("naturals-linen", "Linen", "naturals", "#7a6a58", "#4d4238", "#a8563a", "#3a342e", "cream"),
  p("naturals-moss", "Moss", "naturals", "#4f6b2f", "#2f4020", "#d4a92a", "#24291d", "tinted"),
  p("naturals-terracotta", "Terracotta", "naturals", "#9c4a2b", "#5a2a19", "#3f6b62", "#3b2a22", "deep"),
  p("naturals-fog", "Fog", "naturals", "#4a5f6b", "#2c3a42", "#b5794a", "#2b3237", "deep"),

  // Jewel — deep saturated stones with gold.
  p("jewel-garnet", "Garnet", "jewel", "#7a1f3d", "#3a0f22", "#d4a24c", "#241a1e", "tinted"),
  p("jewel-sapphire", "Sapphire", "jewel", "#1f3f8a", "#102452", "#e0b23a", "#1a1f2e", "deep"),
  p("jewel-emerald", "Emerald", "jewel", "#1c6b4a", "#0f3f2c", "#d9b24a", "#172520", "tinted"),
  p("jewel-amethyst", "Amethyst", "jewel", "#6a3d9a", "#3a1f5c", "#e0a83a", "#211a2a", "tinted"),

  // Soft — gentle mid-tones; the derived bg stays warm and pale.
  p("soft-blush", "Blush", "soft", "#b85c7a", "#7a3a52", "#d9a441", "#3a2c33", "cream"),
  p("soft-sky", "Sky", "soft", "#3f7fb5", "#2a5680", "#e0a040", "#253340", "tinted"),
  p("soft-lavender", "Lavender", "soft", "#7b6bb5", "#4d4080", "#d9a441", "#2d2a3a", "cream"),
  p("soft-butter", "Butter", "soft", "#b58a2a", "#7a5c1a", "#6b8fb5", "#3a3320", "cream"),
  p("soft-seaglass", "Sea Glass", "soft", "#3f8a80", "#255c55", "#d97a5a", "#243330", "tinted"),

  // Seasonal — show and retreat themes.
  p("seasonal-harvest", "Harvest", "seasonal", "#b5551f", "#5c2e14", "#e0b62a", "#2e2119", "tinted"),
  p("seasonal-winter", "Winter", "seasonal", "#2f5f8a", "#1d3a55", "#9bb8d0", "#1e2a33"),
  p("seasonal-spring", "Spring", "seasonal", "#5a9a4a", "#2f5a2a", "#e08ab0", "#23301f"),
  p("seasonal-summer", "Summer", "seasonal", "#1f8a8a", "#145a5a", "#f2b134", "#1c2a2a", "tinted"),
  p("seasonal-autumn-oak", "Autumn Oak", "seasonal", "#8a4a1f", "#4a2810", "#6b7f3a", "#332419", "deep"),

  // Dark — light brand on a dark ground; bg/ink are inverted by deriveRoles.
  p("dark-charcoal-gold", "Charcoal & Gold", "dark", "#d9a441", "#2a2a2e", "#7fc8c0", "#26262b", "night"),
  p("dark-ink-rose", "Ink & Rose", "dark", "#e08aa8", "#1a1f33", "#f0c97a", "#1c2030", "night"),
  p("dark-forest-cream", "Forest & Cream", "dark", "#f0e6c8", "#1f3a2c", "#c8a860", "#182420", "night"),
  p("dark-midnight-teal", "Midnight & Teal", "dark", "#5fd4c4", "#12203a", "#f2a65a", "#141c2e", "night"),
  p("dark-espresso", "Espresso", "dark", "#e8c07a", "#2b1f18", "#d98a6a", "#231a15", "night"),
];

const BY_ID: Map<string, PaletteDef> = new Map(PALETTES.map((d) => [d.id, d]));

export function paletteById(id: string): PaletteDef | null {
  return BY_ID.get(id) ?? null;
}
