import { Hono } from "hono";
import type { Env, MembershipLevel, TenantVariables } from "../types";
import { generateId } from "../lib/utils/id";
import { all, first } from "../lib/db";

export const levelRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

levelRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const levels = await all<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE tenant_id = ? AND status = 'active' ORDER BY sort_order, name"
    ).bind(tenant.id)
  );
  return c.json(levels);
});

levelRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    name: string;
    description?: string;
    price_cents?: number;
    duration_months?: number;
    renewal_type?: "manual" | "auto";
    is_public?: boolean;
  }>();
  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO membership_levels
     (id, tenant_id, name, description, price_cents, duration_months, renewal_type, is_public, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      body.name,
      body.description ?? null,
      body.price_cents ?? 0,
      body.duration_months ?? 12,
      body.renewal_type ?? "manual",
      body.is_public === false ? 0 : 1,
      now,
      now
    )
    .run();
  const level = await first<MembershipLevel>(
    c.env.DB.prepare("SELECT * FROM membership_levels WHERE id = ?").bind(id)
  );
  return c.json(level, 201);
});

levelRoutes.get("/:levelId", async (c) => {
  const tenant = c.get("tenant");
  const levelId = c.req.param("levelId");
  const level = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?"
    ).bind(levelId, tenant.id)
  );
  if (!level) return c.json({ error: "Not found" }, 404);
  return c.json(level);
});

levelRoutes.patch("/:levelId", async (c) => {
  const tenant = c.get("tenant");
  const levelId = c.req.param("levelId");
  const body = await c.req.json();
  const existing = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?"
    ).bind(levelId, tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE membership_levels SET
       name = coalesce(?, name),
       description = coalesce(?, description),
       price_cents = coalesce(?, price_cents),
       duration_months = coalesce(?, duration_months),
       renewal_type = coalesce(?, renewal_type),
       is_public = coalesce(?, is_public),
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.name ?? null,
      body.description ?? null,
      body.price_cents ?? null,
      body.duration_months ?? null,
      body.renewal_type ?? null,
      body.is_public !== undefined ? (body.is_public ? 1 : 0) : null,
      now,
      levelId,
      tenant.id
    )
    .run();
  const updated = await first<MembershipLevel>(
    c.env.DB.prepare("SELECT * FROM membership_levels WHERE id = ?").bind(levelId)
  );
  return c.json(updated);
});
