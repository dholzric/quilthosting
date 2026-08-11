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

  // Tenant-uploaded images (logo, OG image, and anything else uploaded
  // through the Files admin page). tenant_id in the WHERE clause is what
  // stops one tenant's file id from reading another tenant's image -- see
  // siteGate's TENANT_IMAGE_PATH_RE for the allowlist that lets this path
  // shape through the private-preview gate in the first place.
  const imgMatch = path.match(/^\/img\/([A-Za-z0-9_-]{1,64})$/);
  if (imgMatch) {
    const fileRow = await first<{ r2_key: string; content_type: string | null }>(
      c.env.DB.prepare(
        `SELECT r2_key, content_type FROM files WHERE id = ? AND tenant_id = ?`
      ).bind(imgMatch[1], tenant.id)
    );
    if (!fileRow) return new Response("Not found", { status: 404 });
    // Security: this route is served on the tenant's own first-party
    // origin, so echoing back whatever content_type was recorded at upload
    // time (fileRoutes.post("/") accepts ANY Content-Type a caller with
    // upload rights sends) would let a stored `text/html` file execute as
    // same-origin script on the tenant's live site -- stored XSS, not
    // cross-tenant, but real. A route named /img/ has no legitimate reason
    // to serve anything but an actual raster image, so this allowlists the
    // handful of real image types and 404s on everything else rather than
    // guessing or falling back to a default. image/svg+xml is deliberately
    // EXCLUDED: SVG is active content (it can carry inline <script>) and
    // would reopen the same hole even though its MIME type looks image-y.
    const ALLOWED_IMAGE_TYPES = new Set([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
    ]);
    const contentType = fileRow.content_type || "";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      return new Response("Not found", { status: 404 });
    }
    const obj = await c.env.FILES.get(fileRow.r2_key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": contentType,
        // Belt-and-suspenders alongside the allowlist above: even if a
        // browser tried to sniff the body into a different interpretation
        // than the declared (already-allowlisted) type, this forbids it.
        "X-Content-Type-Options": "nosniff",
        // File ids are immutable -- a replaced image gets a new id, so this
        // can be cached forever without a purge.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
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

  let logoFileId = "";
  try {
    logoFileId = String(
      (JSON.parse(tenant.settings_json || "{}").assets || {}).logo_file_id || ""
    );
  } catch {
    logoFileId = "";
  }
  const logoUrl = logoFileId ? `${baseUrl}/img/${logoFileId}` : null;
  const ogImageUrl = row.og_image_file_id ? `${baseUrl}/img/${row.og_image_file_id}` : null;

  return cachedRender({
    host,
    path,
    // Folds in tenant.updated_at, not just the page's own updated_at:
    // business identity (name/phone/address), the logo file id, and nav all
    // live in tenant.settings_json, not on the pages row, and
    // src/routes/tenants.ts's PATCH handler bumps tenants.updated_at
    // unconditionally on every settings save (tenants.ts:167-168). Without
    // this, saving Business Details wouldn't change the cache key at all --
    // the owner could edit her phone number, save, reload, and see nothing
    // change for up to the 24h edge TTL, with no way to force a refresh.
    //
    // Each component is percent-encoded BEFORE being joined with ":", not
    // after -- siteCacheKey only applies one outer encodeURIComponent to
    // the whole string it's handed, so an unescaped ":" here would rely on
    // neither timestamp ever containing a literal ":" itself to stay
    // injective. Both today's formats (SQLite's `datetime('now')` and
    // `Date.prototype.toISOString()`) happen to start "YYYY-MM-DD" before
    // any colon, so a collision can't actually happen right now -- but
    // that's an unenforced property of two unrelated timestamp formats, not
    // something this code guarantees. Encoding each side first turns any
    // ":" or "%" inside either raw value into %3A / %25, so the two
    // components can never be reparsed into a different (page, tenant)
    // pair no matter what either timestamp format does later.
    updatedAt: `${encodeURIComponent(row.updated_at)}:${encodeURIComponent(tenant.updated_at)}`,
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
        logoUrl,
        ogImageUrl,
        showPlatformCredit,
      }),
  });
}
