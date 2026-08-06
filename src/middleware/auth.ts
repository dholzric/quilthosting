import { createMiddleware } from "hono/factory";
import type { Env, TenantVariables } from "../types";
import { verifyJwt, extractBearer } from "../lib/auth";
import { first } from "../lib/db";

export type AuthVariables = TenantVariables & {
  user: {
    id: string;
    email: string;
    name?: string;
    isPlatformAdmin?: boolean;
  };
};

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables;
}>(async (c, next) => {
  const token = extractBearer(c.req.header("Authorization"));
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  c.set("user", {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
  });
  await next();
});

/** Load is_platform_admin from DB (JWT does not carry the flag). */
async function isPlatformAdmin(db: D1Database, userId: string): Promise<boolean> {
  const row = await first<{ is_platform_admin: number }>(
    db.prepare("SELECT is_platform_admin FROM users WHERE id = ?").bind(userId)
  );
  return !!(row && row.is_platform_admin);
}

/**
 * Platform super-users (QuiltHosting operators). Requires requireAuth first.
 */
export const requirePlatformAdmin = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables;
}>(async (c, next) => {
  const user = c.get("user");
  if (!(await isPlatformAdmin(c.env.DB, user.id))) {
    return c.json({ error: "Platform admin required" }, 403);
  }
  c.set("user", { ...user, isPlatformAdmin: true });
  await next();
});

/**
 * Runs after requireAuth + tenantMiddleware: the user must have a
 * tenant_users row for the resolved tenant. Attaches tenantRole.
 * Platform admins may open any tenant with role "platform".
 */
export const requireTenantAccess = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables & { tenantRole: string };
}>(async (c, next) => {
  const user = c.get("user");
  const tenant = c.get("tenant");
  const row = await first<{ role: string }>(
    c.env.DB.prepare(
      "SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
    ).bind(tenant.id, user.id)
  );
  if (row) {
    c.set("tenantRole", row.role);
    await next();
    return;
  }
  if (await isPlatformAdmin(c.env.DB, user.id)) {
    c.set("tenantRole", "platform");
    await next();
    return;
  }
  return c.json({ error: "Forbidden" }, 403);
});

export const optionalAuth = createMiddleware<{
  Bindings: Env;
  Variables: Partial<AuthVariables> & TenantVariables;
}>(async (c, next) => {
  const token = extractBearer(c.req.header("Authorization"));
  if (token) {
    const payload = await verifyJwt(token, c.env.JWT_SECRET);
    if (payload) {
      c.set("user", {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
      });
    }
  }
  await next();
});
