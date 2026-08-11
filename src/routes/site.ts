// src/routes/site.ts
// Serves a business tenant's public website: pages, sitemap, robots.

import type { Context } from "hono";
import type { Env, Tenant } from "../types";
import { all, first } from "../lib/db";
import { renderPageHtml, readBranding } from "../lib/site/render";
import { cachedRender } from "../lib/site/cache";
import { tenantPublicBaseUrl } from "../lib/tenantHost";

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
 * Serve a public site path. Returns null when the path is not a site page so
 * the caller can fall through to the platform's own routes.
 */
export async function serveBusinessSite(
  c: Context<{ Bindings: Env }>,
  tenant: Tenant
): Promise<Response | null> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const host = c.req.header("host") || url.host;
  const baseUrl = tenantPublicBaseUrl(c.env, tenant, host);

  if (path === "/robots.txt") {
    // A launched business site is meant to be crawled. Point at its own
    // sitemap, not the platform's.
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (path === "/sitemap.xml") {
    const rows = await all<{ slug: string; updated_at: string }>(
      c.env.DB.prepare(
        `SELECT slug, updated_at FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(noindex, 0) = 0
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
    const urls = rows
      .map((r) => {
        const loc = r.slug ? `${baseUrl}/${r.slug}` : `${baseUrl}/`;
        return `<url><loc>${loc}</loc><lastmod>${(r.updated_at || "").slice(0, 10)}</lastmod></url>`;
      })
      .join("");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
      { headers: { "Content-Type": "application/xml; charset=utf-8" } }
    );
  }

  const slug = path === "/" ? "" : path.replace(/^\/+/, "").replace(/\/+$/, "");
  // Home page convention: an empty slug, or a page explicitly named "home".
  const row = await first<PageRow>(
    c.env.DB.prepare(
      `SELECT id, slug, title, content_json, blocks_json, seo_title, seo_description,
              og_image_file_id, coalesce(noindex, 0) AS noindex, updated_at
       FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         AND slug = ?
       LIMIT 1`
    ).bind(tenant.id, slug || "home")
  );

  if (!row) return null;

  const nav = await loadNav(c.env, tenant);
  const { showPlatformCredit } = readBranding(tenant.settings_json);

  return cachedRender({
    host,
    path,
    updatedAt: row.updated_at,
    build: () =>
      renderPageHtml({
        tenant: { name: tenant.name, slug: tenant.slug, settings_json: tenant.settings_json },
        page: {
          title: row.title,
          slug: slug,
          seo_title: row.seo_title,
          seo_description: row.seo_description,
          og_image_file_id: row.og_image_file_id,
          noindex: row.noindex,
          content_json: row.content_json,
          blocks_json: row.blocks_json,
        },
        nav,
        baseUrl,
        showPlatformCredit,
      }),
  });
}
