// src/lib/site/composition.test.ts
//
// Ninety-two kits could only differ by palette, type and section order,
// because the renderer knew one shape: a full-width band. 82% of every hero
// in the library was the same one, and 17 of the 33 built section types were
// used by nobody. These are the shapes that fix that, plus the rule that made
// coloured panels usable at all.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSection } from "./sections/render";
import { DEFAULT_STYLE, SECTION_LAYOUTS, SECTION_DIVIDERS, parseSections } from "./sections/schema";
import { DEFAULT_DESIGN } from "./design/tokens";

const CSS = readFileSync(
  path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."), "public/qh-site.css"),
  "utf8"
);

const ctx = { slug: "g", baseUrl: "", design: DEFAULT_DESIGN, data: {}, imgUrl: (id: string) => `/img/${id}` };
const render = (style: Record<string, unknown>) =>
  renderSection(
    { id: "s", type: "rich_text", variant: "prose", html: "<p>x</p>", style: { ...DEFAULT_STYLE, ...style } } as never,
    ctx as never
  );

describe("composition: the default is unchanged", () => {
  it("band and none add no class, so an untouched page renders as it always did", () => {
    const html = render({});
    expect(html).not.toContain("qh-s--layout-");
    expect(html).not.toContain("qh-s--divider-");
  });

  it("a stored section with no composition keys parses to the plain band", () => {
    const { sections, issues } = parseSections([{ type: "rich_text", id: "a", html: "<p>x</p>" }]);
    expect(issues).toEqual([]);
    expect(sections[0].style.layout).toBe("band");
    expect(sections[0].style.divider).toBe("none");
  });
});

describe("composition: every shape reaches the page and the stylesheet", () => {
  it.each(SECTION_LAYOUTS.filter((l) => l !== "band"))("layout %s emits a class the CSS styles", (layout) => {
    const cls = `qh-s--layout-${layout.replace(/_/g, "-")}`;
    expect(render({ layout })).toContain(cls);
    expect(CSS, `${cls} is not styled`).toContain(`.${cls}`);
  });

  it.each(SECTION_DIVIDERS.filter((d) => d !== "none"))("divider %s emits a class the CSS styles", (divider) => {
    const cls = `qh-s--divider-${divider}`;
    expect(render({ divider })).toContain(cls);
    expect(CSS, `${cls} is not styled`).toContain(`.${cls}`);
  });

  it("rejects a shape that is not on the menu, the way every other style key does", () => {
    // Strict, like bg and width: a value nobody offers is reported as an issue
    // rather than quietly coerced, so a hand-edited document says what is wrong.
    const bad = parseSections([
      { type: "rich_text", id: "a", html: "<p>x</p>", style: { layout: "parallax" } },
    ]);
    expect(bad.sections).toHaveLength(0);
    expect(bad.issues.length).toBeGreaterThan(0);
    const alsoBad = parseSections([
      { type: "rich_text", id: "a", html: "<p>x</p>", style: { bg: "hologram" } },
    ]);
    expect(alsoBad.sections).toHaveLength(0);
  });

  it("an overlapping section and the one under it draw no divider — the panel covers it", () => {
    const compact = CSS.replace(/\s+/g, "");
    expect(compact).toContain(".qh-s--layout-offset::after,.qh-s--layout-offset+.qh-s::after{display:none}");
  });
});

describe("secondary text stays readable on a coloured ground", () => {
  it("redefines the muted token rather than naming each component", () => {
    // Twenty components set colour:var(--_muted); listing them here would miss
    // the twenty-first. The token is redefined for coloured grounds instead.
    const compact = CSS.replace(/\s+/g, "");
    expect(compact).toContain(":is(.qh-s--bg-brand,.qh-s--bg-dark,.qh-s--bg-image){--_muted:currentColor}");
    expect(compact).toContain("color-mix(inoklab,currentColor78%,transparent)");
  });

  it("still has components that read the token, so the fix is load-bearing", () => {
    const readers = (CSS.match(/color:var\(--_muted\)/g) || []).length;
    expect(readers).toBeGreaterThan(10);
  });
});
