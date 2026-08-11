/** Simple block-based page content for the website builder. */

export type PageBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; html: string }
  | { type: "image"; url: string; alt?: string; caption?: string }
  | { type: "button"; label: string; href: string; style?: "primary" | "secondary" }
  | { type: "divider" }
  | { type: "html"; html: string }
  | { type: "join_cta"; title?: string; body?: string }
  | { type: "events_list"; limit?: number }
  | { type: "store_list"; limit?: number }
  | { type: "spacer"; height?: number }
  | { type: "hero"; eyebrow?: string; title: string; subtitle?: string; imageUrl?: string; ctaLabel?: string; ctaHref?: string }
  | { type: "service_cards"; items: { icon?: string; title: string; body?: string }[] }
  | { type: "gallery_grid"; items: { url: string; alt?: string; caption?: string }[] }
  | { type: "faq"; items: { q: string; a: string }[] }
  | { type: "testimonials"; items: { quote: string; author?: string }[] }
  | { type: "contact_form"; formSlug: string; submitLabel?: string };

export type SiteTheme = {
  primary?: string;
  accent?: string;
  font?: "system" | "serif" | "rounded";
  style?: "classic" | "modern" | "warm";
  headerBg?: string;
};

export type NavItem = {
  label: string;
  href: string;
  external?: boolean;
};

export function parseBlocks(raw: unknown): PageBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: PageBlock[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const type = String(b.type || "");
    switch (type) {
      case "heading":
        out.push({
          type: "heading",
          text: String(b.text || "").slice(0, 200),
          level: ([1, 2, 3].includes(Number(b.level)) ? Number(b.level) : 2) as 1 | 2 | 3,
        });
        break;
      case "text":
        out.push({ type: "text", html: String(b.html || b.text || "").slice(0, 20000) });
        break;
      case "image":
        out.push({
          type: "image",
          url: String(b.url || "").slice(0, 2000),
          alt: String(b.alt || "").slice(0, 200),
          caption: String(b.caption || "").slice(0, 300),
        });
        break;
      case "button":
        out.push({
          type: "button",
          label: String(b.label || "Learn more").slice(0, 80),
          href: String(b.href || "#").slice(0, 2000),
          style: b.style === "secondary" ? "secondary" : "primary",
        });
        break;
      case "divider":
        out.push({ type: "divider" });
        break;
      case "html":
        out.push({ type: "html", html: String(b.html || "").slice(0, 50000) });
        break;
      case "join_cta":
        out.push({
          type: "join_cta",
          title: String(b.title || "Become a member").slice(0, 120),
          body: String(b.body || "").slice(0, 500),
        });
        break;
      case "events_list":
        out.push({ type: "events_list", limit: Math.min(20, Math.max(1, Number(b.limit) || 5)) });
        break;
      case "store_list":
        out.push({ type: "store_list", limit: Math.min(20, Math.max(1, Number(b.limit) || 6)) });
        break;
      case "spacer":
        out.push({ type: "spacer", height: Math.min(120, Math.max(8, Number(b.height) || 24)) });
        break;
      case "hero":
        out.push({
          type: "hero",
          eyebrow: String(b.eyebrow || "").slice(0, 80),
          title: String(b.title || "").slice(0, 160),
          subtitle: String(b.subtitle || "").slice(0, 300),
          imageUrl: String(b.imageUrl || "").slice(0, 2000),
          ctaLabel: String(b.ctaLabel || "").slice(0, 60),
          ctaHref: String(b.ctaHref || "").slice(0, 2000),
        });
        break;
      case "service_cards":
        out.push({
          type: "service_cards",
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 12).map((raw) => {
            const it = (raw || {}) as Record<string, unknown>;
            return {
              icon: String(it.icon || "").slice(0, 8),
              title: String(it.title || "").slice(0, 120),
              body: String(it.body || "").slice(0, 600),
            };
          }),
        });
        break;
      case "gallery_grid":
        out.push({
          type: "gallery_grid",
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 40).map((raw) => {
            const it = (raw || {}) as Record<string, unknown>;
            return {
              url: String(it.url || "").slice(0, 2000),
              alt: String(it.alt || "").slice(0, 200),
              caption: String(it.caption || "").slice(0, 300),
            };
          }).filter((it) => it.url),
        });
        break;
      case "faq":
        out.push({
          type: "faq",
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 30).map((raw) => {
            const it = (raw || {}) as Record<string, unknown>;
            return { q: String(it.q || "").slice(0, 300), a: String(it.a || "").slice(0, 2000) };
          }).filter((it) => it.q),
        });
        break;
      case "testimonials":
        out.push({
          type: "testimonials",
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 20).map((raw) => {
            const it = (raw || {}) as Record<string, unknown>;
            return { quote: String(it.quote || "").slice(0, 800), author: String(it.author || "").slice(0, 120) };
          }).filter((it) => it.quote),
        });
        break;
      case "contact_form":
        out.push({
          type: "contact_form",
          formSlug: String(b.formSlug || "contact").slice(0, 100),
          submitLabel: String(b.submitLabel || "Send").slice(0, 60),
        });
        break;
      default:
        break;
    }
    if (out.length >= 80) break;
  }
  return out;
}

/** Render blocks to safe-ish HTML (admin-authored). */
export function blocksToHtml(blocks: PageBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading": {
        const tag = `h${b.level || 2}`;
        parts.push(`<${tag} class="qh-block-heading">${escapeHtml(b.text)}</${tag}>`);
        break;
      }
      case "text":
        parts.push(`<div class="qh-block-text">${b.html}</div>`);
        break;
      case "image":
        if (!b.url) break;
        parts.push(
          `<figure class="qh-block-image"><img src="${escapeAttr(b.url)}" alt="${escapeAttr(b.alt || "")}" loading="lazy" />${
            b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ""
          }</figure>`
        );
        break;
      case "button":
        parts.push(
          `<p class="qh-block-button"><a class="btn ${b.style === "secondary" ? "secondary" : ""}" href="${escapeAttr(safeHref(b.href))}">${escapeHtml(b.label)}</a></p>`
        );
        break;
      case "divider":
        parts.push(`<hr class="qh-block-divider" />`);
        break;
      case "html":
        parts.push(`<div class="qh-block-html">${b.html}</div>`);
        break;
      case "join_cta":
        parts.push(
          `<div class="qh-block-cta card"><h3>${escapeHtml(b.title || "Become a member")}</h3>${
            b.body ? `<p>${escapeHtml(b.body)}</p>` : ""
          }<p class="muted">See membership levels above to join.</p></div>`
        );
        break;
      case "events_list":
        parts.push(`<div class="qh-block-events" data-limit="${b.limit || 5}"><!-- events --></div>`);
        break;
      case "store_list":
        parts.push(`<div class="qh-block-store" data-limit="${b.limit || 6}"><!-- store --></div>`);
        break;
      case "spacer":
        parts.push(`<div class="qh-block-spacer" style="height:${b.height || 24}px"></div>`);
        break;
      case "hero": {
        const heroImageOk = !!b.imageUrl && safeHref(b.imageUrl) !== "#" && isCssUrlSafe(b.imageUrl);
        parts.push(
          `<section class="qh-block-hero"${
            heroImageOk ? ` style="background-image:url('${escapeAttr(b.imageUrl as string)}')"` : ""
          }><div class="qh-hero-inner">${
            b.eyebrow ? `<p class="qh-hero-eyebrow">${escapeHtml(b.eyebrow)}</p>` : ""
          }<h1 class="qh-hero-title">${escapeHtml(b.title)}</h1>${
            b.subtitle ? `<p class="qh-hero-sub">${escapeHtml(b.subtitle)}</p>` : ""
          }${
            b.ctaLabel && b.ctaHref
              ? `<p class="qh-hero-cta"><a class="btn" href="${escapeAttr(safeHref(b.ctaHref))}">${escapeHtml(b.ctaLabel)}</a></p>`
              : ""
          }</div></section>`
        );
        break;
      }
      case "service_cards":
        parts.push(
          `<div class="qh-block-services">${b.items
            .map(
              (it) =>
                `<div class="qh-service-card card">${
                  it.icon ? `<div class="qh-service-icon">${escapeHtml(it.icon)}</div>` : ""
                }<h3>${escapeHtml(it.title)}</h3>${
                  it.body ? `<p>${escapeHtml(it.body)}</p>` : ""
                }</div>`
            )
            .join("")}</div>`
        );
        break;
      case "gallery_grid":
        parts.push(
          `<div class="qh-block-gallery">${b.items
            .map(
              (it) =>
                `<figure class="qh-gallery-item"><img src="${escapeAttr(it.url)}" alt="${escapeAttr(
                  it.alt || ""
                )}" loading="lazy" />${
                  it.caption ? `<figcaption>${escapeHtml(it.caption)}</figcaption>` : ""
                }</figure>`
            )
            .join("")}</div>`
        );
        break;
      case "faq":
        parts.push(
          `<div class="qh-block-faq">${b.items
            .map(
              (it) =>
                `<details class="qh-faq-item"><summary>${escapeHtml(it.q)}</summary><div>${escapeHtml(
                  it.a
                )}</div></details>`
            )
            .join("")}</div>`
        );
        break;
      case "testimonials":
        parts.push(
          `<div class="qh-block-testimonials">${b.items
            .map(
              (it) =>
                `<blockquote class="qh-testimonial"><p>${escapeHtml(it.quote)}</p>${
                  it.author ? `<cite>${escapeHtml(it.author)}</cite>` : ""
                }</blockquote>`
            )
            .join("")}</div>`
        );
        break;
      case "contact_form":
        // Hydrated client-side against POST /public/:slug/forms/:formSlug,
        // the same endpoint the existing public form pages use.
        parts.push(
          `<div class="qh-block-contact-form" data-form-slug="${escapeAttr(
            b.formSlug
          )}" data-submit-label="${escapeAttr(b.submitLabel || "Send")}"></div>`
        );
        break;
    }
  }
  return parts.join("\n");
}

export function contentFromPage(row: {
  content_json?: string | null;
  blocks_json?: string | null;
}): { html: string; blocks: PageBlock[] } {
  let blocks: PageBlock[] = [];
  if (row.blocks_json) {
    try {
      blocks = parseBlocks(JSON.parse(row.blocks_json));
    } catch {
      blocks = [];
    }
  }
  if (blocks.length) {
    return { html: blocksToHtml(blocks), blocks };
  }
  try {
    const c = JSON.parse(row.content_json || "{}");
    return { html: String(c.html || ""), blocks: [] };
  } catch {
    return { html: "", blocks: [] };
  }
}

export function parseTheme(settingsJson: string | null | undefined): SiteTheme {
  try {
    const s = JSON.parse(settingsJson || "{}");
    return (s.theme || {}) as SiteTheme;
  } catch {
    return {};
  }
}

export function parseNav(settingsJson: string | null | undefined): NavItem[] {
  try {
    const s = JSON.parse(settingsJson || "{}");
    const nav = s.nav;
    if (!Array.isArray(nav)) return [];
    return nav
      .map((n: any) => ({
        label: String(n.label || "").slice(0, 60),
        href: String(n.href || "").slice(0, 500),
        external: !!n.external,
      }))
      .filter((n: NavItem) => n.label && n.href)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

/** Schemes allowed through {@link safeHref}. Allowlist, never blocklist a dangerous scheme. */
const SAFE_HREF_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Removes ASCII control characters (defeats `java\tscript:`-style scheme obfuscation). */
function stripControlChars(input: string): string {
  const s = String(input || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 31 && code !== 127) out += s[i];
  }
  return out;
}

/**
 * Neutralizes script-executing href values (e.g. `javascript:`) before they reach an
 * `href`/CSS-url attribute. Strips control characters (defeats `java\tscript:`-style
 * obfuscation) and trims whitespace before matching a leading scheme case-insensitively
 * (defeats `JaVaScRiPt:`). Root-relative (`/...`), anchor (`#...`), and scheme-less
 * relative values are passed through untouched. Anything else — including any scheme
 * not on the allowlist — collapses to `"#"`. Does not perform attribute/HTML escaping;
 * callers should still route the result through `escapeAttr`.
 */
function safeHref(raw: string): string {
  const cleaned = stripControlChars(raw).trim();
  if (!cleaned) return "#";
  if (cleaned.startsWith("/") || cleaned.startsWith("#")) return cleaned;
  const schemeMatch = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase() + ":";
    return SAFE_HREF_SCHEMES.has(scheme) ? cleaned : "#";
  }
  // No scheme at all -- scheme-less relative path, safe to pass through.
  return cleaned;
}

/** CSS-injection guard for values interpolated into a `'`-delimited `url(...)` declaration. */
function isCssUrlSafe(raw: string): boolean {
  return !/['"();\\\s]/.test(raw);
}

/** Blocks offered in the admin picker for business tenants. */
export const BUSINESS_BLOCK_TYPES = [
  "hero", "heading", "text", "image", "gallery_grid", "service_cards",
  "faq", "testimonials", "contact_form", "button", "events_list",
  "store_list", "divider", "spacer", "html",
];

/** Blocks that only make sense for a membership organisation. */
export const GUILD_ONLY_BLOCK_TYPES = ["join_cta"];
