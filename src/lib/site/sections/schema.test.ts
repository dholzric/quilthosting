import { describe, it, expect } from "vitest";
import { DEFAULT_STYLE, SECTION_TYPES, SECTION_VARIANTS, parseSections } from "./schema";

describe("parseSections", () => {
  it("parses a valid hero split section", () => {
    const { sections, issues } = parseSections([
      {
        type: "hero",
        id: "welcome",
        variant: "split",
        eyebrow: "Est. 1987",
        title: "Hill Country Quilt Guild",
        subtitle: "Monthly meetings, workshops, and a biennial show.",
        ctaLabel: "Join the guild",
        ctaHref: "/membership",
        style: { bg: "tint", width: "wide", spacing: "airy", align: "center", media: "left" },
      },
    ]);
    expect(issues).toEqual([]);
    expect(sections).toHaveLength(1);
    const s = sections[0];
    expect(s.type).toBe("hero");
    if (s.type !== "hero") return;
    expect(s.id).toBe("welcome");
    expect(s.variant).toBe("split");
    expect(s.title).toBe("Hill Country Quilt Guild");
    expect(s.ctaHref).toBe("/membership");
    expect(s.style).toEqual({ bg: "tint", width: "wide", spacing: "airy", align: "center", media: "left" });
  });

  it("rejects an unknown type with a path and drops the item", () => {
    const { sections, issues } = parseSections([
      { type: "rich_text", html: "<p>Keep me</p>", style: DEFAULT_STYLE },
      { type: "carousel", items: [], style: DEFAULT_STYLE },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe("rich_text");
    expect(issues).toEqual([{ path: "sections.1.type", message: 'Unsupported section type "carousel"' }]);
  });

  it("rejects an invalid variant with a path", () => {
    const { sections, issues } = parseSections([
      { type: "events", variant: "ticker", limit: 3, style: DEFAULT_STYLE },
    ]);
    expect(sections).toHaveLength(0);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].path).toBe("sections.0.variant");
  });

  it("sanitizes <script> in rich_text.html", () => {
    const { sections } = parseSections([
      {
        type: "rich_text",
        html: '<p>Hello</p><script>alert(1)</script><img src="x" onerror="alert(2)">',
        style: DEFAULT_STYLE,
      },
    ]);
    expect(sections).toHaveLength(1);
    const s = sections[0];
    if (s.type !== "rich_text") throw new Error("expected rich_text");
    expect(s.html).toContain("<p>Hello</p>");
    expect(s.html).not.toContain("<script");
    expect(s.html).not.toContain("alert(1)");
    expect(s.html).not.toContain("onerror");
  });

  it("does not allow iframes in rich_text but allows them in embed", () => {
    const iframe = '<iframe src="https://www.youtube.com/embed/abc123"></iframe>';
    const { sections } = parseSections([
      { type: "rich_text", html: iframe, style: DEFAULT_STYLE },
      { type: "embed", html: iframe, style: DEFAULT_STYLE },
    ]);
    expect(sections).toHaveLength(2);
    const [rich, embed] = sections;
    if (rich.type !== "rich_text" || embed.type !== "embed") throw new Error("unexpected types");
    expect(rich.html).not.toContain("<iframe");
    expect(embed.html).toContain("<iframe");
  });

  it("sanitizes faq answers and url fields", () => {
    const { sections } = parseSections([
      { type: "faq", items: [{ q: "When?", a: "<b>Tuesdays</b><script>x()</script>" }], style: DEFAULT_STYLE },
      { type: "cta", label: "Go", href: "javascript:alert(1)", style: DEFAULT_STYLE },
      {
        type: "meeting_info",
        when: "Second Tuesday, 7 pm",
        where: "Community Center",
        mapUrl: "javascript:alert(1)",
        style: DEFAULT_STYLE,
      },
    ]);
    expect(sections).toHaveLength(3);
    const [faq, cta, meeting] = sections;
    if (faq.type !== "faq" || cta.type !== "cta" || meeting.type !== "meeting_info") throw new Error("unexpected");
    expect(faq.items[0].a).toBe("<b>Tuesdays</b>");
    expect(cta.href).toBe("#");
    expect(meeting.mapUrl).toBeUndefined();
  });

  it("defaults style when missing and fills partial styles", () => {
    const { sections, issues } = parseSections([
      { type: "rich_text", html: "<p>No style here</p>" },
      { type: "join_band", title: "Become a member", ctaLabel: "Join", style: { bg: "brand" } },
    ]);
    expect(issues).toEqual([]);
    expect(sections).toHaveLength(2);
    expect(sections[0].style).toEqual(DEFAULT_STYLE);
    expect(sections[1].style).toEqual({ ...DEFAULT_STYLE, bg: "brand" });
  });

  it("keeps valid ids and generates s_<index> otherwise", () => {
    const { sections } = parseSections([
      { type: "divider", id: "top-rule_1", style: DEFAULT_STYLE },
      { type: "divider", id: "Not Valid!", style: DEFAULT_STYLE },
      { type: "divider", style: DEFAULT_STYLE },
    ]);
    expect(sections.map((s) => s.id)).toEqual(["top-rule_1", "s_1", "s_2"]);
  });

  it("accepts a legacy block array and normalizes it", () => {
    const { sections, issues } = parseSections([
      { type: "heading", text: "Welcome", level: 2 },
      { type: "join_cta", title: "Join us" },
    ]);
    expect(issues).toEqual([]);
    expect(sections.map((s) => s.type)).toEqual(["rich_text", "join_band"]);
    expect(sections[0].style).toEqual(DEFAULT_STYLE);
  });

  it("reports a non-array document", () => {
    const { sections, issues } = parseSections({ type: "hero" });
    expect(sections).toEqual([]);
    expect(issues[0].path).toBe("sections");
  });
});

describe("SECTION_TYPES / SECTION_VARIANTS", () => {
  it("lists every type in the union (19)", () => {
    expect(SECTION_TYPES).toHaveLength(19);
    expect(new Set(SECTION_TYPES).size).toBe(19);
    for (const t of [
      "hero", "rich_text", "image", "feature_grid", "faq", "testimonials", "gallery", "events",
      "membership_levels", "join_band", "meeting_info", "store_teaser", "blog_teaser", "contact",
      "quote_cta", "cta", "divider", "spacer", "embed",
    ]) {
      expect(SECTION_TYPES).toContain(t);
    }
  });

  it("has a variant list for every type, with \"\" for types without variants", () => {
    for (const t of SECTION_TYPES) {
      expect(Array.isArray(SECTION_VARIANTS[t])).toBe(true);
      expect(SECTION_VARIANTS[t].length).toBeGreaterThan(0);
    }
    expect(SECTION_VARIANTS.hero).toEqual(["image", "split", "pattern", "minimal", "stats"]);
    expect(SECTION_VARIANTS.events).toEqual(["cards", "list", "calendar", "next_up"]);
    expect(SECTION_VARIANTS.faq).toEqual([""]);
    expect(SECTION_VARIANTS.divider).toEqual([""]);
  });

  it("DEFAULT_STYLE is the neutral style", () => {
    expect(DEFAULT_STYLE).toEqual({ bg: "none", width: "normal", spacing: "normal", align: "left", media: "right" });
  });
});
