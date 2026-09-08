import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env, MembershipLevel, TenantVariables } from "../types";
import { generateId } from "../lib/utils/id";
import { all, first } from "../lib/db";

export const levelRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

// price_cents is integer cents (the admin UI converts from dollars);
// duration_months 1..120 (ten years) keeps computeMembershipEnd sane.
const priceCentsSchema = z
  .number({ invalid_type_error: "price_cents must be a whole number of cents" })
  .int("price_cents must be a whole number of cents")
  .min(0, "price_cents cannot be negative")
  .max(100_000_000, "price_cents is too large");
const durationSchema = z
  .number({ invalid_type_error: "duration_months must be a whole number" })
  .int("duration_months must be a whole number")
  .min(1, "duration_months must be between 1 and 120")
  .max(120, "duration_months must be between 1 and 120");
const nameSchema = z.string().trim().min(1, "name is required").max(120);
const descriptionSchema = z.string().max(2000).nullable();
const renewalSchema = z.enum(["manual", "auto"]);

const createLevelSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  price_cents: priceCentsSchema.optional(),
  duration_months: durationSchema.optional(),
  renewal_type: renewalSchema.optional(),
  is_public: z.boolean().optional(),
});
const patchLevelSchema = createLevelSchema.partial();

function validationError(c: Context, error: z.ZodError) {
  const first = error.issues[0];
  return c.json(
    {
      error: first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request body",
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
    400
  );
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

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
  const parsed = createLevelSchema.safeParse(await readJson(c));
  if (!parsed.success) return validationError(c, parsed.error);
  const body = parsed.data;
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
  const parsed = patchLevelSchema.safeParse(await readJson(c));
  if (!parsed.success) return validationError(c, parsed.error);
  const body = parsed.data;
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

// Soft-archive level (hide from public/join; keep history)
levelRoutes.delete("/:levelId", async (c) => {
  const tenant = c.get("tenant");
  const levelId = c.req.param("levelId");
  const res = await c.env.DB.prepare(
    `UPDATE membership_levels SET status = 'archived', updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'active'`
  )
    .bind(new Date().toISOString(), levelId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Level not found" }, 404);
  return c.json({ ok: true, status: "archived" });
});
