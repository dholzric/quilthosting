import { describe, it, expect } from "vitest";
import { PATTERN_IDS, patternDataUri, patternSvg, type PatternId } from "./patterns";

const colors = { a: "#8a2060", b: "#f4ecd8", c: "#d9a441" };
const drawn: PatternId[] = ["nine-patch", "flying-geese", "log-cabin", "churn-dash", "bear-paw"];

describe("patternSvg", () => {
  it("returns an svg tile built only from rect and polygon", () => {
    const svg = patternSvg("log-cabin", colors);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\son\w+=/i);
    expect(svg).not.toMatch(/<(path|circle|image|use|foreignObject)\b/);
    expect(svg).toMatch(/<(rect|polygon)\b/);
  });

  it("produces distinct art for each of the five block ids", () => {
    const outputs = drawn.map((id) => patternSvg(id, colors));
    expect(new Set(outputs).size).toBe(5);
    for (const out of outputs) expect(out).toMatch(/^<svg/);
  });

  it("lists the five drawable ids after none", () => {
    expect(PATTERN_IDS).toEqual(["none", ...drawn]);
  });

  it("uses the supplied colors and tile size", () => {
    const svg = patternSvg("nine-patch", colors, 120);
    expect(svg).toContain("#8a2060");
    expect(svg).toContain("#f4ecd8");
    expect(svg).toContain("width='120'");
    expect(svg).toContain("viewBox='0 0 120 120'");
  });

  it("defaults the tile to 96", () => {
    expect(patternSvg("bear-paw", colors)).toContain("viewBox='0 0 96 96'");
  });

  it("returns an empty string for none", () => {
    expect(patternSvg("none", colors)).toBe("");
  });

  it("refuses unsafe color strings so a role value cannot break out of an attribute", () => {
    const svg = patternSvg("churn-dash", { a: "'><script>1</script>", b: "red", c: "#ABC" });
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("'><script");
    expect(svg).not.toContain("red");
    expect(svg).toContain("fill='#808080'");
    expect(svg).toContain("#ABC");
  });
});

describe("patternDataUri", () => {
  it("wraps the svg in a css url() with no raw # < > or double quotes inside", () => {
    const uri = patternDataUri("flying-geese", colors);
    expect(uri.startsWith('url("data:image/svg+xml;utf8,')).toBe(true);
    expect(uri.endsWith('")')).toBe(true);
    const payload = uri.slice('url("data:image/svg+xml;utf8,'.length, -2);
    expect(payload).not.toMatch(/[#<>"]/);
    expect(payload).toContain("%23");
    expect(payload).toContain("%3Csvg");
  });

  it("returns the css keyword none for the none id", () => {
    expect(patternDataUri("none", colors)).toBe("none");
  });

  it("passes the tile size through", () => {
    expect(patternDataUri("log-cabin", colors, 64)).toContain("viewBox='0 0 64 64'");
  });
});
