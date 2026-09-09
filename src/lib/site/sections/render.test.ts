import { describe, it, expect } from "vitest";
import { renderSection, renderSections, sectionWrapper, formatEventDate } from "./render";
import type { RenderContext } from "./render";
import { SECTION_FIXTURES, fixtureContext, fixtureData } from "./fixtures";
import { DEFAULT_STYLE, SECTION_TYPES, SECTION_VARIANTS } from "./schema";
import type { Section } from "./schema";
import { DEFAULT_DESIGN } from "../design/tokens";

/** Wrapper class the renderer emits for each section type. */
const TYPE_CLASS: Record<Section["type"], string> = {
  hero: "qh-hero",
  rich_text: "qh-rich",
  image: "qh-image",
  feature_grid: "qh-features",
  faq: "qh-faq",
  testimonials: "qh-testimonials",
  gallery: "qh-gallery",
  events: "qh-events",
  membership_levels: "qh-levels",
  join_band: "qh-join-band",
  meeting_info: "qh-meeting",
  store_teaser: "qh-store",
  blog_teaser: "qh-blog",
  contact: "qh-contact",
  quote_cta: "qh-quote-cta",
  cta: "qh-cta",
  divider: "qh-divider",
  spacer: "qh-spacer",
  embed: "qh-embed",
  timeline: "qh-timeline",
  quote: "qh-quote",
  officers: "qh-officers",
  benefits: "qh-benefits",
  event_spotlight: "qh-spotlight",
  projects: "qh-projects",
  sponsors: "qh-sponsors",
  newsletter_signup: "qh-newsletter",
  services: "qh-services",
  portfolio: "qh-portfolio",
  hours_location: "qh-hours",
  process: "qh-process",
  documents: "qh-documents",
  donate: "qh-donate",
};

function section<T extends Section["type"]>(partial: Extract<Section, { type: T }>): Section {
  return partial;
}

const ctx = fixtureContext();

describe("fixtures", () => {
  it("cover every section type and every variant", () => {
    const seen = new Map<string, Set<string>>();
    for (const f of SECTION_FIXTURES) {
      const s = f.section as Section & { variant?: string };
      if (!seen.has(s.type)) seen.set(s.type, new Set());
      seen.get(s.type)!.add(s.variant ?? "");
    }
    for (const type of SECTION_TYPES) {
      expect(seen.has(type), `fixture for ${type}`).toBe(true);
      for (const v of SECTION_VARIANTS[type]) {
        expect(seen.get(type)!.has(v), `fixture for ${type}/${v || "(none)"}`).toBe(true);
      }
    }
    expect(SECTION_FIXTURES.length).toBeGreaterThanOrEqual(35);
  });

  it("use real copy: no lorem, unique ids", () => {
    const ids = new Set<string>();
    for (const f of SECTION_FIXTURES) {
      expect(JSON.stringify(f.section).toLowerCase()).not.toContain("lorem");
      expect(ids.has(f.section.id), `duplicate id ${f.section.id}`).toBe(false);
      ids.add(f.section.id);
    }
  });
});

describe("renderSection over fixtures", () => {
  for (const f of SECTION_FIXTURES) {
    it(`renders ${f.name}`, () => {
      const html = renderSection(f.section, ctx);
      expect(html.startsWith("<section")).toBe(true);
      expect(html).toContain(`id="${f.section.id}"`);
      expect(html).toContain(`class="qh-s `);
      expect(html).toContain(TYPE_CLASS[f.section.type]);
      const variant = (f.section as { variant?: string }).variant;
      if (variant) expect(html).toContain(`${TYPE_CLASS[f.section.type]}--${variant}`);
      expect(html).not.toContain("<!--");
      expect(html).not.toContain("undefined");
      expect(html).not.toContain("[object Object]");
    });
  }

  it("renderSections concatenates every fixture", () => {
    const html = renderSections(
      SECTION_FIXTURES.map((f) => f.section),
      ctx
    );
    const count = (html.match(/<section /g) ?? []).length;
    expect(count).toBe(SECTION_FIXTURES.length);
  });
});

describe("sectionWrapper", () => {
  it("emits id and the style classes", () => {
    const s = section({
      type: "divider",
      id: "rule-1",
      style: { bg: "tint", width: "wide", spacing: "airy", align: "center", media: "top" },
    });
    const html = sectionWrapper(s, "<hr>", "qh-divider");
    expect(html).toContain('id="rule-1"');
    expect(html).toContain("qh-s--bg-tint");
    expect(html).toContain("qh-s--w-wide");
    expect(html).toContain("qh-s--sp-airy");
    expect(html).toContain("qh-s--align-center");
    expect(html).toContain("qh-s--media-top");
    expect(html).toContain("qh-divider");
    expect(html).toContain("<hr>");
    expect(html.endsWith("</section>")).toBe(true);
  });

  it("omits align-center for left alignment and never emits a style attribute without a bg image or pattern", () => {
    const s = section({ type: "divider", id: "rule-2", style: { ...DEFAULT_STYLE } });
    const html = sectionWrapper(s, "<hr>");
    expect(html).not.toContain("qh-s--align-center");
    expect(html).not.toContain(" style=");
  });

  it("bg image sets --qh-s-image from imgUrl plus the focal point", () => {
    const s = section({
      type: "rich_text",
      id: "about",
      variant: "prose",
      html: "<p>Founded in 1987.</p>",
      style: { ...DEFAULT_STYLE, bg: "image", imageId: "file_abc", imageFocal: [0.25, 0.8] },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-s--bg-image");
    expect(html).toContain("--qh-s-image:url(");
    expect(html).toContain("/img/file_abc");
    expect(html).toContain("--qh-s-focal:25% 80%");
  });

  it("bg pattern sets --qh-s-pattern from the design pattern", () => {
    const s = section({
      type: "join_band",
      id: "band",
      title: "Become a member",
      ctaLabel: "Join",
      style: { ...DEFAULT_STYLE, bg: "pattern" },
    });
    const html = renderSection(s, { ...ctx, design: { ...DEFAULT_DESIGN, pattern: { id: "log-cabin", opacity: 0.1 } } });
    expect(html).toContain("qh-s--bg-pattern");
    expect(html).toContain("--qh-s-pattern:url(");
    expect(html).toContain("data:image/svg+xml");
    // The data URI must not contain a raw quote that could end the attribute.
    const style = /style="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(style).toContain("--qh-s-pattern");
    expect(style).not.toContain("<");
  });

  it("falls back to a default pattern when the design has none", () => {
    const s = section({ type: "divider", id: "d", style: { ...DEFAULT_STYLE, bg: "pattern" } });
    const html = renderSection(s, { ...ctx, design: { ...DEFAULT_DESIGN, pattern: { id: "none", opacity: 0.1 } } });
    expect(html).toContain("--qh-s-pattern:url(");
  });
});

describe("hero", () => {
  it("image variant emits --qh-s-image, focal, and an eager hero image", () => {
    const s = section({
      type: "hero",
      id: "welcome",
      variant: "image",
      title: "Hill Country Quilt Guild",
      subtitle: "Meeting the second Tuesday of every month in Kerrville.",
      ctaLabel: "Join the guild",
      ctaHref: "/membership",
      style: { ...DEFAULT_STYLE, bg: "image", imageId: "hero_1", imageFocal: [0.5, 0.3] },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-hero qh-hero--image");
    expect(html).toContain("--qh-s-image:url(");
    expect(html).toContain("--qh-s-focal:50% 30%");
    expect(html).toContain('fetchpriority="high"');
    expect(html).toContain('class="qh-hero__title"');
    expect(html).toContain("Hill Country Quilt Guild");
    expect(html).toContain('class="qh-btn qh-btn--primary"');
    // Root-relative CTA hrefs are prefixed with the base URL so /g/:slug hosts work.
    expect(html).toContain(`href="${ctx.baseUrl}/membership"`);
  });

  it("only the first hero image is eager; later images are lazy", () => {
    const hero = section({
      type: "hero",
      id: "h",
      variant: "split",
      title: "Show and tell",
      style: { ...DEFAULT_STYLE, imageId: "img_a" },
    });
    const second = section({
      type: "hero",
      id: "h2",
      variant: "split",
      title: "Retreat weekend",
      style: { ...DEFAULT_STYLE, imageId: "img_b" },
    });
    const html = renderSections([hero, second], ctx);
    expect(html.match(/fetchpriority="high"/g)?.length).toBe(1);
    expect(html.indexOf('fetchpriority="high"')).toBeLessThan(html.indexOf('loading="lazy"'));
  });

  it("stats variant renders each stat", () => {
    const s = section({
      type: "hero",
      id: "stats",
      variant: "stats",
      title: "By the numbers",
      stats: [
        { value: "212", label: "Members" },
        { value: "38", label: "Years" },
      ],
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-hero__stats");
    expect(html).toContain('<span class="qh-stat__value">212</span>');
    expect(html).toContain('<span class="qh-stat__label">Members</span>');
  });

  it("escapes tenant text", () => {
    const s = section({
      type: "hero",
      id: "x",
      variant: "minimal",
      title: 'Quilts & Co <script>alert("x")</script>',
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).not.toContain("<script>");
    expect(html).toContain("Quilts &amp; Co &lt;script&gt;");
  });
});

describe("rich_text", () => {
  it("re-sanitizes html at render so <img onerror> is inert", () => {
    const s = section({
      type: "rich_text",
      id: "r",
      variant: "prose",
      html: '<p>Hello</p><img src="x" onerror="alert(1)"><script>alert(2)</script>',
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-rich qh-rich--prose");
    expect(html).toContain("<p>Hello</p>");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });

  it("with_image variant renders the media from style.imageId", () => {
    const s = section({
      type: "rich_text",
      id: "r2",
      variant: "with_image",
      heading: "Our history",
      html: "<p>Founded in 1987 by eleven quilters.</p>",
      style: { ...DEFAULT_STYLE, imageId: "hist_1", media: "left" },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-rich--with_image");
    expect(html).toContain("qh-s--media-left");
    expect(html).toContain('class="qh-media"');
    expect(html).toContain("/img/hist_1");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('<h2 class="qh-s__heading">Our history</h2>');
  });
});

describe("image", () => {
  it("passes legacy url through the image URL sanitizer and drops javascript:", () => {
    const s = section({
      type: "image",
      id: "i",
      variant: "duo",
      items: [
        { url: "javascript:alert(1)", alt: "bad" },
        { url: "https://example.com/quilt.jpg", alt: "Nine patch quilt" },
      ],
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="https://example.com/quilt.jpg"');
    expect(html).toContain('alt="Nine patch quilt"');
    expect(html).toContain('loading="lazy"');
  });
});

describe("events", () => {
  it("renders two <article class=\"qh-event\"> with wall-time dates", () => {
    const s = section({ type: "events", id: "e", variant: "cards", limit: 6, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, {
      ...ctx,
      data: {
        events: [
          { ...fixtureData.events![0], id: "ev_1", title: "September meeting", start_at: "2026-09-12T09:00:00" },
          { ...fixtureData.events![0], id: "ev_2", title: "Fall retreat", start_at: "2026-10-03T18:30:00Z" },
        ],
      },
    });
    expect(html.match(/<article class="qh-event"/g)?.length).toBe(2);
    expect(html).toContain('<time datetime="2026-09-12T09:00:00">Sat, Sep 12 · 9:00 AM</time>');
    expect(html).toContain('<time datetime="2026-10-03T18:30:00Z">Sat, Oct 3 · 6:30 PM</time>');
    expect(html).toContain('data-register="ev_1"');
    expect(html).toContain(`href="${ctx.baseUrl}/events/ev_1"`);
  });

  it("respects limit", () => {
    const s = section({ type: "events", id: "e", variant: "list", limit: 1, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, ctx);
    expect(html.match(/<article class="qh-event"/g)?.length).toBe(1);
  });

  it("omits the register button when registration is closed", () => {
    const s = section({ type: "events", id: "e", variant: "cards", limit: 6, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, {
      ...ctx,
      data: { events: [{ ...fixtureData.events![0], id: "ev_closed", registration_open: 0 }] },
    });
    expect(html).not.toContain("data-register");
  });

  it("empty data renders a friendly qh-empty, never a comment", () => {
    const s = section({ type: "events", id: "e", variant: "cards", limit: 6, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, { ...ctx, data: {} });
    expect(html).toContain('<div class="qh-empty">');
    expect(html).toMatch(/qh-empty">[^<]*[a-z]/);
    expect(html).not.toContain("<!--");
  });

  it("calendar variant carries data-month on the .qh-events--calendar container", () => {
    const s = section({ type: "events", id: "cal", variant: "calendar", limit: 50, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, ctx);
    expect(html).toMatch(/<section[^>]*qh-events--calendar[^>]*data-month="2026-09"/);
  });

  it("next_up renders only the first event", () => {
    const s = section({ type: "events", id: "n", variant: "next_up", limit: 6, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, ctx);
    expect(html.match(/<article class="qh-event"/g)?.length).toBe(1);
  });
});

describe("formatEventDate", () => {
  it("formats from the ISO components without applying a time zone", () => {
    expect(formatEventDate("2026-09-12T09:00:00")).toBe("Sat, Sep 12 · 9:00 AM");
    expect(formatEventDate("2026-09-12T09:00:00.000Z")).toBe("Sat, Sep 12 · 9:00 AM");
    expect(formatEventDate("2026-09-12T14:05:00-05:00")).toBe("Sat, Sep 12 · 2:05 PM");
    expect(formatEventDate("2026-09-12")).toBe("Sat, Sep 12");
    expect(formatEventDate("2026-12-25T00:00:00")).toBe("Fri, Dec 25 · 12:00 AM");
  });
  it("falls back to the raw string when unparseable", () => {
    expect(formatEventDate("soon")).toBe("soon");
  });
});

describe("membership_levels", () => {
  it("renders price $40.00 and a data-join button", () => {
    const s = section({ type: "membership_levels", id: "m", variant: "cards", style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, {
      ...ctx,
      data: {
        levels: [
          { id: "lvl_1", name: "Individual", description: "One person, all meetings.", price_cents: 4000, duration_months: 12, renewal_type: "manual" },
        ],
      },
    });
    expect(html).toContain("qh-levels qh-levels--cards");
    expect(html).toContain("$40.00");
    expect(html).toContain('<button class="qh-btn qh-btn--primary" data-join="lvl_1">Join</button>');
    expect(html).toContain("per year");
  });

  it("compact variant renders rows and empty state", () => {
    const s = section({ type: "membership_levels", id: "m", variant: "compact", style: { ...DEFAULT_STYLE } });
    expect(renderSection(s, ctx)).toContain("qh-levels--compact");
    expect(renderSection(s, { ...ctx, data: {} })).toContain('<div class="qh-empty">');
  });
});

describe("store_teaser and blog_teaser", () => {
  it("store renders data-buy and data-add buttons and prices", () => {
    const s = section({ type: "store_teaser", id: "s", limit: 6, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, ctx);
    const first = fixtureData.products![0];
    expect(html).toContain("qh-store");
    expect(html).toContain(`data-buy="${first.id}"`);
    expect(html).toContain(`data-add="${first.id}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain(`/img/${first.image_file_id}`);
  });

  it("store sold-out products have no buttons", () => {
    const s = section({ type: "store_teaser", id: "s", limit: 6, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, {
      ...ctx,
      data: { products: [{ ...fixtureData.products![0], id: "p_out", stock: 0 }] },
    });
    expect(html).not.toContain("data-buy");
    expect(html).toContain("Sold out");
  });

  it("blog renders posts with links under baseUrl and an empty state", () => {
    const s = section({ type: "blog_teaser", id: "b", limit: 3, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-blog");
    expect(html).toContain(`href="${ctx.baseUrl}/blog/${fixtureData.posts![0].slug}"`);
    expect(html).toContain('class="qh-post"');
    expect(renderSection(s, { ...ctx, data: {} })).toContain('<div class="qh-empty">');
  });
});

describe("gallery", () => {
  it("manual items render lightbox links with lazy images", () => {
    const s = section({
      type: "gallery",
      id: "g",
      variant: "grid",
      source: "manual",
      items: [{ imageId: "ph_1", alt: "Log cabin, 2024 show" }],
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-gallery qh-gallery--grid");
    expect(html).toMatch(/<a data-lightbox href="[^"]*\/img\/ph_1[^"]*">/);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('alt="Log cabin, 2024 show"');
  });

  it("gallery source renders from ctx.data.gallery and empty state without it", () => {
    const s = section({
      type: "gallery",
      id: "g2",
      variant: "masonry",
      source: "gallery",
      gallerySlug: fixtureData.gallery!.slug,
      items: [],
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html.match(/data-lightbox/g)?.length).toBe(fixtureData.gallery!.photos.length);
    expect(renderSection(s, { ...ctx, data: {} })).toContain('<div class="qh-empty">');
  });
});

describe("contact and quote_cta keep the qh-site.js hydration hooks", () => {
  it("contact with formSlug renders the contact-form placeholder", () => {
    const s = section({ type: "contact", id: "c", formSlug: "contact", showDetails: true, style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-contact");
    expect(html).toMatch(/<div class="qh-block-contact-form" data-form="contact" data-form-slug="contact"/);
    expect(html).toContain("qh-contact__details");
    expect(html).toContain(fixtureData.profile!.email!);
  });

  it("contact without form or details renders an empty state", () => {
    const s = section({ type: "contact", id: "c", showDetails: false, style: { ...DEFAULT_STYLE } });
    expect(renderSection(s, ctx)).toContain('<div class="qh-empty">');
  });

  it("quote_cta renders the project-intake placeholder", () => {
    const s = section({ type: "quote_cta", id: "q", projectType: "tshirt_quilt", heading: "Get an estimate", style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-quote-cta");
    expect(html).toContain('<div class="qh-block-project-intake" data-project-type="tshirt_quilt"');
    expect(html).toContain('data-heading="Get an estimate"');
    expect(html).toContain('data-submit-label="Get my estimate"');
  });
});

describe("small sections", () => {
  it("cta renders a button link of the requested kind", () => {
    const s = section({ type: "cta", id: "c", label: "See the calendar", href: "/calendar", kind: "secondary", style: { ...DEFAULT_STYLE } });
    const html = renderSection(s, ctx);
    expect(html).toContain('class="qh-btn qh-btn--secondary"');
    expect(html).toContain(`href="${ctx.baseUrl}/calendar"`);
  });

  it("spacer sets its height", () => {
    const s = section({ type: "spacer", id: "sp", height: 48, style: { ...DEFAULT_STYLE } });
    expect(renderSection(s, ctx)).toContain("--qh-s-height:48px");
  });

  it("embed allows iframes from embed hosts and strips script", () => {
    const s = section({
      type: "embed",
      id: "em",
      html: '<iframe src="https://www.youtube.com/embed/abc123"></iframe><script>alert(1)</script>',
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("<iframe");
    expect(html).not.toContain("<script");
  });

  it("feature_grid links titles and shows prices", () => {
    const s = section({
      type: "feature_grid",
      id: "f",
      variant: "cards",
      items: [{ icon: "🧵", title: "Edge-to-edge quilting", body: "Allover designs.", href: "/services", price: "from $0.02/sq in" }],
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-features qh-features--cards");
    expect(html).toContain(`<a href="${ctx.baseUrl}/services">Edge-to-edge quilting</a>`);
    expect(html).toContain('<span class="qh-feature__price">from $0.02/sq in</span>');
  });

  it("faq re-sanitizes answers", () => {
    const s = section({
      type: "faq",
      id: "faq",
      items: [{ q: "Do I need to be a member?", a: '<p>No.</p><img src=x onerror="alert(1)">' }],
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain('<details class="qh-faq__item">');
    expect(html).not.toContain("onerror");
  });

  it("meeting_info renders when/where and the map link", () => {
    const s = section({
      type: "meeting_info",
      id: "mi",
      when: "Second Tuesday, 6:30 PM",
      where: "First Methodist Church fellowship hall",
      address: "321 Thompson Dr, Kerrville, TX",
      mapUrl: "https://maps.google.com/?q=321+Thompson+Dr+Kerrville",
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-meeting");
    expect(html).toContain("Second Tuesday, 6:30 PM");
    expect(html).toContain('href="https://maps.google.com/?q=321+Thompson+Dr+Kerrville"');
  });
});

describe("phase 2 sections", () => {
  const st = { ...DEFAULT_STYLE };

  it("timeline renders an ordered list of years and escapes text", () => {
    const s = section({ type: "timeline", id: "t", items: [{ year: "1987", title: "Founded <b>", body: "Eleven quilters." }], style: st });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-timeline");
    expect(html).toContain('<ol class="qh-timeline__list">');
    expect(html).toContain('<span class="qh-timeline__year">1987</span>');
    expect(html).toContain("Founded &lt;b&gt;");
    expect(renderSection(section({ type: "timeline", id: "t2", items: [], style: st }), ctx)).toContain('<div class="qh-empty">');
  });

  it("quote renders a blockquote with cite", () => {
    const html = renderSection(section({ type: "quote", id: "q", quote: "Finish it.", author: "Marla", style: st }), ctx);
    expect(html).toContain("qh-quote");
    expect(html).toContain('<blockquote class="qh-quote__text"><p>Finish it.</p><cite>Marla</cite></blockquote>');
  });

  it("officers renders a person per item with image via imgUrl, initials fallback, and a mailto link", () => {
    const s = section({
      type: "officers",
      id: "o",
      items: [
        { name: "Ann Reyes", role: "President", email: "ann@example.org", imageId: "img_ann" },
        { name: "Denise Moore", role: "Treasurer" },
      ],
      style: st,
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-officers");
    expect(html.match(/<div class="qh-officer">/g)?.length).toBe(2);
    expect(html).toContain("/img/img_ann");
    expect(html).toContain('href="mailto:ann@example.org"');
    expect(html).toContain('<span class="qh-officer__avatar" aria-hidden="true">DM</span>');
    expect(html).toContain('<p class="qh-officer__role">Treasurer</p>');
  });

  it("benefits is a checklist; process is a numbered step list", () => {
    const b = renderSection(section({ type: "benefits", id: "b", items: [{ title: "Library", body: "Four hundred books." }], style: st }), ctx);
    expect(b).toContain("qh-benefits");
    expect(b).toContain('<ul class="qh-benefits__list">');
    expect(b).toContain('<li class="qh-benefit"><strong>Library</strong><p>Four hundred books.</p></li>');
    const p = renderSection(section({ type: "process", id: "p", heading: "How it works", items: [{ title: "Drop off" }, { title: "We quilt", body: "Two weeks." }], style: st }), ctx);
    expect(p).toContain("qh-process");
    expect(p).toContain('<ol class="qh-process__steps">');
    expect(p.match(/<li class="qh-process__step">/g)?.length).toBe(2);
    expect(p).not.toMatch(/1\./);
  });

  it("event_spotlight shows the named event, falls back to the next upcoming, and has an empty state", () => {
    const named = renderSection(section({ type: "event_spotlight", id: "sp", eventId: "ev_fall_retreat", style: st }), ctx);
    expect(named).toContain("qh-spotlight");
    expect(named).toContain("Fall retreat at Mo-Ranch");
    expect(named).toContain('data-register="ev_fall_retreat"');
    expect(named).toContain(`href="${ctx.baseUrl}/events/ev_fall_retreat"`);
    expect(named).toContain("Two nights, three days");
    const next = renderSection(section({ type: "event_spotlight", id: "sp2", eventId: "ev_missing", style: st }), ctx);
    expect(next).toContain(fixtureData.events![0].title);
    expect(renderSection(section({ type: "event_spotlight", id: "sp3", style: st }), { ...ctx, data: {} })).toContain('<div class="qh-empty">');
  });

  it("projects renders cards with image, linked title and stat", () => {
    const s = section({
      type: "projects",
      id: "pr",
      items: [{ title: "Charity quilts", body: "For CASA.", imageId: "img_charity", href: "/charity", stat: "340 donated" }],
      style: st,
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-projects");
    expect(html).toContain('<article class="qh-project">');
    expect(html).toContain("/img/img_charity");
    expect(html).toContain(`<a href="${ctx.baseUrl}/charity">Charity quilts</a>`);
    expect(html).toContain('<p class="qh-project__stat">340 donated</p>');
  });

  it("sponsors renders a logo strip with grayscale-able images and name fallback", () => {
    const s = section({
      type: "sponsors",
      id: "sp",
      items: [{ name: "Hill Country Fabrics", imageId: "logo_hcf", href: "https://hcf.example" }, { name: "Kerrville Bank" }],
      style: st,
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-sponsors");
    expect(html).toContain('<ul class="qh-sponsors__list">');
    expect(html).toMatch(/<a class="qh-sponsor__link" href="https:\/\/hcf\.example" rel="noopener">/);
    expect(html).toContain('alt="Hill Country Fabrics"');
    expect(html).toContain('<span class="qh-sponsor__name">Kerrville Bank</span>');
  });

  it("newsletter_signup renders a form with the island hook, an email field, and no action attribute", () => {
    const html = renderSection(section({ type: "newsletter_signup", id: "nl", heading: "Newsletter", buttonLabel: "Sign me up", style: st }), ctx);
    expect(html).toContain("qh-newsletter");
    expect(html).toMatch(/<form class="qh-newsletter__form" data-newsletter method="post">/);
    expect(html).toContain('type="email"');
    expect(html).toContain('name="email"');
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain('<button class="qh-btn qh-btn--primary" type="submit">Sign me up</button>');
    expect(html).not.toContain(' action=');
  });

  it("services cards vs table (table scrolls in its own wrapper)", () => {
    const items = [{ title: "Edge to edge", body: "Allover.", price: "2¢", unit: "per sq in" }];
    const cards = renderSection(section({ type: "services", id: "sv", variant: "cards", items, style: st }), ctx);
    expect(cards).toContain("qh-services qh-services--cards");
    expect(cards).toContain('<div class="qh-service">');
    expect(cards).toContain('<span class="qh-service__price">2¢</span>');
    expect(cards).toContain('<span class="qh-service__unit">per sq in</span>');
    const table = renderSection(section({ type: "services", id: "sv2", variant: "table", items, style: st }), ctx);
    expect(table).toContain("qh-services--table");
    expect(table).toContain('<div class="qh-table-wrap"><table class="qh-services__table">');
    expect(table).toContain("<th scope=\"col\">Service</th>");
    expect(table).toContain("<td>2¢ <span class=\"qh-service__unit\">per sq in</span></td>");
  });

  it("portfolio grid uses lightbox links; featured marks the first item", () => {
    const items = [{ imageId: "pf_1", title: "Ocean Waves", caption: "Custom quilting" }, { imageId: "pf_2", title: "Log cabin" }];
    const grid = renderSection(section({ type: "portfolio", id: "pf", variant: "grid", items, style: st }), ctx);
    expect(grid).toContain("qh-portfolio qh-portfolio--grid");
    expect(grid.match(/data-lightbox/g)?.length).toBe(2);
    expect(grid).toContain('alt="Ocean Waves"');
    const feat = renderSection(section({ type: "portfolio", id: "pf2", variant: "featured", items, style: st }), ctx);
    expect(feat).toContain("qh-portfolio--featured");
    expect(feat).toContain('class="qh-portfolio__item qh-portfolio__item--featured"');
    expect(feat).toContain("/img/pf_1?w=1600");
    expect(renderSection(section({ type: "portfolio", id: "pf3", variant: "grid", items: [], style: st }), ctx)).toContain('<div class="qh-empty">');
  });

  it("hours_location renders hours rows, address, map/tel/mailto links and note", () => {
    const s = section({
      type: "hours_location",
      id: "h",
      hours: [{ day: "Tue–Sat", open: "10–5" }],
      address: "1210 Water St, Kerrville, TX",
      mapUrl: "https://maps.google.com/?q=1210+Water+St",
      phone: "830-555-0147",
      email: "studio@example.org",
      note: "Ring the bell.",
      style: st,
    });
    const html = renderSection(s, ctx);
    expect(html).toContain("qh-hours");
    expect(html).toContain('<dl class="qh-hours__list"><div><dt>Tue–Sat</dt><dd>10–5</dd></div></dl>');
    expect(html).toContain("1210 Water St, Kerrville, TX");
    expect(html).toContain('href="https://maps.google.com/?q=1210+Water+St"');
    expect(html).toContain('href="tel:8305550147"');
    expect(html).toContain('href="mailto:studio@example.org"');
    expect(html).toContain('<p class="qh-hours__note">Ring the bell.</p>');
  });

  it("documents renders a sign-in prompt when data.documents is undefined and a list otherwise", () => {
    const s = section({ type: "documents", id: "d", limit: 2, style: st });
    const prompt = renderSection(s, { ...ctx, data: {} });
    expect(prompt).toContain("qh-documents");
    expect(prompt).toContain('class="qh-documents__signin"');
    expect(prompt).toContain('href="https://hillcountryquiltguild.org/portal?slug=hcqg"');
    const list = renderSection(s, {
      ...ctx,
      data: { documents: [{ id: "f1", filename: "Bylaws 2026.pdf", size: 204800 }, { id: "f2", filename: "Minutes.pdf", size: null }, { id: "f3", filename: "Extra.pdf", size: 10 }] },
    });
    expect(list).toContain('<ul class="qh-documents__list">');
    expect(list.match(/<li class="qh-document">/g)?.length).toBe(2);
    expect(list).toContain('href="https://hillcountryquiltguild.org/api/portal/hcqg/files/f1"');
    expect(list).toContain("200 KB");
    expect(list).not.toContain("undefined");
    expect(renderSection(s, { ...ctx, data: { documents: [] } })).toContain('<div class="qh-empty">');
  });

  it("donate emits one data-donate button per amount in cents plus an other-amount button", () => {
    const html = renderSection(section({ type: "donate", id: "dn", heading: "Support the guild", amounts: [1000, 2500], style: st }), ctx);
    expect(html).toContain("qh-donate");
    expect(html).toContain('<button class="qh-btn qh-btn--primary" data-donate="1000">$10.00</button>');
    expect(html).toContain('<button class="qh-btn qh-btn--primary" data-donate="2500">$25.00</button>');
    expect(html).toContain('<button class="qh-btn qh-btn--secondary" data-donate="0">Other amount</button>');
  });
});

describe("unknown type", () => {
  it("throws", () => {
    const bogus = { type: "carousel", id: "x", style: { ...DEFAULT_STYLE } } as unknown as Section;
    expect(() => renderSection(bogus, ctx)).toThrow(/carousel/);
  });
});

describe("imgUrl", () => {
  it("is the only way an imageId becomes a URL", () => {
    const calls: [string, number | undefined][] = [];
    const custom: RenderContext = {
      ...ctx,
      imgUrl: (id, w) => {
        calls.push([id, w]);
        return `/public/hcqg/img/${id}${w ? `?w=${w}` : ""}`;
      },
    };
    const s = section({
      type: "image",
      id: "i",
      variant: "single",
      items: [{ imageId: "file_9", alt: "Raffle quilt" }],
      style: { ...DEFAULT_STYLE },
    });
    const html = renderSection(s, custom);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe("file_9");
    expect(html).toContain("/public/hcqg/img/file_9");
  });
});


describe("pattern media references (kits)", () => {
  it("renders a split hero with imageId 'pattern:log-cabin' as pattern art, not an <img>", async () => {
    const { renderSection } = await import("./render");
    const { fixtureContext } = await import("./fixtures");
    const html = renderSection(
      { type: "hero", variant: "split", title: "Welcome", id: "h", style: { bg: "pattern", width: "normal", spacing: "normal", align: "left", media: "right", imageId: "pattern:log-cabin" } } as never,
      fixtureContext()
    );
    expect(html).toContain("qh-media--pattern");
    expect(html).toContain("data:image/svg+xml");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/img/pattern:");
  });
});

// ---------------------------------------------------------------------------
// Event times and the guild's clock
//
// The admin converts the officer's local entry with toISOString(), so
// events.start_at is a UTC instant. Printing its digits as if they were wall
// time published a 12:25 pm meeting as 5:25 pm — reported from a live guild.
// A stamp that names a zone is converted into the guild's; one that does not
// (kit samples, naive imports) is already wall time and is left alone.
// ---------------------------------------------------------------------------

describe("formatEventDate with a guild time zone", () => {
  const UTC_NOON = "2026-09-25T17:25:00.000Z";

  it("converts a zoned stamp into the guild's clock", () => {
    expect(formatEventDate(UTC_NOON, "America/Chicago")).toBe("Fri, Sep 25 · 12:25 PM");
    expect(formatEventDate(UTC_NOON, "America/New_York")).toBe("Fri, Sep 25 · 1:25 PM");
    expect(formatEventDate(UTC_NOON, "America/Los_Angeles")).toBe("Fri, Sep 25 · 10:25 AM");
    expect(formatEventDate(UTC_NOON, "UTC")).toBe("Fri, Sep 25 · 5:25 PM");
  });

  it("rolls the date when the zone crosses midnight", () => {
    // 1:00 am UTC on the 26th is still the evening of the 25th in Chicago.
    expect(formatEventDate("2026-09-26T01:00:00Z", "America/Chicago")).toBe("Fri, Sep 25 · 8:00 PM");
  });

  it("leaves a stamp with no zone as the wall time it already is", () => {
    expect(formatEventDate("2026-09-12T09:00:00", "America/Chicago")).toBe("Sat, Sep 12 · 9:00 AM");
    expect(formatEventDate("2026-09-12", "America/Chicago")).toBe("Sat, Sep 12");
  });

  it("falls back to the wall-clock reading for a zone it does not know", () => {
    expect(formatEventDate(UTC_NOON, "Mars/Olympus")).toBe("Fri, Sep 25 · 5:25 PM");
  });

  it("without a zone, behaves exactly as before", () => {
    expect(formatEventDate(UTC_NOON)).toBe("Fri, Sep 25 · 5:25 PM");
  });
});
