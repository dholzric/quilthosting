import { Hono } from "hono";
import type { Env, TenantVariables, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

export const chapterRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

/** List child chapters (multi-chapter Council). */
chapterRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all<Pick<Tenant, "id" | "name" | "slug" | "status" | "plan" | "created_at">>(
      c.env.DB.prepare(
        `SELECT id, name, slug, status, plan, created_at FROM tenants
         WHERE parent_tenant_id = ? ORDER BY name`
      ).bind(tenant.id)
    );
    return c.json({ parent: { id: tenant.id, name: tenant.name, slug: tenant.slug }, chapters: rows });
  } catch {
    return c.json({ parent: { id: tenant.id, name: tenant.name }, chapters: [] });
  }
});

/** Create a child chapter under this tenant. */
chapterRoutes.post("/", async (c) => {
  const parent = c.get("tenant");
  // Only root orgs can create chapters; chapters cannot nest further
  try {
    const p = await first<{ parent_tenant_id: string | null }>(
      c.env.DB.prepare(`SELECT parent_tenant_id FROM tenants WHERE id = ?`).bind(parent.id)
    );
    if (p?.parent_tenant_id) {
      return c.json({ error: "Chapters cannot create sub-chapters" }, 400);
    }
  } catch {
    /* column may not exist pre-migration */
  }

  const body = await c.req.json<{ name: string; slug?: string }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  let slug = (body.slug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (!slug) slug = generateId().slice(0, 8);

  const dupe = await first(
    c.env.DB.prepare(`SELECT id FROM tenants WHERE slug = ?`).bind(slug)
  );
  if (dupe) return c.json({ error: "That slug is already taken" }, 409);

  const id = generateId();
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants (id, name, slug, plan, status, settings_json, parent_tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'free', 'active', '{}', ?, ?, ?)`
    )
      .bind(id, name, slug, parent.id, now, now)
      .run();
  } catch (e: any) {
    return c.json({ error: e.message || "Could not create chapter" }, 500);
  }

  // Grant current user owner on the chapter if we can find them via header context
  // (owner is set separately by team invite flow)

  return c.json({ id, name, slug, parent_tenant_id: parent.id }, 201);
});

chapterRoutes.delete("/:chapterId", async (c) => {
  const parent = c.get("tenant");
  const chapterId = c.req.param("chapterId");
  const row = await first<{ id: string; parent_tenant_id: string | null }>(
    c.env.DB.prepare(`SELECT id, parent_tenant_id FROM tenants WHERE id = ?`).bind(chapterId)
  );
  if (!row || row.parent_tenant_id !== parent.id) {
    return c.json({ error: "Chapter not found" }, 404);
  }
  // Soft-disable rather than hard-delete guild data
  await c.env.DB.prepare(
    `UPDATE tenants SET status = 'archived', updated_at = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), chapterId)
    .run();
  return c.json({ ok: true });
});
