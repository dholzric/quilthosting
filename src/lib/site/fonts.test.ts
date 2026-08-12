import { describe, it, expect } from "vitest";
import { resolveFont, buildFontsHref, FONT_OPTIONS } from "./fonts";

describe("resolveFont", () => {
  it("resolves a known key", () => {
    expect(resolveFont("fraunces").label).toBe("Fraunces");
  });

  it("falls back to inter for an unknown key", () => {
    expect(resolveFont("not-a-font").label).toBe("Inter");
    expect(resolveFont("").label).toBe("Inter");
  });
});

describe("buildFontsHref", () => {
  it("requests both families", () => {
    const href = buildFontsHref("fraunces", "inter");
    expect(href).toContain("family=Fraunces");
    expect(href).toContain("family=Inter");
    expect(href).toContain("display=swap");
  });

  it("requests a single family when heading and body match", () => {
    const href = buildFontsHref("inter", "inter");
    expect(href.match(/family=/g)).toHaveLength(1);
  });

  it("every option has a non-empty css stack", () => {
    for (const [key, opt] of Object.entries(FONT_OPTIONS)) {
      expect(opt.cssStack, key).toBeTruthy();
      expect(opt.googleQuery, key).toBeTruthy();
    }
  });
});
