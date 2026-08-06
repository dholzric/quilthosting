import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { parseBlocks } from "../lib/blocks";

export const pageRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type PageRow = {
  id: string;
  slug: string;
  title: string;
  content_json: string;
  blocks_json?: string | null;
  page_type?: string;
  show_in_nav?: number;
  nav_label?: string | null;
  is_members_only: number;
  published: number;
  sort_order: number;
  updated_at: string;
};

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// GET /api/tenants/:tenantId/pages
pageRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const type = c.req.query("type"); // page | blog_post
  try {
    let sql = `SELECT id, slug, title, content_json, blocks_json, page_type, show_in_nav, nav_label,
                      is_members_only, published, sort_order, updated_at
               FROM pages WHERE tenant_id = ?`;
    const binds: string[] = [tenant.id];
    if (type === "blog_post" || type === "page") {
      sql += ` AND coalesce(page_type, 'page') = ?`;
      binds.push(type);
    }
    sql += ` ORDER BY sort_order, title`;
    const rows = await all<PageRow>(c.env.DB.prepare(sql).bind(...binds));
    return c.json(rows);
  } catch {
    // Pre-migration fallback
    const rows = await all<PageRow>(
      c.env.DB.prepare(
        `SELECT id, slug, title, content_json, is_members_only, published, sort_order, updated_at
         FROM pages WHERE tenant_id = ? ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
    return c.json(rows);
  }
});

// POST /api/tenants/:tenantId/pages
pageRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    title: string;
    content_html?: string;
    blocks?: unknown;
    page_type?: "page" | "blog_post";
    is_members_only?: boolean;
    published?: boolean;
    sort_order?: number;
    show_in_nav?: boolean;
    nav_label?: string;
  }>();
  if (!body.title) return c.json({ error: "title is required" }, 400);
  const slug = slugify(body.title);
  if (!slug) return c.json({ error: "title must contain letters or numbers" }, 400);
  const dupe = await first(
    c.env.DB.prepare(
      "SELECT id FROM pages WHERE tenant_id = ? AND slug = ?"
    ).bind(tenant.id, slug)
  );
  if (dupe) return c.json({ error: "A page with that title already exists" }, 409);
  const id = generateId();
  const now = new Date().toISOString();
  const blocks = body.blocks !== undefined ? parseBlocks(body.blocks) : [];
  const contentJson = JSON.stringify({ html: body.content_html || "" });
  const pageType = body.page_type === "blog_post" ? "blog_post" : "page";
  try {
    await c.env.DB.prepare(
      `INSERT INTO pages
       (id, tenant_id, slug, title, content_json, blocks_json, page_type, show_in_nav, nav_label,
        is_members_only, published, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenant.id,
        slug,
        body.title,
        contentJson,
        blocks.length ? JSON.stringify(blocks) : null,
        pageType,
        body.show_in_nav === false ? 0 : 1,
        body.nav_label?.trim() || null,
        body.is_members_only ? 1 : 0,
        body.published === false ? 0 : 1,
        body.sort_order ?? 0,
        now,
        now
      )
      .run();
  } catch {
    await c.env.DB.prepare(
      `INSERT INTO pages (id, tenant_id, slug, title, content_json, is_members_only, published, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenant.id,
        slug,
        body.title,
        contentJson,
        body.is_members_only ? 1 : 0,
        body.published === false ? 0 : 1,
        body.sort_order ?? 0,
        now,
        now
      )
      .run();
  }
  const page = await first<PageRow>(
    c.env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id)
  );
  return c.json(page, 201);
});

// PATCH /api/tenants/:tenantId/pages/:pageId
pageRoutes.patch("/:pageId", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const existing = await first<PageRow>(
    c.env.DB.prepare(
      "SELECT * FROM pages WHERE id = ? AND tenant_id = ?"
    ).bind(pageId, tenant.id)
  );
  if (!existing) return c.json({ error: "Page not found" }, 404);
  const body = await c.req.json<{
    title?: string;
    content_html?: string;
    blocks?: unknown;
    page_type?: "page" | "blog_post";
    is_members_only?: boolean;
    published?: boolean;
    sort_order?: number;
    show_in_nav?: boolean;
    nav_label?: string | null;
  }>();
  const content =
    body.content_html !== undefined
      ? JSON.stringify({ html: body.content_html })
      : existing.content_json;
  const blocksJson =
    body.blocks !== undefined
      ? JSON.stringify(parseBlocks(body.blocks))
      : existing.blocks_json ?? null;
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `UPDATE pages SET
         title = coalesce(?, title),
         content_json = ?,
         blocks_json = ?,
         page_type = coalesce(?, page_type),
         is_members_only = coalesce(?, is_members_only),
         published = coalesce(?, published),
         sort_order = coalesce(?, sort_order),
         show_in_nav = coalesce(?, show_in_nav),
         nav_label = coalesce(?, nav_label),
         updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    )
      .bind(
        body.title ?? null,
        content,
        blocksJson,
        body.page_type ?? null,
        body.is_members_only !== undefined ? (body.is_members_only ? 1 : 0) : null,
        body.published !== undefined ? (body.published ? 1 : 0) : null,
        body.sort_order ?? null,
        body.show_in_nav !== undefined ? (body.show_in_nav ? 1 : 0) : null,
        body.nav_label !== undefined ? body.nav_label : null,
        now,
        pageId,
        tenant.id
      )
      .run();
  } catch {
    await c.env.DB.prepare(
      `UPDATE pages SET
         title = coalesce(?, title),
         content_json = ?,
         is_members_only = coalesce(?, is_members_only),
         published = coalesce(?, published),
         sort_order = coalesce(?, sort_order),
         updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    )
      .bind(
        body.title ?? null,
        content,
        body.is_members_only !== undefined ? (body.is_members_only ? 1 : 0) : null,
        body.published !== undefined ? (body.published ? 1 : 0) : null,
        body.sort_order ?? null,
        now,
        pageId,
        tenant.id
      )
      .run();
  }
  const page = await first<PageRow>(
    c.env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(pageId)
  );
  return c.json(page);
});

// DELETE /api/tenants/:tenantId/pages/:pageId
pageRoutes.delete("/:pageId", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const res = await c.env.DB.prepare(
    "DELETE FROM pages WHERE id = ? AND tenant_id = ?"
  )
    .bind(pageId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Page not found" }, 404);
  return c.json({ ok: true });
});

/** Site theme + custom nav links stored on tenant settings_json */
pageRoutes.get("/site/settings", async (c) => {
  const tenant = c.get("tenant");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  return c.json({
    theme: settings.theme || {},
    nav: settings.nav || [],
  });
});

pageRoutes.patch("/site/settings", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{ theme?: unknown; nav?: unknown }>();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  if (body.theme !== undefined) settings.theme = body.theme;
  if (body.nav !== undefined) {
    const nav = Array.isArray(body.nav)
      ? body.nav
          .map((n: any) => ({
            label: String(n.label || "").slice(0, 60),
            href: String(n.href || "").slice(0, 500),
            external: !!n.external,
          }))
          .filter((n: any) => n.label && n.href)
          .slice(0, 20)
      : [];
    settings.nav = nav;
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(JSON.stringify(settings), now, tenant.id)
    .run();
  return c.json({ theme: settings.theme || {}, nav: settings.nav || [] });
});
