import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { sendEmail } from "../lib/email";

export const teamRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables & TenantVariables & { tenantRole: string };
}>();

const ROLES = ["owner", "admin", "membership", "events", "viewer"];

// GET /api/tenants/:tenantId/team
teamRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all(
    c.env.DB.prepare(
      `SELECT u.id user_id, u.email, u.name, tu.role, tu.created_at
       FROM tenant_users tu JOIN users u ON u.id = tu.user_id
       WHERE tu.tenant_id = ? ORDER BY tu.created_at`
    ).bind(tenant.id)
  );
  return c.json(rows);
});

// POST /api/tenants/:tenantId/team — invite a co-admin by email
teamRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const me = c.get("user");
  const myRole = c.get("tenantRole");
  if (!["owner", "admin"].includes(myRole)) {
    return c.json({ error: "Only owners and admins can invite" }, 403);
  }
  const body = await c.req.json<{ email: string; role?: string; name?: string }>();
  if (!body.email) return c.json({ error: "email is required" }, 400);
  const role = body.role || "admin";
  if (!ROLES.includes(role)) return c.json({ error: "Invalid role" }, 400);
  if (role === "owner" && myRole !== "owner") {
    return c.json({ error: "Only an owner can grant owner" }, 403);
  }

  const email = body.email.toLowerCase().trim();
  let user = await first<{ id: string; email: string; name: string | null }>(
    c.env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?").bind(email)
  );
  const now = new Date().toISOString();
  if (!user) {
    const id = generateId();
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(id, email, body.name ?? null, now, now)
      .run();
    user = { id, email, name: body.name ?? null };
  }

  const existing = await first(
    c.env.DB.prepare(
      "SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
    ).bind(tenant.id, user.id)
  );
  if (existing) return c.json({ error: "Already on the team" }, 409);

  await c.env.DB.prepare(
    "INSERT INTO tenant_users (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(tenant.id, user.id, role, now)
    .run();

  const adminUrl = `${c.env.APP_URL}/admin`;
  await sendEmail(c.env, {
    to: email,
    subject: `You've been added to ${tenant.name} on QuiltHosting`,
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.6;max-width:600px">
      <p>Hi${user.name ? " " + user.name : ""},</p>
      <p>${me.name || me.email} added you to <strong>${tenant.name}</strong> as <strong>${role}</strong>.</p>
      <p><a href="${adminUrl}" style="background:#c45c26;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Open the admin dashboard</a></p>
      <p style="color:#666;font-size:0.9em">Sign in with Google using this email address.</p>
    </div>`,
  });

  return c.json({ ok: true, user_id: user.id, role }, 201);
});

// PATCH /api/tenants/:tenantId/team/:userId — change role
teamRoutes.patch("/:userId", async (c) => {
  const tenant = c.get("tenant");
  const myRole = c.get("tenantRole");
  const userId = c.req.param("userId");
  if (!["owner", "admin"].includes(myRole)) {
    return c.json({ error: "Only owners and admins can manage roles" }, 403);
  }
  const body = await c.req.json<{ role: string }>();
  if (!ROLES.includes(body.role)) return c.json({ error: "Invalid role" }, 400);
  const target = await first<{ role: string }>(
    c.env.DB.prepare(
      "SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
    ).bind(tenant.id, userId)
  );
  if (!target) return c.json({ error: "Not on the team" }, 404);
  if ((target.role === "owner" || body.role === "owner") && myRole !== "owner") {
    return c.json({ error: "Only an owner can change owner roles" }, 403);
  }
  await c.env.DB.prepare(
    "UPDATE tenant_users SET role = ? WHERE tenant_id = ? AND user_id = ?"
  )
    .bind(body.role, tenant.id, userId)
    .run();
  return c.json({ ok: true });
});

// DELETE /api/tenants/:tenantId/team/:userId
teamRoutes.delete("/:userId", async (c) => {
  const tenant = c.get("tenant");
  const me = c.get("user");
  const myRole = c.get("tenantRole");
  const userId = c.req.param("userId");
  if (!["owner", "admin"].includes(myRole)) {
    return c.json({ error: "Only owners and admins can remove members" }, 403);
  }
  const target = await first<{ role: string }>(
    c.env.DB.prepare(
      "SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
    ).bind(tenant.id, userId)
  );
  if (!target) return c.json({ error: "Not on the team" }, 404);
  if (target.role === "owner") {
    const owners = await first<{ cnt: number }>(
      c.env.DB.prepare(
        "SELECT COUNT(*) cnt FROM tenant_users WHERE tenant_id = ? AND role = 'owner'"
      ).bind(tenant.id)
    );
    if ((owners?.cnt ?? 0) <= 1) {
      return c.json({ error: "Cannot remove the last owner" }, 400);
    }
    if (myRole !== "owner" && userId !== me.id) {
      return c.json({ error: "Only an owner can remove an owner" }, 403);
    }
  }
  await c.env.DB.prepare(
    "DELETE FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
  )
    .bind(tenant.id, userId)
    .run();
  return c.json({ ok: true });
});
