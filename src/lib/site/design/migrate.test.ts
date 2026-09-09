import { describe, it, expect } from "vitest";
import { readSiteDesign, nearestTypePair } from "./migrate";
import { DEFAULT_DESIGN } from "./tokens";
import { tint } from "./color";
import { paletteById } from "./palettes";
import { DEFAULT_THEME } from "../theme";

describe("readSiteDesign", () => {
  it("falls back to DEFAULT_DESIGN on empty, junk, or unparsable input", () => {
    expect(readSiteDesign(null)).toEqual(DEFAULT_DESIGN);
    expect(readSiteDesign(undefined)).toEqual(DEFAULT_DESIGN);
    expect(readSiteDesign("")).toEqual(DEFAULT_DESIGN);
    expect(readSiteDesign("{not json")).toEqual(DEFAULT_DESIGN);
    expect(readSiteDesign("[]")).toEqual(DEFAULT_DESIGN);
    expect(readSiteDesign(JSON.stringify({ design: "x", theme: 7 }))).toEqual(DEFAULT_DESIGN);
    expect(readSiteDesign(JSON.stringify({ theme: {} }))).toEqual(DEFAULT_DESIGN);
  });

  it("reads a stored settings.design verbatim", () => {
    const design = {
      ...DEFAULT_DESIGN,
      // The stored design names a library palette, so reading it back fills
      // that palette's authored page tone (jewel-emerald is tinted).
      palette: { id: "jewel-emerald", input: paletteById("jewel-emerald")!.input, ground: "tinted" as const },
      typePair: "playfair-lato",
      scale: "editorial" as const,
      header: { ...DEFAULT_DESIGN.header, variant: "centered" as const },
    };
    const out = readSiteDesign(JSON.stringify({ design, theme: { primary: "#ff0000" } }));
    expect(out).toEqual(design);
  });

  it("fills defaults for a partial settings.design", () => {
    const out = readSiteDesign(JSON.stringify({ design: { palette: { id: "soft-sky" }, footer: { variant: "meeting" } } }));
    expect(out.palette.input).toEqual(paletteById("soft-sky")!.input);
    expect(out.footer.variant).toBe("meeting");
    expect(out.typePair).toBe("fraunces-inter");
  });

  it("migrates a 13-token business theme", () => {
    const theme = {
      ...DEFAULT_THEME,
      primary: "#1f6f8b",
      secondary: "#3d5a6c",
      gold: "#e9c46a",
      textBase: "#22303a",
    };
    const out = readSiteDesign(JSON.stringify({ theme, fonts: { heading: "playfair", body: "lato" } }));
    expect(out.palette.id).toBeUndefined();
    expect(out.palette.input).toEqual({
      brand: "#1f6f8b", brandAlt: "#3d5a6c", accent: "#e9c46a", neutral: "#22303a",
    });
    expect(out.typePair).toBe("playfair-lato");
    expect(out.scale).toBe(DEFAULT_DESIGN.scale);
  });

  it("maps 13-token fonts to the nearest pair by display, then body", () => {
    const theme = { ...DEFAULT_THEME };
    expect(readSiteDesign(JSON.stringify({ theme, fonts: { heading: "playfair", body: "inter" } })).typePair).toBe("playfair-lato");
    expect(readSiteDesign(JSON.stringify({ theme, fonts: { heading: "poppins", body: "karla" } })).typePair).toBe("lora-karla");
    expect(readSiteDesign(JSON.stringify({ theme, fonts: { heading: "poppins", body: "poppins" } })).typePair).toBe("fraunces-inter");
    expect(readSiteDesign(JSON.stringify({ theme })).typePair).toBe("fraunces-inter");
  });

  it("falls back per component when a 13-token value is not hex", () => {
    const theme = { ...DEFAULT_THEME, primary: "rgb(1,2,3)", gold: "#abcdef" };
    const out = readSiteDesign(JSON.stringify({ theme }));
    expect(out.palette.input.brand).toBe(DEFAULT_DESIGN.palette.input.brand);
    expect(out.palette.input.accent).toBe("#abcdef");
  });

  it("migrates a guild {primary, style, font} theme", () => {
    const out = readSiteDesign(JSON.stringify({ theme: { primary: "#336699", style: "modern", font: "serif" } }));
    expect(out.palette.id).toBeUndefined();
    expect(out.palette.input).toEqual({
      brand: "#336699",
      brandAlt: tint("#336699", 0.35),
      accent: "#d9a441",
      neutral: "#2b2118",
    });
    expect(out.typePair).toBe("playfair-lato");
    expect(out.shape).toEqual({ radius: "sharp", shadow: "none" });
  });

  it("maps every guild font value", () => {
    const at = (font: string) =>
      readSiteDesign(JSON.stringify({ theme: { primary: "#336699", font } })).typePair;
    expect(at("serif")).toBe("playfair-lato");
    expect(at("rounded")).toBe("nunito");
    expect(at("system")).toBe("system");
    expect(at("whatever")).toBe("fraunces-inter");
  });

  it("maps guild style to shape and keeps default palette when primary is missing", () => {
    const warm = readSiteDesign(JSON.stringify({ theme: { style: "warm" } }));
    expect(warm.shape).toEqual({ radius: "round", shadow: "subtle" });
    expect(warm.palette).toEqual(DEFAULT_DESIGN.palette);
    const classic = readSiteDesign(JSON.stringify({ theme: { style: "classic", primary: "#123456" } }));
    expect(classic.shape).toEqual({ radius: "soft", shadow: "subtle" });
    const shortHex = readSiteDesign(JSON.stringify({ theme: { primary: "#ABC" } }));
    expect(shortHex.palette.input.brand).toBe("#aabbcc");
  });

  it("ignores a junk design and still migrates the theme underneath", () => {
    const out = readSiteDesign(JSON.stringify({ design: { typePair: 42 }, theme: { primary: "#336699", font: "rounded" } }));
    expect(out.palette.input.brand).toBe("#336699");
    expect(out.typePair).toBe("nunito");
  });
});

describe("nearestTypePair", () => {
  it("prefers an exact match, then display, then body, then the default", () => {
    expect(nearestTypePair("lora", "karla")).toBe("lora-karla");
    expect(nearestTypePair("lora", "inter")).toBe("lora-karla");
    expect(nearestTypePair("poppins", "opensans")).toBe("bitter-opensans");
    expect(nearestTypePair("poppins", "poppins")).toBe("fraunces-inter");
    expect(nearestTypePair(undefined, undefined)).toBe("fraunces-inter");
  });
});
