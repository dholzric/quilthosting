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
 *   href is `#` and not a route. The volunteer button follows the same
 *   convention with the `volunteer-<eventId>` id (`volunteer` module).
 * - `rich_text.html` is sanitized and emitted verbatim -- the section
 *   renderer does NOT rewrite root-relative hrefs inside it (it only prefixes
 *   the hrefs of link-carrying sections such as `cta`). That is why the
 *   event "Add to calendar" link can be the origin-relative
 *   `/public/<slug>/events/<id>/ics`: the public API is mounted at the origin
 *   of every host (src/index.ts passes `/public/` through on tenant hosts and
 *   serves it directly on the platform host), never under `/g/<slug>`.
 * - `rawHtml` is platform-authored markup `serveSite` appends after the
 *   sections, inside `<main>`, for the few things the sanitizer cannot carry
 *   (a search input, `data-*` hooks). Every tenant string inside it is
 *   escaped here; nothing tenant-authored is emitted raw.
 * - A detail kind (`event`, `gallery`, `post`) whose `param` does not match
 *   the loaded data returns the `not_found` stack with `status: 404`, so
 *   callers get one shape regardless of the lookup outcome.
 * - `members_only` is `noindex: true`; `not_found` is `status: 404`.
 * - `directory` renders the members-only stack unless
 *   `profile.directory_public`; `donate` is `not_found` when
 *   `profile.donations_enabled === false`.
 */

import type { Tenant } from "../../../types";
import type { SiteDesign } from "../design/tokens";
import type { SiteData, SiteDirectoryMember, SiteEvent, SiteGallery, SitePost } from "../data.types";
import type { Section, SectionStyle } from "../sections/schema";
import { DEFAULT_STYLE } from "../sections/schema";
import { escapeHtml } from "../../blocks";
import { sanitizeHtml, sanitizeUrl } from "../../sanitize";
import { formatMoney } from "../../utils/money";
import { toIcsDate } from "../../ical";

// The zone a guild's event times are displayed in when it has not chosen one.
import { DEFAULT_TIMEZONE } from "../timezone";
export type SystemPageKind =
  | "membership"
  | "events"
  | "event"
  | "calendar"
  | "galleries"
  | "gallery"
  | "blog"
  | "post"
  | "directory"
  | "donate"
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
  /** Platform-authored markup appended after the sections; see the header comment. */
  rawHtml?: string;
};

/** Prefix used on the event detail register button; see the header comment. */
export const REGISTER_CTA_ID_PREFIX = "register-";

/** Prefix used on the event detail volunteer button; the island binds `.qh-cta[id^="volunteer-"]`. */
export const VOLUNTEER_CTA_ID_PREFIX = "volunteer-";

/** Suggested one-time gifts on the donate page (cents); "Other amount" is always offered too. */
export const DONATE_AMOUNTS_CENTS: readonly number[] = [1000, 2500, 5000, 10000];

/** Section id of the donate strip on the `/donate` page; the header CTA targets it. */
export const DONATE_SECTION_ID = "donate";


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

/** `/public/<slug>/events/<id>/ics` -- the single-event download public.ts serves at the origin of every host. */
export function eventIcsPath(slug: string, eventId: string): string {
  return `/public/${encodeURIComponent(slug)}/events/${encodeURIComponent(eventId)}/ics`;
}

/**
 * Google Calendar's "add this event" template URL, built from the event
 * fields: UTC basic dates (`YYYYMMDDTHHmmssZ`), a two-hour default end like
 * the .ics feed, location and details when present. Null when the start
 * date does not parse. The `/` between the dates stays literal; everything
 * else is percent-encoded.
 */
export function googleCalendarUrl(ev: Pick<SiteEvent, "title" | "start_at" | "end_at" | "location" | "description">): string | null {
  const start = toIcsDate(ev.start_at);
  if (!start) return null;
  const end = (ev.end_at && toIcsDate(ev.end_at)) || toIcsDate(new Date(new Date(ev.start_at).getTime() + 2 * 3600_000).toISOString());
  const parts = [`action=TEMPLATE`, `text=${encodeURIComponent(ev.title)}`, `dates=${start}/${end}`];
  const location = ev.location?.trim();
  if (location) parts.push(`location=${encodeURIComponent(location)}`);
  const details = ev.description?.trim();
  if (details) parts.push(`details=${encodeURIComponent(details.slice(0, 1000))}`);
  return `https://calendar.google.com/calendar/render?${parts.join("&")}`;
}

/** Only an absolute http(s) URL may be linked from a member's showcase. */
function showcaseWebsite(raw: string | undefined): string | null {
  const clean = raw ? sanitizeUrl(raw, "link") : null;
  return clean && /^https?:\/\//i.test(clean) ? clean : null;
}

// ---------------------------------------------------------------------------
// Section factories
// ---------------------------------------------------------------------------

function hero(id: string, title: string, subtitle?: string): Section {
  return { type: "hero", variant: "minimal", title, subtitle: subtitle || undefined, style: style(), id };
}

/**
 * The header for a page whose job is to show a list.
 *
 * A full hero puts a large centred title and a subtitle above the fold, and on
 * a phone that is most of the first screen spent on the word "Events" before a
 * single event appears. These pages are read, not landed on, so the header is
 * compact and the content starts near the top.
 */
function listHeader(id: string, title: string, subtitle?: string): Section {
  return {
    type: "hero",
    variant: "minimal",
    title,
    subtitle: subtitle || undefined,
    style: style({ spacing: "tight" }),
    id,
  };
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
      listHeader("events-hero", "Events", `Upcoming meetings, workshops, and shows from ${ctx.tenant.name}.`),
      { type: "events", variant: "list", limit: 50, viewSwitch: true, style: style({ spacing: "tight" }), id: "events-list" },
    ],
  };
}

function calendarPage(): SystemPage {
  return {
    title: "Calendar",
    sections: [
      listHeader("calendar-hero", "Calendar"),
      {
        type: "events",
        variant: "calendar",
        limit: 50,
        viewSwitch: true,
        style: style({ width: "wide", spacing: "tight" }),
        id: "calendar",
      },
    ],
  };
}

/** "Add to calendar" (.ics download) and "Google Calendar" as secondary buttons in a prose section. */
function calendarLinks(ctx: SystemPageContext, ev: SiteEvent): Section {
  const links = [`<a class="qh-btn qh-btn--secondary" href="${escapeHtml(eventIcsPath(ctx.tenant.slug, ev.id))}">Add to calendar</a>`];
  const google = googleCalendarUrl(ev);
  if (google) links.push(`<a class="qh-btn qh-btn--secondary" href="${escapeHtml(google)}" target="_blank" rel="noopener">Google Calendar</a>`);
  return {
    type: "rich_text",
    variant: "prose",
    html: sanitizeHtml(`<p class="qh-actions">${links.join("")}</p>`),
    style: style({ width: "narrow", spacing: "tight" }),
    id: "event-calendar",
  };
}

function eventPage(ctx: SystemPageContext, ev: SiteEvent, timeZone: string): SystemPage {
  // Compact, for the same reason the list pages are: an event page is read,
  // not landed on. A full hero spent a phone's whole first screen on the
  // title and the date, and pushed the description — the thing you clicked
  // through to read — most of a screen below the fold.
  const sections: Section[] = [listHeader("event-hero", ev.title, formatEventWhen(ev, timeZone))];
  const body = descriptionToHtml(ev.description);
  if (body) {
    sections.push({
      type: "rich_text",
      variant: "prose",
      html: body,
      // Tight like the rest of this stack: the page is six or seven short
      // sections, and at normal spacing each one's padding met the next one's,
      // leaving a fifth of a phone screen blank between two paragraphs.
      style: style({ width: "narrow", spacing: "tight" }),
      id: "event-description",
    });
  }
  // What to bring, for a class or a workshop. Placed before the price and the
  // register button: someone deciding whether to sign up needs to know they
  // have to bring a machine BEFORE they pay, not after.
  if (ev.bring && ev.bring.length) {
    sections.push({
      type: "rich_text",
      variant: "prose",
      heading: "What to bring",
      html: sanitizeHtml(`<ul>${ev.bring.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`),
      style: style({ width: "narrow", bg: "tint", spacing: "tight" }),
      id: "event-bring",
    });
  }
  sections.push(calendarLinks(ctx, ev));
  sections.push({
    type: "feature_grid",
    variant: "icons",
    heading: "Pricing",
    items: [
      { title: "Members", price: price(ev.member_price_cents) },
      { title: "Non-members", price: price(ev.non_member_price_cents) },
    ],
    style: style({ width: "narrow", spacing: "tight" }),
    id: "event-pricing",
  });
  // Spots, between the price and the button, for the same reason What to
  // bring sits above them: someone deciding whether to sign up should learn
  // the class is nearly full — or already full — before they commit, not from
  // a refusal after they have filled the form in. Capped events only.
  const spotsLeft =
    ev.capacity != null && ev.capacity > 0 && ev.seats_taken != null
      ? Math.max(0, ev.capacity - ev.seats_taken)
      : null;
  if (spotsLeft != null) {
    sections.push({
      type: "rich_text",
      variant: "prose",
      html: sanitizeHtml(
        spotsLeft === 0
          ? `<p><strong>This event is full.</strong> All ${ev.capacity} spots are taken. ` +
            `Contact the guild to ask about a waiting list.</p>`
          : `<p><strong>${spotsLeft} of ${ev.capacity} spots left.</strong></p>`
      ),
      style: style({ width: "narrow", bg: spotsLeft === 0 ? "tint" : "none", spacing: "tight" }),
      id: "event-spots",
    });
  }
  if (ev.registration_open && spotsLeft !== 0) {
    // See the header comment: the register island binds [id^="register-"].
    sections.push(cta(`${REGISTER_CTA_ID_PREFIX}${ev.id}`, "Register", "#", "primary"));
  }
  if ((ev.volunteer_slots ?? 0) > 0) {
    sections.push({
      type: "rich_text",
      variant: "prose",
      heading: "Volunteer",
      html: sanitizeHtml(
        "<p>This event runs on volunteers. Pick a slot that suits you — setup, refreshments, a show shift — and we'll save you a spot.</p>"
      ),
      style: style({ width: "narrow", bg: "tint" }),
      id: "event-volunteer",
    });
    // The volunteer island binds .qh-cta[id^="volunteer-"] and opens the sign-up dialog.
    sections.push(cta(`${VOLUNTEER_CTA_ID_PREFIX}${ev.id}`, "Volunteer sign-up", "#", "secondary"));
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

/**
 * One directory card per member: name, optional photo (served by the public
 * member-photo route, which re-checks directory visibility), headline, bio,
 * interests and website from the showcase. Rendered as rawHtml because the
 * search box above the list is an `<input>` the sanitizer would drop.
 */
function directoryHtml(ctx: SystemPageContext, members: SiteDirectoryMember[]): string {
  const slug = encodeURIComponent(ctx.tenant.slug);
  const cards = members.map((m) => {
    const name = [m.first_name, m.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ") || "Member";
    const photo = m.photo_file_id
      ? `<img class="qh-directory__photo" src="/public/${slug}/member-photo/${encodeURIComponent(m.photo_file_id)}" alt="" width="96" height="96" loading="lazy">`
      : "";
    const headline = m.showcase.headline ? `<p class="qh-muted qh-directory__headline">${escapeHtml(m.showcase.headline)}</p>` : "";
    const bio = m.bio?.trim() ? `<p class="qh-directory__bio">${escapeHtml(m.bio.trim())}</p>` : "";
    const interests = m.showcase.interests ? `<p class="qh-directory__interests"><strong>Interests:</strong> ${escapeHtml(m.showcase.interests)}</p>` : "";
    const site = showcaseWebsite(m.showcase.website);
    const website = site ? `<p><a href="${escapeHtml(site)}" target="_blank" rel="noopener nofollow">Website</a></p>` : "";
    return `<article class="qh-card qh-directory__member">${photo}<h3 class="qh-directory__name">${escapeHtml(name)}</h3>${headline}${bio}${interests}${website}</article>`;
  });
  return (
    `<section id="directory" class="qh-s qh-s--bg-none qh-s--w-normal qh-s--sp-normal qh-s--media-right qh-directory">` +
    `<div class="qh-form qh-directory__search"><label><span>Search members</span>` +
    `<input type="search" data-directory-filter="directory-list" placeholder="Name, interest, or town" autocomplete="off"></label></div>` +
    `<p class="qh-muted qh-directory__count" data-directory-count>${plural(members.length, "member", "members")}</p>` +
    `<div class="qh-grid qh-grid--2 qh-directory__list" id="directory-list">${cards.join("")}</div>` +
    `</section>`
  );
}

function directoryPage(ctx: SystemPageContext): SystemPage {
  if (!ctx.data.profile?.directory_public) return membersOnlyPage(ctx);
  const guild = ctx.tenant.name;
  const members = ctx.data.directory ?? [];
  const sections: Section[] = [hero("directory-hero", "Members", `${guild} members who chose to be listed.`)];
  if (!members.length) {
    sections.push(prose("directory-empty", "<p>No members are listed yet. Members can add themselves from the member portal.</p>"));
    return { title: "Members", sections };
  }
  return { title: "Members", sections, rawHtml: directoryHtml(ctx, members) };
}

/**
 * Support page: a hero, where gifts go (the profile description when there
 * is one) and the `donate` section whose buttons the donate island binds
 * (`[data-donate=cents]`; "Other amount" prompts). The header CTA resolves
 * to `#donate` here and to `/donate` everywhere else (render.ts).
 */
function donatePage(ctx: SystemPageContext): SystemPage {
  if (ctx.data.profile?.donations_enabled === false) return notFoundPage(ctx);
  const guild = ctx.tenant.name;
  const about = ctx.data.profile?.description?.trim() || `${guild} is run by volunteers, and every gift goes straight to the guild's work.`;
  return {
    title: "Donate",
    sections: [
      hero("donate-hero", `Support ${guild}`, "Your gift keeps our meetings, workshops, and community programs going."),
      prose(
        "donate-body",
        sanitizeHtml(`<p>${escapeHtml(about)}</p><p>Donations are one-time and processed securely by Stripe. You'll get a receipt by email.</p>`)
      ),
      {
        type: "donate",
        heading: "Make a one-time gift",
        body: "Choose an amount, or enter your own.",
        amounts: [...DONATE_AMOUNTS_CENTS],
        style: style({ bg: "tint", align: "center", width: "narrow" }),
        id: DONATE_SECTION_ID,
      },
    ],
  };
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
    case "directory":
      return directoryPage(ctx);
    case "donate":
      return donatePage(ctx);
    case "members_only":
      return membersOnlyPage(ctx);
    case "not_found":
      return notFoundPage(ctx);
  }
}
