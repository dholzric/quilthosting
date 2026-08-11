import { describe, it, expect } from "vitest";
import {
  resolveTitle,
  resolveDescription,
  canonicalUrl,
  buildSeoHead,
  buildLocalBusinessJsonLd,
} from "./seo";

const page = { title: "Longarm Quilting", slug: "services" };

describe("resolveTitle", () => {
  it("prefers seo_title", () => {
    expect(resolveTitle({ ...page, seo_title: "Custom Longarm" }, "Stitch Studio"))
      .toBe("Custom Longarm");
  });

  it("falls back to 'title | siteName'", () => {
    expect(resolveTitle(page, "Stitch Studio")).toBe("Longarm Quilting | Stitch Studio");
  });

  it("does not append the site name to the home page", () => {
    expect(resolveTitle({ title: "Stitch Studio", slug: "" }, "Stitch Studio"))
      .toBe("Stitch Studio");
  });
});

describe("resolveDescription", () => {
  it("prefers seo_description", () => {
    expect(resolveDescription({ ...page, seo_description: "Hand-guided." }, "<p>ignored</p>"))
      .toBe("Hand-guided.");
  });

  it("falls back to the body text, stripped and truncated at 160", () => {
    const body = "<p>" + "quilting ".repeat(40) + "</p>";
    const d = resolveDescription(page, body);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).not.toContain("<");
    expect(d.endsWith("…")).toBe(true);
  });

  it("returns empty string when there is no body", () => {
    expect(resolveDescription(page, "")).toBe("");
  });
});

describe("canonicalUrl", () => {
  it("builds an absolute url on the tenant base", () => {
    expect(canonicalUrl("https://stitchstudioquilting.com", "services"))
      .toBe("https://stitchstudioquilting.com/services");
  });

  it("maps the empty slug to the site root", () => {
    expect(canonicalUrl("https://stitchstudioquilting.com", ""))
      .toBe("https://stitchstudioquilting.com/");
  });

  it("tolerates a trailing slash on the base", () => {
    expect(canonicalUrl("https://x.com/", "a")).toBe("https://x.com/a");
  });
});

describe("buildSeoHead", () => {
  const base = {
    page,
    siteName: "Stitch Studio",
    baseUrl: "https://stitchstudioquilting.com",
    bodyHtml: "<p>Edge to edge quilting.</p>",
  };

  it("emits title, description, canonical, and OG tags", () => {
    const head = buildSeoHead(base);
    expect(head).toContain("<title>Longarm Quilting | Stitch Studio</title>");
    expect(head).toContain('<meta name="description" content="Edge to edge quilting.">');
    expect(head).toContain('<link rel="canonical" href="https://stitchstudioquilting.com/services">');
    expect(head).toContain('<meta property="og:title"');
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it("emits robots noindex only when the page asks for it", () => {
    expect(buildSeoHead(base)).not.toContain("noindex");
    expect(buildSeoHead({ ...base, page: { ...page, noindex: 1 } }))
      .toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("escapes quotes and angle brackets in every attribute", () => {
    const head = buildSeoHead({
      ...base,
      page: { ...page, seo_title: 'Quilts" onload="alert(1)' },
    });
    expect(head).not.toContain('onload="alert(1)"');
    expect(head).toContain("&quot;");
  });

  it("omits the og:image tag entirely when there is no image", () => {
    expect(buildSeoHead(base)).not.toContain("og:image");
    expect(buildSeoHead({ ...base, ogImageUrl: "https://x.com/a.jpg" }))
      .toContain('<meta property="og:image" content="https://x.com/a.jpg">');
  });
});

describe("buildLocalBusinessJsonLd", () => {
  it("emits a LocalBusiness script with the address", () => {
    const ld = buildLocalBusinessJsonLd(
      { name: "Stitch Studio", city: "Wimberley", state: "TX", zip: "78676", phone: "512-555-0100" },
      "https://stitchstudioquilting.com",
    );
    expect(ld).toContain('"@type":"LocalBusiness"');
    expect(ld).toContain('"addressLocality":"Wimberley"');
    expect(ld).toContain('"telephone":"512-555-0100"');
  });

  it("cannot break out of the script tag", () => {
    const ld = buildLocalBusinessJsonLd({ name: '</script><script>alert(1)' }, "https://x.com");
    expect(ld).not.toContain("</script><script>");
  });

  it("omits absent fields rather than emitting empty strings", () => {
    const ld = buildLocalBusinessJsonLd({ name: "X" }, "https://x.com");
    expect(ld).not.toContain("telephone");
    expect(ld).not.toContain("addressLocality");
  });
});
