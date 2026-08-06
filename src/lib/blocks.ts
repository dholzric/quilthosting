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
  | { type: "spacer"; height?: number };

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
          `<p class="qh-block-button"><a class="btn ${b.style === "secondary" ? "secondary" : ""}" href="${escapeAttr(b.href)}">${escapeHtml(b.label)}</a></p>`
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
