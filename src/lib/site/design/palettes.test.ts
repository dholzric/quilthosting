import { describe, it, expect } from "vitest";
import { PALETTES, paletteById, PALETTE_FAMILIES } from "./palettes";
import type { PaletteFamily } from "./palettes";
import { deriveRoles } from "./tokens";
import { contrastRatio, normalizeHex } from "./color";

const REQUIRED_IDS = [
  "heritage-madder", "heritage-indigo", "heritage-wheat", "heritage-walnut",
  "modern-indigo-mustard", "modern-charcoal-coral", "modern-slate-lime",
  "naturals-sage", "naturals-clay", "naturals-linen", "naturals-moss",
  "jewel-garnet", "jewel-sapphire", "jewel-emerald", "jewel-amethyst",
  "soft-blush", "soft-sky", "soft-lavender", "soft-butter",
  "seasonal-harvest", "seasonal-winter", "seasonal-spring", "seasonal-summer",
  "dark-charcoal-gold", "dark-ink-rose", "dark-forest-cream",
];

describe("PALETTES", () => {
  it("has at least 24 palettes with unique kebab-case ids", () => {
    expect(PALETTES.length).toBeGreaterThanOrEqual(24);
    const ids = PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("includes every id named in the plan", () => {
    for (const id of REQUIRED_IDS) {
      expect(paletteById(id), id).not.toBeNull();
    }
  });

  it("covers every family at least three times", () => {
    const families: PaletteFamily[] = [
      "heritage", "modern", "naturals", "jewel", "soft", "seasonal", "dark",
    ];
    expect([...PALETTE_FAMILIES]).toEqual(families);
    for (const f of families) {
      expect(PALETTES.filter((p) => p.family === f).length, f).toBeGreaterThanOrEqual(3);
    }
  });

  it("marks exactly the dark-family palettes as dark", () => {
    for (const p of PALETTES) {
      expect(!!p.dark, p.id).toBe(p.family === "dark");
    }
  });

  it("uses valid six-digit hex for every input", () => {
    for (const p of PALETTES) {
      for (const k of ["brand", "brandAlt", "accent", "neutral"] as const) {
        expect(normalizeHex(p.input[k]), `${p.id}.${k}`).toBe(p.input[k]);
      }
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it("every palette derives AA-passing text pairs", () => {
    for (const p of PALETTES) {
      const r = deriveRoles(p.input, p.dark);
      const tag = (k: string) => `${p.id} ${k}`;
      expect(contrastRatio(r.ink, r.bg), tag("ink/bg")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.inkMuted, r.bg), tag("inkMuted/bg")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.ink, r.surface), tag("ink/surface")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.ink, r.surfaceAlt), tag("ink/surfaceAlt")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.ink, r.tint), tag("ink/tint")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.onPrimary, r.primary), tag("onPrimary/primary")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.onAccent, r.accent), tag("onAccent/accent")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.onDark, r.dark), tag("onDark/dark")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.primary, r.bg), tag("primary/bg")).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(r.accent, r.bg), tag("accent/bg")).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(r.onPrimary, r.primaryHover), tag("onPrimary/primaryHover")).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("paletteById", () => {
  it("returns null for unknown ids", () => {
    expect(paletteById("nope")).toBeNull();
    expect(paletteById("")).toBeNull();
  });
  it("returns the matching definition", () => {
    const p = paletteById("heritage-madder");
    expect(p?.family).toBe("heritage");
    expect(p?.input.brand).toMatch(/^#[0-9a-f]{6}$/);
  });
});
