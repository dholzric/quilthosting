// Per-page SEO head emission. She is replacing a site with sixteen years of
// search history, so these tags are load-bearing, not decoration.

export type SeoPage = {
  title: string;
  slug: string;
  seo_title?: string | null;
  seo_description?: string | null;
  og_image_file_id?: string | null;
  noindex?: number | null;
};

export type SeoBusiness = {
  name: string;
  phone?: string;
  email?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
};

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveTitle(page: SeoPage, siteName: string): string {
  const explicit = (page.seo_title || "").trim();
  if (explicit) return explicit;
  const t = (page.title || "").trim();
  // The home page is the site; "Stitch Studio | Stitch Studio" reads as spam.
  if (!page.slug || t === siteName) return t || siteName;
  return `${t} | ${siteName}`;
}

export function resolveDescription(page: SeoPage, bodyHtml: string): string {
  const explicit = (page.seo_description || "").trim();
  if (explicit) return explicit;
  const text = stripTags(bodyHtml || "");
  if (!text) return "";
  if (text.length <= 160) return text;
  return text.slice(0, 159).trimEnd() + "…";
}

export function canonicalUrl(baseUrl: string, slug: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return slug ? `${base}/${slug}` : `${base}/`;
}

export function buildSeoHead(args: {
  page: SeoPage;
  siteName: string;
  baseUrl: string;
  bodyHtml: string;
  ogImageUrl?: string | null;
}): string {
  const { page, siteName, baseUrl, bodyHtml, ogImageUrl } = args;
  const title = resolveTitle(page, siteName);
  const description = resolveDescription(page, bodyHtml);
  const canonical = canonicalUrl(baseUrl, page.slug);

  const out: string[] = [];
  out.push(`<title>${escAttr(title)}</title>`);
  if (description) {
    out.push(`<meta name="description" content="${escAttr(description)}">`);
  }
  out.push(`<link rel="canonical" href="${escAttr(canonical)}">`);
  if (page.noindex === 1) {
    out.push(`<meta name="robots" content="noindex, nofollow">`);
  }
  out.push(`<meta property="og:type" content="website">`);
  out.push(`<meta property="og:site_name" content="${escAttr(siteName)}">`);
  out.push(`<meta property="og:title" content="${escAttr(title)}">`);
  if (description) {
    out.push(`<meta property="og:description" content="${escAttr(description)}">`);
  }
  out.push(`<meta property="og:url" content="${escAttr(canonical)}">`);
  out.push(`<meta name="twitter:card" content="summary_large_image">`);
  if (ogImageUrl) {
    out.push(`<meta property="og:image" content="${escAttr(ogImageUrl)}">`);
    out.push(`<meta name="twitter:image" content="${escAttr(ogImageUrl)}">`);
  }
  return out.join("\n");
}

export function buildLocalBusinessJsonLd(
  business: SeoBusiness,
  baseUrl: string
): string {
  const address: Record<string, string> = { "@type": "PostalAddress" };
  if (business.street) address.streetAddress = business.street;
  if (business.city) address.addressLocality = business.city;
  if (business.state) address.addressRegion = business.state;
  if (business.zip) address.postalCode = business.zip;

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: business.name,
    url: baseUrl.replace(/\/+$/, "") + "/",
  };
  if (business.phone) data.telephone = business.phone;
  if (business.email) data.email = business.email;
  if (Object.keys(address).length > 1) data.address = address;

  // JSON inside <script> must not contain a literal "</script>". Escaping the
  // "<" as < is valid JSON and inert in HTML.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}
