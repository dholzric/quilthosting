/**
 * System pages as section stacks.
 *
 * Membership, events (index / detail / calendar), galleries, blog,
 * members-only and not-found are rendered by the same section system as
 * editor-authored pages (spec §4.4), so they match the site instead of
 * looking like the admin. `systemPageSections` builds the fixed stack for a
 * page kind from the loaded `SiteData`; the shell renderer (render.ts) turns
 * the sections into HTML exactly as it does for a stored page.
 *
 * Conventions the rest of the renderer relies on:
 *
 * - Every link is a root-relative site path (`/membership`, `/galleries/x`).
 *   `serveSite` prefixes the platform base path (`/g/<slug>`) when rendering
 *   on the platform host, so nothing here knows about hosts.
 * - Plain-string fields (hero title/subtitle, feature titles, prices) are
 *   escaped by the section renderers. Only `rich_text.html` and `faq.a`
 *   carry HTML and both are run through `sanitizeHtml` here.
 * - Register button: the event detail page emits
 *   `{ type: "cta", label: "Register", href: "#", kind: "primary", id: "register-<eventId>" }`.
 *   The island bundle (public/qh-site.js, `register` module) binds
 *   `[id^="register-"]`, reads the event id from the suffix and opens the
 *   registration dialog; without JS the button is inert, which is why the
 *   href is `#` and not a route.
 * - A detail kind (`event`, `gallery`, `post`) whose `param` does not match
 *   the loaded data returns the `not_found` stack with `status: 404`, so
 *   callers get one shape regardless of the lookup outcome.
 * - `members_only` is `noindex: true`; `not_found` is `status: 404`.
 */

import type { Tenant } from "../../../types";
import type { SiteDesign } from "../design/tokens";
import type { SiteData, SiteEvent, SiteGallery, SitePost } from "../data.types";
import type { Section, SectionStyle } from "../sections/schema";
import { DEFAULT_STYLE } from "../sections/schema";
import { escapeHtml } from "../../blocks";
import { sanitizeHtml } from "../../sanitize";
import { formatMoney } from "../../utils/money";

export type SystemPageKind =
  | "membership"
  | "events"
  | "event"
  | "calendar"
  | "galleries"
  | "gallery"
  | "blog"
  | "post"
  | "members_only"
  | "not_found";

export type SystemPageContext = {
  tenant: Tenant;
  design: SiteDesign;
  data: SiteData;
  /** Event id, gallery slug or post slug for the detail kinds. */
  param?: string;
};

export type SystemPage = {
  title: string;
  sections: Section[];
  noindex?: boolean;
  status?: number;
};

/** Prefix used on the event detail register button; see the header comment. */
export const REGISTER_CTA_ID_PREFIX = "register-";

/** Used when a guild has not set `settings.timezone`. Workers run in UTC anyway. */
const DEFAULT_TIMEZONE = "UTC";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function style(overrides: Partial<SectionStyle> = {}): SectionStyle {
  return { ...DEFAULT_STYLE, ...overrides };
}

function readSettings(tenant: Tenant): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tenant.settings_json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function tenantTimezone(settings: Record<string, unknown>): string {
  const tz = settings.timezone;
  return typeof tz === "string" && tz.trim() ? tz.trim() : DEFAULT_TIMEZONE;
}

/** `settings.membership_faq`: `[{ q, a }]`; `a` may carry limited HTML. */
function readMembershipFaq(settings: Record<string, unknown>): { q: string; a: string }[] {
  const raw = settings.membership_faq;
  if (!Array.isArray(raw)) return [];
  const out: { q: string; a: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = typeof (item as { q?: unknown }).q === "string" ? (item as { q: string }).q.trim() : "";
    const a = typeof (item as { a?: unknown }).a === "string" ? sanitizeHtml((item as { a: string }).a) : "";
    if (!q || !a) continue;
    out.push({ q, a });
    if (out.length >= 30) break;
  }
  return out;
}

function safeFormat(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(date);
  } catch {
    // Unknown IANA zone in settings: fall back rather than 500 the page.
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: DEFAULT_TIMEZONE }).format(date);
  }
}

const DATE_OPTS: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric", year: "numeric" };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const DAY_KEY_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };

/**
 * "Saturday, October 3, 2026 · 10:00 AM – 1:00 PM · Community Center" in the
 * guild's timezone. Multi-day events spell out both ends. Missing pieces are
 * simply left out; an unparseable start date yields just the location.
 */
export function formatEventWhen(ev: Pick<SiteEvent, "start_at" | "end_at" | "location">, timeZone: string): string {
  const parts: string[] = [];
  const start = new Date(ev.start_at);
  if (!Number.isNaN(start.getTime())) {
    const end = ev.end_at ? new Date(ev.end_at) : null;
    const hasEnd = !!end && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime();
    const sameDay = hasEnd && safeFormat(start, timeZone, DAY_KEY_OPTS) === safeFormat(end!, timeZone, DAY_KEY_OPTS);
    if (hasEnd && !sameDay) {
      parts.push(
        `${safeFormat(start, timeZone, DATE_OPTS)}, ${safeFormat(start, timeZone, TIME_OPTS)} – ` +
          `${safeFormat(end!, timeZone, DATE_OPTS)}, ${safeFormat(end!, timeZone, TIME_OPTS)}`
      );
    } else {
      parts.push(safeFormat(start, timeZone, DATE_OPTS));
      const time = safeFormat(start, timeZone, TIME_OPTS);
      parts.push(hasEnd ? `${time} – ${safeFormat(end!, timeZone, TIME_OPTS)}` : time);
    }
  }
  const location = ev.location?.trim();
  if (location) parts.push(location);
  return parts.join(" · ");
}

function formatDate(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return safeFormat(d, timeZone, { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Event descriptions and post excerpts are plain text today: escape it, wrap
 * paragraphs on blank lines, keep single newlines as `<br>`, then run the
 * result through `sanitizeHtml` so the output is exactly what a stored
 * rich_text section would carry.
 */
export function descriptionToHtml(text: string | null | undefined): string {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const html = normalized
    .split(/\n[ \t]*\n+/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return sanitizeHtml(html);
}

function price(cents: number): string {
  return cents > 0 ? formatMoney(cents) : "Free";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Section factories
// ---------------------------------------------------------------------------

function hero(id: string, title: string, subtitle?: string): Section {
  return { type: "hero", variant: "minimal", title, subtitle: subtitle || undefined, style: style(), id };
}

function prose(id: string, html: string): Section {
  return { type: "rich_text", variant: "prose", html, style: style({ width: "narrow" }), id };
}

function cta(id: string, label: string, href: string, kind: "primary" | "secondary"): Section {
  return { type: "cta", label, href, kind, style: style({ align: "center" }), id };
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

function membershipPage(ctx: SystemPageContext, settings: Record<string, unknown>): SystemPage {
  const guild = ctx.tenant.name;
  const subtitle = ctx.data.profile?.description?.trim() || `Join ${guild} for meetings, workshops, and a community of quilters.`;
  const sections: Section[] = [
    hero("membership-hero", "Membership", subtitle),
    { type: "membership_levels", variant: "cards", heading: "Membership levels", style: style(), id: "membership-levels" },
  ];
  const faq = readMembershipFaq(settings);
  if (faq.length) {
    sections.push({ type: "faq", heading: "Membership questions", items: faq, style: style({ width: "narrow" }), id: "membership-faq" });
  }
  sections.push({
    type: "join_band",
    title: `Ready to join ${guild}?`,
    body: "Pick a level above, fill in your details, and you're a member as soon as dues are paid.",
    ctaLabel: "Join",
    style: style({ bg: "brand", align: "center" }),
    id: "membership-join",
  });
  return { title: "Membership", sections };
}

function eventsPage(ctx: SystemPageContext): SystemPage {
  return {
    title: "Events",
    sections: [
      hero("events-hero", "Events", `Upcoming meetings, workshops, and shows from ${ctx.tenant.name}.`),
      { type: "events", variant: "list", limit: 50, style: style(), id: "events-list" },
      cta("events-calendar-link", "View calendar", "/calendar", "secondary"),
    ],
  };
}

function calendarPage(): SystemPage {
  return {
    title: "Calendar",
    sections: [{ type: "events", variant: "calendar", heading: "Calendar", limit: 50, style: style({ width: "wide" }), id: "calendar" }],
  };
}

function eventPage(ctx: SystemPageContext, ev: SiteEvent, timeZone: string): SystemPage {
  const sections: Section[] = [hero("event-hero", ev.title, formatEventWhen(ev, timeZone))];
  const body = descriptionToHtml(ev.description);
  if (body) sections.push(prose("event-description", body));
  sections.push({
    type: "feature_grid",
    variant: "icons",
    heading: "Pricing",
    items: [
      { title: "Members", price: price(ev.member_price_cents) },
      { title: "Non-members", price: price(ev.non_member_price_cents) },
    ],
    style: style({ width: "narrow" }),
    id: "event-pricing",
  });
  if (ev.registration_open) {
    // See the header comment: the register island binds [id^="register-"].
    sections.push(cta(`${REGISTER_CTA_ID_PREFIX}${ev.id}`, "Register", "#", "primary"));
  }
  return { title: ev.title, sections };
}

function galleriesPage(ctx: SystemPageContext): SystemPage {
  const galleries = ctx.data.galleries ?? [];
  const sections: Section[] = [hero("galleries-hero", "Galleries", `Photos from ${ctx.tenant.name} shows, retreats, and meetings.`)];
  if (galleries.length) {
    sections.push({
      type: "feature_grid",
      variant: "cards",
      items: galleries.slice(0, 12).map((g) => ({
        title: g.title,
        body: plural(g.count, "photo", "photos"),
        href: `/galleries/${encodeURIComponent(g.slug)}`,
      })),
      style: style(),
      id: "galleries-list",
    });
  } else {
    sections.push(prose("galleries-empty", "<p>No galleries have been published yet. Check back after the next show or retreat.</p>"));
  }
  return { title: "Galleries", sections };
}

function galleryPage(g: SiteGallery): SystemPage {
  return {
    title: g.title,
    sections: [
      hero("gallery-hero", g.title, g.description?.trim() || undefined),
      {
        type: "gallery",
        variant: "grid",
        source: "gallery",
        gallerySlug: g.slug,
        items: g.photos.map((p) => ({ imageId: p.id, alt: p.caption?.trim() || g.title, caption: p.caption?.trim() || undefined })),
        style: style({ width: "wide" }),
        id: "gallery-photos",
      },
      cta("gallery-back", "All galleries", "/galleries", "secondary"),
    ],
  };
}

function blogPage(ctx: SystemPageContext): SystemPage {
  return {
    title: "Blog",
    sections: [
      hero("blog-hero", "Blog", `News and notes from ${ctx.tenant.name}.`),
      { type: "blog_teaser", limit: 50, style: style(), id: "blog-posts" },
    ],
  };
}

/**
 * The post body lives in the page row's own sections and is appended by
 * `serveSite` after this stack; here we emit the title, the published date
 * and the excerpt as a lede.
 */
function postPage(post: SitePost, timeZone: string): SystemPage {
  const sections: Section[] = [hero("post-hero", post.title, formatDate(post.published_at, timeZone) || undefined)];
  const lede = descriptionToHtml(post.excerpt);
  if (lede) sections.push(prose("post-lede", lede));
  return { title: post.title, sections };
}

function membersOnlyPage(ctx: SystemPageContext): SystemPage {
  const guild = ctx.tenant.name;
  return {
    title: "Members only",
    noindex: true,
    sections: [
      hero("members-only-hero", "Members only", `This page is for current members of ${guild}.`),
      prose(
        "members-only-body",
        "<p>Sign in to the member portal with the email address on your membership. " +
          "We'll send you a one-time link, so there is no password to remember. " +
          "Not a member yet? See the membership page to join.</p>"
      ),
      cta("members-only-signin", "Member sign-in", `/portal?slug=${encodeURIComponent(ctx.tenant.slug)}`, "primary"),
    ],
  };
}

function notFoundPage(ctx: SystemPageContext): SystemPage {
  return {
    title: "Page not found",
    status: 404,
    sections: [
      hero("not-found-hero", "Page not found", `That page isn't on the ${ctx.tenant.name} site. It may have moved or been unpublished.`),
      cta("not-found-home", "Back to home", "/", "secondary"),
    ],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function systemPageSections(kind: SystemPageKind, ctx: SystemPageContext): SystemPage {
  const settings = readSettings(ctx.tenant);
  const timeZone = tenantTimezone(settings);
  switch (kind) {
    case "membership":
      return membershipPage(ctx, settings);
    case "events":
      return eventsPage(ctx);
    case "calendar":
      return calendarPage();
    case "event": {
      const ev = ctx.param ? ctx.data.events?.find((e) => e.id === ctx.param) : undefined;
      return ev ? eventPage(ctx, ev, timeZone) : notFoundPage(ctx);
    }
    case "galleries":
      return galleriesPage(ctx);
    case "gallery": {
      const g = ctx.data.gallery;
      return g && ctx.param && g.slug === ctx.param ? galleryPage(g) : notFoundPage(ctx);
    }
    case "blog":
      return blogPage(ctx);
    case "post": {
      const post = ctx.param ? ctx.data.posts?.find((p) => p.slug === ctx.param) : undefined;
      return post ? postPage(post, timeZone) : notFoundPage(ctx);
    }
    case "members_only":
      return membersOnlyPage(ctx);
    case "not_found":
      return notFoundPage(ctx);
  }
}
