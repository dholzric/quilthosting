import { describe, it, expect } from "vitest";
import { safeColor, buildRootVars, DEFAULT_THEME, DEFAULT_FONTS } from "./theme";

describe("safeColor", () => {
  it("accepts hex and functional colors", () => {
    expect(safeColor("#8a2060", "#000")).toBe("#8a2060");
    expect(safeColor("#abc", "#000")).toBe("#abc");
    expect(safeColor("rgb(10, 20, 30)", "#000")).toBe("rgb(10, 20, 30)");
    expect(safeColor("hsl(200 50% 40%)", "#000")).toBe("hsl(200 50% 40%)");
  });

  it("rejects anything that could break out of the style sink", () => {
    // This is the whole point: theme values reach an inline <style>.
    expect(safeColor("red}</style><script>alert(1)</script>", "#000")).toBe("#000");
    expect(safeColor("url(https://evil.example/x)", "#000")).toBe("#000");
    expect(safeColor("expression(alert(1))", "#000")).toBe("#000");
    expect(safeColor(42, "#000")).toBe("#000");
    expect(safeColor(undefined, "#000")).toBe("#000");
  });
});

describe("buildRootVars", () => {
  it("emits one CSS custom property per color token plus two font stacks", () => {
    const css = buildRootVars(DEFAULT_THEME, DEFAULT_FONTS);
    expect(css).toContain("--color-primary:#8a2060");
    expect(css).toContain("--color-text-muted:#504852");
    expect(css).toContain("--font-display:");
    expect(css).toContain("--font-sans:");
    // themeColor drives <meta name="theme-color">, not a CSS var.
    expect(css).not.toContain("--color-theme-color");
  });

  it("substitutes the default when a token is unsafe", () => {
    const css = buildRootVars(
      { ...DEFAULT_THEME, primary: "}</style>" },
      DEFAULT_FONTS,
    );
    expect(css).toContain(`--color-primary:${DEFAULT_THEME.primary}`);
  });
});
