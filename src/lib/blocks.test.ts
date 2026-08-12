import { describe, it, expect } from "vitest";
import { parseBlocks, blocksToHtml, BUSINESS_BLOCK_TYPES, GUILD_ONLY_BLOCK_TYPES } from "./blocks";

const XSS = '<img src=x onerror=alert(1)>';

describe("parseBlocks — new business blocks", () => {
  it("parses a hero", () => {
    const [b] = parseBlocks([
      { type: "hero", eyebrow: "Since 2009", title: "Stitch Studio", subtitle: "Longarm quilting",
        imageUrl: "https://x.com/h.jpg", ctaLabel: "Book", ctaHref: "/order" },
    ]);
    expect(b).toMatchObject({ type: "hero", title: "Stitch Studio", ctaHref: "/order" });
  });

  it("parses service cards and caps the list", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `S${i}`, body: "b", icon: "✦" }));
    const [b] = parseBlocks([{ type: "service_cards", items }]) as never[];
    expect((b as { items: unknown[] }).items.length).toBeLessThanOrEqual(12);
  });

  it("parses a gallery grid", () => {
    const [b] = parseBlocks([
      { type: "gallery_grid", items: [{ url: "https://x.com/1.jpg", alt: "a", caption: "c" }] },
    ]);
    expect(b).toMatchObject({ type: "gallery_grid" });
  });

  it("parses faq entries", () => {
    const [b] = parseBlocks([{ type: "faq", items: [{ q: "How long?", a: "Six weeks." }] }]);
    expect(b).toMatchObject({ type: "faq" });
  });

  it("parses testimonials", () => {
    const [b] = parseBlocks([{ type: "testimonials", items: [{ quote: "Lovely", author: "Jan" }] }]);
    expect(b).toMatchObject({ type: "testimonials" });
  });

  it("parses a contact form", () => {
    const [b] = parseBlocks([{ type: "contact_form", formSlug: "contact", submitLabel: "Send" }]);
    expect(b).toMatchObject({ type: "contact_form", formSlug: "contact" });
  });

  it("parses a project intake block", () => {
    const [b] = parseBlocks([
      { type: "project_intake", projectType: "tshirt_quilt", heading: "Get a quote", submitLabel: "Send it" },
    ]);
    expect(b).toMatchObject({
      type: "project_intake",
      projectType: "tshirt_quilt",
      heading: "Get a quote",
      submitLabel: "Send it",
    });
  });

  it("falls back an invalid project_intake projectType to longarm", () => {
    const [b] = parseBlocks([{ type: "project_intake", projectType: "not_a_real_type" }]);
    expect(b).toMatchObject({ type: "project_intake", projectType: "longarm" });
  });

  it("still drops unknown types", () => {
    expect(parseBlocks([{ type: "definitely_not_a_block" }])).toHaveLength(0);
  });
});

describe("blocksToHtml — escaping", () => {
  it("escapes hero text", () => {
    const html = blocksToHtml(parseBlocks([{ type: "hero", title: XSS, subtitle: XSS }]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes service card text", () => {
    const html = blocksToHtml(parseBlocks([
      { type: "service_cards", items: [{ title: XSS, body: XSS, icon: XSS }] },
    ]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes faq and testimonial text", () => {
    const faq = blocksToHtml(parseBlocks([{ type: "faq", items: [{ q: XSS, a: XSS }] }]));
    const tst = blocksToHtml(parseBlocks([{ type: "testimonials", items: [{ quote: XSS, author: XSS }] }]));
    expect(faq).not.toContain("<img src=x");
    expect(faq).toContain("&lt;img");
    expect(tst).not.toContain("<img src=x");
    expect(tst).toContain("&lt;img");
  });

  it("escapes gallery urls into the src attribute", () => {
    const html = blocksToHtml(parseBlocks([
      { type: "gallery_grid", items: [{ url: '"><script>alert(1)</script>', alt: "a" }] },
    ]));
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes project_intake heading and submitLabel into their data- attributes", () => {
    const html = blocksToHtml(parseBlocks([
      { type: "project_intake", projectType: "longarm", heading: XSS, submitLabel: XSS },
    ]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("still passes the raw html block through untouched", () => {
    // Deliberate: owner-authored embed escape hatch, already length-capped.
    const html = blocksToHtml(parseBlocks([{ type: "html", html: "<iframe src='https://youtube.com'></iframe>" }]));
    expect(html).toContain("<iframe");
  });
});

describe("block type lists", () => {
  it("keeps join_cta out of the business picker", () => {
    expect(GUILD_ONLY_BLOCK_TYPES).toContain("join_cta");
    expect(BUSINESS_BLOCK_TYPES).not.toContain("join_cta");
  });

  it("offers every new block to businesses", () => {
    for (const t of ["hero", "service_cards", "gallery_grid", "faq", "testimonials", "contact_form", "project_intake"]) {
      expect(BUSINESS_BLOCK_TYPES, t).toContain(t);
    }
  });
});

describe("blocksToHtml — href scheme safety", () => {
  it("neutralizes a javascript: hero CTA href to #", () => {
    const html = blocksToHtml(parseBlocks([
      { type: "hero", title: "T", ctaLabel: "Go", ctaHref: "javascript:alert(1)" },
    ]));
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:alert(1)");
  });

  it("neutralizes obfuscated javascript: variants in a hero CTA href", () => {
    const variants = [
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "JaVaScRiPt:alert(1)",
    ];
    for (const ctaHref of variants) {
      const html = blocksToHtml(parseBlocks([{ type: "hero", title: "T", ctaLabel: "Go", ctaHref }]));
      expect(html, ctaHref).toContain('href="#"');
    }
  });

  it("neutralizes a javascript: button href to #", () => {
    const html = blocksToHtml(parseBlocks([{ type: "button", label: "Go", href: "javascript:alert(1)" }]));
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:alert(1)");
  });

  it("neutralizes obfuscated javascript: variants in a button href", () => {
    const variants = [
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "JaVaScRiPt:alert(1)",
    ];
    for (const href of variants) {
      const html = blocksToHtml(parseBlocks([{ type: "button", label: "Go", href }]));
      expect(html, href).toContain('href="#"');
    }
  });

  it("passes legitimate hrefs through untouched", () => {
    const legit = ["https://example.com/x", "/order", "#faq", "mailto:a@b.com", "tel:+15125550100"];
    for (const href of legit) {
      const html = blocksToHtml(parseBlocks([{ type: "button", label: "Go", href }]));
      expect(html, href).toContain(`href="${href}"`);
    }
  });

  it("passes an sms: href through untouched (standard small-business 'Text us' CTA)", () => {
    const html = blocksToHtml(parseBlocks([{ type: "button", label: "Text us", href: "sms:+15125550100" }]));
    expect(html).toContain('href="sms:+15125550100"');
  });
});

describe("blocksToHtml — hero background CSS injection", () => {
  it("omits the style attribute entirely for a CSS-breakout imageUrl", () => {
    const html = blocksToHtml(parseBlocks([
      { type: "hero", title: "T", imageUrl: "x'); background: red; foo: url('" },
    ]));
    expect(html).not.toContain("style=");
  });

  it("still renders the style attribute for a clean https image URL", () => {
    const html = blocksToHtml(parseBlocks([{ type: "hero", title: "T", imageUrl: "https://x.com/h.jpg" }]));
    expect(html).toContain("style=");
    expect(html).toContain("background-image:url(");
  });

  // Intentionally unsupported: data: URLs are a wider CSS-injection sink inside url(...)
  // than an <img src>, and a hero background is a far less likely place for an inlined
  // image than a gallery photo. This is a deliberate, documented "no", not a silent gap.
  it("omits the style attribute for a data: image URL (intentionally unsupported)", () => {
    const html = blocksToHtml(parseBlocks([
      { type: "hero", title: "T", imageUrl: "data:image/png;base64,AAAA" },
    ]));
    expect(html).not.toContain("style=");
  });
});
