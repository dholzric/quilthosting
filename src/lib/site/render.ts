// Server-rendered page shell for business tenants. Replaces guild.html's
// client-side paint so pages are indexable and paint on first byte.

import { contentFromPage } from "../blocks";
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

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

  const navHtml = nav
    .map(
      (n) =>
        `<a href="${esc(n.href)}"${n.external ? ' rel="noopener"' : ""}>${esc(n.label)}</a>`
    )
    .join("");

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
      logoUrl ? `<img src="${esc(logoUrl)}" alt="" width="48" height="48">` : ""
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
