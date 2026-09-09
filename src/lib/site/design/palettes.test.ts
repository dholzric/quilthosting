import { describe, it, expect } from "vitest";
import { PALETTES, paletteById, PALETTE_FAMILIES, PALETTE_GROUNDS } from "./palettes";
import type { PaletteFamily } from "./palettes";
import { deriveRoles } from "./tokens";
import { contrastRatio, hexToOklch, normalizeHex, tint } from "./color";

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
      "heritage", "modern", "mono", "naturals", "jewel", "soft", "seasonal", "dark",
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

// ---------------------------------------------------------------------------
// Page tone
//
// The library was always varied; the derivation was not. Every light palette
// used to land on a near-white page, so twenty-three of them differed only in
// the colour of the buttons — "our colour choices are almost all similar",
// which is exactly what a user saw. These pin the axis that fixes it.

describe("page tone (ground)", () => {
  it("paper derives exactly what a single near-white ground used to", () => {
    const paper = PALETTES.find((p) => !p.ground && !p.dark)!;
    const r = deriveRoles(paper.input, false, "paper");
    expect(r.bg).toBe(tint(paper.input.neutral, 0.985));
    expect(r.surface).toBe(tint(paper.input.neutral, 0.995));
    expect(r.surfaceAlt).toBe(tint(paper.input.neutral, 0.95));
    expect(r.border).toBe(tint(paper.input.neutral, 0.88));
  });

  it("each ground puts visibly more tone in the page than the one before", () => {
    const input = PALETTES.find((p) => p.id === "naturals-sage")!.input;
    const grounds = PALETTE_GROUNDS.map((g) => hexToOklch(deriveRoles(input, false, g).bg));
    for (let i = 1; i < grounds.length; i++) {
      const dl = grounds[i - 1].l - grounds[i].l;
      const dc = grounds[i].c - grounds[i - 1].c;
      // Each step is both darker and more saturated than the one before, and
      // the two together have to add up to a difference the eye can see —
      // pages a hair apart are the bug this axis replaced.
      expect(dl, `${PALETTE_GROUNDS[i]} lightness`).toBeGreaterThan(0.01);
      expect(dc, `${PALETTE_GROUNDS[i]} chroma`).toBeGreaterThan(0);
      expect(dl + dc, `${PALETTE_GROUNDS[i]} overall`).toBeGreaterThan(0.02);
    }
    expect(grounds[0].l - grounds[grounds.length - 1].l).toBeGreaterThan(0.06);
    const hexes = PALETTE_GROUNDS.map((g) => deriveRoles(input, false, g).bg);
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  it("the library spreads across tones instead of stacking on one", () => {
    const light = PALETTES.filter((p) => !p.dark);
    const byGround = new Map<string, number>();
    for (const p of light) byGround.set(p.ground ?? "paper", (byGround.get(p.ground ?? "paper") ?? 0) + 1);
    for (const g of PALETTE_GROUNDS) {
      expect(byGround.get(g) ?? 0, `palettes on ${g}`).toBeGreaterThanOrEqual(3);
    }
    // No single tone may hold more than half the light palettes.
    for (const [g, n] of byGround) expect(n, g).toBeLessThanOrEqual(Math.ceil(light.length / 2));
  });

  it("every palette still clears AA for body text and buttons at its own tone", () => {
    for (const p of PALETTES) {
      const r = deriveRoles(p.input, !!p.dark, p.ground);
      expect(contrastRatio(r.ink, r.bg), `${p.id} ink on bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.ink, r.surface), `${p.id} ink on surface`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.ink, r.surfaceAlt), `${p.id} ink on surfaceAlt`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.inkMuted, r.bg), `${p.id} muted on bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.primary, r.bg), `${p.id} primary on bg`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(r.onPrimary, r.primary), `${p.id} label on primary`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.ink, r.tint), `${p.id} ink on tint band`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no two light palettes render the same page as each other", () => {
    const light = PALETTES.filter((p) => !p.dark);
    const pages = light.map((p) => {
      const r = deriveRoles(p.input, false, p.ground);
      return `${r.bg}|${r.primary}`;
    });
    expect(new Set(pages).size, "distinct bg+primary pairs").toBe(light.length);
  });
});
