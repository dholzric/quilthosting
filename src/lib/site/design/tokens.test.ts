import { describe, it, expect } from "vitest";
import {
  DEFAULT_DESIGN,
  deriveRoles,
  buildDesignVars,
  designFontsHref,
  siteDesignSchema,
  ROLE_KEYS,
} from "./tokens";
import type { SiteDesign } from "./tokens";
import { TYPE_PAIRS, typePairById } from "./typePairs";
import { FONT_OPTIONS } from "../fonts";
import { paletteById } from "./palettes";
import { contrastRatio, hexToOklch, tint, bestInk } from "./color";

function vars(design: SiteDesign): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of buildDesignVars(design).split(";")) {
    if (!part) continue;
    const i = part.indexOf(":");
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

describe("TYPE_PAIRS", () => {
  it("has at least 11 pairs including system", () => {
    expect(TYPE_PAIRS.length).toBeGreaterThanOrEqual(11);
    const sys = TYPE_PAIRS.find((p) => p.id === "system");
    expect(sys).toBeTruthy();
    expect(sys?.display).toBe("system");
    expect(sys?.body).toBe("system");
    const ids = TYPE_PAIRS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every display/body key exists in FONT_OPTIONS (or is system)", () => {
    for (const p of TYPE_PAIRS) {
      for (const k of [p.display, p.body]) {
        expect(k === "system" || k in FONT_OPTIONS, `${p.id}: ${k}`).toBe(true);
      }
      expect(p.sample.length, p.id).toBeGreaterThan(0);
      expect(p.sample.toLowerCase()).not.toContain("lorem");
    }
  });

  it("includes the pairs the spec names", () => {
    for (const id of [
      "fraunces-inter", "cormorantgaramond-sourcesans", "playfair-lato",
      "dmserif-dmsans", "lora-karla", "librebaskerville-nunitosans", "manrope",
      "spacegrotesk-worksans", "bitter-opensans", "newsreader-ibmplexsans",
      "nunito", "system",
    ]) {
      expect(TYPE_PAIRS.some((p) => p.id === id), id).toBe(true);
    }
  });

  it("typePairById falls back to fraunces-inter", () => {
    expect(typePairById("nope").id).toBe("fraunces-inter");
    expect(typePairById("playfair-lato").display).toBe("playfair");
  });
});

describe("DEFAULT_DESIGN", () => {
  it("matches the plan defaults", () => {
    expect(DEFAULT_DESIGN.palette.id).toBe("heritage-madder");
    expect(DEFAULT_DESIGN.palette.input).toEqual(paletteById("heritage-madder")?.input);
    expect(DEFAULT_DESIGN.typePair).toBe("fraunces-inter");
    expect(DEFAULT_DESIGN.scale).toBe("comfortable");
    expect(DEFAULT_DESIGN.shape).toEqual({ radius: "soft", shadow: "subtle" });
    expect(DEFAULT_DESIGN.rhythm).toEqual({ spacing: "normal", container: "normal" });
    expect(DEFAULT_DESIGN.header).toEqual({ variant: "left", sticky: true, cta: "join", overlayHero: false });
    expect(DEFAULT_DESIGN.footer).toEqual({ variant: "columns" });
    expect(DEFAULT_DESIGN.pattern.id).toBe("none");
  });
  it("validates against siteDesignSchema", () => {
    expect(siteDesignSchema.safeParse(DEFAULT_DESIGN).success).toBe(true);
  });
});

describe("deriveRoles", () => {
  const input = paletteById("heritage-madder")!.input;

  it("follows the light derivation rules", () => {
    const r = deriveRoles(input);
    expect(r.bg).toBe(tint(input.neutral, 0.985));
    expect(r.surface).toBe(tint(input.neutral, 0.995));
    expect(r.surfaceAlt).toBe(tint(input.neutral, 0.95));
    expect(r.border).toBe(tint(input.neutral, 0.88));
    expect(r.ink).toBe(tint(input.neutral, 0.2));
    expect(r.inkMuted).toBe(tint(input.neutral, 0.45));
    expect(r.dark).toBe(tint(input.brandAlt, 0.22));
    expect(r.onDark).toBe(bestInk(r.dark));
    const t = hexToOklch(r.tint);
    expect(t.l).toBeCloseTo(0.94, 1);
    expect(t.c).toBeLessThanOrEqual(0.061);
    const dh = Math.abs(((t.h - hexToOklch(input.brand).h + 540) % 360) - 180);
    expect(dh).toBeLessThan(6);
    // Madder already contrasts with the near-white bg, so primary is the brand.
    expect(r.primary).toBe(input.brand);
    expect(r.onPrimary).toBe("#ffffff");
    expect(hexToOklch(r.primaryHover).l).toBeCloseTo(hexToOklch(r.primary).l - 0.08, 1);
  });

  it("follows the dark derivation rules", () => {
    const d = paletteById("dark-charcoal-gold")!;
    const r = deriveRoles(d.input, true);
    expect(r.bg).toBe(tint(d.input.neutral, 0.16));
    expect(r.surface).toBe(tint(d.input.neutral, 0.21));
    expect(r.surfaceAlt).toBe(tint(d.input.neutral, 0.26));
    expect(r.border).toBe(tint(d.input.neutral, 0.3));
    expect(r.ink).toBe(tint(d.input.neutral, 0.93));
    expect(r.inkMuted).toBe(tint(d.input.neutral, 0.7));
    expect(contrastRatio(r.ink, r.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("nudges a too-light brand until it contrasts on a light bg", () => {
    const r = deriveRoles({ brand: "#fff2b0", brandAlt: "#333333", accent: "#eeeeee", neutral: "#222222" });
    expect(contrastRatio(r.primary, r.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(r.onPrimary, r.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(r.accent, r.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(r.onAccent, r.accent)).toBeGreaterThanOrEqual(4.5);
    expect(r.primary).not.toBe("#fff2b0");
  });

  it("nudges a too-dark brand until it contrasts on a dark bg", () => {
    const r = deriveRoles({ brand: "#101010", brandAlt: "#222222", accent: "#151515", neutral: "#1a1a1a" }, true);
    expect(contrastRatio(r.primary, r.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(r.onPrimary, r.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(r.accent, r.bg)).toBeGreaterThanOrEqual(3);
  });

  it("tolerates a bad hex by falling back rather than throwing", () => {
    const r = deriveRoles({ brand: "red", brandAlt: "#333", accent: "#d9a441", neutral: "#2b2118" });
    expect(r.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(r.onPrimary, r.primary)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("buildDesignVars", () => {
  it("emits the roles, fonts, shape, rhythm and scale variables", () => {
    const css = buildDesignVars(DEFAULT_DESIGN);
    expect(css).toContain("--qh-bg:#");
    expect(css).toContain("--qh-font-display:");
    expect(css).toContain("--qh-font-body:");
    expect(css).toContain("--qh-radius:");
    expect(css).toContain("--qh-shadow:");
    expect(css).toContain("--qh-section-y:");
    expect(css).toContain("--qh-container:");
    expect(css).not.toContain("\n");
    const v = vars(DEFAULT_DESIGN);
    for (const role of ROLE_KEYS) {
      const kebab = role.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
      expect(v[`--qh-${kebab}`], role).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(v["--qh-font-display"]).toContain("Fraunces");
    expect(v["--qh-font-body"]).toContain("Inter");
    expect(v["--qh-radius"]).toBe("0.5rem");
    expect(v["--qh-section-y"]).toBe("4rem");
    expect(v["--qh-container"]).toBe("64rem");
    expect(v["--qh-scale"]).toBe("1.25");
    expect(v["--qh-fs-1"]).toBe("1rem");
    expect(parseFloat(v["--qh-fs-6"])).toBeCloseTo(Math.pow(1.25, 5), 2);
    expect(v["--qh-pattern-opacity"]).toBe("0.08");
  });

  it("maps every shape/rhythm/scale option", () => {
    const d = (over: Partial<SiteDesign>): SiteDesign => ({ ...DEFAULT_DESIGN, ...over });
    expect(vars(d({ shape: { radius: "sharp", shadow: "none" } }))["--qh-radius"]).toBe("0");
    expect(vars(d({ shape: { radius: "sharp", shadow: "none" } }))["--qh-shadow"]).toBe("none");
    expect(vars(d({ shape: { radius: "round", shadow: "lifted" } }))["--qh-radius"]).toBe("1rem");
    expect(vars(d({ rhythm: { spacing: "tight", container: "narrow" } }))["--qh-section-y"]).toBe("2.5rem");
    expect(vars(d({ rhythm: { spacing: "tight", container: "narrow" } }))["--qh-container"]).toBe("44rem");
    expect(vars(d({ rhythm: { spacing: "airy", container: "wide" } }))["--qh-section-y"]).toBe("6rem");
    expect(vars(d({ rhythm: { spacing: "airy", container: "wide" } }))["--qh-container"]).toBe("80rem");
    expect(vars(d({ scale: "compact" }))["--qh-scale"]).toBe("1.2");
    expect(vars(d({ scale: "editorial" }))["--qh-scale"]).toBe("1.333");
    const fs = vars(d({ scale: "editorial" }));
    for (let i = 1; i < 6; i++) {
      expect(parseFloat(fs[`--qh-fs-${i + 1}`])).toBeGreaterThan(parseFloat(fs[`--qh-fs-${i}`]));
    }
  });

  it("uses a system stack for the system pair and never leaks unsafe text", () => {
    const v = vars({ ...DEFAULT_DESIGN, typePair: "system" });
    expect(v["--qh-font-display"]).toContain("system-ui");
    expect(v["--qh-font-body"]).toContain("system-ui");
    const css = buildDesignVars({ ...DEFAULT_DESIGN, typePair: "x</style><script>" as string });
    expect(css).not.toContain("<");
    expect(css).toContain("Fraunces");
  });
});

describe("designFontsHref", () => {
  it("returns a Google Fonts URL for a pair and null for system", () => {
    const href = designFontsHref(DEFAULT_DESIGN);
    expect(href).toContain("fonts.googleapis.com/css2");
    expect(href).toContain("Fraunces");
    expect(href).toContain("Inter");
    expect(designFontsHref({ ...DEFAULT_DESIGN, typePair: "system" })).toBeNull();
  });
  it("requests one family for a single-face pair", () => {
    const href = designFontsHref({ ...DEFAULT_DESIGN, typePair: "manrope" });
    expect(href?.match(/family=/g)).toHaveLength(1);
  });
});

describe("siteDesignSchema", () => {
  it("fills defaults for a partial document", () => {
    const r = siteDesignSchema.safeParse({ palette: { id: "jewel-garnet" } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.palette.input).toEqual(paletteById("jewel-garnet")?.input);
      expect(r.data.typePair).toBe("fraunces-inter");
      expect(r.data.header.sticky).toBe(true);
    }
  });
  it("rejects an unknown type pair with a path", () => {
    const r = siteDesignSchema.safeParse({ ...DEFAULT_DESIGN, typePair: "comic-sans" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["typePair"]);
  });
  it("rejects a bad hex and an unknown palette id without input", () => {
    expect(siteDesignSchema.safeParse({ ...DEFAULT_DESIGN, palette: { input: { ...DEFAULT_DESIGN.palette.input, brand: "red" } } }).success).toBe(false);
    expect(siteDesignSchema.safeParse({ palette: { id: "nope" } }).success).toBe(false);
  });
  it("rejects a bad pattern id and out-of-range opacity", () => {
    expect(siteDesignSchema.safeParse({ ...DEFAULT_DESIGN, pattern: { id: "paisley", opacity: 0.1 } }).success).toBe(false);
    expect(siteDesignSchema.safeParse({ ...DEFAULT_DESIGN, pattern: { id: "log-cabin", opacity: 2 } }).success).toBe(false);
  });
});
