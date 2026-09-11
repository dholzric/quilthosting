/**
 * Block -> section normalization.
 *
 * Legacy pages store `blocks_json` (see `PageBlock` in src/lib/blocks.ts);
 * the new renderer works on sections. Every legacy block maps 1:1 onto a
 * section with `DEFAULT_STYLE`, so pages never need a data migration:
 * `sectionsFromPage` reads whichever column a row has.
 *
 * Mapping (frozen, tested in normalize.test.ts):
 *   heading        -> rich_text (prose; html = <h2>/<h3> escaped)
 *   text           -> rich_text (prose)
 *   image          -> image (single)
 *   button         -> cta
 *   divider        -> divider
 *   spacer         -> spacer
 *   html           -> embed
 *   join_cta       -> join_band (ctaLabel "Join")
 *   events_list    -> events (cards)
 *   store_list     -> store_teaser
 *   hero           -> hero (image + style.bg "image" for platform-served images, else minimal)
 *   service_cards  -> feature_grid (cards)
 *   gallery_grid   -> gallery (grid, manual)
 *   faq            -> faq
 *   testimonials   -> testimonials (grid)
 *   contact_form   -> contact
 *   project_intake -> quote_cta
 */

import { escapeHtml, parseBlocks, type PageBlock } from "../../blocks";
import { decodeEntities, sanitizeHtml } from "../../sanitize";
import { DEFAULT_STYLE, parseSections, type Section, type SectionStyle } from "./schema";

// Compile-time complete: adding a PageBlock type without listing it here fails tsc.
const LEGACY_BLOCK_TYPES: Record<PageBlock["type"], true> = {
  heading: true,
  text: true,
  image: true,
  button: true,
  divider: true,
  html: true,
  join_cta: true,
  events_list: true,
  store_list: true,
  spacer: true,
  hero: true,
  service_cards: true,
  gallery_grid: true,
  faq: true,
  testimonials: true,
  contact_form: true,
  project_intake: true,
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Decide whether one raw item should be parsed as a legacy block rather than
 * a section. Section-only markers (an object `style`, a `variant`, an `id`,
 * or section-shaped content on an overlapping type) win; otherwise a legacy
 * type name means legacy.
 */
export function isLegacyBlockItem(obj: Record<string, unknown>): boolean {
  const type = String(obj.type ?? "");
  if (!Object.prototype.hasOwnProperty.call(LEGACY_BLOCK_TYPES, type)) return false;
  if (isPlainObject(obj.style)) return false;
  if (obj.variant !== undefined || obj.id !== undefined) return false;
  if (type === "image" && Array.isArray(obj.items)) return false;
  if (type === "hero" && (Array.isArray(obj.stats) || obj.secondaryLabel !== undefined)) return false;
  return true;
}

/** true when `raw` is an array whose every item carries a `style` object (i.e. a section document). */
export function isSectionDocument(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.every((item) => isPlainObject(item) && isPlainObject(item.style));
}

/** Platform-served image URLs: `/public/:slug/img/:id` or `/img/:id` (query/hash ignored). */
const PLATFORM_IMG_RE = /^(?:\/public\/[^/?#]+)?\/img\/([A-Za-z0-9_-]{1,64})(?:[?#]|$)/;

function platformImageId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(PLATFORM_IMG_RE);
  return m ? m[1] : null;
}

const opt = (s: string | undefined): string | undefined => (s ? s : undefined);

function blockToSection(b: PageBlock, id: string): Section {
  const style: SectionStyle = { ...DEFAULT_STYLE };
  switch (b.type) {
    case "heading": {
      const tag = b.level === 3 ? "h3" : "h2";
      return { type: "rich_text", variant: "prose", html: `<${tag}>${escapeHtml(b.text)}</${tag}>`, style, id };
    }
    case "text":
      return { type: "rich_text", variant: "prose", html: sanitizeHtml(b.html), style, id };
    case "image":
      return {
        type: "image",
        variant: "single",
        items: b.url ? [{ url: b.url, alt: b.alt || "", caption: opt(b.caption) }] : [],
        style,
        id,
      };
    case "button":
      return { type: "cta", label: b.label, href: b.href, kind: b.style === "secondary" ? "secondary" : "primary", style, id };
    case "divider":
      return { type: "divider", style, id };
    case "spacer":
      return { type: "spacer", height: b.height || 24, style, id };
    case "html":
      return { type: "embed", html: b.html, style, id };
    case "join_cta":
      return { type: "join_band", title: b.title || "Become a member", body: opt(b.body), ctaLabel: "Join", style, id };
    case "events_list":
      return { type: "events", variant: "cards", limit: b.limit || 5, style, id };
    case "store_list":
      return { type: "store_teaser", limit: b.limit || 6, style, id };
    case "hero": {
      const imageId = platformImageId(b.imageUrl);
      if (imageId) {
        style.bg = "image";
        style.imageId = imageId;
      }
      return {
        type: "hero",
        variant: imageId ? "image" : "minimal",
        eyebrow: opt(b.eyebrow),
        title: b.title,
        subtitle: opt(b.subtitle),
        ctaLabel: opt(b.ctaLabel),
        ctaHref: opt(b.ctaHref),
        style,
        id,
      };
    }
    case "service_cards":
      return {
        type: "feature_grid",
        variant: "cards",
        items: b.items.map((it) => ({ icon: opt(it.icon), title: it.title, body: opt(it.body) })),
        style,
        id,
      };
    case "gallery_grid":
      return {
        type: "gallery",
        variant: "grid",
        source: "manual",
        items: b.items.map((it) => ({ url: it.url, alt: opt(it.alt), caption: opt(it.caption) })),
        style,
        id,
      };
    case "faq":
      return { type: "faq", items: b.items.map((it) => ({ q: it.q, a: it.a })), style, id };
    case "testimonials":
      return {
        type: "testimonials",
        variant: "grid",
        items: b.items.map((it) => ({ quote: it.quote, author: opt(it.author) })),
        style,
        id,
      };
    case "contact_form":
      return { type: "contact", formSlug: b.formSlug, showDetails: true, style, id };
    case "project_intake":
      return { type: "quote_cta", projectType: b.projectType, heading: opt(b.heading), submitLabel: opt(b.submitLabel), style, id };
  }
}

/** 1:1 mapping of already-parsed blocks to sections with DEFAULT_STYLE and ids `s_<index>`. */
export function blocksToSections(blocks: PageBlock[]): Section[] {
  return blocks.map((b, i) => blockToSection(b, `s_${i}`));
}

// ---------------------------------------------------------------------------
// Styled conversion ("Try the new design", src/lib/site/migrateGuild.ts)
// ---------------------------------------------------------------------------

/** Longest hero subtitle the section schema accepts. */
const HERO_SUBTITLE_MAX = 300;
/** Longest heading / hero title the section schema accepts. */
const HEADING_MAX = 160;

/** Plain text of a fragment of HTML, whitespace collapsed, cut at a word to `max`. */
function plainText(html: string, max: number): string {
  const text = decodeEntities(sanitizeHtml(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const atWord = cut.lastIndexOf(" ");
  return (atWord > max / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

export type StyledConversionOpts = {
  /** Home page: the first heading (+ text) becomes a minimal, centred hero. */
  hero?: boolean;
};

/**
 * Blocks -> sections with kit-style hints applied by position, for guilds
 * upgrading from the classic renderer:
 *   - a `heading` followed by a `text` merges into one `rich_text` with a
 *     `heading` (a lone heading becomes a heading-only rich_text);
 *   - with `hero: true`, the first heading (+ text) becomes a `hero`
 *     (`minimal`, centred) so the home page opens the way a kit does;
 *   - backgrounds alternate `none` / `tint` by content position; dividers
 *     and spacers neither count nor tint, and a section that already has a
 *     background (an image hero) keeps it.
 * Ids are `s_<index>` over the output. The result round-trips through
 * `parseSections` unchanged.
 */
export function blocksToSectionsStyled(blocks: PageBlock[], opts: StyledConversionOpts = {}): Section[] {
  const out: Section[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    const next = blocks[i + 1];
    const id = `s_${out.length}`;
    if (b.type === "heading") {
      const pairedText = next && next.type === "text" ? next : null;
      const title = b.text.trim().slice(0, HEADING_MAX);
      if (opts.hero && out.length === 0) {
        const subtitle = pairedText ? plainText(pairedText.html, HERO_SUBTITLE_MAX) : "";
        out.push({
          type: "hero",
          variant: "minimal",
          title,
          subtitle: subtitle || undefined,
          style: { ...DEFAULT_STYLE, align: "center" },
          id,
        });
      } else {
        out.push({
          type: "rich_text",
          variant: "prose",
          heading: title,
          html: pairedText ? sanitizeHtml(pairedText.html) : "",
          style: { ...DEFAULT_STYLE },
          id,
        });
      }
      i += pairedText ? 2 : 1;
      continue;
    }
    out.push(blockToSection(b, id));
    i += 1;
  }
  let position = 0;
  for (const s of out) {
    if (s.type === "divider" || s.type === "spacer") continue;
    if (s.style.bg === "none" && position % 2 === 1) s.style.bg = "tint";
    position += 1;
  }
  return out;
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Sections for a page row: `sections_json` (new format, or a block array
 * stored there), then `blocks_json`, then the pre-block `content_json.html`
 * as one prose `rich_text`. Never throws.
 */
export function sectionsFromPage(row: {
  blocks_json?: string | null;
  sections_json?: string | null;
  content_json?: string | null;
}): Section[] {
  const fromSections = parseJson(row.sections_json);
  if (Array.isArray(fromSections)) {
    const { sections } = parseSections(fromSections);
    if (sections.length) return sections;
  }
  const fromBlocks = parseJson(row.blocks_json);
  if (Array.isArray(fromBlocks)) {
    // Despite the historical column name, new pages store native sections
    // here. parseSections also accepts legacy blocks, so it preserves both
    // formats without flattening a native section through parseBlocks.
    const { sections } = parseSections(fromBlocks);
    if (sections.length) return sections;
  }
  const content = parseJson(row.content_json);
  const raw = isPlainObject(content) && typeof content.html === "string" ? content.html : "";
  if (!raw.trim()) return [];
  // Pre-block pages could carry an allowlisted YouTube/Vimeo/Maps iframe in
  // raw HTML (contentFromPage sanitized them with allowEmbeds). Keep those as
  // an `embed` section so migration never drops a working embed.
  const withEmbeds = sanitizeHtml(raw, { allowEmbeds: true });
  if (withEmbeds.toLowerCase().includes("<iframe")) {
    return [{ type: "embed", html: withEmbeds, style: { ...DEFAULT_STYLE }, id: "s_0" }];
  }
  const html = sanitizeHtml(raw);
  if (!html) return [];
  return [{ type: "rich_text", variant: "prose", html, style: { ...DEFAULT_STYLE }, id: "s_0" }];
}
