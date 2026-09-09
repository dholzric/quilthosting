/**
 * Section renderers for the server-rendered tenant site.
 *
 * One function per section type; `renderSection` dispatches on `type` and
 * `renderSections` renders a stack. Every renderer returns a complete
 * `<section id class="qh-s …">` produced by `sectionWrapper`, so the
 * stylesheet's wrapper classes (`.qh-s--bg-*`, `.qh-s--w-*`, `.qh-s--sp-*`,
 * `.qh-s--align-center`, `.qh-s--media-*`) and the per-type class
 * (`.qh-hero.qh-hero--split`, `.qh-events.qh-events--list`, …) always land
 * on the same element.
 *
 * Safety: every tenant string goes through `escapeHtml`; rich HTML fields are
 * sanitized again here even though `parseSections` already did (defense in
 * depth, same as `blocksToHtml`); URLs go through `sanitizeUrl`; image ids
 * become URLs only via `ctx.imgUrl`. Inline `style` attributes are built from
 * numbers and percent-encoded URLs and then attribute-escaped.
 *
 * Island hooks (bound by public/qh-site.js): `[data-join=levelId]`,
 * `[data-register=eventId]`, `[data-buy=productId]`, `[data-add=productId]`,
 * `[data-donate=cents]`, `a[data-lightbox]`, `.qh-events--calendar[data-month]`,
 * and the legacy placeholders `.qh-block-contact-form[data-form-slug]` and
 * `.qh-block-project-intake[data-project-type]`.
 */

import { escapeHtml } from "../../blocks";
import { sanitizeHtml, sanitizeUrl } from "../../sanitize";
import { formatMoney } from "../../utils/money";
import { deriveRoles, designGround, isDarkDesign } from "../design/tokens";
import type { Roles, SiteDesign } from "../design/tokens";
import { patternDataUri, PATTERN_IDS } from "../design/patterns";
import {
  srcsetFor,
  sizesFor,
  focalToObjectPosition,
  VARIANT_WIDTHS,
  type ImageSizeKind,
} from "../../images";
import type { PatternId } from "../design/patterns";
import type { SiteData, SiteDocument, SiteEvent, SiteLevel, SitePost, SiteProduct } from "../data.types";
import { DEFAULT_STYLE } from "./schema";
import type { Section, SectionStyle } from "./schema";

/** What the renderer knows about a stored image (from serveSite's batch). */
export type ImgMeta = { w?: number | null; h?: number | null; focal?: [number, number] };

export type RenderContext = {
  slug: string;
  /** "" or "/g/<slug>" on the platform host, "https://host" on tenant hosts. Internal links are `${baseUrl}/path`. */
  baseUrl: string;
  design: SiteDesign;
  /** Dynamic data for events/levels/store/blog/gallery sections; may be empty. */
  data: SiteData;
  /** Turns a files.id into an image URL; provided by the caller, never computed here. */
  imgUrl: (fileId: string, w?: number) => string;
  /**
   * The guild's IANA time zone (`settings.timezone`). Event times are stored
   * as UTC — the admin converts the officer's local entry with toISOString()
   * — so a page that prints the stored digits shows the wrong hour to
   * everyone. Absent means UTC, which is only right for a guild that has not
   * said otherwise.
   */
  timeZone?: string;
  /**
   * Intrinsic size and focal point of an uploaded image, when the caller
   * looked them up. Absent for previews and for files uploaded before the
   * variant pipeline; `srcset` is emitted either way (a file with no stored
   * variants simply serves its original for every width).
   */
  imgMeta?: (fileId: string) => ImgMeta | undefined;
};

type Sec<T extends Section["type"]> = Extract<Section, { type: T }>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const esc = escapeHtml;

/** Root-relative hrefs are prefixed with the base URL so `/g/:slug` hosts resolve them. */
function href(raw: string | undefined, ctx: RenderContext): string {
  const clean = raw ? sanitizeUrl(raw, "link") : null;
  if (!clean) return "#";
  if (clean.startsWith("/") && !clean.startsWith("//")) return esc(base(ctx) + clean);
  return esc(clean);
}

function base(ctx: RenderContext): string {
  return (ctx.baseUrl || "").replace(/\/+$/, "");
}

function internal(path: string, ctx: RenderContext): string {
  return esc(base(ctx) + path);
}

/** Percent-encode the characters that could break out of a CSS url("…") or the style attribute. */
function cssUrl(url: string): string {
  const encoded = url.replace(/["'()\\<>\s;{}]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `url("${encoded}")`;
}

function pct(n: number | undefined, fallback = 0.5): string {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
  return `${Math.round(v * 100)}%`;
}

const rolesCache = new WeakMap<SiteDesign, Roles>();
function rolesFor(design: SiteDesign): Roles {
  let r = rolesCache.get(design);
  if (!r) {
    r = deriveRoles(design.palette.input, isDarkDesign(design), designGround(design));
    rolesCache.set(design, r);
  }
  return r;
}

function patternFor(ctx: RenderContext): string {
  const id: PatternId = ctx.design.pattern?.id && ctx.design.pattern.id !== "none" ? ctx.design.pattern.id : "nine-patch";
  const r = rolesFor(ctx.design);
  return patternDataUri(id, { a: r.primary, b: r.dark, c: r.accent });
}

type ImgOpts = { eager?: boolean; cls?: string; width?: number; height?: number };

function img(src: string, alt: string, opts: ImgOpts = {}): string {
  const parts = [`<img src="${esc(src)}" alt="${esc(alt)}"`];
  if (opts.cls) parts.push(` class="${opts.cls}"`);
  if (opts.width && opts.height) parts.push(` width="${opts.width}" height="${opts.height}"`);
  if (opts.eager) parts.push(` fetchpriority="high"`);
  else parts.push(` loading="lazy" decoding="async"`);
  return parts.join("") + ">";
}

/**
 * An uploaded image with responsive sources: `srcset` over the stored
 * variant widths, `sizes` for how the slot is laid out, `object-position`
 * from the file's focal point (or the section's), and intrinsic
 * width/height so the browser reserves the right box (no layout shift).
 */
function uploadedImg(
  fileId: string,
  alt: string,
  ctx: RenderContext,
  kind: ImageSizeKind,
  baseW: number,
  opts: ImgOpts = {},
  focalOverride?: [number, number]
): string {
  const meta = ctx.imgMeta?.(fileId);
  const focal = focalOverride ?? meta?.focal;
  const attrs: string[] = [];
  const srcset = srcsetFor((w) => ctx.imgUrl(fileId, w), [...VARIANT_WIDTHS].filter((w) => w <= 1600));
  if (srcset) attrs.push(` srcset="${esc(srcset)}" sizes="${esc(sizesFor(kind))}"`);
  if (focal) attrs.push(` style="object-position:${esc(focalToObjectPosition(focal))}"`);
  const size =
    meta && typeof meta.w === "number" && meta.w > 0 && typeof meta.h === "number" && meta.h > 0
      ? { width: meta.w, height: meta.h }
      : {};
  const tag = img(ctx.imgUrl(fileId, baseW), alt, { ...opts, ...size });
  return attrs.length ? tag.slice(0, -1) + attrs.join("") + ">" : tag;
}

/**
 * Kits reference generated quilt-block art as `imageId: "pattern:<id>"`
 * (see kits/apply.ts). Those never resolve to a file; they render as a tile
 * of pattern art in the tenant's own colors.
 */
export function isPatternRef(imageId: string | undefined): boolean {
  return typeof imageId === "string" && imageId.startsWith("pattern:");
}
function patternRefUri(imageId: string, ctx: RenderContext): string {
  const raw = imageId.slice("pattern:".length);
  const id = (PATTERN_IDS as readonly string[]).includes(raw) && raw !== "none"
    ? (raw as PatternId)
    : ctx.design.pattern.id !== "none" ? ctx.design.pattern.id : "nine-patch";
  const r = deriveRoles(ctx.design.palette.input, isDarkDesign(ctx.design), designGround(ctx.design));
  return patternDataUri(id, { a: r.primary, b: r.dark, c: r.accent });
}
function patternMedia(imageId: string, ctx: RenderContext, extra = ""): string {
  return `<div class="qh-media qh-media--pattern${extra}" role="img" aria-label="" style="${esc("background-image:" + patternRefUri(imageId, ctx))}"></div>`;
}

/** Resolve a media item to a URL: `imageId` via ctx.imgUrl, else a sanitized legacy `url`. */
/**
 * Renders a media item as an <img>: uploaded files get srcset/sizes/focal
 * via uploadedImg, legacy `url` items stay a plain tag.
 */
function mediaImg(
  item: { imageId?: string; url?: string; alt?: string },
  ctx: RenderContext,
  kind: ImageSizeKind,
  w: number,
  opts: ImgOpts = {}
): string | null {
  if (item.imageId && !isPatternRef(item.imageId)) {
    return uploadedImg(item.imageId, item.alt ?? "", ctx, kind, w, opts);
  }
  const src = mediaSrc(item, ctx, w);
  return src ? img(src, item.alt ?? "", opts) : null;
}

function mediaSrc(item: { imageId?: string; url?: string }, ctx: RenderContext, w: number): string | null {
  if (isPatternRef(item.imageId)) return null;
  if (item.imageId) return ctx.imgUrl(item.imageId, w);
  if (item.url) return sanitizeUrl(item.url, "image");
  return null;
}

function heading(text: string | undefined): string {
  return text ? `<h2 class="qh-s__heading">${esc(text)}</h2>` : "";
}

function empty(sentence: string): string {
  return `<div class="qh-empty">${esc(sentence)}</div>`;
}

function btn(kind: "primary" | "secondary" | "ghost", label: string, attrs: string): string {
  return `<button class="qh-btn qh-btn--${kind}" ${attrs}>${esc(label)}</button>`;
}

function linkBtn(kind: "primary" | "secondary" | "ghost", label: string, url: string): string {
  return `<a class="qh-btn qh-btn--${kind}" href="${url}">${esc(label)}</a>`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

type Wall = { y: number; m: number; d: number; hh: number | null; mm: number };

/**
 * Read the wall-clock components straight out of the ISO string. No time
 * zone is applied: the Worker has no idea where the guild is, and event
 * times are entered as local wall time by the admin, so "09:00" renders as
 * 9:00 AM whether the string ends in "Z", an offset, or nothing at all.
 * The weekday comes from `Date.UTC` on those same components, which is
 * time-zone free.
 */
function wallTime(iso: string): Wall | null {
  const m = ISO_RE.exec(iso ?? "");
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d, hh: m[4] !== undefined ? +m[4] : null, mm: m[5] !== undefined ? +m[5] : 0 };
}

function weekday(w: Wall): string {
  return DOW[new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay()];
}

function clock(w: Wall): string {
  if (w.hh === null) return "";
  const h12 = w.hh % 12 || 12;
  return `${h12}:${String(w.mm).padStart(2, "0")} ${w.hh < 12 ? "AM" : "PM"}`;
}

/** A timestamp that names its offset ("…Z" or "…+02:00") — a real instant. */
const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * "Sat, Sep 12 · 9:00 AM" (or "Sat, Sep 12" without a time). Unparseable
 * input is returned as-is.
 *
 * A timestamp that carries a zone is a real instant and is converted into
 * `timeZone` (the guild's). One without a zone is already a wall-clock time —
 * that is what a kit's sample data and a naive import contain — and its
 * digits are used as they stand. Getting this wrong published an event five
 * hours late: the admin stores UTC, and printing those digits made 12:25 PM
 * read as 5:25 PM.
 */
export function formatEventDate(iso: string, timeZone?: string): string {
  if (timeZone && HAS_ZONE_RE.test(String(iso ?? "").trim())) {
    const zoned = zonedParts(iso, timeZone);
    if (zoned) return zoned;
  }
  const w = wallTime(iso);
  if (!w) return iso;
  const day = `${weekday(w)}, ${MON[w.m - 1]} ${w.d}`;
  const t = clock(w);
  return t ? `${day} · ${t}` : day;
}

/** The same shape as the wall-time path, formatted in `timeZone`. */
function zonedParts(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone }).format(d);
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(d);
    return `${day} · ${time}`;
  } catch {
    return null; // an unknown zone falls back to the wall-clock reading
  }
}

/** "Sep 1, 2026" for blog post dates. */
export function formatPostDate(iso: string): string {
  const w = wallTime(iso);
  if (!w) return iso;
  return `${MON[w.m - 1]} ${w.d}, ${w.y}`;
}

function monthOf(iso: string | undefined): string {
  const w = iso ? wallTime(iso) : null;
  return w ? `${w.y}-${String(w.m).padStart(2, "0")}` : "";
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

type WrapOpts = {
  extraClass?: string;
  /** Extra attributes, already escaped, e.g. `data-month="2026-09"`. */
  attrs?: string;
  /** Extra inline declarations, already safe (numbers / cssUrl output). */
  decls?: string[];
  ctx?: RenderContext;
};

function styleOf(s: Section): SectionStyle {
  return (s.style ?? DEFAULT_STYLE) as SectionStyle;
}

function wrap(s: Section, inner: string, opts: WrapOpts = {}): string {
  const st = styleOf(s);
  const classes = ["qh-s", `qh-s--bg-${st.bg}`, `qh-s--w-${st.width}`, `qh-s--sp-${st.spacing}`];
  if (st.align === "center") classes.push("qh-s--align-center");
  classes.push(`qh-s--media-${st.media}`);
  if (opts.extraClass) classes.push(opts.extraClass);

  const decls: string[] = [];
  const isHero = s.type === "hero";
  const wantsImage = st.bg === "image" || (isHero && s.variant === "image");
  const wantsPattern = st.bg === "pattern" || (isHero && s.variant === "pattern");
  if (opts.ctx && wantsImage && st.imageId && !isPatternRef(st.imageId)) {
    decls.push(`--qh-s-image:${cssUrl(opts.ctx.imgUrl(st.imageId, 1600))}`);
    const [fx, fy] = st.imageFocal ?? [0.5, 0.5];
    decls.push(`--qh-s-focal:${pct(fx)} ${pct(fy)}`);
  }
  if (opts.ctx && wantsPattern) {
    decls.push(`--qh-s-pattern:${patternFor(opts.ctx)}`);
  }
  if (opts.decls) decls.push(...opts.decls);

  const attrs = [`id="${esc(s.id)}"`, `class="${classes.join(" ")}"`];
  if (decls.length) attrs.push(`style="${esc(decls.join(";"))}"`);
  if (opts.attrs) attrs.push(opts.attrs);
  return `<section ${attrs.join(" ")}>${inner}</section>`;
}

/**
 * `<section id class="qh-s …" style="…">inner</section>`. Pass `ctx` to get
 * the `--qh-s-image` / `--qh-s-focal` / `--qh-s-pattern` declarations for
 * `bg: "image"` and `bg: "pattern"`; without it only the classes are emitted.
 */
export function sectionWrapper(s: Section, inner: string, extraClass?: string, ctx?: RenderContext): string {
  return wrap(s, inner, { extraClass, ctx });
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

type Opts = { eagerHero: boolean };

function renderHero(s: Sec<"hero">, ctx: RenderContext, opts: Opts): string {
  const st = styleOf(s);
  const body: string[] = [];
  if (s.eyebrow) body.push(`<p class="qh-eyebrow">${esc(s.eyebrow)}</p>`);
  body.push(`<h1 class="qh-hero__title">${esc(s.title)}</h1>`);
  if (s.subtitle) body.push(`<p class="qh-hero__sub">${esc(s.subtitle)}</p>`);
  const actions: string[] = [];
  if (s.ctaLabel) actions.push(linkBtn("primary", s.ctaLabel, href(s.ctaHref, ctx)));
  if (s.secondaryLabel) actions.push(linkBtn("secondary", s.secondaryLabel, href(s.secondaryHref, ctx)));
  if (actions.length) body.push(`<div class="qh-hero__actions">${actions.join("")}</div>`);
  if (s.variant === "stats" && s.stats?.length) {
    body.push(
      `<div class="qh-hero__stats">${s.stats
        .map((x) => `<div class="qh-stat"><span class="qh-stat__value">${esc(x.value)}</span><span class="qh-stat__label">${esc(x.label)}</span></div>`)
        .join("")}</div>`
    );
  }

  const parts: string[] = [];
  if (s.variant === "image" && st.imageId && !isPatternRef(st.imageId)) {
    parts.push(uploadedImg(st.imageId, "", ctx, "hero", 1600, { cls: "qh-hero__media", eager: opts.eagerHero }, st.imageFocal));
  }
  parts.push(`<div class="qh-hero__body">${body.join("")}</div>`);
  if (s.variant === "split" && st.imageId) {
    parts.push(
      isPatternRef(st.imageId)
        ? patternMedia(st.imageId, ctx, " qh-hero__media")
        : `<div class="qh-media qh-hero__media">${uploadedImg(st.imageId, "", ctx, "split", 1200, { eager: opts.eagerHero }, st.imageFocal)}</div>`
    );
  }
  return wrap(s, parts.join(""), { extraClass: `qh-hero qh-hero--${s.variant}`, ctx });
}

function renderRichText(s: Sec<"rich_text">, ctx: RenderContext): string {
  const st = styleOf(s);
  const html = sanitizeHtml(s.html ?? "");
  const cls = `qh-rich qh-rich--${s.variant}`;
  if (s.variant === "with_image" && st.imageId) {
    // The section itself is the grid, so the heading lives inside the body cell.
    const body = `<div class="qh-rich__body">${heading(s.heading)}${html}</div>`;
    const media = isPatternRef(st.imageId)
      ? patternMedia(st.imageId, ctx)
      : `<div class="qh-media">${uploadedImg(st.imageId, "", ctx, "split", 1200, {}, st.imageFocal)}</div>`;
    return wrap(s, body + media, { extraClass: cls, ctx });
  }
  return wrap(s, `${heading(s.heading)}<div class="qh-rich__body">${html}</div>`, { extraClass: cls, ctx });
}

function renderImage(s: Sec<"image">, ctx: RenderContext): string {
  const w = s.variant === "full_bleed" ? 2000 : s.variant === "duo" ? 900 : 1400;
  const figures = (s.items ?? [])
    .map((it) => {
      const tag = mediaImg(it, ctx, s.variant === "duo" ? "grid" : "single", w);
      if (!tag) return "";
      const cap = it.caption ? `<figcaption>${esc(it.caption)}</figcaption>` : "";
      return `<figure>${tag}${cap}</figure>`;
    })
    .filter(Boolean);
  const inner = figures.length
    ? s.variant === "duo"
      ? `<div class="qh-image__items">${figures.join("")}</div>`
      : figures.join("")
    : empty("No image has been added here yet.");
  return wrap(s, inner, { extraClass: `qh-image qh-image--${s.variant}`, ctx });
}

function renderFeatureGrid(s: Sec<"feature_grid">, ctx: RenderContext): string {
  const items = (s.items ?? []).map((it) => {
    const title = it.href ? `<a href="${href(it.href, ctx)}">${esc(it.title)}</a>` : esc(it.title);
    return (
      `<div class="qh-feature">` +
      (it.icon ? `<div class="qh-feature__icon">${esc(it.icon)}</div>` : "") +
      `<h3>${title}</h3>` +
      (it.body ? `<p>${esc(it.body)}</p>` : "") +
      (it.price ? `<span class="qh-feature__price">${esc(it.price)}</span>` : "") +
      `</div>`
    );
  });
  const inner = heading(s.heading) + (items.length ? `<div class="qh-grid">${items.join("")}</div>` : empty("Nothing has been listed here yet."));
  return wrap(s, inner, { extraClass: `qh-features qh-features--${s.variant}`, ctx });
}

function renderFaq(s: Sec<"faq">, ctx: RenderContext): string {
  const items = (s.items ?? []).map(
    (it) => `<details class="qh-faq__item"><summary>${esc(it.q)}</summary><div>${sanitizeHtml(it.a ?? "")}</div></details>`
  );
  const inner = heading(s.heading) + (items.length ? `<div class="qh-faq__list">${items.join("")}</div>` : empty("No questions have been added yet."));
  return wrap(s, inner, { extraClass: "qh-faq", ctx });
}

function renderTestimonials(s: Sec<"testimonials">, ctx: RenderContext): string {
  const list = s.variant === "single" ? (s.items ?? []).slice(0, 1) : s.items ?? [];
  const quotes = list.map(
    (it) => `<blockquote class="qh-testimonial"><p>${esc(it.quote)}</p>${it.author ? `<cite>${esc(it.author)}</cite>` : ""}</blockquote>`
  );
  const inner = quotes.length
    ? s.variant === "grid"
      ? `<div class="qh-grid">${quotes.join("")}</div>`
      : quotes.join("")
    : empty("No testimonials have been added yet.");
  return wrap(s, inner, { extraClass: `qh-testimonials qh-testimonials--${s.variant}`, ctx });
}

function renderGallery(s: Sec<"gallery">, ctx: RenderContext): string {
  type Photo = { tag: string; full: string; alt: string; caption?: string };
  const photos: Photo[] = [];
  if (s.source === "gallery") {
    const g = ctx.data.gallery;
    if (g && (!s.gallerySlug || g.slug === s.gallerySlug)) {
      for (const p of g.photos ?? []) {
        photos.push({
          tag: uploadedImg(p.id, p.caption ?? "", ctx, "grid", 480),
          full: ctx.imgUrl(p.id, 1600),
          alt: p.caption ?? "",
          caption: p.caption ?? undefined,
        });
      }
    }
  } else {
    for (const it of s.items ?? []) {
      const tag = mediaImg(it, ctx, "grid", 480);
      const full = mediaSrc(it, ctx, 1600);
      if (!tag || !full) continue;
      photos.push({ tag, full, alt: it.alt ?? "", caption: it.caption });
    }
  }
  const figures = photos.map(
    (p) =>
      `<figure class="qh-gallery__item"><a data-lightbox href="${esc(p.full)}">${p.tag}</a>` +
      (p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : "") +
      `</figure>`
  );
  const listCls = s.variant === "grid" ? "qh-gallery__items qh-grid" : "qh-gallery__items";
  const inner = figures.length ? `<div class="${listCls}">${figures.join("")}</div>` : empty("No photos have been added yet.");
  return wrap(s, inner, { extraClass: `qh-gallery qh-gallery--${s.variant}`, ctx });
}

function priceLine(ev: SiteEvent): string {
  const m = ev.member_price_cents || 0;
  const n = ev.non_member_price_cents || 0;
  if (!m && !n) return "Free";
  if (m === n) return formatMoney(m);
  return `Members ${formatMoney(m)} · Non-members ${formatMoney(n)}`;
}

function eventArticle(ev: SiteEvent, ctx: RenderContext, layout: "cards" | "list" | "next_up"): string {
  const url = internal(`/events/${encodeURIComponent(ev.id)}`, ctx);
  const date = `<p class="qh-event__date"><time datetime="${esc(ev.start_at)}">${esc(formatEventDate(ev.start_at, ctx.timeZone))}</time></p>`;
  const meta = [ev.location ? esc(ev.location) : "", esc(priceLine(ev))].filter(Boolean).join(" · ");
  const body = `<h3 class="qh-event__title"><a href="${url}">${esc(ev.title)}</a></h3><p class="qh-event__meta">${meta}</p>`;
  const actions =
    `<div class="qh-event__actions"><a class="qh-btn qh-btn--ghost" href="${url}">Details</a>` +
    (ev.registration_open ? btn("primary", "Register", `data-register="${esc(ev.id)}"`) : "") +
    `</div>`;
  if (layout === "list") return `<article class="qh-event">${date}<div class="qh-event__body">${body}</div>${actions}</article>`;
  return `<article class="qh-event">${date}<div class="qh-event__body">${body}${actions}</div></article>`;
}

function renderEvents(s: Sec<"events">, ctx: RenderContext): string {
  const all = ctx.data.events ?? [];
  const limit = Math.max(1, s.limit || 6);
  const list = s.variant === "next_up" ? all.slice(0, 1) : all.slice(0, limit);
  const none = empty("No upcoming events are scheduled yet. Check back soon.");
  const cls = `qh-events qh-events--${s.variant}`;

  if (s.variant === "calendar") {
    // The calendar island replaces this fallback list with a month grid; it
    // reads `data-month` (YYYY-MM of the first listed event, "" = current month).
    const inner = heading(s.heading) + (list.length ? `<div class="qh-events__list">${list.map((ev) => eventArticle(ev, ctx, "list")).join("")}</div>` : none);
    // data-timezone: the grid must show the guild's clock, not the visitor's.
    // Without it a member in Denver saw a Texas meeting an hour early.
    const tzAttr = ctx.timeZone ? ` data-timezone="${esc(ctx.timeZone)}"` : "";
    return wrap(s, inner, { extraClass: cls, ctx, attrs: `data-month="${esc(monthOf(all[0]?.start_at))}"${tzAttr}` });
  }
  let body: string;
  if (!list.length) body = none;
  else if (s.variant === "cards") body = `<div class="qh-grid">${list.map((ev) => eventArticle(ev, ctx, "cards")).join("")}</div>`;
  else if (s.variant === "list") body = `<div class="qh-events__list">${list.map((ev) => eventArticle(ev, ctx, "list")).join("")}</div>`;
  else body = eventArticle(list[0], ctx, "next_up");
  return wrap(s, heading(s.heading) + body, { extraClass: cls, ctx });
}

function levelTerm(l: SiteLevel): string {
  if (l.renewal_type === "lifetime" || !l.duration_months) return "one time";
  const m = l.duration_months;
  if (m === 1) return "per month";
  if (m === 12) return "per year";
  if (m % 12 === 0) return `per ${m / 12} years`;
  return `per ${m} months`;
}

function renderLevels(s: Sec<"membership_levels">, ctx: RenderContext): string {
  const levels = ctx.data.levels ?? [];
  const cls = `qh-levels qh-levels--${s.variant}`;
  if (!levels.length) return wrap(s, heading(s.heading) + empty("Membership levels haven't been set up yet."), { extraClass: cls, ctx });
  const rows = levels.map((l) => {
    const price = `<p class="qh-level__price">${esc(formatMoney(l.price_cents || 0))} <span class="qh-level__term">${esc(levelTerm(l))}</span></p>`;
    const name = `<h3 class="qh-level__name">${esc(l.name)}</h3>`;
    const desc = l.description ? `<p class="qh-level__body">${esc(l.description)}</p>` : "";
    const join = btn("primary", "Join", `data-join="${esc(l.id)}"`);
    if (s.variant === "compact") return `<div class="qh-level"><div>${name}${desc}</div>${price}${join}</div>`;
    return `<div class="qh-level">${name}${price}${desc}${join}</div>`;
  });
  const listCls = s.variant === "cards" ? "qh-grid qh-levels__list" : "qh-levels__list";
  return wrap(s, `${heading(s.heading)}<div class="${listCls}">${rows.join("")}</div>`, { extraClass: cls, ctx });
}

function renderJoinBand(s: Sec<"join_band">, ctx: RenderContext): string {
  const inner =
    `<div class="qh-join-band__body"><h2>${esc(s.title)}</h2>` +
    (s.body ? `<p>${esc(s.body)}</p>` : "") +
    linkBtn("primary", s.ctaLabel || "Join", internal("/membership", ctx)) +
    `</div>`;
  return wrap(s, inner, { extraClass: "qh-join-band", ctx });
}

function renderMeeting(s: Sec<"meeting_info">, ctx: RenderContext): string {
  const where = [esc(s.where), s.address ? esc(s.address) : ""].filter(Boolean).join("<br>");
  const map = s.mapUrl ? `<p><a href="${href(s.mapUrl, ctx)}" rel="noopener">Open in Maps</a></p>` : "";
  const inner =
    heading(s.heading) +
    `<div class="qh-meeting__grid">` +
    `<dl><dt>When</dt><dd>${esc(s.when)}</dd></dl>` +
    `<dl><dt>Where</dt><dd>${where}${map}</dd></dl>` +
    `</div>` +
    (s.note ? `<p class="qh-meeting__note">${esc(s.note)}</p>` : "");
  return wrap(s, inner, { extraClass: "qh-meeting", ctx });
}

function productCard(p: SiteProduct, ctx: RenderContext): string {
  const soldOut = p.stock !== null && p.stock !== undefined && p.stock <= 0;
  const image = p.image_file_id ? uploadedImg(p.image_file_id, p.name, ctx, "grid", 480) : "";
  const actions = soldOut
    ? `<p><span class="qh-badge">Sold out</span></p>`
    : `<div class="qh-actions">${btn("secondary", "Add to cart", `data-add="${esc(p.id)}"`)}${btn("primary", "Buy", `data-buy="${esc(p.id)}"`)}</div>`;
  return (
    `<div class="qh-product">${image}<h3 class="qh-product__name">${esc(p.name)}</h3>` +
    `<p class="qh-product__price">${esc(formatMoney(p.price_cents || 0))}</p>` +
    (p.description ? `<p class="qh-muted">${esc(p.description)}</p>` : "") +
    actions +
    `</div>`
  );
}

function renderStore(s: Sec<"store_teaser">, ctx: RenderContext): string {
  const products = (ctx.data.products ?? []).slice(0, Math.max(1, s.limit || 6));
  const body = products.length ? `<div class="qh-grid qh-grid--4">${products.map((p) => productCard(p, ctx)).join("")}</div>` : empty("Nothing is in the store right now.");
  return wrap(s, heading(s.heading) + body, { extraClass: "qh-store", ctx });
}

function postRow(p: SitePost, ctx: RenderContext): string {
  const url = internal(`/blog/${encodeURIComponent(p.slug)}`, ctx);
  return (
    `<article class="qh-post"><p class="qh-post__date"><time datetime="${esc(p.published_at)}">${esc(formatPostDate(p.published_at))}</time></p>` +
    `<h3 class="qh-post__title"><a href="${url}">${esc(p.title)}</a></h3>` +
    (p.excerpt ? `<p>${esc(p.excerpt)}</p>` : "") +
    `</article>`
  );
}

function renderBlog(s: Sec<"blog_teaser">, ctx: RenderContext): string {
  const posts = (ctx.data.posts ?? []).slice(0, Math.max(1, s.limit || 3));
  const body = posts.length
    ? posts.map((p) => postRow(p, ctx)).join("") + `<p class="qh-s__more">${linkBtn("ghost", "All posts", internal("/blog", ctx))}</p>`
    : empty("No posts yet.");
  return wrap(s, heading(s.heading) + body, { extraClass: "qh-blog", ctx });
}

function contactDetails(ctx: RenderContext): string {
  const p = ctx.data.profile;
  if (!p) return "";
  const rows: string[] = [];
  if (p.email) {
    const mail = sanitizeUrl(`mailto:${p.email}`, "link");
    rows.push(`<dt>Email</dt><dd>${mail ? `<a href="${esc(mail)}">${esc(p.email)}</a>` : esc(p.email)}</dd>`);
  }
  if (p.meeting_info) rows.push(`<dt>Meetings</dt><dd>${esc(p.meeting_info)}</dd>`);
  if (p.location) rows.push(`<dt>Location</dt><dd>${esc(p.location)}</dd>`);
  if (p.website) {
    const site = sanitizeUrl(p.website, "link");
    rows.push(`<dt>Website</dt><dd>${site ? `<a href="${esc(site)}" rel="noopener">${esc(p.website)}</a>` : esc(p.website)}</dd>`);
  }
  return rows.length ? `<dl class="qh-contact__details">${rows.join("")}</dl>` : "";
}

function renderContact(s: Sec<"contact">, ctx: RenderContext): string {
  // Same placeholder blocksToHtml emits, so the existing qh-site.js hydration
  // (reads data-form-slug / data-submit-label) keeps working; data-form is the
  // island-bundle name for the same value.
  const form = s.formSlug
    ? `<div class="qh-block-contact-form" data-form="${esc(s.formSlug)}" data-form-slug="${esc(s.formSlug)}" data-submit-label="Send"></div>`
    : "";
  const details = s.showDetails ? contactDetails(ctx) : "";
  const body = form || details ? `<div class="qh-contact__grid">${form}${details}</div>` : empty("Contact details are coming soon.");
  return wrap(s, heading(s.heading) + body, { extraClass: "qh-contact", ctx });
}

function renderQuoteCta(s: Sec<"quote_cta">, ctx: RenderContext): string {
  // Placeholder hydrated by qh-site.js (data-project-type / data-heading /
  // data-submit-label), identical to the project_intake block.
  const inner =
    `<div class="qh-block-project-intake" data-project-type="${esc(s.projectType || "longarm")}"` +
    ` data-heading="${esc(s.heading || "Request a quote")}" data-submit-label="${esc(s.submitLabel || "Get my estimate")}"></div>`;
  return wrap(s, inner, { extraClass: "qh-quote-cta", ctx });
}

function renderCta(s: Sec<"cta">, ctx: RenderContext): string {
  const kind = s.kind === "secondary" ? "secondary" : "primary";
  return wrap(s, `<p class="qh-actions">${linkBtn(kind, s.label, href(s.href, ctx))}</p>`, { extraClass: "qh-cta", ctx });
}

function renderDivider(s: Sec<"divider">, ctx: RenderContext): string {
  return wrap(s, "<hr>", { extraClass: "qh-divider", ctx });
}

function renderSpacer(s: Sec<"spacer">, ctx: RenderContext): string {
  const h = Number.isFinite(s.height) ? Math.min(160, Math.max(8, Math.round(s.height))) : 24;
  return wrap(s, "", { extraClass: "qh-spacer", ctx, decls: [`--qh-s-height:${h}px`], attrs: 'aria-hidden="true"' });
}

function renderEmbed(s: Sec<"embed">, ctx: RenderContext): string {
  return wrap(s, sanitizeHtml(s.html ?? "", { allowEmbeds: true }), { extraClass: "qh-embed", ctx });
}

// ---------------------------------------------------------------------------
// Phase 2 renderers
// ---------------------------------------------------------------------------

/** Origin of the base URL ("" on the platform host, where the portal is at the same origin). */
function originOf(ctx: RenderContext): string {
  const m = /^(https?:\/\/[^/]+)/i.exec(ctx.baseUrl || "");
  return m ? m[1] : "";
}

function mailto(email: string | undefined): string | null {
  if (!email) return null;
  const clean = sanitizeUrl(`mailto:${email}`, "link");
  return clean ? esc(clean) : null;
}

function renderTimeline(s: Sec<"timeline">, ctx: RenderContext): string {
  const items = (s.items ?? []).map(
    (it) =>
      `<li class="qh-timeline__item"><span class="qh-timeline__year">${esc(it.year)}</span>` +
      `<div class="qh-timeline__body"><h3>${esc(it.title)}</h3>${it.body ? `<p>${esc(it.body)}</p>` : ""}</div></li>`
  );
  const inner = heading(s.heading) + (items.length ? `<ol class="qh-timeline__list">${items.join("")}</ol>` : empty("No milestones have been added yet."));
  return wrap(s, inner, { extraClass: "qh-timeline", ctx });
}

function renderQuote(s: Sec<"quote">, ctx: RenderContext): string {
  const inner = `<blockquote class="qh-quote__text"><p>${esc(s.quote)}</p>${s.author ? `<cite>${esc(s.author)}</cite>` : ""}</blockquote>`;
  return wrap(s, inner, { extraClass: "qh-quote", ctx });
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function renderOfficers(s: Sec<"officers">, ctx: RenderContext): string {
  const people = (s.items ?? []).map((p) => {
    const photo = p.imageId && !isPatternRef(p.imageId)
      ? uploadedImg(p.imageId, p.name, ctx, "grid", 480, { cls: "qh-officer__photo" })
      : `<span class="qh-officer__avatar" aria-hidden="true">${esc(initials(p.name))}</span>`;
    const mail = mailto(p.email);
    return (
      `<div class="qh-officer">${photo}<h3 class="qh-officer__name">${esc(p.name)}</h3><p class="qh-officer__role">${esc(p.role)}</p>` +
      (mail && p.email ? `<p class="qh-officer__email"><a href="${mail}">${esc(p.email)}</a></p>` : "") +
      `</div>`
    );
  });
  const inner = heading(s.heading) + (people.length ? `<div class="qh-grid qh-officers__grid">${people.join("")}</div>` : empty("Officers haven't been listed yet."));
  return wrap(s, inner, { extraClass: "qh-officers", ctx });
}

function renderBenefits(s: Sec<"benefits">, ctx: RenderContext): string {
  const items = (s.items ?? []).map((it) => `<li class="qh-benefit"><strong>${esc(it.title)}</strong>${it.body ? `<p>${esc(it.body)}</p>` : ""}</li>`);
  const inner = heading(s.heading) + (items.length ? `<ul class="qh-benefits__list">${items.join("")}</ul>` : empty("Benefits haven't been listed yet."));
  return wrap(s, inner, { extraClass: "qh-benefits", ctx });
}

function renderSpotlight(s: Sec<"event_spotlight">, ctx: RenderContext): string {
  const all = ctx.data.events ?? [];
  const ev = (s.eventId ? all.find((e) => e.id === s.eventId) : undefined) ?? all[0];
  if (!ev) return wrap(s, heading(s.heading) + empty("No upcoming events are scheduled yet. Check back soon."), { extraClass: "qh-spotlight", ctx });
  const url = internal(`/events/${encodeURIComponent(ev.id)}`, ctx);
  const meta = [ev.location ? esc(ev.location) : "", esc(priceLine(ev))].filter(Boolean).join(" · ");
  const inner =
    heading(s.heading) +
    `<article class="qh-spotlight__event">` +
    `<p class="qh-event__date"><time datetime="${esc(ev.start_at)}">${esc(formatEventDate(ev.start_at, ctx.timeZone))}</time></p>` +
    `<h3 class="qh-spotlight__title"><a href="${url}">${esc(ev.title)}</a></h3>` +
    `<p class="qh-event__meta">${meta}</p>` +
    (ev.description ? `<p class="qh-spotlight__body">${esc(ev.description)}</p>` : "") +
    `<div class="qh-event__actions"><a class="qh-btn qh-btn--secondary" href="${url}">Details</a>` +
    (ev.registration_open ? btn("primary", "Register", `data-register="${esc(ev.id)}"`) : "") +
    `</div></article>`;
  return wrap(s, inner, { extraClass: "qh-spotlight", ctx });
}

function renderProjects(s: Sec<"projects">, ctx: RenderContext): string {
  const cards = (s.items ?? []).map((it) => {
    const title = it.href ? `<a href="${href(it.href, ctx)}">${esc(it.title)}</a>` : esc(it.title);
    const media = it.imageId
      ? isPatternRef(it.imageId)
        ? patternMedia(it.imageId, ctx, " qh-project__media")
        : `<div class="qh-media qh-project__media">${uploadedImg(it.imageId, "", ctx, "grid", 960)}</div>`
      : "";
    return (
      `<article class="qh-project">${media}<div class="qh-project__body">` +
      (it.stat ? `<p class="qh-project__stat">${esc(it.stat)}</p>` : "") +
      `<h3>${title}</h3>` +
      (it.body ? `<p>${esc(it.body)}</p>` : "") +
      `</div></article>`
    );
  });
  const inner = heading(s.heading) + (cards.length ? `<div class="qh-grid qh-projects__grid">${cards.join("")}</div>` : empty("No projects have been added yet."));
  return wrap(s, inner, { extraClass: "qh-projects", ctx });
}

function renderSponsors(s: Sec<"sponsors">, ctx: RenderContext): string {
  const items = (s.items ?? []).map((sp) => {
    const body = sp.imageId && !isPatternRef(sp.imageId)
      ? uploadedImg(sp.imageId, sp.name, ctx, "grid", 480)
      : `<span class="qh-sponsor__name">${esc(sp.name)}</span>`;
    const link = sp.href ? href(sp.href, ctx) : null;
    return `<li class="qh-sponsor">${link && link !== "#" ? `<a class="qh-sponsor__link" href="${link}" rel="noopener">${body}</a>` : body}</li>`;
  });
  const inner = heading(s.heading) + (items.length ? `<ul class="qh-sponsors__list">${items.join("")}</ul>` : empty("No sponsors have been added yet."));
  return wrap(s, inner, { extraClass: "qh-sponsors", ctx });
}

function renderNewsletter(s: Sec<"newsletter_signup">, ctx: RenderContext): string {
  // No action attribute: the island posts to /public/:slug/newsletter; without
  // JS the form does nothing rather than GET-ing the address into the URL.
  const inner =
    `<div class="qh-newsletter__body">${heading(s.heading)}` +
    (s.body ? `<p class="qh-lead">${esc(s.body)}</p>` : "") +
    `</div>` +
    `<form class="qh-newsletter__form" data-newsletter method="post">` +
    `<label><span>Email</span><input type="email" name="email" autocomplete="email" required placeholder="you@example.com"></label>` +
    `<button class="qh-btn qh-btn--primary" type="submit">${esc(s.buttonLabel || "Subscribe")}</button>` +
    `</form>`;
  return wrap(s, inner, { extraClass: "qh-newsletter", ctx });
}

function renderServices(s: Sec<"services">, ctx: RenderContext): string {
  const items = s.items ?? [];
  const cls = `qh-services qh-services--${s.variant}`;
  if (!items.length) return wrap(s, heading(s.heading) + empty("No services have been listed yet."), { extraClass: cls, ctx });
  const unit = (u: string | undefined) => (u ? ` <span class="qh-service__unit">${esc(u)}</span>` : "");
  let body: string;
  if (s.variant === "table") {
    const rows = items
      .map(
        (it) =>
          `<tr><th scope="row">${esc(it.title)}</th><td>${it.body ? esc(it.body) : ""}</td>` +
          `<td>${it.price ? esc(it.price) + unit(it.unit) : ""}</td></tr>`
      )
      .join("");
    body =
      `<div class="qh-table-wrap"><table class="qh-services__table"><thead><tr>` +
      `<th scope="col">Service</th><th scope="col">What's included</th><th scope="col">Price</th></tr></thead>` +
      `<tbody>${rows}</tbody></table></div>`;
  } else {
    body =
      `<div class="qh-grid qh-services__grid">` +
      items
        .map(
          (it) =>
            `<div class="qh-service"><h3>${esc(it.title)}</h3>` +
            (it.body ? `<p>${esc(it.body)}</p>` : "") +
            (it.price ? `<p class="qh-service__pricing"><span class="qh-service__price">${esc(it.price)}</span>${unit(it.unit)}</p>` : "") +
            `</div>`
        )
        .join("") +
      `</div>`;
  }
  return wrap(s, heading(s.heading) + body, { extraClass: cls, ctx });
}

function renderPortfolio(s: Sec<"portfolio">, ctx: RenderContext): string {
  const cls = `qh-portfolio qh-portfolio--${s.variant}`;
  const figures = (s.items ?? [])
    .map((it, i) => {
      const featured = s.variant === "featured" && i === 0;
      // Portfolio items have no alt field: the title (else the caption)
      // describes the piece, same as before the responsive-image refactor.
      const tag = mediaImg(
        { ...it, alt: it.title ?? it.caption ?? "" },
        ctx,
        featured ? "single" : "grid",
        featured ? 1600 : 640
      );
      const full = mediaSrc(it, ctx, 1600);
      if (!tag || !full) return "";
      const cap = it.title || it.caption
        ? `<figcaption>${it.title ? `<strong>${esc(it.title)}</strong>` : ""}${it.caption ? `<span>${esc(it.caption)}</span>` : ""}</figcaption>`
        : "";
      return `<figure class="qh-portfolio__item${featured ? " qh-portfolio__item--featured" : ""}"><a data-lightbox href="${esc(full)}">${tag}</a>${cap}</figure>`;
    })
    .filter(Boolean);
  const inner = heading(s.heading) + (figures.length ? `<div class="qh-portfolio__items">${figures.join("")}</div>` : empty("No work has been added yet."));
  return wrap(s, inner, { extraClass: cls, ctx });
}

function renderHours(s: Sec<"hours_location">, ctx: RenderContext): string {
  const rows = (s.hours ?? []).map((h) => `<div><dt>${esc(h.day)}</dt><dd>${esc(h.open)}</dd></div>`).join("");
  const hours = rows ? `<dl class="qh-hours__list">${rows}</dl>` : "";
  const details: string[] = [];
  if (s.address) {
    const map = s.mapUrl ? ` <a href="${href(s.mapUrl, ctx)}" rel="noopener">Open in Maps</a>` : "";
    details.push(`<p class="qh-hours__address">${esc(s.address)}${map}</p>`);
  }
  if (s.phone) {
    const digits = s.phone.replace(/[^\d+]/g, "");
    const tel = digits ? sanitizeUrl(`tel:${digits}`, "link") : null;
    details.push(`<p class="qh-hours__phone">${tel ? `<a href="${esc(tel)}">${esc(s.phone)}</a>` : esc(s.phone)}</p>`);
  }
  const mail = mailto(s.email);
  if (s.email) details.push(`<p class="qh-hours__email">${mail ? `<a href="${mail}">${esc(s.email)}</a>` : esc(s.email)}</p>`);
  if (s.note) details.push(`<p class="qh-hours__note">${esc(s.note)}</p>`);
  const body = hours || details.length
    ? `<div class="qh-hours__grid">${hours}${details.length ? `<div class="qh-hours__details">${details.join("")}</div>` : ""}</div>`
    : empty("Hours and location are coming soon.");
  return wrap(s, heading(s.heading) + body, { extraClass: "qh-hours", ctx });
}

function renderProcess(s: Sec<"process">, ctx: RenderContext): string {
  // Numbering comes from the stylesheet's counter(); the markup carries no digits.
  const steps = (s.items ?? []).map((it) => `<li class="qh-process__step"><h3>${esc(it.title)}</h3>${it.body ? `<p>${esc(it.body)}</p>` : ""}</li>`);
  const inner = heading(s.heading) + (steps.length ? `<ol class="qh-process__steps">${steps.join("")}</ol>` : empty("No steps have been added yet."));
  return wrap(s, inner, { extraClass: "qh-process", ctx });
}

function fileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDocuments(s: Sec<"documents">, ctx: RenderContext): string {
  const docs: SiteDocument[] | undefined = ctx.data.documents;
  const origin = originOf(ctx);
  let body: string;
  if (docs === undefined) {
    const portal = `${origin}/portal?slug=${encodeURIComponent(ctx.slug)}`;
    body =
      `<div class="qh-documents__signin"><p>These files are for members.</p>` +
      `<a class="qh-btn qh-btn--primary" href="${esc(portal)}">Member sign-in</a></div>`;
  } else if (!docs.length) {
    body = empty("No documents have been shared yet.");
  } else {
    const items = docs.slice(0, Math.max(1, s.limit || 10)).map((d) => {
      const url = `${origin}/api/portal/${encodeURIComponent(ctx.slug)}/files/${encodeURIComponent(d.id)}`;
      const size = fileSize(d.size);
      return `<li class="qh-document"><a href="${esc(url)}">${esc(d.filename)}</a>${size ? ` <span class="qh-document__size">${esc(size)}</span>` : ""}</li>`;
    });
    body = `<ul class="qh-documents__list">${items.join("")}</ul>`;
  }
  return wrap(s, heading(s.heading) + body, { extraClass: "qh-documents", ctx });
}

function renderDonate(s: Sec<"donate">, ctx: RenderContext): string {
  const amounts = (s.amounts ?? []).filter((n) => Number.isFinite(n) && n >= 100).map((n) => Math.round(n));
  const buttons = amounts.map((c) => btn("primary", formatMoney(c), `data-donate="${c}"`));
  buttons.push(btn("secondary", "Other amount", `data-donate="0"`));
  const inner =
    `<div class="qh-donate__body">${heading(s.heading)}` +
    (s.body ? `<p class="qh-lead">${esc(s.body)}</p>` : "") +
    `</div><div class="qh-donate__amounts">${buttons.join("")}</div>`;
  return wrap(s, inner, { extraClass: "qh-donate", ctx });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function renderOne(s: Section, ctx: RenderContext, opts: Opts): string {
  switch (s.type) {
    case "timeline":
      return renderTimeline(s, ctx);
    case "quote":
      return renderQuote(s, ctx);
    case "officers":
      return renderOfficers(s, ctx);
    case "benefits":
      return renderBenefits(s, ctx);
    case "event_spotlight":
      return renderSpotlight(s, ctx);
    case "projects":
      return renderProjects(s, ctx);
    case "sponsors":
      return renderSponsors(s, ctx);
    case "newsletter_signup":
      return renderNewsletter(s, ctx);
    case "services":
      return renderServices(s, ctx);
    case "portfolio":
      return renderPortfolio(s, ctx);
    case "hours_location":
      return renderHours(s, ctx);
    case "process":
      return renderProcess(s, ctx);
    case "documents":
      return renderDocuments(s, ctx);
    case "donate":
      return renderDonate(s, ctx);
    case "hero":
      return renderHero(s, ctx, opts);
    case "rich_text":
      return renderRichText(s, ctx);
    case "image":
      return renderImage(s, ctx);
    case "feature_grid":
      return renderFeatureGrid(s, ctx);
    case "faq":
      return renderFaq(s, ctx);
    case "testimonials":
      return renderTestimonials(s, ctx);
    case "gallery":
      return renderGallery(s, ctx);
    case "events":
      return renderEvents(s, ctx);
    case "membership_levels":
      return renderLevels(s, ctx);
    case "join_band":
      return renderJoinBand(s, ctx);
    case "meeting_info":
      return renderMeeting(s, ctx);
    case "store_teaser":
      return renderStore(s, ctx);
    case "blog_teaser":
      return renderBlog(s, ctx);
    case "contact":
      return renderContact(s, ctx);
    case "quote_cta":
      return renderQuoteCta(s, ctx);
    case "cta":
      return renderCta(s, ctx);
    case "divider":
      return renderDivider(s, ctx);
    case "spacer":
      return renderSpacer(s, ctx);
    case "embed":
      return renderEmbed(s, ctx);
    default: {
      const t = (s as { type?: unknown }).type;
      throw new Error(`Unsupported section type "${String(t)}"`);
    }
  }
}

/** Render one section. A lone hero is treated as the page's first hero (eager image). */
export function renderSection(s: Section, ctx: RenderContext): string {
  return renderOne(s, ctx, { eagerHero: true });
}

/** Render a stack. Only the first hero's image is fetched eagerly; every other image is lazy. */
export function renderSections(sections: Section[], ctx: RenderContext): string {
  let heroSeen = false;
  const out: string[] = [];
  for (const s of sections) {
    const eagerHero = s.type === "hero" && !heroSeen;
    if (s.type === "hero") heroSeen = true;
    out.push(renderOne(s, ctx, { eagerHero }));
  }
  return out.join("\n");
}

/**
 * Render a stack with no dynamic data: the admin editor's canvas/preview
 * (`POST /pages/preview`) and the `content_json` html snapshot pages.ts
 * writes for section documents. Data-driven sections (events, levels,
 * store, blog, gallery-from-gallery) render their empty states. Image ids
 * resolve on the platform host (`/public/:slug/img/:id`), matching
 * `serveSite`'s platform-host `imgUrl`.
 */
export function renderSectionsStandalone(
  sections: Section[],
  opts: { slug: string; baseUrl: string; design: SiteDesign }
): string {
  const ctx: RenderContext = {
    slug: opts.slug,
    baseUrl: opts.baseUrl,
    design: opts.design,
    data: {},
    imgUrl: (id) => `/public/${encodeURIComponent(opts.slug)}/img/${encodeURIComponent(id)}`,
  };
  return renderSections(sections, ctx);
}
