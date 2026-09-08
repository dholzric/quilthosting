// Server-rendered page shell for business tenants. Replaces guild.html's
// client-side paint so pages are indexable and paint on first byte.

import { contentFromPage, escapeHtml } from "../blocks";
import { sanitizeUrl } from "../sanitize";
import { buildRootVars } from "./theme";
import { buildFontsHref } from "./fonts";
import { readTenantTheme } from "./themeMigrate";
import { buildSeoHead, buildLocalBusinessJsonLd, type SeoPage, type SeoBusiness } from "./seo";

export type RenderNavItem = { label: string; href: string; external?: boolean };

export type RenderArgs = {
  tenant: { name: string; slug: string; settings_json: string | null };
  page: SeoPage & { content_json?: string | null; blocks_json?: string | null };
  nav: RenderNavItem[];
  baseUrl: string;
  logoUrl?: string | null;
  ogImageUrl?: string | null;
  showPlatformCredit: boolean;
};

// Encodes & < > " ' -- every interpolation below is either a text node or a
// double-quoted attribute, and the single quote is covered so a future
// single-quoted attribute cannot become a hole.
const esc = escapeHtml;

function parseSettings(settingsJson: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(settingsJson || "{}") as Record<string, unknown>;
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

export function renderPageHtml(args: RenderArgs): string {
  const { tenant, page, nav, baseUrl, logoUrl, ogImageUrl, showPlatformCredit } = args;

  const { theme, fonts } = readTenantTheme(tenant.settings_json);
  const identity = readBusinessIdentity(tenant.settings_json);
  // The owner-entered business name (settings.business.name) is the
  // authority for what the public site displays — title, header, footer,
  // and JSON-LD all show it. tenant.name (the internal platform record set
  // once at signup) is only the fallback for tenants that haven't filled in
  // Business details yet.
  const siteName = identity.name || tenant.name;

  const { html: bodyHtml } = contentFromPage(page);
  const seoHead = buildSeoHead({ page, siteName, baseUrl, bodyHtml, ogImageUrl });
  const jsonLd = buildLocalBusinessJsonLd({ ...identity, name: siteName }, baseUrl);

  // Nav hrefs are tenant-controlled (settings.nav / page slugs). Escaping
  // alone leaves a `javascript:` href clickable, so validate the scheme too.
  const navHtml = nav
    .map((n) => ({ ...n, href: sanitizeUrl(n.href, "link") }))
    .filter((n) => n.href !== null)
    .map(
      (n) =>
        `<a href="${esc(n.href as string)}"${n.external ? ' rel="noopener noreferrer"' : ""}>${esc(n.label)}</a>`
    )
    .join("");

  // The logo/og URLs are built by the caller from a file id, but validate the
  // scheme anyway so a future caller cannot hand us a javascript: value.
  const safeLogoUrl = logoUrl ? sanitizeUrl(logoUrl, "image") : null;

  return `<!DOCTYPE html>
<html lang="en" data-tenant-slug="${esc(tenant.slug)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${esc(theme.themeColor)}">
${seoHead}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="${esc(buildFontsHref(fonts.heading, fonts.body))}">
<link rel="stylesheet" href="/qh-site.css">
<style>:root{${buildRootVars(theme, fonts)}}</style>
${jsonLd}
</head>
<body class="qh-site">
<header class="qh-site-header">
  <div class="qh-site-header-inner">
    <a class="qh-site-brand" href="/">${
      // Sized by HEIGHT only, with width left to the intrinsic aspect ratio.
      // A fixed 48x48 square squashed and shrank every wordmark logo -- and a
      // wordmark is what most shops upload. The explicit height attribute
      // still gives the browser something to reserve, so this does not
      // reintroduce layout shift. Width is capped in CSS, not here.
      safeLogoUrl
        ? `<img class="qh-site-logo" src="${esc(safeLogoUrl)}" alt="" height="44">`
        : ""
    }<span>${esc(siteName)}</span></a>
    <nav class="qh-site-nav">${navHtml}</nav>
  </div>
</header>
<main class="qh-site-main">
${bodyHtml}
</main>
<footer class="qh-site-footer">
  <div class="qh-site-footer-inner">
    <p>${esc(siteName)}</p>
    ${
      showPlatformCredit
        ? `<p class="qh-platform-credit">Powered by <a href="https://quilthosting.com">QuiltHosting</a></p>`
        : ""
    }
  </div>
</footer>
<script src="/qh-site.js" defer></script>
</body>
</html>`;
}
