// The block studio.
//
// 120 starter kits and any two guilds that picked the same one got the same
// page. A guild's signature block is generated from its slug, so two guilds on
// one palette still get different sites — the thing hand-authoring kits was
// never going to achieve.
//
// Determinism is the contract, not an implementation detail: a guild's block
// must be THEIRS and must never change underneath them.
import { describe, it, expect } from "vitest";
import {
  seedOf, blockRecipe, describeBlock, signatureBlockSvg, signatureBlockUri, BLOCK_UNITS,
} from "./blockStudio";

const C = { a: "#355d85", b: "#263f59", c: "#a97843", d: "#f7f3ec" };

describe("it is the same block every time", () => {
  it("gives identical output for the same slug, across calls", () => {
    const a = signatureBlockSvg("wimberley-valley-quilt-guild", C, 96);
    const b = signatureBlockSvg("wimberley-valley-quilt-guild", C, 96);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(200);
  });

  it("is stable against case and surrounding space", () => {
    // A slug that arrives trimmed differently must not repaint the site.
    expect(seedOf("  Riverbend  ")).toBe(seedOf("riverbend"));
  });

  it("uses no clock and no randomness", () => {
    // The only way determinism survives refactoring is if nothing here can
    // reach for a moving value in the first place.
    const src = String(signatureBlockSvg) + String(blockRecipe) + String(seedOf);
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date/);
  });
});

describe("two guilds do not get the same site", () => {
  const slugs = [
    "wimberley-valley-quilt-guild", "austin-area-quilt-guild", "test-steph",
    "bluebonnet-quilt-guild", "hill-country-quilters", "aaqg", "amqg",
    "texas-short-horn-quilt-guild", "stitchstudio", "autoquilt", "hailhaus", "riverbend",
  ];

  it("draws a different block for every real guild slug we have", () => {
    const drawn = new Set(slugs.map((s) => signatureBlockSvg(s, C, 96)));
    expect(drawn.size).toBe(slugs.length);
  });

  it("spreads them across the unit vocabulary rather than favouring one", () => {
    const units = new Set(slugs.map((s) => blockRecipe(s).unit));
    expect(units.size).toBeGreaterThanOrEqual(4);
  });

  it("keeps the grid in the range that still reads as a block", () => {
    // Under 4 there is no block; over 6 it is noise once scaled to a background.
    for (const s of slugs) {
      const { grid } = blockRecipe(s);
      expect(grid, s).toBeGreaterThanOrEqual(4);
      expect(grid, s).toBeLessThanOrEqual(6);
    }
  });

  it("only ever pieces from units a quilter would name", () => {
    for (const s of slugs) expect(BLOCK_UNITS).toContain(blockRecipe(s).unit);
  });
});

describe("it is safe to drop into a style attribute", () => {
  // The tile lands in an SVG attribute, inside a CSS url(), inside a
  // double-quoted HTML style attribute.
  it("never emits a double quote", () => {
    expect(signatureBlockSvg("guild", C, 96)).not.toContain('"');
  });

  it("refuses a colour that is not a plain hex", () => {
    const evil = signatureBlockSvg("guild", { ...C, a: "#fff'/><script>x" }, 96);
    expect(evil).not.toContain("script");
    expect(evil).toContain("#808080");
  });

  it("percent-encodes what CSS and HTML would otherwise eat", () => {
    const uri = signatureBlockUri("guild", C, 96);
    expect(uri.startsWith('url("data:image/svg+xml;utf8,')).toBe(true);
    const payload = uri.slice('url("data:image/svg+xml;utf8,'.length, -2);
    // % is the escape character itself, so it is expected to be there.
    for (const ch of ['"', "<", ">", "#"]) expect(payload, ch).not.toContain(ch);
  });

  it("falls back to a sane tile rather than drawing nothing", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(signatureBlockSvg("guild", C, bad as number)).toContain("width='96'");
    }
  });
});

describe("the recipe reads like a quilter wrote it", () => {
  it("names the unit, the grid and the symmetry", () => {
    expect(describeBlock("riverbend")).toMatch(/^[A-Z][a-z ]+ · \d × \d · (pinwheel|mirrored|scrappy)$/);
  });

  it("describes the block it actually drew", () => {
    const { grid } = blockRecipe("aaqg");
    expect(describeBlock("aaqg")).toContain(`${grid} × ${grid}`);
  });
});
