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
    const html = renderPageHtml({
      ...args,
      nav: [{ label: '<img src=x onerror=alert(1)>', href: '"><script>' }],
    });
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
