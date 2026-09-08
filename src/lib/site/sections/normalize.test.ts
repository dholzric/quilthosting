import { describe, it, expect } from "vitest";
import { parseBlocks, type PageBlock } from "../../blocks";
import { KNOWN_BLOCK_TYPES } from "../../../routes/pages";
import { DEFAULT_STYLE, type Section } from "./schema";
import { blocksToSections, sectionsFromPage, isSectionDocument } from "./normalize";

/** One representative raw block per legacy type, plus what we expect after normalization. */
const TABLE: Record<
  (typeof KNOWN_BLOCK_TYPES)[number],
  { block: Record<string, unknown>; expect: (s: Section) => void }
> = {
  heading: {
    block: { type: "heading", text: "Guild <news>", level: 3 },
    expect: (s) => {
      expect(s.type).toBe("rich_text");
      if (s.type !== "rich_text") return;
      expect(s.variant).toBe("prose");
      expect(s.html).toBe("<h3>Guild &lt;news&gt;</h3>");
    },
  },
  text: {
    block: { type: "text", html: "<p>Hello</p><script>x()</script>" },
    expect: (s) => {
      expect(s.type).toBe("rich_text");
      if (s.type !== "rich_text") return;
      expect(s.variant).toBe("prose");
      expect(s.html).toBe("<p>Hello</p>");
    },
  },
  image: {
    block: { type: "image", url: "https://example.com/a.jpg", alt: "A quilt", caption: "Show 2025" },
    expect: (s) => {
      expect(s.type).toBe("image");
      if (s.type !== "image") return;
      expect(s.variant).toBe("single");
      expect(s.items).toEqual([{ url: "https://example.com/a.jpg", alt: "A quilt", caption: "Show 2025" }]);
    },
  },
  button: {
    block: { type: "button", label: "See events", href: "/events", style: "secondary" },
    expect: (s) => {
      expect(s.type).toBe("cta");
      if (s.type !== "cta") return;
      expect(s.label).toBe("See events");
      expect(s.href).toBe("/events");
      expect(s.kind).toBe("secondary");
    },
  },
  divider: {
    block: { type: "divider" },
    expect: (s) => expect(s.type).toBe("divider"),
  },
  html: {
    block: { type: "html", html: '<iframe src="https://www.youtube.com/embed/abc"></iframe>' },
    expect: (s) => {
      expect(s.type).toBe("embed");
      if (s.type !== "embed") return;
      expect(s.html).toContain("<iframe");
    },
  },
  join_cta: {
    block: { type: "join_cta", title: "Become a member", body: "Dues are $40 a year." },
    expect: (s) => {
      expect(s.type).toBe("join_band");
      if (s.type !== "join_band") return;
      expect(s.title).toBe("Become a member");
      expect(s.body).toBe("Dues are $40 a year.");
      expect(s.ctaLabel).toBe("Join");
    },
  },
  events_list: {
    block: { type: "events_list", limit: 4 },
    expect: (s) => {
      expect(s.type).toBe("events");
      if (s.type !== "events") return;
      expect(s.variant).toBe("cards");
      expect(s.limit).toBe(4);
    },
  },
  store_list: {
    block: { type: "store_list", limit: 8 },
    expect: (s) => {
      expect(s.type).toBe("store_teaser");
      if (s.type !== "store_teaser") return;
      expect(s.limit).toBe(8);
    },
  },
  spacer: {
    block: { type: "spacer", height: 48 },
    expect: (s) => {
      expect(s.type).toBe("spacer");
      if (s.type !== "spacer") return;
      expect(s.height).toBe(48);
    },
  },
  hero: {
    block: {
      type: "hero",
      eyebrow: "Since 1987",
      title: "Hill Country Quilt Guild",
      subtitle: "Meets monthly",
      imageUrl: "/public/hcqg/img/file_abc123",
      ctaLabel: "Join",
      ctaHref: "/membership",
    },
    expect: (s) => {
      expect(s.type).toBe("hero");
      if (s.type !== "hero") return;
      expect(s.variant).toBe("image");
      expect(s.style.bg).toBe("image");
      expect(s.style.imageId).toBe("file_abc123");
      expect(s.eyebrow).toBe("Since 1987");
      expect(s.title).toBe("Hill Country Quilt Guild");
      expect(s.subtitle).toBe("Meets monthly");
      expect(s.ctaLabel).toBe("Join");
      expect(s.ctaHref).toBe("/membership");
    },
  },
  service_cards: {
    block: { type: "service_cards", items: [{ icon: "🧵", title: "Longarm", body: "Edge to edge" }] },
    expect: (s) => {
      expect(s.type).toBe("feature_grid");
      if (s.type !== "feature_grid") return;
      expect(s.variant).toBe("cards");
      expect(s.items).toEqual([{ icon: "🧵", title: "Longarm", body: "Edge to edge" }]);
    },
  },
  gallery_grid: {
    block: { type: "gallery_grid", items: [{ url: "https://example.com/q.jpg", alt: "Quilt", caption: "Best in show" }] },
    expect: (s) => {
      expect(s.type).toBe("gallery");
      if (s.type !== "gallery") return;
      expect(s.variant).toBe("grid");
      expect(s.source).toBe("manual");
      expect(s.items).toEqual([{ url: "https://example.com/q.jpg", alt: "Quilt", caption: "Best in show" }]);
    },
  },
  faq: {
    block: { type: "faq", items: [{ q: "When do you meet?", a: "Second Tuesday." }] },
    expect: (s) => {
      expect(s.type).toBe("faq");
      if (s.type !== "faq") return;
      expect(s.items).toEqual([{ q: "When do you meet?", a: "Second Tuesday." }]);
    },
  },
  testimonials: {
    block: { type: "testimonials", items: [{ quote: "Best guild around.", author: "Marie" }] },
    expect: (s) => {
      expect(s.type).toBe("testimonials");
      if (s.type !== "testimonials") return;
      expect(s.variant).toBe("grid");
      expect(s.items).toEqual([{ quote: "Best guild around.", author: "Marie" }]);
    },
  },
  contact_form: {
    block: { type: "contact_form", formSlug: "hello", submitLabel: "Send it" },
    expect: (s) => {
      expect(s.type).toBe("contact");
      if (s.type !== "contact") return;
      expect(s.formSlug).toBe("hello");
      expect(s.showDetails).toBe(true);
    },
  },
  project_intake: {
    block: { type: "project_intake", projectType: "tshirt_quilt", heading: "Get a quote", submitLabel: "Estimate" },
    expect: (s) => {
      expect(s.type).toBe("quote_cta");
      if (s.type !== "quote_cta") return;
      expect(s.projectType).toBe("tshirt_quilt");
      expect(s.heading).toBe("Get a quote");
      expect(s.submitLabel).toBe("Estimate");
    },
  },
};

describe("blocksToSections", () => {
  it("covers every legacy block type in KNOWN_BLOCK_TYPES", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...KNOWN_BLOCK_TYPES].sort());
  });

  for (const type of KNOWN_BLOCK_TYPES) {
    it(`maps ${type}`, () => {
      const blocks = parseBlocks([TABLE[type].block]);
      expect(blocks).toHaveLength(1);
      const sections = blocksToSections(blocks);
      expect(sections).toHaveLength(1);
      TABLE[type].expect(sections[0]);
      if (type !== "hero") expect(sections[0].style).toEqual(DEFAULT_STYLE);
      expect(sections[0].id).toBe("s_0");
    });
  }

  it("maps 1:1 and numbers ids by index", () => {
    const blocks = parseBlocks([{ type: "divider" }, { type: "spacer" }, { type: "heading", text: "x" }]);
    const sections = blocksToSections(blocks);
    expect(sections.map((s) => s.id)).toEqual(["s_0", "s_1", "s_2"]);
    expect(sections.map((s) => s.type)).toEqual(["divider", "spacer", "rich_text"]);
  });

  it("heading level 1 and 2 become <h2>", () => {
    const blocks = parseBlocks([{ type: "heading", text: "A", level: 1 }, { type: "heading", text: "B", level: 2 }]);
    const [a, b] = blocksToSections(blocks);
    if (a.type !== "rich_text" || b.type !== "rich_text") throw new Error("expected rich_text");
    expect(a.html).toBe("<h2>A</h2>");
    expect(b.html).toBe("<h2>B</h2>");
  });

  it("hero with an external image stays minimal and does not set style.bg", () => {
    const blocks = parseBlocks([{ type: "hero", title: "T", imageUrl: "https://example.com/x.jpg" }]);
    const [s] = blocksToSections(blocks);
    if (s.type !== "hero") throw new Error("expected hero");
    expect(s.variant).toBe("minimal");
    expect(s.style).toEqual(DEFAULT_STYLE);
  });

  it("hero with a business-host /img/ URL becomes an image hero", () => {
    const blocks = parseBlocks([{ type: "hero", title: "T", imageUrl: "/img/f_1?w=1200" }]);
    const [s] = blocksToSections(blocks);
    if (s.type !== "hero") throw new Error("expected hero");
    expect(s.variant).toBe("image");
    expect(s.style.bg).toBe("image");
    expect(s.style.imageId).toBe("f_1");
  });

  it("hero without an image is minimal with empty optionals dropped", () => {
    const blocks = parseBlocks([{ type: "hero", title: "T" }]);
    const [s] = blocksToSections(blocks);
    if (s.type !== "hero") throw new Error("expected hero");
    expect(s.variant).toBe("minimal");
    expect(s.eyebrow).toBeUndefined();
    expect(s.subtitle).toBeUndefined();
    expect(s.ctaLabel).toBeUndefined();
    expect(s.ctaHref).toBeUndefined();
  });

  it("image block without a usable url yields an image section with no items", () => {
    const block: PageBlock = { type: "image", url: "", alt: "" };
    const [s] = blocksToSections([block]);
    if (s.type !== "image") throw new Error("expected image");
    expect(s.items).toEqual([]);
  });
});

describe("sectionsFromPage", () => {
  it("prefers sections_json", () => {
    const sections = sectionsFromPage({
      sections_json: JSON.stringify([{ type: "join_band", title: "Join", ctaLabel: "Join now", style: DEFAULT_STYLE }]),
      blocks_json: JSON.stringify([{ type: "heading", text: "Blocks" }]),
      content_json: JSON.stringify({ html: "<p>legacy</p>" }),
    });
    expect(sections.map((s) => s.type)).toEqual(["join_band"]);
  });

  it("falls back to blocks_json", () => {
    const sections = sectionsFromPage({
      sections_json: null,
      blocks_json: JSON.stringify([{ type: "heading", text: "Blocks" }, { type: "events_list" }]),
      content_json: JSON.stringify({ html: "<p>legacy</p>" }),
    });
    expect(sections.map((s) => s.type)).toEqual(["rich_text", "events"]);
  });

  it("falls back to legacy content_json.html as one rich_text", () => {
    const sections = sectionsFromPage({
      blocks_json: "[]",
      content_json: JSON.stringify({ html: "<p>legacy</p><script>x()</script>" }),
    });
    expect(sections).toHaveLength(1);
    const s = sections[0];
    if (s.type !== "rich_text") throw new Error("expected rich_text");
    expect(s.variant).toBe("prose");
    expect(s.html).toBe("<p>legacy</p>");
    expect(s.style).toEqual(DEFAULT_STYLE);
  });

  it("returns [] for an empty or unparseable row", () => {
    expect(sectionsFromPage({})).toEqual([]);
    expect(sectionsFromPage({ sections_json: "{not json", blocks_json: "nope", content_json: "{}" })).toEqual([]);
  });

  it("treats a legacy block array stored in sections_json as blocks", () => {
    const sections = sectionsFromPage({
      sections_json: JSON.stringify([{ type: "heading", text: "Old" }]),
    });
    expect(sections.map((s) => s.type)).toEqual(["rich_text"]);
  });
});

describe("isSectionDocument", () => {
  it("is true for section arrays (every item has a style object)", () => {
    expect(
      isSectionDocument([
        { type: "hero", title: "x", style: DEFAULT_STYLE },
        { type: "divider", style: { bg: "tint" } },
      ])
    ).toBe(true);
  });

  it("is false for legacy block arrays and non-arrays", () => {
    expect(isSectionDocument([{ type: "heading", text: "x" }, { type: "divider" }])).toBe(false);
    // a legacy button's `style` is a string, not an object
    expect(isSectionDocument([{ type: "button", label: "x", href: "/", style: "primary" }])).toBe(false);
    expect(isSectionDocument([{ type: "hero", title: "x", style: DEFAULT_STYLE }, { type: "divider" }])).toBe(false);
    expect(isSectionDocument({ type: "hero" })).toBe(false);
    expect(isSectionDocument("[]")).toBe(false);
    expect(isSectionDocument(null)).toBe(false);
  });
});
