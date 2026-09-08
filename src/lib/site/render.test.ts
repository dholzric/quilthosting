import { describe, it, expect } from "vitest";
import { renderPageHtml, readBranding, readBusinessIdentity } from "./render";

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
    expect(html).not.toContain("qh-site-logo");
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
