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
import { deriveRoles, isDarkDesign } from "../design/tokens";
import type { Roles, SiteDesign } from "../design/tokens";
import { patternDataUri } from "../design/patterns";
import type { PatternId } from "../design/patterns";
import type { SiteData, SiteEvent, SiteLevel, SitePost, SiteProduct } from "../data.types";
import { DEFAULT_STYLE } from "./schema";
import type { Section, SectionStyle } from "./schema";

export type RenderContext = {
  slug: string;
  /** "" or "/g/<slug>" on the platform host, "https://host" on tenant hosts. Internal links are `${baseUrl}/path`. */
  baseUrl: string;
  design: SiteDesign;
  /** Dynamic data for events/levels/store/blog/gallery sections; may be empty. */
  data: SiteData;
  /** Turns a files.id into an image URL; provided by the caller, never computed here. */
  imgUrl: (fileId: string, w?: number) => string;
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
    r = deriveRoles(design.palette.input, isDarkDesign(design));
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
  if (opts.eager) parts.push(` fetchpriority="high"`);
  else parts.push(` loading="lazy" decoding="async"`);
  return parts.join("") + ">";
}

/** Resolve a media item to a URL: `imageId` via ctx.imgUrl, else a sanitized legacy `url`. */
function mediaSrc(item: { imageId?: string; url?: string }, ctx: RenderContext, w: number): string | null {
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

/** "Sat, Sep 12 · 9:00 AM" (or "Sat, Sep 12" without a time). Unparseable input is returned as-is. */
export function formatEventDate(iso: string): string {
  const w = wallTime(iso);
  if (!w) return iso;
  const day = `${weekday(w)}, ${MON[w.m - 1]} ${w.d}`;
  const t = clock(w);
  return t ? `${day} · ${t}` : day;
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
  if (opts.ctx && wantsImage && st.imageId) {
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
  if (s.variant === "image" && st.imageId) {
    parts.push(img(ctx.imgUrl(st.imageId, 1600), "", { cls: "qh-hero__media", eager: opts.eagerHero }));
  }
  parts.push(`<div class="qh-hero__body">${body.join("")}</div>`);
  if (s.variant === "split" && st.imageId) {
    parts.push(`<div class="qh-media qh-hero__media">${img(ctx.imgUrl(st.imageId, 1200), "", { eager: opts.eagerHero })}</div>`);
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
    const media = `<div class="qh-media">${img(ctx.imgUrl(st.imageId, 1200), "")}</div>`;
    return wrap(s, body + media, { extraClass: cls, ctx });
  }
  return wrap(s, `${heading(s.heading)}<div class="qh-rich__body">${html}</div>`, { extraClass: cls, ctx });
}

function renderImage(s: Sec<"image">, ctx: RenderContext): string {
  const w = s.variant === "full_bleed" ? 2000 : s.variant === "duo" ? 900 : 1400;
  const figures = (s.items ?? [])
    .map((it) => {
      const src = mediaSrc(it, ctx, w);
      if (!src) return "";
      const cap = it.caption ? `<figcaption>${esc(it.caption)}</figcaption>` : "";
      return `<figure>${img(src, it.alt ?? "")}${cap}</figure>`;
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
  type Photo = { thumb: string; full: string; alt: string; caption?: string };
  const photos: Photo[] = [];
  if (s.source === "gallery") {
    const g = ctx.data.gallery;
    if (g && (!s.gallerySlug || g.slug === s.gallerySlug)) {
      for (const p of g.photos ?? []) {
        photos.push({ thumb: ctx.imgUrl(p.id, 480), full: ctx.imgUrl(p.id, 1600), alt: p.caption ?? "", caption: p.caption ?? undefined });
      }
    }
  } else {
    for (const it of s.items ?? []) {
      const thumb = mediaSrc(it, ctx, 480);
      const full = mediaSrc(it, ctx, 1600);
      if (!thumb || !full) continue;
      photos.push({ thumb, full, alt: it.alt ?? "", caption: it.caption });
    }
  }
  const figures = photos.map(
    (p) =>
      `<figure class="qh-gallery__item"><a data-lightbox href="${esc(p.full)}">${img(p.thumb, p.alt)}</a>` +
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
  const date = `<p class="qh-event__date"><time datetime="${esc(ev.start_at)}">${esc(formatEventDate(ev.start_at))}</time></p>`;
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
    return wrap(s, inner, { extraClass: cls, ctx, attrs: `data-month="${esc(monthOf(all[0]?.start_at))}"` });
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
  const image = p.image_file_id ? img(ctx.imgUrl(p.image_file_id, 480), p.name) : "";
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
// Dispatch
// ---------------------------------------------------------------------------

function renderOne(s: Section, ctx: RenderContext, opts: Opts): string {
  switch (s.type) {
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
