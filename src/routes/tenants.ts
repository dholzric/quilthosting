import { Hono } from "hono";
import type { Env, Tenant } from "../types";
import { generateId } from "../lib/utils/id";
import { first, all } from "../lib/db";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { TRIAL_DAYS } from "../lib/plans";
import { ensurePlatformSubdomain } from "../lib/tenantHost";

export const tenantRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

tenantRoutes.use("*", requireAuth);

// GET /api/tenants — guilds the current user belongs to
// Platform admins see every tenant (role = membership role or "platform").
tenantRoutes.get("/", async (c) => {
  const user = c.get("user");
  const adminRow = await first<{ is_platform_admin: number }>(
    c.env.DB.prepare(
      "SELECT is_platform_admin FROM users WHERE id = ?"
    ).bind(user.id)
  );
  if (adminRow?.is_platform_admin) {
    const rows = await all<Tenant & { role: string }>(
      c.env.DB.prepare(
        `SELECT t.*, COALESCE(tu.role, 'platform') AS role
         FROM tenants t
         LEFT JOIN tenant_users tu
           ON tu.tenant_id = t.id AND tu.user_id = ?
         ORDER BY t.name COLLATE NOCASE`
      ).bind(user.id)
    );
    return c.json({ tenants: rows, platform_admin: true });
  }
  const rows = await all<Tenant & { role: string }>(
    c.env.DB.prepare(
      `SELECT t.*, tu.role FROM tenants t
       JOIN tenant_users tu ON tu.tenant_id = t.id
       WHERE tu.user_id = ? AND t.status = 'active'
       ORDER BY t.created_at`
    ).bind(user.id)
  );
  return c.json({ tenants: rows, platform_admin: false });
});

// POST /api/tenants — create a guild; creator becomes owner
tenantRoutes.post("/", async (c) => {
  const user = c.get("user");
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
  // 30-day Guild trial (unlimited members) without a credit card
  const trialEnds = new Date();
  trialEnds.setUTCDate(trialEnds.getUTCDate() + TRIAL_DAYS);
  const trialIso = trialEnds.toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO tenants (id, name, slug, plan, status, settings_json, trial_ends_at, created_at, updated_at)
         VALUES (?, ?, ?, 'free', 'active', '{}', ?, ?, ?)`
      ).bind(id, body.name, slug, trialIso, now, now),
      c.env.DB.prepare(
        `INSERT INTO tenant_users (tenant_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`
      ).bind(id, user.id, now),
    ]);
  } catch {
    // Pre-migration fallback without trial_ends_at
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO tenants (id, name, slug, plan, status, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, 'free', 'active', '{}', ?, ?)`
      ).bind(id, body.name, slug, now, now),
      c.env.DB.prepare(
        `INSERT INTO tenant_users (tenant_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`
      ).bind(id, user.id, now),
    ]);
  }
  const tenant = await first<Tenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  // Best-effort: attach free {slug}.quilthosting.com Workers domain
  void ensurePlatformSubdomain(c.env, slug).catch(() => {});
  return c.json(tenant, 201);
});

// GET /api/tenants/:id — members of the guild only (platform admins: any)
tenantRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const membership = await first(
    c.env.DB.prepare(
      "SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
    ).bind(id, user.id)
  );
  if (!membership) {
    const adminRow = await first<{ is_platform_admin: number }>(
      c.env.DB.prepare(
        "SELECT is_platform_admin FROM users WHERE id = ?"
      ).bind(user.id)
    );
    if (!adminRow?.is_platform_admin) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }
  const tenant = await first<Tenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  if (!tenant) return c.json({ error: "Not found" }, 404);
  return c.json(tenant);
});

// PATCH /api/tenants/:id — owner/admin can rename or update settings
tenantRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const membership = await first<{ role: string }>(
    c.env.DB.prepare(
      "SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
    ).bind(id, user.id)
  );
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const body = await c.req.json<{
    name?: string;
    settings?: Record<string, unknown>;
    public_launched?: number | boolean;
  }>();
  const fields: string[] = [];
  const params: any[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: "name cannot be empty" }, 400);
    fields.push("name = ?");
    params.push(body.name.trim());
  }
  if (body.settings !== undefined) {
    fields.push("settings_json = ?");
    params.push(JSON.stringify(body.settings));
  }
  // Deliberately NOT handled here: tenant_type. A tenant owner/admin who
  // could flip their own guild to "business" would drop their member cap
  // (src/lib/plans.ts) and gain the public launch toggle below. tenant_type
  // is set at tenant creation or by a platform admin only — see
  // PATCH /api/platform/tenants/:id in src/routes/platform.ts.
  if (body.public_launched !== undefined) {
    fields.push("public_launched = ?");
    params.push(body.public_launched ? 1 : 0);
  }
  if (!fields.length) return c.json({ error: "No fields to update" }, 400);
  fields.push("updated_at = ?");
  params.push(new Date().toISOString(), id);
  await c.env.DB.prepare(
    `UPDATE tenants SET ${fields.join(", ")} WHERE id = ?`
  )
    .bind(...params)
    .run();
  const tenant = await first<Tenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  return c.json(tenant);
});
