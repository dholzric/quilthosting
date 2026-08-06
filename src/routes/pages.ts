import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

export const pageRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type PageRow = {
  id: string;
  slug: string;
  title: string;
  content_json: string;
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
  const rows = await all<PageRow>(
    c.env.DB.prepare(
      `SELECT id, slug, title, content_json, is_members_only, published, sort_order, updated_at
       FROM pages WHERE tenant_id = ? ORDER BY sort_order, title`
    ).bind(tenant.id)
  );
  return c.json(rows);
});

// POST /api/tenants/:tenantId/pages
pageRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    title: string;
    content_html?: string;
    is_members_only?: boolean;
    published?: boolean;
    sort_order?: number;
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
  await c.env.DB.prepare(
    `INSERT INTO pages (id, tenant_id, slug, title, content_json, is_members_only, published, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      slug,
      body.title,
      JSON.stringify({ html: body.content_html || "" }),
      body.is_members_only ? 1 : 0,
      body.published === false ? 0 : 1,
      body.sort_order ?? 0,
      now,
      now
    )
    .run();
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
    is_members_only?: boolean;
    published?: boolean;
    sort_order?: number;
  }>();
  const content =
    body.content_html !== undefined
      ? JSON.stringify({ html: body.content_html })
      : existing.content_json;
  const now = new Date().toISOString();
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
