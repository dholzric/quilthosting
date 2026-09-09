/**
 * The site shell: one server-rendered document for every tenant (guild and
 * business), around a stack of sections.
 *
 * `renderSitePage` is the renderer proper: head (SEO, design tokens, fonts),
 * header per `design.header.variant` with the nested menu, phone drawer and
 * primary CTA, `<main>` with `renderSections`, footer per
 * `design.footer.variant`, and the island bundle. `renderPageHtml` is the
 * pre-shell entry point the business routes still call; it now migrates the
 * tenant's stored theme to a `SiteDesign`, normalises the page's blocks to
 * sections and delegates to `renderSitePage`, so today's business pages get
 * the new shell + stylesheet without a data migration.
 *
 * Safety: every tenant string goes through `escapeHtml`; hrefs go through
 * `sanitizeUrl`; the inline `<style>` is built only from closed tables and
 * normalised hexes (`buildDesignVars` / `buildRootVars`).
 *
 * Hosts: `baseUrl` is "" or "/g/<slug>" on the platform host and
 * "https://host" on tenant hosts. Every internal link is `${baseUrl}/path`.
 * The portal and the public API live at the origin, never under the base
 * path, so `data-qh-base` and the member sign-in link use `originOf(baseUrl)`.
 */

import { contentFromPage, escapeHtml } from "../blocks";
import type { NavItem } from "../blocks";
import { sanitizeUrl } from "../sanitize";
import { buildRootVars } from "./theme";
import { readTenantTheme } from "./themeMigrate";
import { buildSeoHead, buildLocalBusinessJsonLd, type SeoPage, type SeoBusiness } from "./seo";
import { buildDesignVars, deriveRoles, designFontsHref, designGround, isDarkDesign } from "./design/tokens";
import { LOGO_WIDTH, withWidth } from "../images";
import type { SiteDesign } from "./design/tokens";
import { readSiteDesign } from "./design/migrate";
import { renderSections } from "./sections/render";
import type { RenderContext } from "./sections/render";
import { sectionsFromPage } from "./sections/normalize";
import type { Section } from "./sections/schema";
import { readProfile } from "./data";
import type { SiteData, SiteProfile } from "./data.types";

export type RenderNavItem = { label: string; href: string; external?: boolean };

export type RenderArgs = {
  tenant: { name: string; slug: string; settings_json: string | null; tenant_type?: "guild" | "business" };
  page: SeoPage & { content_json?: string | null; blocks_json?: string | null; sections_json?: string | null; membersOnly?: boolean };
  nav: RenderNavItem[];
  baseUrl: string;
  logoUrl?: string | null;
  ogImageUrl?: string | null;
  showPlatformCredit: boolean;
  /** Optional overrides; renderPageHtml derives each from the tenant when absent. */
  host?: string;
  design?: SiteDesign;
  data?: SiteData;
  imgUrl?: RenderContext["imgUrl"];
  extraHead?: string;
};

export type SiteMenuItem = { label: string; href: string; external?: boolean; children?: SiteMenuItem[] };

export type SitePageArgs = {
  tenant: { name: string; slug: string; settings_json: string | null; tenant_type: "guild" | "business" };
  page: SeoPage & { sections: Section[]; membersOnly?: boolean };
  menu: SiteMenuItem[];
  baseUrl: string;
  host: string;
  logoUrl?: string | null;
  ogImageUrl?: string | null;
  showPlatformCredit: boolean;
  design: SiteDesign;
  data: SiteData;
  imgUrl: RenderContext["imgUrl"];
  /** Intrinsic size + focal point per uploaded image id (serveSite fills it). */
  imgMeta?: RenderContext["imgMeta"];
  /** Extra markup for <head>, e.g. noindex while gated. Emitted verbatim: platform-authored only. */
  extraHead?: string;
  /** Additional `<script type="application/ld+json">` blocks (seo.ts builders) appended to <head>. */
  jsonLd?: string[];
  /**
   * Platform-authored markup appended after the sections inside <main>
   * (pages/system.ts `SystemPage.rawHtml`). Emitted verbatim: the caller has
   * escaped every tenant string in it.
   */
  rawHtml?: string;
};

// Encodes & < > " ' -- every interpolation below is either a text node or a
// double-quoted attribute, and the single quote is covered so a future
// single-quoted attribute cannot become a hole.
const esc = escapeHtml;

function parseSettings(settingsJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(settingsJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Platform credit defaults to shown; white-labelling is opt-out. */
export function readBranding(settingsJson: string | null | undefined): {
  showPlatformCredit: boolean;
} {
  const branding = (parseSettings(settingsJson).branding || {}) as Record<string, unknown>;
  return { showPlatformCredit: branding.show_platform_credit !== false };
}

export function readBusinessIdentity(settingsJson: string | null | undefined): SeoBusiness {
  const b = (parseSettings(settingsJson).business || {}) as Record<string, unknown>;
  return {
    name: String(b.name || ""),
    phone: b.phone ? String(b.phone) : undefined,
    email: b.email ? String(b.email) : undefined,
    street: b.street ? String(b.street) : undefined,
    city: b.city ? String(b.city) : undefined,
    state: b.state ? String(b.state) : undefined,
    zip: b.zip ? String(b.zip) : undefined,
  };
}

// ---------------------------------------------------------------------------
// URLs

function trimBase(baseUrl: string): string {
  return (baseUrl || "").replace(/\/+$/, "");
}

/** "https://host" for an absolute base, "" for a platform-relative one ("", "/g/slug"). */
function originOf(baseUrl: string): string {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(baseUrl || "");
  return m ? m[1] : "";
}

function isRootRelative(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

/** Root-relative → `${baseUrl}${href}`; anything else unchanged. Callers sanitize first. */
function withBase(href: string, baseUrl: string): string {
  return isRootRelative(href) ? trimBase(baseUrl) + href : href;
}

// ---------------------------------------------------------------------------
// Menu

/** A settings.nav item with the optional one-level `children` the menu editor stores. */
export type SettingsMenuItem = NavItem & { children?: NavItem[] };

const NAV_MAX = 20;

function readNavItem(raw: unknown): NavItem | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  const label = String(n.label || "").slice(0, 60);
  const href = sanitizeUrl(String(n.href || "").slice(0, 500), "link") || "";
  if (!label || !href) return null;
  return { label, href, external: !!n.external };
}

/**
 * `settings.nav` with one level of `children`, using `parseNav`'s rules for
 * every item (label ≤ 60, sanitized href, at most 20). `parseNav` itself is
 * frozen (it drops children), so this is the reader the menu builder uses.
 */
export function readSettingsMenu(settingsJson: string | null | undefined): SettingsMenuItem[] {
  const nav = parseSettings(settingsJson).nav;
  if (!Array.isArray(nav)) return [];
  const out: SettingsMenuItem[] = [];
  for (const raw of nav) {
    const item = readNavItem(raw) as SettingsMenuItem | null;
    if (!item) continue;
    const kids = (raw as Record<string, unknown>).children;
    if (Array.isArray(kids)) {
      const children = kids.map(readNavItem).filter((k): k is NavItem => !!k).slice(0, NAV_MAX);
      if (children.length) item.children = children;
    }
    out.push(item);
    if (out.length >= NAV_MAX) break;
  }
  return out;
}

/**
 * Sanitize one nav item into a menu item. `prefix` (default true) rewrites
 * root-relative hrefs to `${baseUrl}${href}`; `renderPageHtml` passes false
 * because its `nav` comes from `loadNav` already shaped for the host.
 */
function toMenuItem(n: SettingsMenuItem, baseUrl: string, prefix = true): SiteMenuItem | null {
  const clean = sanitizeUrl(n.href, "link");
  if (!clean) return null;
  const origin = originOf(baseUrl);
  const absolute = /^https?:\/\//i.test(clean);
  const external = !!n.external || (absolute && !(origin && (clean === origin || clean.startsWith(origin + "/"))));
  const item: SiteMenuItem = { label: n.label, href: prefix ? withBase(clean, baseUrl) : clean };
  if (external) item.external = true;
  if (n.children?.length) {
    const children = n.children.map((c) => toMenuItem(c, baseUrl, prefix)).filter((c): c is SiteMenuItem => !!c);
    if (children.length) item.children = children;
  }
  return item;
}

/**
 * The site menu. An owner-arranged `settings.nav` wins (one level of
 * children supported); otherwise the pages flagged `show_in_nav`, in the
 * order given (callers pass them in `sort_order`). Root-relative hrefs are
 * prefixed with `baseUrl`; absolute links to another origin are `external`.
 */
export function buildMenu(
  pages: { slug: string; title: string; nav_label?: string | null; show_in_nav?: number | boolean | null }[],
  settingsNav: SettingsMenuItem[],
  baseUrl: string
): SiteMenuItem[] {
  if (settingsNav.length) {
    return settingsNav.map((n) => toMenuItem(n, baseUrl)).filter((n): n is SiteMenuItem => !!n);
  }
  const out: SiteMenuItem[] = [];
  for (const p of pages) {
    if (p.show_in_nav === 0 || p.show_in_nav === false) continue;
    const slug = String(p.slug || "");
    const href = slug && slug !== "home" ? `/${slug}` : "/";
    const label = String(p.nav_label || p.title || "").trim();
    if (!label) continue;
    const item = toMenuItem({ label, href }, baseUrl);
    if (item) out.push(item);
  }
  return out;
}

/**
 * The Events page is a system page, not a row in `pages`, so buildMenu never
 * had anything to list it from: a guild could add an event and find no way to
 * reach it from its own site. When the guild has an upcoming event and the
 * menu does not already point at /events or /calendar, one is appended.
 *
 * An explicit menu (settings.nav) is the officer's own list and is left alone
 * — if they removed Events, it stays removed.
 */
export function withEventsLink(
  menu: SiteMenuItem[],
  baseUrl: string,
  opts: { hasEvents: boolean; explicitMenu: boolean; label?: string }
): SiteMenuItem[] {
  if (!opts.hasEvents || opts.explicitMenu) return menu;
  const base = trimBase(baseUrl);
  const already = menu.some((m) => {
    const href = m.href || "";
    return /\/(events|calendar)(\/|$|\?)/.test(href) || (m.children ?? []).some((c) => /\/(events|calendar)(\/|$|\?)/.test(c.href || ""));
  });
  if (already) return menu;
  return [...menu, { label: opts.label || "Events", href: `${base}/events` }];
}

function menuLink(item: SiteMenuItem, current?: string): string {
  const attrs = [`href="${esc(item.href)}"`];
  if (item.external) attrs.push('rel="noopener noreferrer"');
  if (current && item.href === current) attrs.push('aria-current="page"');
  return `<a ${attrs.join(" ")}>${esc(item.label)}</a>`;
}

function navList(menu: SiteMenuItem[], current: string): string {
  if (!menu.length) return "";
  const items = menu.map((item) => {
    if (item.children?.length) {
      const sub = item.children.map((c) => `<li class="qh-nav__item">${menuLink(c, current)}</li>`).join("");
      return `<li class="qh-nav__item has-children">${menuLink(item, current)}<ul class="qh-nav__menu">${sub}</ul></li>`;
    }
    return `<li class="qh-nav__item">${menuLink(item, current)}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

function nav(menu: SiteMenuItem[], current: string, extraClass = ""): string {
  const cls = extraClass ? `qh-nav ${extraClass}` : "qh-nav";
  return `<nav class="${cls}" aria-label="Main">${navList(menu, current)}</nav>`;
}

/** The drawer duplicates the menu as one flat list (children follow their parent). */
function drawerList(menu: SiteMenuItem[], current: string): string {
  const flat: SiteMenuItem[] = [];
  for (const item of menu) {
    flat.push(item);
    for (const c of item.children ?? []) flat.push(c);
  }
  return `<ul>${flat.map((item) => `<li>${menuLink(item, current)}</li>`).join("")}</ul>`;
}

// ---------------------------------------------------------------------------
// Header

type Cta = { label: string; href: string } | null;

function pathOf(href: string): string {
  return href.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
}

function resolveCta(args: SitePageArgs, sections: Section[]): Cta {
  const base = trimBase(args.baseUrl);
  const basePath = pathOf(base || "/").replace(/\/$/, "");
  switch (args.design.header.cta) {
    case "join": {
      if (args.tenant.tenant_type === "guild") return { label: "Join", href: `${base}/membership` };
      const band = sections.find((s) => s.type === "join_band");
      return band ? { label: "Join", href: `#${band.id}` } : null;
    }
    case "quote": {
      const onPage = sections.find((s) => s.type === "quote_cta");
      if (onPage) return { label: "Request a quote", href: `#${onPage.id}` };
      const inMenu = flatten(args.menu).find((m) => !m.external && pathOf(m.href) === `${basePath}/request-a-quote`);
      return { label: "Request a quote", href: inMenu ? inMenu.href : `${base}/contact` };
    }
    case "donate": {
      // The first donate section on this page, else the system /donate page
      // (pages/system.ts), which carries one with the id "donate".
      const onPage = sections.find((s) => s.type === "donate");
      return { label: "Donate", href: onPage ? `#${onPage.id}` : `${base}/donate` };
    }
    default:
      return null;
  }
}

function flatten(menu: SiteMenuItem[]): SiteMenuItem[] {
  const out: SiteMenuItem[] = [];
  for (const m of menu) {
    out.push(m);
    if (m.children) out.push(...m.children);
  }
  return out;
}

function ctaLink(cta: Cta, extraClass: string): string {
  if (!cta) return "";
  const safe = sanitizeUrl(cta.href, "link");
  if (!safe) return "";
  return `<a class="qh-btn qh-btn--primary ${extraClass}" href="${esc(safe)}">${esc(cta.label)}</a>`;
}

function brandLink(siteName: string, logoUrl: string | null | undefined, homeHref: string): string {
  // The logo/og URLs are built by the caller from a file id, but validate the
  // scheme anyway so a future caller cannot hand us a javascript: value.
  const safeLogo = logoUrl ? sanitizeUrl(logoUrl, "image") : null;
  // Sized by HEIGHT only, width left to the intrinsic aspect ratio: a fixed
  // square squashed every wordmark. The height attribute still reserves space.
  // The header box is 44 px tall, so ask for the 240 px variant and offer
  // the 480 for 2x. A logo is on every page of the site: serving the original
  // here is the difference between a few KB and the whole upload, every view.
  // Structured data and og:image keep the canonical URL (args.logoUrl).
  const logo = safeLogo
    ? `<img class="qh-brand__logo" src="${esc(withWidth(safeLogo, LOGO_WIDTH))}"` +
      ` srcset="${esc(withWidth(safeLogo, LOGO_WIDTH))} 1x, ${esc(withWidth(safeLogo, LOGO_WIDTH * 2))} 2x"` +
      ` alt="" height="44" decoding="async">`
    : "";
  return `<a class="qh-brand" href="${esc(homeHref)}">${logo}<span>${esc(siteName)}</span></a>`;
}

function renderHeader(args: SitePageArgs, siteName: string, current: string, cta: Cta, overlay: boolean): string {
  const h = args.design.header;
  const classes = ["qh-header", `qh-header--${h.variant}`];
  if (h.sticky) classes.push("qh-header--sticky");
  if (overlay) classes.push("qh-header--overlay");

  const brand = brandLink(siteName, args.logoUrl, `${trimBase(args.baseUrl)}/`);
  const toggle =
    `<button class="qh-nav-toggle" type="button" aria-controls="qh-drawer" aria-expanded="false" aria-label="Open menu">` +
    `<span class="qh-nav-toggle__bars"></span></button>`;
  const ctaHtml = ctaLink(cta, "qh-header__cta");

  let inner: string;
  if (h.variant === "split") {
    const half = Math.ceil(args.menu.length / 2);
    inner = nav(args.menu.slice(0, half), current, "qh-nav--start") + brand + nav(args.menu.slice(half), current, "qh-nav--end") + ctaHtml + toggle;
  } else {
    // left: brand, nav, CTA last. centered: same order, stacked by the stylesheet.
    inner = brand + nav(args.menu, current) + ctaHtml + toggle;
  }

  const drawer =
    `<dialog class="qh-drawer" id="qh-drawer" aria-label="Menu"><div class="qh-drawer__panel">` +
    `<div class="qh-drawer__head"><strong>${esc(siteName)}</strong>` +
    `<button class="qh-drawer__close" type="button" aria-label="Close menu">&times;</button></div>` +
    drawerList(args.menu, current) +
    ctaLink(cta, "qh-drawer__cta") +
    `</div></dialog>`;

  return `<header class="${classes.join(" ")}">\n  <div class="qh-header__inner">${inner}</div>\n</header>\n${drawer}`;
}

// ---------------------------------------------------------------------------
// Footer

function mailLink(email: string): string {
  const mail = sanitizeUrl(`mailto:${email}`, "link");
  return mail ? `<a href="${esc(mail)}">${esc(email)}</a>` : esc(email);
}

function telLink(phone: string): string {
  const tel = sanitizeUrl(`tel:${phone.replace(/[^\d+]/g, "")}`, "link");
  return tel ? `<a href="${esc(tel)}">${esc(phone)}</a>` : esc(phone);
}

function col(title: string, body: string): string {
  // A footer column heading is level 2: a page whose content is only a
  // system list (e.g. /events) has no <h2>, so an <h3> here would make the
  // document jump h1 -> h3. The visual size comes from the class, not the tag.
  return body ? `<div class="qh-footer__col"><h2 class="qh-footer__heading">${esc(title)}</h2>${body}</div>` : "";
}

function aboutColumn(args: SitePageArgs, identity: SeoBusiness, profile: SiteProfile, siteName: string): string {
  if (args.tenant.tenant_type === "business") {
    const lines = [esc(siteName)];
    if (identity.street) lines.push(esc(identity.street));
    const cityLine = [identity.city, identity.state].filter(Boolean).join(", ") + (identity.zip ? ` ${identity.zip}` : "");
    if (cityLine.trim()) lines.push(esc(cityLine.trim()));
    return `<p>${lines.join("<br>")}</p>`;
  }
  return `<p>${esc(profile.description || siteName)}</p>`;
}

function contactColumn(args: SitePageArgs, identity: SeoBusiness, profile: SiteProfile): string {
  const rows: string[] = [];
  const email = args.tenant.tenant_type === "business" ? identity.email : profile.email;
  if (email) rows.push(`<li>${mailLink(email)}</li>`);
  if (args.tenant.tenant_type === "business" && identity.phone) rows.push(`<li>${telLink(identity.phone)}</li>`);
  if (args.tenant.tenant_type === "guild" && profile.location) rows.push(`<li>${esc(profile.location)}</li>`);
  return rows.length ? `<ul>${rows.join("")}</ul>` : "";
}

function meetingColumn(profile: SiteProfile): string {
  const parts: string[] = [];
  if (profile.meeting_info) parts.push(esc(profile.meeting_info));
  if (profile.location) parts.push(esc(profile.location));
  return parts.length ? `<p class="qh-footer__meeting">${parts.join("<br>")}</p>` : "";
}

function renderFooter(args: SitePageArgs, siteName: string, identity: SeoBusiness, profile: SiteProfile, portalUrl: string | null): string {
  const variant = args.design.footer.variant;
  const signIn = portalUrl ? `<a href="${esc(portalUrl)}">Member sign-in</a>` : "";
  const credit = args.showPlatformCredit
    ? `<p class="qh-platform-credit">Powered by <a href="https://quilthosting.com">QuiltHosting</a></p>`
    : "";
  const utility = signIn || credit ? `<div class="qh-footer__utility">${signIn}${credit}</div>` : "";
  const name = `<p>${esc(siteName)}</p>`;

  let inner: string;
  if (variant === "simple") {
    inner = name + utility;
  } else {
    const links = flatten(args.menu)
      .map((m) => `<li>${menuLink(m)}</li>`)
      .join("");
    const cols = [
      col("About", aboutColumn(args, identity, profile, siteName)),
      col("Links", links ? `<ul>${links}</ul>` : ""),
      variant === "meeting" ? col("Meetings", meetingColumn(profile)) : "",
      col("Members", signIn ? `<ul><li>${signIn}</li></ul>` : ""),
      col("Contact", contactColumn(args, identity, profile)),
    ].join("");
    inner = `<div class="qh-footer__cols">${cols}</div><div class="qh-footer__bottom">${name}${credit ? `<div class="qh-footer__utility">${credit}</div>` : ""}</div>`;
  }
  return `<footer class="qh-footer qh-footer--${variant}">\n  <div class="qh-footer__inner">${inner}</div>\n</footer>`;
}

// ---------------------------------------------------------------------------
// Page

function firstImageHero(sections: Section[]): boolean {
  const s = sections[0];
  return !!s && s.type === "hero" && (s.style?.bg === "image" || s.variant === "image") && !!s.style?.imageId;
}

/**
 * `settings.timezone`, the IANA zone a guild's event times are shown in.
 * Absent means UTC — right only for a guild that has not said otherwise,
 * which is why the Settings screen asks for it.
 */
export function readTimeZone(settingsJson: string | null | undefined): string {
  try {
    const tz = (JSON.parse(settingsJson || "{}") || {}).timezone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : "UTC";
  } catch {
    return "UTC";
  }
}

/** Full document for one page on one host. */
export function renderSitePage(args: SitePageArgs): string {
  const { tenant, page, baseUrl, design } = args;
  const settings = tenant.settings_json;
  const identity = readBusinessIdentity(settings);
  // The owner-entered business name (settings.business.name) is the
  // authority for what a business site displays; tenant.name is the fallback
  // and the guild name.
  const siteName = (tenant.tenant_type === "business" && identity.name) || tenant.name;
  const profile = args.data.profile ?? readProfile(settings);
  const roles = deriveRoles(design.palette.input, isDarkDesign(design), designGround(design));
  const sections = page.sections ?? [];

  const ctx: RenderContext = {
    slug: tenant.slug,
    baseUrl,
    design,
    data: args.data,
    imgUrl: args.imgUrl,
    imgMeta: args.imgMeta,
    timeZone: readTimeZone(settings),
  };
  let bodyHtml = renderSections(sections, ctx);
  const overlay = !!design.header.overlayHero && firstImageHero(sections);
  if (overlay) {
    // The first section's wrapper opens the output; give it the under-header
    // padding so the hero starts beneath the transparent header.
    bodyHtml = bodyHtml.replace(/^(<section id="[^"]*" class="qh-s )/, "$1qh-hero--under-header ");
  }

  const seoPage: SeoPage = { ...page, noindex: page.membersOnly ? 1 : page.noindex ?? null };
  const heroImageId = sections[0]?.type === "hero" ? sections[0].style?.imageId : undefined;
  const ogImageUrl = args.ogImageUrl || (heroImageId ? args.imgUrl(heroImageId, 1200) : null);
  const seoHead = buildSeoHead({ page: seoPage, siteName, baseUrl, bodyHtml, ogImageUrl });
  const localBusiness = tenant.tenant_type === "business" ? buildLocalBusinessJsonLd({ ...identity, name: siteName }, baseUrl) : "";
  const jsonLd = [localBusiness, ...(args.jsonLd ?? [])].filter(Boolean).join("\n");

  const fontsHref = designFontsHref(design);
  const fontLinks = fontsHref
    ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${esc(fontsHref)}">\n`
    : "";
  // Legacy --color-* / --font-* vars ride along for one release; the
  // stylesheet's .qh-block-* aliases still read them.
  const { theme, fonts } = readTenantTheme(settings);
  const rootVars = `${buildDesignVars(design)};${buildRootVars(theme, fonts)}`;

  const origin = originOf(baseUrl);
  const portalUrl = tenant.tenant_type === "guild" ? `${origin}/portal?slug=${encodeURIComponent(tenant.slug)}` : null;
  const current = page.slug ? `${trimBase(baseUrl)}/${page.slug}` : `${trimBase(baseUrl)}/`;
  const cta = resolveCta(args, sections);

  return `<!DOCTYPE html>
<html lang="en" data-tenant-slug="${esc(tenant.slug)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${esc(roles.primary)}">
${seoHead}
${args.extraHead ?? ""}
${fontLinks}<link rel="stylesheet" href="/qh-site.css">
<style>:root{${rootVars}}.qh-skip{position:absolute;left:-999px;top:0;z-index:100;padding:.5rem .75rem;background:var(--qh-primary);color:var(--qh-on-primary)}.qh-skip:focus{left:.5rem;top:.5rem}</style>
${jsonLd}
</head>
<body class="qh-site" data-qh-slug="${esc(tenant.slug)}" data-qh-base="${esc(origin)}" data-qh-type="${esc(tenant.tenant_type)}">
<a class="qh-skip" href="#main">Skip to content</a>
${renderHeader(args, siteName, current, cta, overlay)}
<main id="main" class="qh-main">
${bodyHtml}${args.rawHtml ? `\n${args.rawHtml}` : ""}
</main>
${renderFooter(args, siteName, identity, profile, portalUrl)}
<script src="/qh-site.js" defer></script>
</body>
</html>`;
}

/**
 * Pre-shell entry point (business routes, admin preview). Same signature as
 * before; now migrates the stored theme to a SiteDesign, normalises the
 * page's blocks/content to sections and renders through `renderSitePage`.
 */
export function renderPageHtml(args: RenderArgs): string {
  const { tenant, page, baseUrl } = args;
  const design = args.design ?? readSiteDesign(tenant.settings_json);
  const base = trimBase(baseUrl);

  let sections = sectionsFromPage(page);
  if (!sections.length) {
    // Keep the pre-block fallback exactly: contentFromPage's sanitized html
    // becomes one prose section, so a page never renders empty when it
    // still has content the normaliser could not classify.
    const { html } = contentFromPage(page);
    if (html.trim()) sections = [{ type: "rich_text", variant: "prose", html, style: { bg: "none", width: "normal", spacing: "normal", align: "left", media: "right" }, id: "s_0" }];
  }

  // Legacy nav is already host-shaped (root-relative on tenant hosts); do not re-prefix.
  const menu = args.nav.map((n) => toMenuItem(n, baseUrl, false)).filter((n): n is SiteMenuItem => !!n);

  return renderSitePage({
    tenant: { name: tenant.name, slug: tenant.slug, settings_json: tenant.settings_json, tenant_type: tenant.tenant_type ?? "business" },
    page: { ...page, sections },
    menu,
    baseUrl,
    host: args.host ?? originOf(baseUrl).replace(/^https?:\/\//i, ""),
    logoUrl: args.logoUrl,
    ogImageUrl: args.ogImageUrl,
    showPlatformCredit: args.showPlatformCredit,
    design,
    data: args.data ?? {},
    imgUrl: args.imgUrl ?? ((id) => `${base}/img/${id}`),
    extraHead: args.extraHead,
  });
}
