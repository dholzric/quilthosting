import { describe, it, expect } from "vitest";
import {
  hexToOklch,
  oklchToHex,
  contrastRatio,
  tint,
  bestInk,
  normalizeHex,
} from "./color";

const SAMPLES = [
  "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00",
  "#00ffff", "#ff00ff", "#808080", "#9b2c2c", "#2c3e6b", "#d9a441",
  "#2b2118", "#6b8f71", "#1f3f8a", "#e08aa8", "#f0e6c8", "#3f3fbf",
  "#475569", "#b5551f",
];

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

describe("normalizeHex", () => {
  it("accepts #rgb, #rrggbb, #rrggbbaa and lowercases", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#AaBbCc")).toBe("#aabbcc");
    expect(normalizeHex("#aabbcc80")).toBe("#aabbcc");
    expect(normalizeHex("  #aabbcc ")).toBe("#aabbcc");
  });
  it("rejects junk", () => {
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#12")).toBeNull();
    expect(normalizeHex("rgb(1,2,3)")).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(42)).toBeNull();
  });
});

describe("hexToOklch / oklchToHex", () => {
  it("round-trips within 1/255 for sample colors", () => {
    for (const hex of SAMPLES) {
      const { l, c, h } = hexToOklch(hex);
      const back = oklchToHex(l, c, h);
      const a = channels(hex);
      const b = channels(back);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(a[i] - b[i]), `${hex} channel ${i} -> ${back}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("maps white and black to the ends of the lightness axis", () => {
    expect(hexToOklch("#ffffff").l).toBeCloseTo(1, 2);
    expect(hexToOklch("#000000").l).toBeCloseTo(0, 2);
    expect(hexToOklch("#808080").c).toBeLessThan(0.01);
  });

  it("gamut-clips out-of-range chroma to a valid hex", () => {
    const hex = oklchToHex(0.6, 0.5, 30);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    const hex2 = oklchToHex(1.5, 0, 0);
    expect(hex2).toBe("#ffffff");
    const hex3 = oklchToHex(-1, 0, 0);
    expect(hex3).toBe("#000000");
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and symmetric", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 3);
  });
  it("matches a known WCAG value", () => {
    // #767676 on white is the classic 4.54:1 AA-passing grey.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThan(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("tint", () => {
  it("keeps hue and sets lightness", () => {
    const base = hexToOklch("#9b2c2c");
    const light = hexToOklch(tint("#9b2c2c", 0.9));
    expect(light.l).toBeCloseTo(0.9, 1);
    // Hue preserved within a few degrees (chroma may be clipped at high L).
    const dh = Math.abs(((light.h - base.h + 540) % 360) - 180);
    expect(dh).toBeLessThan(6);
  });
  it("produces near-white for l close to 1", () => {
    expect(contrastRatio(tint("#2b2118", 0.985), "#ffffff")).toBeLessThan(1.15);
  });
});

describe("bestInk", () => {
  it("picks white on dark and near-black on light", () => {
    expect(bestInk("#1a1a1a")).toBe("#ffffff");
    expect(bestInk("#f5f5f5")).toBe("#111111");
    expect(bestInk("#d9a441")).toBe("#111111");
  });
});
