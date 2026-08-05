import { Hono } from "hono";
import type { Env, Tenant } from "../types";
import { generateId } from "../lib/utils/id";
import { first } from "../lib/db";

export const tenantRoutes = new Hono<{ Bindings: Env }>();

tenantRoutes.post("/", async (c) => {
  const body = await c.req.json<{ name: string; slug: string }>();
  if (!body.name || !body.slug) {
    return c.json({ error: "name and slug are required" }, 400);
  }
  const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (slug.length < 2) {
    return c.json({ error: "Invalid slug" }, 400);
  }
  const existing = await first(
    c.env.DB.prepare("SELECT id FROM tenants WHERE slug = ?").bind(slug)
  );
  if (existing) {
    return c.json({ error: "Slug already taken" }, 409);
  }
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO tenants (id, name, slug, plan, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, 'free', 'active', '{}', ?, ?)`
  )
    .bind(id, body.name, slug, now, now)
    .run();
  const tenant = await first<Tenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  return c.json(tenant, 201);
});

tenantRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const tenant = await first<Tenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  if (!tenant) return c.json({ error: "Not found" }, 404);
  return c.json(tenant);
});
