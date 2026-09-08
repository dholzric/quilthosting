import { describe, it, expect } from "vitest";
import { renderPageHtml, renderSitePage, buildMenu, readBranding, readBusinessIdentity, readSettingsMenu } from "./render";
import type { SitePageArgs } from "./render";
import { DEFAULT_DESIGN } from "./design/tokens";
import type { SiteDesign } from "./design/tokens";
import { DEFAULT_STYLE } from "./sections/schema";
import type { Section } from "./sections/schema";

const tenant = {
  name: "Stitch Studio",
  slug: "stitchstudio",
  settings_json: JSON.stringify({
    theme: { primary: "#8a2060", accent: "#a04080", themeColor: "#c060a0" },
    fonts: { heading: "fraunces", body: "inter" },
    business: { name: "Stitch Studio Quilting", city: "Wimberley", state: "TX", phone: "512-555-0100" },
  }),
};

const page = {
  title: "Services",
  slug: "services",
  blocks_json: JSON.stringify([{ type: "heading", text: "Longarm", level: 2 }]),
};

const args = {
  tenant,
  page,
  nav: [{ label: "Services", href: "/services" }],
  baseUrl: "https://stitchstudioquilting.com",
  showPlatformCredit: true,
};

describe("renderPageHtml", () => {
  it("returns a complete document", () => {
    const html = renderPageHtml(args);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // The slug attribute is how qh-site.js finds the tenant to hydrate against.
    expect(html).toContain('<html lang="en" data-tenant-slug="stitchstudio">');
    expect(html).toContain("</html>");
  });

  it("inlines the theme tokens as css custom properties", () => {
    expect(renderPageHtml(args)).toContain("--color-primary:#8a2060");
  });

  it("emits the seo head and the json-ld", () => {
    const html = renderPageHtml(args);
    // settings.business.name ("Stitch Studio Quilting") wins over
    // tenant.name ("Stitch Studio") — the owner-entered business identity is
    // the authority for what the public site displays, not the internal
    // platform record set once at signup. See the fallback leg covered by
    // "uses the tenant name when settings have no business identity" below.
    expect(html).toContain("<title>Services | Stitch Studio Quilting</title>");
    expect(html).toContain('"@type":"LocalBusiness"');
    expect(html).toContain('"name":"Stitch Studio Quilting"');
  });

  it("renders the page blocks", () => {
    expect(renderPageHtml(args)).toContain("Longarm");
  });

  it("renders nav links and escapes them", () => {
    // The href was '"><script>' before the sanitizer landed; that value is
    // now rejected by sanitizeUrl (the whole link is dropped -- see the
    // javascript: test below), so the label-escaping property is exercised
    // with a valid href and the attribute-breakout href is asserted separately.
    const html = renderPageHtml({
      ...args,
      nav: [
        { label: '<img src=x onerror=alert(1)>', href: "/x" },
        { label: "Breakout", href: '"><script>' },
      ],
    });
    expect(html).not.toContain(">Breakout<");
    // esc() neutralizes HTML structure (&<>") — it does not strip arbitrary
    // substrings, so "onerror=alert(1)" legitimately survives as inert text
    // inside the escaped tag. The security property to assert is that the
    // unescaped tag-opening sequence is gone and the escaped form is present
    // (same correction the coordinator ruled on for this identical pattern
    // in src/lib/blocks.test.ts, Task 6).
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('"><script>');
  });

  it("drops a nav link whose href is a javascript: URL", () => {
    const html = renderPageHtml({
      ...args,
      nav: [{ label: "Bad", href: "javascript:alert(1)" }, { label: "Good", href: "/good" }],
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain(">Bad<");
    // The legacy nav arrives host-shaped from loadNav and is emitted as-is
    // (buildMenu is what prefixes the base URL for the new serveSite path).
    expect(html).toContain('<a href="/good">Good</a>');
  });

  it("adds rel=noopener noreferrer to external nav links", () => {
    const html = renderPageHtml({
      ...args,
      nav: [{ label: "Shop", href: "https://shop.example", external: true }],
    });
    expect(html).toContain('<a href="https://shop.example" rel="noopener noreferrer">Shop</a>');
  });

  it("sanitizes rich-text blocks and legacy content_json before they reach the page", () => {
    const payload = '<p>ok</p><img src=x onerror=alert(1)><script>alert(1)</script>';
    const viaBlocks = renderPageHtml({
      ...args,
      page: { ...page, blocks_json: JSON.stringify([{ type: "text", html: payload }]) },
    });
    const viaLegacy = renderPageHtml({
      ...args,
      page: { title: "Legacy", slug: "legacy", blocks_json: null, content_json: JSON.stringify({ html: payload }) },
    });
    for (const html of [viaBlocks, viaLegacy]) {
      expect(html).toContain("<p>ok</p>");
      expect(html).not.toContain("onerror");
      // The only <script> on the page is the platform's own qh-site.js and the JSON-LD.
      expect(html).not.toContain("<script>alert");
    }
  });

  it("escapes single quotes in the business name", () => {
    const html = renderPageHtml({
      ...args,
      tenant: { ...tenant, settings_json: JSON.stringify({ business: { name: "Jo's Quilts" } }) },
    });
    expect(html).toContain("Jo&#39;s Quilts");
  });

  it("drops a javascript: logo url", () => {
    const html = renderPageHtml({ ...args, logoUrl: "javascript:alert(1)" });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("qh-brand__logo");
  });

  it("renders a safe logo sized by height", () => {
    const html = renderPageHtml({ ...args, logoUrl: "https://stitchstudioquilting.com/img/logo1" });
    expect(html).toContain('<img class="qh-brand__logo" src="https://stitchstudioquilting.com/img/logo1" alt="" height="44">');
  });

  it("shows the platform credit when enabled", () => {
    const html = renderPageHtml(args);
    expect(html).toContain("Powered by");
    expect(html).toContain("https://quilthosting.com");
  });

  it("omits the platform credit when disabled", () => {
    expect(renderPageHtml({ ...args, showPlatformCredit: false })).not.toContain("Powered by");
  });

  it("uses the tenant name when settings have no business identity", () => {
    const html = renderPageHtml({
      ...args,
      tenant: { ...tenant, settings_json: "{}" },
    });
    expect(html).toContain("Stitch Studio");
  });

  it("renders even when settings_json is corrupt", () => {
    const html = renderPageHtml({ ...args, tenant: { ...tenant, settings_json: "{oops" } });
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("renders through the new shell with the migrated design", () => {
    const html = renderPageHtml(args);
    // Migrated 13-token theme → SiteDesign → --qh-* vars next to the legacy vars.
    expect(html).toContain("--qh-bg:#");
    expect(html).toContain("--qh-font-display:");
    expect(html).toContain('<body class="qh-site" data-qh-slug="stitchstudio" data-qh-base="https://stitchstudioquilting.com" data-qh-type="business">');
    expect(html).toContain('<header class="qh-header qh-header--left qh-header--sticky">');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('<section id="s_0" class="qh-s ');
    expect(html).toContain('<script src="/qh-site.js" defer></script>');
    expect(html).toContain('href="https://fonts.googleapis.com/css2?');
    expect(html).toContain("display=swap");
  });

  it("uses the page image for og:image when the hero has one and no explicit og image is set", () => {
    const html = renderPageHtml({
      ...args,
      page: {
        ...page,
        blocks_json: JSON.stringify([{ type: "hero", title: "Welcome", imageUrl: "/img/hero77" }]),
      },
    });
    expect(html).toContain('<meta property="og:image" content="https://stitchstudioquilting.com/img/hero77">');
  });
});

// ---------------------------------------------------------------------------
// renderSitePage

function design(overrides: Partial<SiteDesign> = {}): SiteDesign {
  return {
    ...DEFAULT_DESIGN,
    palette: { ...DEFAULT_DESIGN.palette, input: { ...DEFAULT_DESIGN.palette.input } },
    header: { ...DEFAULT_DESIGN.header, ...(overrides.header ?? {}) },
    footer: { ...DEFAULT_DESIGN.footer, ...(overrides.footer ?? {}) },
  };
}

const heroImage: Section = {
  type: "hero",
  variant: "image",
  title: "Welcome",
  style: { ...DEFAULT_STYLE, bg: "image", imageId: "f1" },
  id: "hero",
};

const heroMinimal: Section = { type: "hero", variant: "minimal", title: "Welcome", style: { ...DEFAULT_STYLE }, id: "hero" };

function siteArgs(overrides: Partial<SitePageArgs> = {}): SitePageArgs {
  return {
    tenant: {
      name: "Hill Country Quilt Guild",
      slug: "hcqg",
      settings_json: JSON.stringify({ profile: { description: "A guild in the hills.", meeting_info: "2nd Tuesday, 7pm", location: "Wimberley Community Center", contact_email: "hello@hcqg.org" } }),
      tenant_type: "guild",
    },
    page: { title: "Home", slug: "", sections: [heroMinimal] },
    menu: [
      { label: "About", href: "/about" },
      { label: "Events", href: "/events", children: [{ label: "Calendar", href: "/calendar" }, { label: "Retreat", href: "/retreat" }] },
      { label: "Shop", href: "https://shop.example", external: true },
    ],
    baseUrl: "",
    host: "quilthosting.com",
    showPlatformCredit: true,
    design: design(),
    data: {},
    imgUrl: (id, w) => `/public/hcqg/img/${id}${w ? `?w=${w}` : ""}`,
    ...overrides,
  };
}

describe("renderSitePage", () => {
  it("emits each header variant's class", () => {
    for (const variant of ["left", "centered", "split"] as const) {
      const html = renderSitePage(siteArgs({ design: design({ header: { ...DEFAULT_DESIGN.header, variant } }) }));
      expect(html).toContain(`class="qh-header qh-header--${variant} qh-header--sticky"`);
    }
  });

  it("drops the sticky class when sticky is off", () => {
    const html = renderSitePage(siteArgs({ design: design({ header: { ...DEFAULT_DESIGN.header, sticky: false } }) }));
    expect(html).toContain('class="qh-header qh-header--left"');
    expect(html).not.toContain("qh-header--sticky");
  });

  it("split header puts the nav halves around the brand", () => {
    const html = renderSitePage(siteArgs({ design: design({ header: { ...DEFAULT_DESIGN.header, variant: "split" } }) }));
    const start = html.indexOf('class="qh-nav qh-nav--start"');
    const brand = html.indexOf('class="qh-brand"');
    const end = html.indexOf('class="qh-nav qh-nav--end"');
    expect(start).toBeGreaterThan(-1);
    expect(brand).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(brand);
  });

  it("renders a nested menu, external rel, and the phone drawer as a flat list", () => {
    const html = renderSitePage(siteArgs());
    expect(html).toContain('<li class="qh-nav__item has-children"><a href="/events">Events</a><ul class="qh-nav__menu"><li class="qh-nav__item"><a href="/calendar">Calendar</a></li>');
    expect(html).toContain('<a href="https://shop.example" rel="noopener noreferrer">Shop</a>');
    expect(html).toContain('<button class="qh-nav-toggle" type="button" aria-controls="qh-drawer" aria-expanded="false" aria-label="Open menu"><span class="qh-nav-toggle__bars"></span></button>');
    expect(html).toContain('<dialog class="qh-drawer" id="qh-drawer" aria-label="Menu">');
    expect(html).toContain('class="qh-drawer__panel"');
    expect(html).toContain('class="qh-drawer__close"');
    // Drawer list is flat: the child appears as a sibling of its parent, not nested.
    const drawer = html.slice(html.indexOf("<dialog"), html.indexOf("</dialog>"));
    expect(drawer).not.toContain("qh-nav__menu");
    expect(drawer).toContain('<li><a href="/events">Events</a></li><li><a href="/calendar">Calendar</a></li>');
  });

  it("resolves the join CTA to /membership for a guild", () => {
    const html = renderSitePage(siteArgs({ baseUrl: "/g/hcqg" }));
    expect(html).toContain('<a class="qh-btn qh-btn--primary qh-header__cta" href="/g/hcqg/membership">Join</a>');
  });

  it("resolves the join CTA to the page's join band for a business, else omits it", () => {
    const band: Section = { type: "join_band", title: "Join us", ctaLabel: "Join", style: { ...DEFAULT_STYLE }, id: "band" };
    const withBand = renderSitePage(siteArgs({ tenant: { ...siteArgs().tenant, tenant_type: "business" }, page: { title: "Home", slug: "", sections: [heroMinimal, band] } }));
    expect(withBand).toContain('qh-header__cta" href="#band">Join</a>');
    const without = renderSitePage(siteArgs({ tenant: { ...siteArgs().tenant, tenant_type: "business" } }));
    expect(without).not.toContain("qh-header__cta");
  });

  it("resolves quote and donate CTAs", () => {
    const quote = renderSitePage(siteArgs({ design: design({ header: { ...DEFAULT_DESIGN.header, cta: "quote" } }) }));
    expect(quote).toContain('qh-header__cta" href="/contact">Request a quote</a>');
    const quoteSection: Section = { type: "quote_cta", projectType: "longarm", style: { ...DEFAULT_STYLE }, id: "q" };
    const quoteOnPage = renderSitePage(siteArgs({ design: design({ header: { ...DEFAULT_DESIGN.header, cta: "quote" } }), page: { title: "Quote", slug: "request-a-quote", sections: [quoteSection] } }));
    expect(quoteOnPage).toContain('qh-header__cta" href="#q">Request a quote</a>');
    const quoteInMenu = renderSitePage(siteArgs({ design: design({ header: { ...DEFAULT_DESIGN.header, cta: "quote" } }), menu: [{ label: "Quote", href: "/request-a-quote" }] }));
    expect(quoteInMenu).toContain('qh-header__cta" href="/request-a-quote">Request a quote</a>');
    const donate = renderSitePage(siteArgs({ design: design({ header: { ...DEFAULT_DESIGN.header, cta: "donate" } }) }));
    expect(donate).toContain('qh-header__cta" href="#donate">Donate</a>');
    const none = renderSitePage(siteArgs({ design: design({ header: { ...DEFAULT_DESIGN.header, cta: "none" } }) }));
    expect(none).not.toContain("qh-header__cta");
  });

  it("footer columns include About, Links, Members (sign-in) and Contact", () => {
    const html = renderSitePage(siteArgs({ baseUrl: "/g/hcqg" }));
    expect(html).toContain('<footer class="qh-footer qh-footer--columns">');
    expect(html).toContain("A guild in the hills.");
    expect(html).toContain('<a href="/portal?slug=hcqg">Member sign-in</a>');
    expect(html).toContain('<a href="mailto:hello@hcqg.org">hello@hcqg.org</a>');
    // The menu handed to renderSitePage is already built (buildMenu prefixes
    // the base); the footer Links column repeats it verbatim, flattened.
    const footer = html.slice(html.indexOf("<footer"));
    expect(footer).toContain('<li><a href="/about">About</a></li><li><a href="/events">Events</a></li><li><a href="/calendar">Calendar</a></li>');
    expect(html).toContain('Powered by <a href="https://quilthosting.com">QuiltHosting</a>');
  });

  it("portal link uses the tenant host origin on a tenant host", () => {
    const html = renderSitePage(siteArgs({ baseUrl: "https://hcqg.org", host: "hcqg.org" }));
    expect(html).toContain('<a href="https://hcqg.org/portal?slug=hcqg">Member sign-in</a>');
    expect(html).toContain('data-qh-base="https://hcqg.org"');
  });

  it("footer simple is name + utility row; footer meeting adds when/where", () => {
    const simple = renderSitePage(siteArgs({ design: design({ footer: { variant: "simple" } }) }));
    expect(simple).toContain('<footer class="qh-footer qh-footer--simple">');
    expect(simple).not.toContain("qh-footer__cols");
    expect(simple).toContain("Member sign-in");
    const meeting = renderSitePage(siteArgs({ design: design({ footer: { variant: "meeting" } }) }));
    expect(meeting).toContain('<footer class="qh-footer qh-footer--meeting">');
    expect(meeting).toContain('class="qh-footer__meeting"');
    expect(meeting).toContain("2nd Tuesday, 7pm");
    expect(meeting).toContain("Wimberley Community Center");
  });

  it("omits the platform credit when disabled", () => {
    expect(renderSitePage(siteArgs({ showPlatformCredit: false }))).not.toContain("Powered by");
  });

  it("overlayHero adds the header overlay class and .qh-hero--under-header only for a first image hero", () => {
    const d = design({ header: { ...DEFAULT_DESIGN.header, overlayHero: true } });
    const withImage = renderSitePage(siteArgs({ design: d, page: { title: "Home", slug: "", sections: [heroImage] } }));
    expect(withImage).toContain("qh-header--overlay");
    expect(withImage).toContain('<section id="hero" class="qh-s qh-hero--under-header ');
    const minimal = renderSitePage(siteArgs({ design: d, page: { title: "Home", slug: "", sections: [heroMinimal] } }));
    expect(minimal).not.toContain("qh-hero--under-header");
    expect(minimal).not.toContain("qh-header--overlay");
    const notFirst = renderSitePage(siteArgs({ design: d, page: { title: "Home", slug: "", sections: [heroMinimal, heroImage] } }));
    expect(notFirst).not.toContain("qh-hero--under-header");
  });

  it("emits theme-color, design vars, fonts, skip link, body data attributes and the island script", () => {
    const html = renderSitePage(siteArgs({ baseUrl: "/g/hcqg" }));
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}">/);
    expect(html).toContain("<style>:root{--qh-bg:#");
    expect(html).toContain('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
    expect(html).toContain('<a class="qh-skip" href="#main">Skip to content</a>');
    expect(html).toContain('<body class="qh-site" data-qh-slug="hcqg" data-qh-base="" data-qh-type="guild">');
    expect(html).toContain('<script src="/qh-site.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="/qh-site.css">');
  });

  it("skips the fonts link for the system pair", () => {
    const html = renderSitePage(siteArgs({ design: { ...design(), typePair: "system" } }));
    expect(html).not.toContain("fonts.googleapis.com/css2");
  });

  it("escapes tenant strings everywhere they land", () => {
    const html = renderSitePage(
      siteArgs({
        tenant: { name: 'Bad <b>Guild</b> "&" Co', slug: "bad", settings_json: JSON.stringify({ profile: { description: "<script>x</script>" } }), tenant_type: "guild" },
        menu: [{ label: "<i>Hi</i>", href: "/hi" }],
      })
    );
    expect(html).not.toContain("<b>Guild</b>");
    expect(html).toContain("Bad &lt;b&gt;Guild&lt;/b&gt; &quot;&amp;&quot; Co");
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<i>Hi</i>");
    expect(html).toContain("&lt;i&gt;Hi&lt;/i&gt;");
  });

  it("emits noindex for members-only pages and honours extraHead", () => {
    const html = renderSitePage(siteArgs({ page: { title: "Newsletter", slug: "newsletter", sections: [heroMinimal], membersOnly: true }, extraHead: "<!-- gated -->" }));
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("<!-- gated -->");
  });

  it("emits a LocalBusiness JSON-LD for business tenants only", () => {
    const biz = renderSitePage(siteArgs({ tenant: { name: "Stitch", slug: "s", settings_json: JSON.stringify({ business: { name: "Stitch Studio", phone: "512-555-0100" } }), tenant_type: "business" } }));
    expect(biz).toContain('"@type":"LocalBusiness"');
    expect(biz).toContain("512-555-0100");
    expect(renderSitePage(siteArgs())).not.toContain('"@type":"LocalBusiness"');
  });
});

// ---------------------------------------------------------------------------
// buildMenu

describe("buildMenu", () => {
  const pages = [
    { slug: "", title: "Home", nav_label: null, show_in_nav: 1 },
    { slug: "about", title: "About us", nav_label: "About", show_in_nav: 1 },
    { slug: "secret", title: "Secret", nav_label: null, show_in_nav: 0 },
  ];

  it("builds from pages with show_in_nav when there is no settings nav", () => {
    expect(buildMenu(pages, [], "/g/hcqg")).toEqual([
      { label: "Home", href: "/g/hcqg/" },
      { label: "About", href: "/g/hcqg/about" },
    ]);
  });

  it("prefers the settings nav and keeps children", () => {
    const menu = buildMenu(pages, [{ label: "Events", href: "/events", children: [{ label: "Calendar", href: "/calendar" }] }, { label: "Shop", href: "https://shop.example", external: true }], "https://hcqg.org");
    expect(menu).toEqual([
      { label: "Events", href: "https://hcqg.org/events", children: [{ label: "Calendar", href: "https://hcqg.org/calendar" }] },
      { label: "Shop", href: "https://shop.example", external: true },
    ]);
  });

  it("marks absolute links to other origins as external and drops unsafe hrefs", () => {
    const menu = buildMenu([], [{ label: "Other", href: "https://other.example/x" }, { label: "Bad", href: "javascript:alert(1)" }], "https://hcqg.org");
    expect(menu).toEqual([{ label: "Other", href: "https://other.example/x", external: true }]);
  });
});

describe("readSettingsMenu", () => {
  it("reads settings.nav with one level of children", () => {
    const j = JSON.stringify({ nav: [{ label: "Events", href: "/events", children: [{ label: "Calendar", href: "/calendar" }, { label: "", href: "/x" }] }] });
    expect(readSettingsMenu(j)).toEqual([{ label: "Events", href: "/events", external: false, children: [{ label: "Calendar", href: "/calendar", external: false }] }]);
  });

  it("returns [] on junk", () => {
    expect(readSettingsMenu("{oops")).toEqual([]);
    expect(readSettingsMenu(null)).toEqual([]);
  });
});

describe("readBranding", () => {
  it("defaults the platform credit to shown", () => {
    expect(readBranding("{}").showPlatformCredit).toBe(true);
    expect(readBranding(null).showPlatformCredit).toBe(true);
  });

  it("honours an explicit false", () => {
    const j = JSON.stringify({ branding: { show_platform_credit: false } });
    expect(readBranding(j).showPlatformCredit).toBe(false);
  });
});

describe("readBusinessIdentity", () => {
  it("reads the business subtree", () => {
    expect(readBusinessIdentity(tenant.settings_json).city).toBe("Wimberley");
  });

  it("returns an empty name for missing settings", () => {
    expect(readBusinessIdentity("{}").name).toBe("");
  });
});
