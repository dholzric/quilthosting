import { describe, it, expect } from "vitest";
import {
  resolveTitle,
  resolveDescription,
  canonicalUrl,
  buildSeoHead,
  buildLocalBusinessJsonLd,
  buildOrganizationJsonLd,
  buildEventJsonLd,
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

describe("buildOrganizationJsonLd", () => {
  it("emits an Organization with the site url and an optional logo", () => {
    const ld = buildOrganizationJsonLd("Hill Country Quilt Guild", "https://hcqg.org/", "https://hcqg.org/img/logo");
    expect(ld.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(ld).toContain('"@type":"Organization"');
    expect(ld).toContain('"name":"Hill Country Quilt Guild"');
    expect(ld).toContain('"url":"https://hcqg.org/"');
    expect(ld).toContain('"logo":"https://hcqg.org/img/logo"');
    expect(buildOrganizationJsonLd("X", "https://x.org")).not.toContain("logo");
  });

  it("escapes < so the name cannot close the script tag", () => {
    const ld = buildOrganizationJsonLd("</script><script>alert(1)", "https://x.org");
    expect(ld).not.toContain("</script><script>");
    expect(ld).toContain("\\u003c/script>");
  });
});

describe("buildEventJsonLd", () => {
  const event = {
    id: "ev_1",
    title: "October Workshop",
    description: "Bring a rotary cutter.",
    location: "Community Center, Room B",
    start_at: "2026-10-03T15:00:00Z",
    end_at: "2026-10-03T18:00:00Z",
    member_price_cents: 0,
    non_member_price_cents: 1500,
    registration_open: 1,
  };

  it("emits a schema.org Event with dates, place, url and an offer when priced", () => {
    const ld = buildEventJsonLd(event, "https://hcqg.org");
    expect(ld).toContain('"@type":"Event"');
    expect(ld).toContain('"name":"October Workshop"');
    expect(ld).toContain('"startDate":"2026-10-03T15:00:00.000Z"');
    expect(ld).toContain('"endDate":"2026-10-03T18:00:00.000Z"');
    expect(ld).toContain('"url":"https://hcqg.org/events/ev_1"');
    expect(ld).toContain('"location":{"@type":"Place","name":"Community Center, Room B"');
    expect(ld).toContain('"offers":{"@type":"Offer","price":"15.00","priceCurrency":"USD"');
    expect(ld).toContain('"availability":"https://schema.org/InStock"');
    expect(ld).not.toContain("isAccessibleForFree");
  });

  it("marks a free event accessible for free, omits missing end/location, and tolerates a bad date", () => {
    const ld = buildEventJsonLd({ ...event, non_member_price_cents: 0, end_at: null, location: null, start_at: "garbage" }, "https://hcqg.org/");
    expect(ld).toContain('"isAccessibleForFree":true');
    expect(ld).not.toContain("offers");
    expect(ld).not.toContain("endDate");
    expect(ld).not.toContain("startDate");
    expect(ld).not.toContain('"location"');
  });

  it("escapes < in tenant strings", () => {
    const ld = buildEventJsonLd({ ...event, title: "</script><script>alert(1)", description: "<b>x</b>" }, "https://hcqg.org");
    expect(ld).not.toContain("</script><script>");
    expect(ld).not.toContain("<b>");
  });
});
