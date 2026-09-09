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

describe("phase 2 sections", () => {
  const one = (raw: Record<string, unknown>) => {
    const { sections, issues } = parseSections([raw]);
    expect(issues).toEqual([]);
    expect(sections).toHaveLength(1);
    return sections[0];
  };

  it("timeline keeps year/title/body items", () => {
    const s = one({ type: "timeline", heading: "Our history", items: [{ year: "1987", title: "Founded", body: "Eleven quilters." }, { year: "2001", title: "First show" }] });
    expect(s.type).toBe("timeline");
    if (s.type !== "timeline") return;
    expect(s.items).toHaveLength(2);
    expect(s.items[1].body).toBeUndefined();
    expect(s.style).toEqual(DEFAULT_STYLE);
  });

  it("quote requires the quote text", () => {
    const s = one({ type: "quote", quote: "A quilt is a letter you can wrap around someone.", author: "Rosa T." });
    if (s.type !== "quote") throw new Error("expected quote");
    expect(s.author).toBe("Rosa T.");
    const { sections, issues } = parseSections([{ type: "quote", author: "Nobody" }]);
    expect(sections).toHaveLength(0);
    expect(issues[0].path).toBe("sections.0.quote");
  });

  it("officers accepts name/role/email/imageId and rejects a bad imageId", () => {
    const s = one({ type: "officers", items: [{ name: "Ann Reyes", role: "President", email: "ann@example.org", imageId: "file_ann" }] });
    if (s.type !== "officers") throw new Error("expected officers");
    expect(s.items[0].imageId).toBe("file_ann");
    const { issues } = parseSections([{ type: "officers", items: [{ name: "X", role: "Y", imageId: "../etc" }] }]);
    expect(issues[0].path).toBe("sections.0.items.0.imageId");
  });

  it("benefits and process are simple title/body lists", () => {
    const b = one({ type: "benefits", items: [{ title: "Library", body: "Four hundred books." }] });
    const p = one({ type: "process", heading: "How it works", items: [{ title: "Drop off" }, { title: "We quilt" }] });
    expect(b.type).toBe("benefits");
    expect(p.type).toBe("process");
    if (p.type === "process") expect(p.items).toHaveLength(2);
  });

  it("event_spotlight has an optional eventId", () => {
    const s = one({ type: "event_spotlight", heading: "The show" });
    if (s.type !== "event_spotlight") throw new Error("expected event_spotlight");
    expect(s.eventId).toBeUndefined();
    const t = one({ type: "event_spotlight", eventId: "ev_show" });
    if (t.type === "event_spotlight") expect(t.eventId).toBe("ev_show");
  });

  it("projects and sponsors sanitize hrefs", () => {
    const p = one({ type: "projects", items: [{ title: "Charity quilts", href: "javascript:alert(1)", stat: "340 donated" }] });
    if (p.type !== "projects") throw new Error("expected projects");
    expect(p.items[0].href).toBeUndefined();
    expect(p.items[0].stat).toBe("340 donated");
    const sp = one({ type: "sponsors", items: [{ name: "Hill Country Fabrics", href: "https://example.com", imageId: "logo_hcf" }, { name: "Bad", href: "javascript:x" }] });
    if (sp.type !== "sponsors") throw new Error("expected sponsors");
    expect(sp.items[0].href).toBe("https://example.com");
    expect(sp.items[1].href).toBeUndefined();
  });

  it("newsletter_signup carries heading/body/buttonLabel", () => {
    const s = one({ type: "newsletter_signup", heading: "Newsletter", body: "Once a month.", buttonLabel: "Sign me up" });
    if (s.type !== "newsletter_signup") throw new Error("expected newsletter_signup");
    expect(s.buttonLabel).toBe("Sign me up");
  });

  it("services has cards|table variants; portfolio has grid|featured and filters image-less items", () => {
    const s = one({ type: "services", variant: "table", items: [{ title: "Edge to edge", price: "2¢", unit: "per sq in" }] });
    if (s.type !== "services") throw new Error("expected services");
    expect(s.variant).toBe("table");
    expect(parseSections([{ type: "services", variant: "list", items: [] }]).issues[0].path).toBe("sections.0.variant");
    const d = one({ type: "services", items: [] });
    if (d.type === "services") expect(d.variant).toBe("cards");

    const p = one({
      type: "portfolio",
      variant: "featured",
      items: [{ imageId: "pf_1", title: "Ocean Waves" }, { url: "javascript:bad", title: "Nope" }, { url: "https://x.example/q.jpg", caption: "Log cabin" }],
    });
    if (p.type !== "portfolio") throw new Error("expected portfolio");
    expect(p.items).toHaveLength(2);
    expect(p.items[1].url).toBe("https://x.example/q.jpg");
  });

  it("hours_location keeps hours rows and sanitizes mapUrl", () => {
    const s = one({
      type: "hours_location",
      hours: [{ day: "Tue–Sat", open: "10–5" }, { day: "Sun–Mon", open: "Closed" }],
      address: "1210 Water St, Kerrville, TX",
      mapUrl: "javascript:alert(1)",
      phone: "830-555-0147",
      email: "studio@example.org",
    });
    if (s.type !== "hours_location") throw new Error("expected hours_location");
    expect(s.hours).toHaveLength(2);
    expect(s.mapUrl).toBeUndefined();
    expect(s.phone).toBe("830-555-0147");
  });

  it("documents defaults limit and donate defaults amounts (cents, bounded)", () => {
    const d = one({ type: "documents" });
    if (d.type === "documents") expect(d.limit).toBe(10);
    const g = one({ type: "donate" });
    if (g.type !== "donate") throw new Error("expected donate");
    expect(g.amounts).toEqual([1000, 2500, 5000, 10000]);
    const custom = one({ type: "donate", amounts: [500, 2000] });
    if (custom.type === "donate") expect(custom.amounts).toEqual([500, 2000]);
    expect(parseSections([{ type: "donate", amounts: [50] }]).issues[0].path).toBe("sections.0.amounts.0");
  });
});

describe("SECTION_TYPES / SECTION_VARIANTS", () => {
  it("lists every type in the union (33)", () => {
    expect(SECTION_TYPES).toHaveLength(33);
    expect(new Set(SECTION_TYPES).size).toBe(33);
    for (const t of [
      "hero", "rich_text", "image", "feature_grid", "faq", "testimonials", "gallery", "events",
      "membership_levels", "join_band", "meeting_info", "store_teaser", "blog_teaser", "contact",
      "quote_cta", "cta", "divider", "spacer", "embed",
      "timeline", "quote", "officers", "benefits", "event_spotlight", "projects", "sponsors",
      "newsletter_signup", "services", "portfolio", "hours_location", "process", "documents", "donate",
    ]) {
      expect(SECTION_TYPES).toContain(t);
    }
  });

  it("phase 2 variants: services cards|table, portfolio grid|featured, the rest none", () => {
    expect(SECTION_VARIANTS.services).toEqual(["cards", "table"]);
    expect(SECTION_VARIANTS.portfolio).toEqual(["grid", "featured"]);
    for (const t of ["timeline", "quote", "officers", "benefits", "event_spotlight", "projects", "sponsors", "newsletter_signup", "hours_location", "process", "documents", "donate"] as const) {
      expect(SECTION_VARIANTS[t]).toEqual([""]);
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
