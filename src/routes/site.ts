// src/routes/site.ts
// Serves a tenant's public website (guild or business) through the section
// renderer: pages, the composed home, system pages (membership, events,
// calendar, galleries, blog), images, sitemap, robots, and the business
// quote/e-signature pages. `serveSite` is the entry point for tenant hosts
// and for /g/<slug>/* on the platform host. It is the only renderer: the
// classic guild.html shell was removed in v0.61.0.

import type { Context } from "hono";
import type { Env, Tenant, Project, ProjectLine, AgreementSignature } from "../types";
import { all, first } from "../lib/db";
import { APP_VERSION } from "../version";
import {
  renderSitePage,
  buildMenu,
  withEventsLink,
  readSettingsMenu,
  readBranding,
  type RenderArgs,
  type SitePageArgs,
} from "../lib/site/render";
import { readSiteDesign } from "../lib/site/design/migrate";
import { needsFor, loadSiteData, readProfile, excerptFromHtml } from "../lib/site/data";
import type { DataNeed, SiteData, SitePost, SiteProfile } from "../lib/site/data";
import { systemPageSections, type SystemPageKind } from "../lib/site/pages/system";
import { buildOrganizationJsonLd, buildEventJsonLd } from "../lib/site/seo";
import { sectionsFromPage } from "../lib/site/sections/normalize";
import type { ImgMeta } from "../lib/site/sections/render";
import { DEFAULT_STYLE, type Section, type SectionStyle } from "../lib/site/sections/schema";
import { isLaunched } from "../lib/tenantType";
import { cachedRender } from "../lib/site/cache";
import { findRedirect } from "../lib/pageDrafts";
import { tenantPublicBaseUrl } from "../lib/tenantHost";
import { renderQuotePage, renderSignedCopy, renderInvalidLink, renderCannotSign } from "../lib/site/quote";
import { hashToken } from "../lib/projects/token";
import { assertTransition } from "../lib/projects/status";
import { buildGuardedStatusUpdate } from "../lib/projects/statusWrite";
import type { ProjectStatus } from "../lib/projects/types";
import { buildAgreementSnapshot, CONSENT_TEXT, type AgreementSnapshotLine } from "../lib/projects/agreement";
import { sha256Hex } from "../lib/projects/hash";
import { sendEmail } from "../lib/email";
import { escapeHtml, contentFromPage } from "../lib/blocks";
import { generateId } from "../lib/utils/id";

// Shared by every route that echoes a stored `files.content_type` back as a
// real image response (this file's /img/:fileId, galleries.ts's photo raw
// route, public.ts's public gallery photo route): allowlists the handful of
// real raster image types and excludes everything else, including
// image/svg+xml -- SVG is active content (it can carry inline <script>) and
// would reopen stored-XSS even though its MIME type looks image-y. The set
// itself now lives in lib/images.ts (serveImage enforces it); re-exported
// here for the routes written against this import.
export { ALLOWED_IMAGE_TYPES } from "../lib/images";
import { ALLOWED_IMAGE_TYPES, IMAGE_ROW_COLUMNS, serveImage, type ImageRow, parseFocal } from "../lib/images";

// A shop that never finished configuring its agreement can't produce a
// signable estimate -- shown on GET and enforced again on POST (Task 10 fix
// round 1, Minor #3).
const EMPTY_AGREEMENT_MESSAGE =
  "This shop has not finished setting up a service agreement for this estimate yet. Please check back soon.";

// buildAgreementSnapshot's money()/assertIntCents() throw a TypeError on a
// non-integer cents value -- reachable in practice, not just theoretically:
// the admin UI rounds rate inputs before saving, but PATCH /api/tenants/:id
// does not, so a fractional minimumCents written straight through the API
// produces a fractional amount_cents at intake, which flows into
// total_cents and every line's amount_cents untouched. Before this guard,
// that reached the customer's quote page as an uncaught throw -- a 500 on
// the one page an anonymous token holder has no way to route around (final
// review, F8).
const INVALID_PRICING_MESSAGE =
  "This estimate cannot be displayed right now due to a pricing configuration issue. Please contact us for an updated quote.";

/**
 * A customer-safe explanation for every project status other than
 * 'estimated' -- the only status assertTransition() allows a transition to
 * 'signed' from. Used both when rendering the GET page (so the sign form is
 * never shown for a project that can't accept a signature) and inside
 * signQuote's assertTransition catch block, so a customer is NEVER handed
 * the raw internal string an Error("Illegal transition: a -> b") carries
 * (Task 10 fix round 1, Minor #2).
 */
function cannotSignMessage(status: string): string {
  switch (status) {
    case "declined":
      return "This estimate was declined and is no longer available for signature.";
    case "cancelled":
      return "This project was cancelled and is no longer available for signature.";
    case "submitted":
      return "This project has not been estimated yet. Please check back soon.";
    case "signed":
      return "This estimate has already been signed.";
    case "in_progress":
      return "This project is already in progress.";
    case "completed":
      return "This project has already been completed.";
    default:
      return "This estimate is not currently available for signature.";
  }
}

type PageRow = {
  id: string;
  slug: string;
  title: string;
  content_json: string | null;
  blocks_json: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_image_file_id: string | null;
  noindex: number;
  updated_at: string;
};

/** Shared by the GET quote render and the POST sign handler, so both build
 * the agreement title/body from tenant.settings_json the exact same way --
 * that identical construction is what makes the render-time hash and the
 * sign-time hash comparable at all. */
function readAgreementFields(tenant: Tenant): { title: string; body: string } {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {
    settings = {};
  }
  const longarm = (settings.longarm || {}) as { agreementTitle?: string; agreementBody?: string };
  return {
    title: longarm.agreementTitle || "Service Agreement",
    body: longarm.agreementBody || "",
  };
}

async function loadNav(env: Env, tenant: Tenant) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {
    settings = {};
  }
  const explicit = Array.isArray(settings.nav) ? settings.nav : [];
  if (explicit.length) {
    return explicit
      .filter((n) => typeof n === "object" && n !== null)
      .map((n: Record<string, unknown>) => ({
        label: String(n.label || "").slice(0, 60),
        href: String(n.href || "").slice(0, 500),
        external: !!n.external,
      }))
      .filter((n) => n.label && n.href)
      .slice(0, 20);
  }
  const rows = await all<{ slug: string; title: string; nav_label: string | null }>(
    env.DB.prepare(
      `SELECT slug, title, nav_label FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         AND deleted_at IS NULL
         AND coalesce(show_in_nav, 1) = 1 AND coalesce(page_type, 'page') = 'page'
       ORDER BY sort_order, title`
    ).bind(tenant.id)
  );
  return rows.map((r) => ({
    label: r.nav_label || r.title,
    href: r.slug ? `/${r.slug}` : "/",
  }));
}

/**
 * Everything renderPageHtml needs for one page on one host, built the same
 * way for the live site (serveBusinessSite) and the admin preview
 * (GET /api/tenants/:id/pages/:pageId/preview). `page.slug` is the URL slug
 * ("" for the home page), not necessarily the stored slug.
 */
export async function buildRenderArgs(
  env: Env,
  tenant: Tenant,
  page: {
    slug: string;
    title: string;
    seo_title?: string | null;
    seo_description?: string | null;
    og_image_file_id?: string | null;
    noindex?: number | null;
    content_json?: string | null;
    blocks_json?: string | null;
  },
  host: string
): Promise<RenderArgs> {
  const baseUrl = tenantPublicBaseUrl(env, tenant, host);
  const nav = await loadNav(env, tenant);
  const { showPlatformCredit } = readBranding(tenant.settings_json);

  let logoFileId = "";
  try {
    logoFileId = String(
      (JSON.parse(tenant.settings_json || "{}").assets || {}).logo_file_id || ""
    );
  } catch {
    logoFileId = "";
  }
  const logoUrl = logoFileId ? `${baseUrl}/img/${logoFileId}` : null;
  const ogImageUrl = page.og_image_file_id ? `${baseUrl}/img/${page.og_image_file_id}` : null;

  return {
    tenant: { name: tenant.name, slug: tenant.slug, settings_json: tenant.settings_json },
    page: {
      title: page.title,
      slug: page.slug,
      seo_title: page.seo_title ?? null,
      seo_description: page.seo_description ?? null,
      og_image_file_id: page.og_image_file_id ?? null,
      noindex: page.noindex ?? 0,
      content_json: page.content_json ?? null,
      blocks_json: page.blocks_json ?? null,
    },
    nav,
    baseUrl,
    logoUrl,
    ogImageUrl,
    showPlatformCredit,
  };
}

// ---------------------------------------------------------------------------
// serveSite — one renderer for guild and business sites
// ---------------------------------------------------------------------------

/** `SELECT * FROM tenants WHERE slug = ? AND status = 'active'` — the same lookup public.ts uses. */
export async function getTenantBySlug(db: D1Database, slug: string): Promise<Tenant | null> {
  return first<Tenant>(
    db.prepare("SELECT * FROM tenants WHERE slug = ? AND status = 'active'").bind(slug)
  );
}

function parseSettings(settingsJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(settingsJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type SiteRoute =
  | { kind: "home" }
  | { kind: "page"; slug: string }
  | { kind: "not_found"; slug: string }
  | { kind: Exclude<SystemPageKind, "members_only" | "not_found">; param?: string };

/**
 * The routing table, on the path AFTER the base path. `null` means "not a
 * site route" (the renderer's own assets), so the caller falls through to the
 * static asset binding. System routes win over a stored page with the same
 * slug; anything deeper than the shapes below is `not_found`.
 */
export function resolveSiteRoute(path: string): SiteRoute | null {
  if (path === "/qh-site.css" || path === "/qh-site.js") return null;
  const rel = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel === "") return { kind: "home" };
  const parts = rel.split("/");
  const [head, second] = parts;
  if (parts.length === 1) {
    switch (head) {
      case "membership":
      case "join":
      case "join-renew":
        return { kind: "membership" };
      case "events":
        return { kind: "events" };
      case "calendar":
        return { kind: "calendar" };
      case "galleries":
      case "photos":
        return { kind: "galleries" };
      case "blog":
        return { kind: "blog" };
      case "directory":
        return { kind: "directory" };
      case "donate":
        return { kind: "donate" };
      default:
        return { kind: "page", slug: head };
    }
  }
  if (parts.length === 2 && second) {
    if (head === "events") return { kind: "event", param: second };
    if (head === "galleries") return { kind: "gallery", param: second };
    if (head === "blog") return { kind: "post", param: second };
  }
  return { kind: "not_found", slug: rel };
}

type SitePageRow = PageRow & { is_members_only: number; created_at: string };

const PAGE_COLUMNS = `id, slug, title, content_json, blocks_json, seo_title, seo_description,
              og_image_file_id, coalesce(noindex, 0) AS noindex,
              coalesce(is_members_only, 0) AS is_members_only, created_at, updated_at`;

/** One published, non-deleted page by slug (members-only rows included; the caller renders the sign-in stack). */
function pageBySlugStatement(db: D1Database, tenantId: string, slug: string, postOnly: boolean): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${PAGE_COLUMNS}
       FROM pages
       WHERE tenant_id = ? AND published = 1
         AND deleted_at IS NULL
         AND slug = ?${postOnly ? " AND coalesce(page_type, 'page') = 'blog_post'" : ""}
       LIMIT 1`
    )
    .bind(tenantId, slug);
}

/**
 * Sections for a stored page. Kits (kits/apply.ts) write section documents
 * into `blocks_json`, and older editors wrote legacy block arrays there;
 * `parseSections` accepts both, so `blocks_json` is offered as the section
 * source first and `sectionsFromPage` falls back to the block and
 * content_json paths on its own.
 */
function pageSections(row: { blocks_json: string | null; content_json: string | null }): Section[] {
  return sectionsFromPage({ sections_json: row.blocks_json, blocks_json: row.blocks_json, content_json: row.content_json });
}

function sectionStyle(overrides: Partial<SectionStyle> = {}): SectionStyle {
  return { ...DEFAULT_STYLE, ...overrides };
}

/**
 * The composed default home (spec §5.2) for a guild with no `home` page:
 * hero from the profile, the membership levels, the next three events, the
 * latest three posts and a join band -- so every guild has a real home the
 * moment it exists.
 */
export function defaultHomeSections(tenant: Pick<Tenant, "name">, profile: SiteProfile): Section[] {
  return [
    {
      type: "hero",
      variant: "minimal",
      title: tenant.name,
      subtitle: profile.description?.trim() || undefined,
      ctaLabel: "Join",
      ctaHref: "/membership",
      secondaryLabel: "See events",
      secondaryHref: "/events",
      style: sectionStyle({ align: "center" }),
      id: "home-hero",
    },
    { type: "membership_levels", variant: "cards", heading: "Membership", style: sectionStyle(), id: "home-levels" },
    { type: "events", variant: "cards", heading: "Upcoming events", limit: 3, style: sectionStyle({ bg: "tint" }), id: "home-events" },
    { type: "blog_teaser", heading: "News", limit: 3, style: sectionStyle(), id: "home-blog" },
    {
      type: "join_band",
      title: `Join ${tenant.name}`,
      body: "Meetings, workshops, and a community of quilters. Membership is open to all.",
      ctaLabel: "Join",
      style: sectionStyle({ bg: "brand", align: "center" }),
      id: "home-join",
    },
  ];
}

/** Data a system stack needs before it can be built (the stack itself comes from the loaded data). */
const SYSTEM_NEEDS: Record<SystemPageKind, DataNeed[]> = {
  membership: ["levels", "profile"],
  events: ["events"],
  event: ["events"], // with LoadOpts.eventId: the one event by id (past or upcoming) + its volunteer slot count
  calendar: ["events"],
  galleries: ["galleries"],
  gallery: ["gallery"],
  blog: ["posts"],
  post: [], // the post row is looked up by slug directly
  directory: ["profile", "directory"], // the directory loader only queries when profile.directory_public
  donate: ["profile"],
  members_only: [],
  not_found: [],
};

/** Events/posts the index stacks in pages/system.ts list (their sections say `limit: 50`). */
const SYSTEM_LIST_LIMIT = 50;

/** Largest events/posts limit any section on the page asks for, so one query covers every section. */
function pageLimit(sections: Section[]): number | undefined {
  let max: number | undefined;
  for (const s of sections) {
    if (s.type === "events" || s.type === "blog_teaser" || s.type === "store_teaser") {
      if (typeof s.limit === "number" && s.limit > 0) max = Math.max(max ?? 0, s.limit);
    }
  }
  return max;
}

function postFromRow(row: SitePageRow): SitePost {
  return {
    slug: row.slug,
    title: row.title,
    published_at: row.created_at,
    excerpt: excerptFromHtml(contentFromPage(row).html),
  };
}

/**
 * The members-only stack's sign-in CTA (pages/system.ts) is the root-relative
 * `/portal?slug=…`. The section renderer prefixes root-relative hrefs with
 * the base URL, which is right on a tenant host but wrong under `/g/<slug>`
 * on the platform host (the portal lives at the origin, never under the base
 * path). Pin it to an absolute URL so the renderer leaves it alone.
 */
function pinPortalLink(section: Section, origin: string): Section {
  if (section.type !== "cta" || !section.href.startsWith("/portal")) return section;
  return { ...section, href: `${origin.replace(/\/+$/, "")}${section.href}` };
}

/** Five-minute buckets: dynamic data (events, levels, posts…) changes without any updated_at the cache key can see. */
const DYNAMIC_BUCKET_MS = 5 * 60 * 1000;

/**
 * Serve a public site path for any tenant. Returns null when the path is not
 * a site page (the renderer's own qh-site.css/js, or a path outside
 * `opts.basePath`) so the caller can fall through to assets / platform routes.
 *
 * `basePath` is "" on tenant hosts and "/g/<slug>" on the platform host.
 * Every internal link is `${baseUrl}${path}`; the portal and public API stay
 * at the origin (render.ts handles that).
 */
export async function serveSite(
  c: Context<{ Bindings: Env }>,
  tenant: Tenant,
  opts: { basePath?: string } = {}
): Promise<Response | null> {
  const url = new URL(c.req.url);
  const basePath = (opts.basePath || "").replace(/\/+$/, "");
  let path = url.pathname;
  if (basePath) {
    if (path === basePath) path = "/";
    else if (path.startsWith(basePath + "/")) path = path.slice(basePath.length);
    else return null;
  }
  const host = c.req.header("host") || url.host;
  const onTenantHost = !basePath;
  const baseUrl = onTenantHost ? tenantPublicBaseUrl(c.env, tenant, host) : basePath;

  if (onTenantHost) {
    if (path === "/robots.txt") {
      // A launched business site is meant to be crawled. Point at its own
      // sitemap, not the platform's.
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const imgMatch = path.match(/^\/img\/([A-Za-z0-9_-]{1,64})$/);
    if (imgMatch) return serveTenantImage(c, tenant, imgMatch[1]);
    if (path === "/sitemap.xml") return serveSitemap(c, tenant, baseUrl);
    const quote = await serveQuotePage(c, tenant, path, baseUrl);
    if (quote) return quote;
  }

  const route = resolveSiteRoute(path);
  if (!route) return null;

  const settings = tenant.settings_json;
  const design = readSiteDesign(settings);
  const profile = readProfile(settings);

  // -- Resolve the page row (stored pages, the home page, blog posts) ------
  let row: SitePageRow | null = null;
  let kind: SystemPageKind | "page" = route.kind === "home" ? "page" : route.kind;
  let param = "param" in route ? route.param : undefined;
  let pageSectionsForRoute: Section[] = [];

  if (route.kind === "home" || route.kind === "page") {
    const slug = route.kind === "home" ? "home" : route.slug;
    row = await first<SitePageRow>(pageBySlugStatement(c.env.DB, tenant.id, slug, false));
    if (row) {
      pageSectionsForRoute = pageSections(row);
      if (row.is_members_only) kind = "members_only";
    } else if (route.kind === "home") {
      if (tenant.tenant_type === "business") kind = "not_found";
      else pageSectionsForRoute = defaultHomeSections(tenant, profile);
    } else {
      // A renamed page leaves a page_redirects row behind (pages.ts PATCH /
      // publish). Only a single path segment can ever be a slug.
      const to = await findRedirect(c.env.DB, tenant.id, route.slug);
      if (to) {
        const target = to === "home" ? "/" : `/${to}`;
        return c.redirect(`${baseUrl}${target}${url.search}`, 301);
      }
      kind = "not_found";
    }
  } else if (route.kind === "post") {
    row = await first<SitePageRow>(pageBySlugStatement(c.env.DB, tenant.id, route.param!, true));
    if (row) pageSectionsForRoute = pageSections(row);
    else kind = "not_found";
  }

  // -- Data: one batch for the page's sections, the system stack and the shell
  const needs = needsFor(pageSectionsForRoute);
  for (const n of SYSTEM_NEEDS[kind === "page" ? "not_found" : kind]) needs.add(n);
  if (design.footer.variant === "meeting") needs.add("profile");
  const systemKind = kind === "page" ? null : kind;
  const listKind = systemKind === "events" || systemKind === "calendar" || systemKind === "blog";
  const limit = listKind ? SYSTEM_LIST_LIMIT : pageLimit(pageSectionsForRoute);
  const data: SiteData = await loadSiteData(c.env, tenant, needs, {
    limit,
    gallerySlug: kind === "gallery" ? param : undefined,
    // The detail page must outlive the upcoming-events window, so the loader
    // fetches this one event by id (plus its volunteer slot count) instead.
    eventId: kind === "event" ? param : undefined,
  });
  if (kind === "post" && row) data.posts = [postFromRow(row)];
  if (!data.profile && needs.has("profile")) data.profile = profile;

  // -- Sections + SEO for the page -----------------------------------------
  let title: string;
  let sections: Section[];
  let status = 200;
  let membersOnly = false;
  let noindex = 0;
  let rawHtml: string | undefined;
  let seo: Pick<SitePageRow, "seo_title" | "seo_description" | "og_image_file_id"> = {
    seo_title: null,
    seo_description: null,
    og_image_file_id: null,
  };
  if (kind === "page") {
    title = row?.title ?? tenant.name;
    sections = pageSectionsForRoute;
    noindex = row?.noindex ?? 0;
    if (row) seo = row;
  } else {
    const system = systemPageSections(kind, { tenant, design, data, param });
    title = system.title;
    sections = kind === "post" && system.status !== 404 ? [...system.sections, ...pageSectionsForRoute] : system.sections;
    // Every stack, not only members_only: a private directory renders the
    // same sign-in stack (pages/system.ts) and its portal CTA needs the same pin.
    sections = sections.map((s) => pinPortalLink(s, onTenantHost ? baseUrl : c.env.APP_URL));
    status = system.status ?? 200;
    membersOnly = kind === "members_only";
    noindex = system.noindex ? 1 : 0;
    rawHtml = system.rawHtml;
    if (kind === "post" && row) seo = row;
  }
  // noindex stacks (members-only, the private directory) are per-visitor prompts, not cacheable pages.
  const cacheable = status === 200 && !membersOnly && !noindex && kind !== "not_found";

  // -- Shell: menu, branding, image URLs -----------------------------------
  const navRows = await all<{ slug: string; title: string; nav_label: string | null; show_in_nav: number }>(
    c.env.DB.prepare(
      `SELECT slug, title, nav_label, coalesce(show_in_nav, 1) AS show_in_nav FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         AND deleted_at IS NULL
         AND coalesce(show_in_nav, 1) = 1 AND coalesce(page_type, 'page') = 'page'
       ORDER BY sort_order, title`
    ).bind(tenant.id)
  );
  const settingsMenu = readSettingsMenu(settings);
  // "I added an event, but I don't see the calendar on the site": /events and
  // /calendar are system pages, so nothing in `pages` ever linked to them.
  // One indexed COUNT (idx_events_public) decides whether the guild has
  // anything to show there.
  const eventCount = await first<{ n: number }>(
    c.env.DB.prepare(
      `SELECT count(*) AS n FROM events WHERE tenant_id = ? AND is_public = 1 AND datetime(start_at) >= datetime('now', '-1 day')`
    ).bind(tenant.id)
  );
  const menu = withEventsLink(buildMenu(navRows, settingsMenu, baseUrl), baseUrl, {
    hasEvents: (eventCount?.n ?? 0) > 0,
    explicitMenu: settingsMenu.length > 0,
  });
  const { showPlatformCredit } = readBranding(settings);
  const q = (w?: number) => (w ? `?w=${w}` : "");
  const imgUrl: SitePageArgs["imgUrl"] = onTenantHost
    ? (id, w) => `${baseUrl}/img/${id}${q(w)}`
    : (id, w) => `/public/${encodeURIComponent(tenant.slug)}/img/${id}${q(w)}`;
  // Intrinsic size + focal point for every uploaded image the page renders,
  // in one query, so <img> can carry width/height (no layout shift) and
  // object-position. Pattern references ("pattern:<id>") are not files.
  const imageIds = collectImageIds(sections);
  const imgMeta = await loadImgMeta(c.env, tenant.id, imageIds);

  const logoFileId = String(((parseSettings(settings).assets || {}) as { logo_file_id?: unknown }).logo_file_id || "");
  const logoUrl = logoFileId ? imgUrl(logoFileId) : null;
  const ogImageUrl = seo.og_image_file_id ? imgUrl(seo.og_image_file_id) : null;
  // Never let an unlaunched site into an index, whichever host it renders on.
  const extraHead = isLaunched(tenant) ? undefined : `<meta name="robots" content="noindex">`;
  const slug = path === "/" ? "" : path.replace(/^\/+/, "").replace(/\/+$/, "");

  // Structured data: Organization on every guild page (businesses get
  // LocalBusiness from render.ts) and Event on a found event detail. The
  // urls in it must be absolute, so under /g/<slug> they are built on APP_URL.
  const appOrigin = (c.env.APP_URL || "").replace(/\/+$/, "");
  const absoluteBase = onTenantHost ? baseUrl : `${appOrigin}${basePath}`;
  const jsonLd: string[] = [];
  if (tenant.tenant_type !== "business") {
    const absoluteLogo = logoUrl && logoUrl.startsWith("/") ? `${appOrigin}${logoUrl}` : logoUrl;
    jsonLd.push(buildOrganizationJsonLd(tenant.name, absoluteBase, absoluteLogo));
  }
  if (kind === "event" && status === 200 && data.events?.[0]) {
    jsonLd.push(buildEventJsonLd(data.events[0], absoluteBase));
  }

  const args: SitePageArgs = {
    tenant: { name: tenant.name, slug: tenant.slug, settings_json: settings, tenant_type: tenant.tenant_type === "business" ? "business" : "guild" },
    page: {
      title,
      slug,
      seo_title: seo.seo_title ?? null,
      seo_description: seo.seo_description ?? null,
      og_image_file_id: seo.og_image_file_id ?? null,
      noindex,
      sections,
      membersOnly,
    },
    menu,
    baseUrl,
    host,
    logoUrl,
    ogImageUrl,
    showPlatformCredit,
    design,
    data,
    imgUrl,
    imgMeta,
    extraHead,
    jsonLd,
    rawHtml,
  };

  if (!cacheable) {
    return new Response(renderSitePage(args), {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Nav is built from the whole pages list, so publishing, renaming, or
  // trashing ANOTHER page must also invalidate this page's cached render.
  // max(updated_at) across the tenant's pages moves on every one of those
  // writes, so folding it into the key covers it without a purge.
  const siteVersion = await first<{ v: string | null }>(
    c.env.DB.prepare(`SELECT max(updated_at) AS v FROM pages WHERE tenant_id = ?`).bind(tenant.id)
  );
  // Dynamic data (events, levels, posts, galleries) has no updated_at the
  // key can see, so pages that render it also fold in a coarse time bucket.
  const dynamic = [...needs].some((n) => n !== "profile");
  const bucket = dynamic ? String(Math.floor(Date.now() / DYNAMIC_BUCKET_MS)) : "";

  return cachedRender({
    host,
    path: url.pathname,
    // Folds in tenant.updated_at, not just the page's own updated_at:
    // identity, logo, nav, theme and design all live in tenant.settings_json,
    // and src/routes/tenants.ts's PATCH handler bumps tenants.updated_at on
    // every settings save -- so a theme change re-renders without a purge.
    //
    // Each component is percent-encoded BEFORE being joined with ":" so a
    // literal ":" or "%" inside any raw value can never be reparsed into a
    // different (page, tenant, site, bucket) tuple.
    //
    // APP_VERSION is in the key because a renderer change is invisible to
    // every other component: pages cached for a day kept serving the old
    // markup after a deploy, so a fix to the site renderer did not reach a
    // live site until its content happened to change.
    updatedAt: [row?.updated_at || kind, tenant.updated_at, siteVersion?.v || "0", bucket, APP_VERSION]
      .map((v) => encodeURIComponent(v))
      .join(":"),
    build: () => renderSitePage(args),
  });
}

/** `serveSite` on a tenant host; kept for callers written against the business-only name. */
export function serveBusinessSite(c: Context<{ Bindings: Env }>, tenant: Tenant): Promise<Response | null> {
  return serveSite(c, tenant);
}

/**
 * Tenant-uploaded images (logo, OG image, and anything else uploaded through
 * the Files admin page). tenant_id in the WHERE clause is what stops one
 * tenant's file id from reading another tenant's image -- see siteGate's
 * TENANT_IMAGE_PATH_RE for the allowlist that lets this path shape through
 * the private-preview gate in the first place.
 */
async function serveTenantImage(c: Context<{ Bindings: Env }>, tenant: Tenant, fileId: string): Promise<Response> {
  const fileRow = await first<ImageRow>(
    c.env.DB.prepare(`SELECT ${IMAGE_ROW_COLUMNS} FROM files WHERE id = ? AND tenant_id = ?`).bind(fileId, tenant.id)
  );
  if (!fileRow) return new Response("Not found", { status: 404 });
  // Security: this route is served on the tenant's own first-party origin,
  // so echoing back whatever content_type was recorded at upload time
  // (fileRoutes.post("/") accepts ANY Content-Type a caller with upload
  // rights sends) would let a stored `text/html` file execute as same-origin
  // script on the tenant's live site -- stored XSS, not cross-tenant, but
  // real. serveImage allowlists the handful of real raster types
  // (ALLOWED_IMAGE_TYPES; image/svg+xml deliberately excluded), sets
  // nosniff + immutable caching, and picks a stored variant per ?w= / ?f=
  // (format negotiated from Accept when ?f is absent). null means nothing
  // servable -- 404, never a guess.
  const res = await serveImage(c.env, fileRow, new URL(c.req.url), c.req.header("accept"));
  return res ?? new Response("Not found", { status: 404 });
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** `YYYY-MM-DD` from an ISO timestamp; undefined when there is nothing usable (the tag is then omitted). */
function lastmodOf(iso: string | null | undefined): string | undefined {
  const day = (iso || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

type SitemapPageRow = { slug: string; updated_at: string; page_type: string };
type SitemapEventRow = { id: string; start_at: string; updated_at: string | null };

/**
 * sitemap.xml for a tenant host: everything a crawler may index. The home,
 * the system indexes (`/events`, `/calendar`, `/galleries`, `/blog`, and for
 * a guild `/membership` plus `/directory` / `/donate` when they are turned
 * on), every published, public, indexable page, each published blog post at
 * `/blog/<slug>` (where it actually lives) and each upcoming public event at
 * `/events/<id>`. `<lastmod>` is the row's `updated_at` (an event falls back
 * to `start_at`). An unlaunched tenant renders every page noindex, so its
 * sitemap is an empty urlset rather than a list of pages it asks crawlers
 * to skip.
 */
async function serveSitemap(c: Context<{ Bindings: Env }>, tenant: Tenant, baseUrl: string): Promise<Response> {
  const base = baseUrl.replace(/\/+$/, "");
  const entries: { path: string; lastmod?: string }[] = [];

  if (isLaunched(tenant)) {
    const [pagesResult, eventsResult] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT slug, updated_at, coalesce(page_type, 'page') AS page_type FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND deleted_at IS NULL
           AND coalesce(noindex, 0) = 0
         ORDER BY sort_order, title`
      ).bind(tenant.id),
      c.env.DB.prepare(
        `SELECT id, start_at, updated_at FROM events
         WHERE tenant_id = ? AND is_public = 1 AND start_at >= datetime('now')
         ORDER BY start_at ASC LIMIT 500`
      ).bind(tenant.id),
    ]);
    const pages = (pagesResult?.results ?? []) as SitemapPageRow[];
    const events = (eventsResult?.results ?? []) as SitemapEventRow[];
    const isGuild = tenant.tenant_type !== "business";
    const profile = readProfile(tenant.settings_json);

    const home = pages.find((p) => p.slug === "home" && p.page_type === "page");
    entries.push({ path: "/", lastmod: lastmodOf(home?.updated_at) });
    if (isGuild) entries.push({ path: "/membership" });
    entries.push({ path: "/events" }, { path: "/calendar" }, { path: "/galleries" }, { path: "/blog" });
    if (isGuild && profile.directory_public) entries.push({ path: "/directory" });
    if (isGuild && profile.donations_enabled !== false) entries.push({ path: "/donate" });
    for (const p of pages) {
      if (!p.slug || p.slug === "home") continue;
      const path = p.page_type === "blog_post" ? `/blog/${p.slug}` : `/${p.slug}`;
      entries.push({ path, lastmod: lastmodOf(p.updated_at) });
    }
    for (const e of events) {
      entries.push({ path: `/events/${encodeURIComponent(e.id)}`, lastmod: lastmodOf(e.updated_at) ?? lastmodOf(e.start_at) });
    }
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    urls.push(`<url><loc>${xmlEscape(`${base}${e.path}`)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`);
  }
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } }
  );
}

/**
 * Customer quote page (business tenants). Matched BEFORE the page-slug lookup.
 *
 * There is no collision with a page whose slug is "quote": a page slug is one
 * path segment, this is two, and pages.ts's slugify strips "/", so
 * "quote/<token>" can never equal a stored slug. No reserved-slug machinery is
 * needed.
 *
 * No siteGate change is required either: rule 5 already passes any path that
 * is not a reserved platform prefix, and "quote" is not in
 * PLATFORM_PATH_PREFIXES (src/lib/platformPaths.ts).
 *
 * Returns null when `path` is not a quote path.
 */
async function serveQuotePage(
  c: Context<{ Bindings: Env }>,
  tenant: Tenant,
  path: string,
  baseUrl: string
): Promise<Response | null> {
  const quoteMatch = path.match(/^\/quote\/([A-Za-z0-9_-]{20,120})$/);
  const signMatch = path.match(/^\/quote\/([A-Za-z0-9_-]{20,120})\/sign$/);
  if (!quoteMatch && !signMatch) return null;

  const rawToken = (quoteMatch || signMatch)![1];
  const tokenHash = await hashToken(rawToken);
  // Scoped to the resolved (Host-header) tenant, not just the token hash.
  // access_token_hash is already globally unique (idx_projects_token_hash),
  // so this AND is defense in depth rather than the only thing preventing
  // a token minted for tenant A from resolving on tenant B's host -- but
  // it also means a request that reaches the wrong tenant's host for a
  // given token fails the SAME way as an unknown token, not with a
  // different error, which matters for property 4 below.
  const project = await first<Project>(
    c.env.DB.prepare(
      `SELECT * FROM projects WHERE access_token_hash = ? AND tenant_id = ?`
    ).bind(tokenHash, tenant.id)
  );

  // Looked up BEFORE the expiry gate below. A signed project's customer
  // must always be able to retrieve their own copy of what they agreed to
  // -- the one thing this whole table exists to answer -- independent of
  // the access token's normal 90-day TTL (Task 9's resend-link window).
  // Without this reorder, the token going stale after a signature already
  // exists would 404 the customer out of their own signed record forever
  // (Task 10 fix round 1, Important #3).
  //
  // Issued UNCONDITIONALLY -- binding "" when there is no project -- not
  // guarded behind `if (project)`. Guarding it made an unknown token cost
  // one round trip and an expired-unsigned token cost two, even though
  // both return byte-identical responses: a timing oracle for "this token
  // existed once" that fix round 1 introduced by accident (fix round 2,
  // Finding 3). No project has id "", so this is a real query that always
  // finds nothing when `project` is null, rather than a conditional skip.
  const signature = await first<AgreementSignature>(
    c.env.DB.prepare(
      `SELECT * FROM agreement_signatures WHERE project_id = ? AND tenant_id = ?`
    ).bind(project?.id ?? "", tenant.id)
  );

  const expired =
    !!project?.token_expires_at &&
    new Date(project.token_expires_at).getTime() < Date.now();

  // Invalid and expired-with-no-signature return the SAME response, same
  // status. Distinguishing them would let the endpoint be probed to learn
  // which tokens exist (or existed). Expired-WITH-a-signature is NOT
  // folded into this branch -- see the comment above.
  if (!project || (expired && !signature)) {
    return new Response(renderInvalidLink(tenant), {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  if (signMatch) {
    if (c.req.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    return signQuote(c, tenant, project, tokenHash);
  }

  let html: string;
  if (signature) {
    // Signed copy renders from the signature row alone -- see quote.ts's
    // renderSignedCopy for why (Important #2). No project_lines query.
    html = renderSignedCopy({ tenant, project, signature, baseUrl });
  } else if (project.status !== "estimated") {
    // A terminal (or not-yet-estimated) status can never legally reach
    // 'signed' -- assertTransition() would refuse it anyway, but showing
    // a full sign form the customer can fill in and submit only to be
    // rejected on POST is a bad UX and, worse, an unnecessary place for an
    // internal transition string to almost leak (Minor #2).
    html = renderCannotSign(tenant, project, cannotSignMessage(project.status));
  } else {
    const { title: agreementTitle, body: agreementBody } = readAgreementFields(tenant);
    if (!agreementBody.trim()) {
      // A shop that never wrote terms has nothing for a customer to agree
      // to -- refuse to render the signing form (Minor #3).
      html = renderCannotSign(tenant, project, EMPTY_AGREEMENT_MESSAGE);
    } else {
      const lines = await all<ProjectLine>(
        c.env.DB.prepare(
          // ", id" makes the ordering total: sort_order alone has no
          // UNIQUE constraint, so a future writer that produces a tie
          // would let this GET and signQuote's own identically-shaped
          // query (below) order their rows differently -- and since both
          // build the SAME hash from that order, any tie would make every
          // signature attempt 409 forever (final review, F7). `id` is
          // unique and stable, so appending it as the tiebreaker is a
          // no-op today (no ties exist) and a guarantee for whenever one
          // does.
          `SELECT * FROM project_lines WHERE project_id = ? ORDER BY sort_order, id`
        ).bind(project.id)
      );
      // Hash the EXACT snapshot being rendered below, using the same
      // buildAgreementSnapshot() call signQuote uses to rebuild it at POST
      // time -- including the SAME line items, so a re-itemise between
      // this render and the POST is caught the same way an edited
      // agreement body is (Important #1). The hash is round-tripped
      // through a hidden form field so the POST can prove (see signQuote)
      // that the text about to be signed matches what was on screen when
      // the customer clicked -- not whatever happens to be live by the
      // time the request arrives.
      const snapshotLines: AgreementSnapshotLine[] = lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitCents: l.unit_cents,
        amountCents: l.amount_cents,
      }));
      try {
        const snapshot = buildAgreementSnapshot({
          title: agreementTitle,
          body: agreementBody,
          project: {
            reference: project.reference,
            customerName: project.customer_name,
            totalCents: project.total_cents,
          },
          lines: snapshotLines,
        });
        const agreementSha256 = await sha256Hex(snapshot);
        html = renderQuotePage({
          tenant,
          project,
          lines,
          baseUrl,
          agreementTitle,
          agreementBody,
          agreementSha256,
        });
      } catch (err) {
        // money()/assertIntCents() threw -- a fractional cents value
        // somewhere in project.total_cents or a line's amount_cents/
        // unit_cents. Render the same "can't sign right now" page a
        // terminal status or a blank agreement body already produces,
        // rather than letting the TypeError propagate into a 500 (F8).
        console.error("quote page: could not build agreement snapshot", err);
        html = renderCannotSign(tenant, project, INVALID_PRICING_MESSAGE);
      }
    }
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The token is in the URL path. Without this, any outbound link the
      // customer clicks hands their quote to a third party in a Referer
      // header.
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * POST /quote/:token/sign — the e-signature ceremony.
 *
 * Idempotent by design AND by schema. The pre-check below (SELECT before
 * INSERT) is only a fast path for the common case -- a double-click or a
 * client retry -- and is deliberately NOT trusted to be race-free on its
 * own: two concurrent POSTs for the same project can both pass that SELECT
 * before either INSERT lands. This feature has already had four
 * check-then-act races land as bugs (the reference counter, the member
 * upsert in send-estimate, the intake_json optimistic-concurrency link, and
 * this endpoint's own INSERT-vs-UNIQUE-index race from fix round 1), so the
 * actual guarantee here is the UNIQUE index on agreement_signatures
 * (project_id) plus `ON CONFLICT(project_id) DO NOTHING RETURNING id`:
 * exactly one concurrent request gets a row back and is the one that
 * performs the status transition and sends notifications. Every other
 * request -- whether it lost the pre-check or lost the INSERT itself --
 * returns the same { ok: true, already_signed: true } response.
 */
async function signQuote(
  c: Context<{ Bindings: Env }>,
  tenant: Tenant,
  project: Project,
  tokenHash: string
): Promise<Response> {
  const existing = await first<AgreementSignature>(
    c.env.DB.prepare(
      `SELECT * FROM agreement_signatures WHERE project_id = ? AND tenant_id = ?`
    ).bind(project.id, tenant.id)
  );
  if (existing) {
    return c.json({ ok: true, already_signed: true });
  }

  const body = await c.req
    .json<{ signer_name?: string; consent?: boolean; agreement_sha256?: string }>()
    .catch(() => ({}) as { signer_name?: string; consent?: boolean; agreement_sha256?: string });
  const signerName = String(body.signer_name || "").trim().slice(0, 200);
  if (!signerName) return c.json({ error: "Type your full name to sign" }, 400);
  if (body.consent !== true) return c.json({ error: "You must agree to the terms" }, 400);

  try {
    assertTransition(project.status as ProjectStatus, "signed");
  } catch {
    // NEVER return the raw Error("Illegal transition: a -> b") string to an
    // anonymous token holder -- it's an internal implementation detail, not
    // customer-facing copy (Minor #2). cannotSignMessage() gives the same
    // status-aware explanation the GET page would have shown instead of the
    // sign form in the first place.
    return c.json({ error: cannotSignMessage(project.status) }, 409);
  }

  const { title: agreementTitle, body: agreementBody } = readAgreementFields(tenant);
  if (!agreementBody.trim()) {
    // Mirrors the GET-side refusal (Minor #3): a shop with no configured
    // terms has nothing for the customer to be signing.
    return c.json({ error: EMPTY_AGREEMENT_MESSAGE }, 409);
  }

  // Re-queried live, not trusted from whatever the GET rendered a moment
  // ago -- exactly like agreementTitle/agreementBody above. A shop can
  // re-itemise a project's line items (PUT /projects/:id/lines has no
  // status guard) between the customer loading the page and clicking Sign;
  // folding the live lines into the same snapshot/hash the GET page hashed
  // is what makes that edit show up as a hash mismatch below instead of
  // silently signing a different breakdown than the one on screen
  // (Important #1).
  const liveLines = await all<ProjectLine>(
    c.env.DB.prepare(
      // ", id" -- same total-ordering fix as the GET branch above (F7): a
      // tie in sort_order alone could let this query and the GET's return
      // rows in different orders, producing a different hash and 409ing a
      // customer who did nothing wrong.
      `SELECT * FROM project_lines WHERE project_id = ? ORDER BY sort_order, id`
    ).bind(project.id)
  );
  const snapshotLines: AgreementSnapshotLine[] = liveLines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitCents: l.unit_cents,
    amountCents: l.amount_cents,
  }));

  // Rebuilt from whatever is live in tenant settings AND live project_lines
  // right now -- the same way the GET handler built it moments ago to
  // render the page this POST is a response to. Those two builds are only
  // guaranteed to match if nothing changed settings.longarm or the line
  // items in between, which is exactly what the hash comparison below
  // verifies before anything is persisted: the signature must attest to the
  // text (and the pricing breakdown) that was actually on screen, not to
  // whatever happens to be live by the time the request lands.
  let snapshot: string;
  try {
    snapshot = buildAgreementSnapshot({
      title: agreementTitle,
      body: agreementBody,
      project: {
        reference: project.reference,
        customerName: project.customer_name,
        totalCents: project.total_cents,
      },
      lines: snapshotLines,
    });
  } catch (err) {
    // Same fractional-cents failure mode the GET branch above now guards
    // (F8) -- a TypeError here must never 500 the sign endpoint.
    console.error("signQuote: could not build agreement snapshot", err);
    return c.json({ error: INVALID_PRICING_MESSAGE }, 409);
  }
  const hash = await sha256Hex(snapshot);

  // Fail closed, same discipline as the price gate: a missing or malformed
  // submitted hash is treated as a mismatch, never as "no opinion, sign
  // whatever is live". This is what turns "the shop edited the agreement (or
  // re-itemised the lines) between page load and click" from a silent,
  // undetectable gap into a rejected request the customer's browser
  // automatically reloads to re-review. It proves the text hashed is the
  // text that was rendered to the browser -- it does not, and cannot, prove
  // the human actually read it before clicking Sign; that is not a claim
  // any server-side check can make.
  const submittedHash =
    typeof body.agreement_sha256 === "string" ? body.agreement_sha256.trim() : "";
  if (!submittedHash || submittedHash !== hash) {
    return c.json(
      {
        error:
          "This agreement has been updated since you loaded this page. Please reload and review it before signing.",
      },
      409
    );
  }

  const now = new Date().toISOString();

  const insertStmt = c.env.DB.prepare(
    `INSERT INTO agreement_signatures
       (id, tenant_id, project_id, signer_name, signer_email, consent_text,
        agreement_title, agreement_text, agreement_sha256, signing_token_hash,
        signer_ip, signer_user_agent, signed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO NOTHING
     RETURNING id`
  ).bind(
    generateId(),
    tenant.id,
    project.id,
    signerName,
    project.customer_email,
    CONSENT_TEXT,
    agreementTitle,
    snapshot,
    hash,
    tokenHash,
    c.req.header("cf-connecting-ip") || null,
    (c.req.header("user-agent") || "").slice(0, 500) || null,
    now
  );

  // The status predicate is load-bearing twice over (Important #4, the
  // feature's FIFTH check-then-act race): it's what stops an owner's
  // concurrent cancel/decline -- landing between this request's earlier
  // assertTransition() read and this write -- from being silently reverted
  // back to 'signed' underneath them, and it's what keeps this statement
  // SAFE to run unconditionally in the same batch as the INSERT even when
  // the INSERT no-ops for a race loser: DO NOTHING'd INSERT + WHERE-guarded
  // UPDATE are each independently self-correct regardless of whether the
  // other one actually changed anything this time.
  //
  // Built through the shared helper (final review, F1) instead of
  // hardcoding "AND status = 'estimated'" here: that literal duplicated
  // knowledge that already lives in status.ts's ALLOWED table (only
  // 'estimated' can transition to 'signed'), and PATCH/send-estimate in
  // projects.ts had the identical race with no guard at all until this
  // review. Deliberately NOT gating the response on guardedUpdateApplied()
  // below, unlike PATCH/send-estimate: the signature INSERT is the source
  // of truth that the customer signed, and that already succeeded by the
  // time this UPDATE runs -- a lost status-guard race here means the
  // signature is real but the project's status column doesn't flip, not
  // that signing itself failed. See the "fifth check-then-act race" test
  // below for the exact scenario this protects.
  const updateStmt = buildGuardedStatusUpdate(c.env.DB, {
    tenantId: tenant.id,
    projectId: project.id,
    // project.status, not a hardcoded "estimated": assertTransition() above
    // already proved this specific value is a legal source for "signed" per
    // status.ts's ALLOWED table, so binding what was actually read (rather
    // than re-asserting the literal that happens to be the only legal
    // source today) is what keeps this correct if that table ever grows a
    // second legal source status for "signed" -- exactly the failure mode
    // F1 calls out for a hardcoded literal.
    fromStatus: project.status as ProjectStatus,
    toStatus: "signed",
    now,
    extraSet: "signed_at = ?",
    extraBinds: [now],
  });

  // Run together as ONE batch/transaction, not as two sequential round
  // trips. Sequential calls left a window where the INSERT could commit and
  // the UPDATE could then fail (worker eviction, transient D1 error) --
  // leaving a permanently-orphaned signature attached to a project stuck in
  // 'estimated', because every later POST short-circuits on the `existing`
  // pre-check above and never revisits the status write.
  const [insertResult] = await c.env.DB.batch<{ id: string }>([insertStmt, updateStmt]);
  const inserted = insertResult.results[0] ?? null;

  if (!inserted) {
    // Lost the race at the database level: some other concurrent request's
    // INSERT won. This is the normal, expected outcome of a double-click or
    // retry racing another in-flight request -- not an error -- so the loser
    // must NOT re-run the status transition or send a second pair of emails.
    return c.json({ ok: true, already_signed: true });
  }

  // The customer's own permanent copy, independent of any link surviving:
  // full agreement text (already includes the line items, per Important
  // #1) plus the fingerprint that proves it hasn't been altered since. If
  // this email is lost, the signed page itself remains reachable forever
  // now (Important #3's expiry-gate fix) -- but the shop should not be the
  // only party holding a durable copy.
  const requestUrl = new URL(c.req.url);
  const quoteUrl = `${requestUrl.origin}${requestUrl.pathname.replace(/\/sign$/, "")}`;
  await sendEmail(c.env, {
    to: project.customer_email,
    subject: `Signed — ${project.reference}`,
    html: `<p>Thank you. Your agreement for ${escapeHtml(project.reference)} is signed.</p>
<p>For your records, here is the complete agreement you signed:</p>
<pre style="white-space:pre-wrap;font-family:inherit;border:1px solid #ddd;padding:12px">${escapeHtml(snapshot)}</pre>
<p>Document fingerprint (SHA-256): <code>${escapeHtml(hash)}</code></p>
<p><a href="${escapeHtml(quoteUrl)}">View your signed agreement online</a></p>`,
  }).catch(() => undefined);

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {
    settings = {};
  }
  const ownerEmail = (settings.business as { email?: string } | undefined)?.email;
  if (ownerEmail) {
    await sendEmail(c.env, {
      to: ownerEmail,
      subject: `${project.reference} signed by ${signerName}`,
      html: `<p>${escapeHtml(signerName)} signed ${escapeHtml(project.reference)}.</p>`,
    }).catch(() => undefined);
  }

  return c.json({ ok: true });
}

/** Every uploaded-file id referenced by a section stack (skips pattern refs). */
export function collectImageIds(sections: Section[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "imageId" && typeof val === "string" && val && !val.startsWith("pattern:")) {
        out.add(val);
      } else {
        walk(val);
      }
    }
  };
  walk(sections);
  return [...out];
}

/**
 * One query for the page's images. Returns a lookup the renderer calls per
 * image; unknown ids (deleted files, previews) simply return undefined and
 * the image renders without width/height.
 */
export async function loadImgMeta(
  env: Env,
  tenantId: string,
  ids: string[]
): Promise<((fileId: string) => ImgMeta | undefined) | undefined> {
  if (!ids.length) return undefined;
  const capped = ids.slice(0, 60);
  const placeholders = capped.map(() => "?").join(", ");
  let rows: { id: string; width: number | null; height: number | null; focal_json: string | null }[] = [];
  try {
    rows = await all<{ id: string; width: number | null; height: number | null; focal_json: string | null }>(
      env.DB.prepare(
        `SELECT id, width, height, focal_json FROM files
         WHERE tenant_id = ? AND id IN (${placeholders})`
      ).bind(tenantId, ...capped)
    );
  } catch {
    // Pre-0028 database: no width/height/focal columns yet.
    return undefined;
  }
  if (!rows.length) return undefined;
  const map = new Map<string, ImgMeta>();
  for (const r of rows) {
    map.set(r.id, { w: r.width, h: r.height, focal: parseFocal(r.focal_json) });
  }
  return (fileId: string) => map.get(fileId);
}
