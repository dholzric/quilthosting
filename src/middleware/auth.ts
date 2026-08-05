import { createMiddleware } from "hono/factory";
import type { Env, TenantVariables } from "../types";
import { verifyJwt, extractBearer } from "../lib/auth";
import { first } from "../lib/db";

export type AuthVariables = TenantVariables & {
  user: {
    id: string;
    email: string;
    name?: string;
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

/**
 * Runs after requireAuth + tenantMiddleware: the user must have a
 * tenant_users row for the resolved tenant. Attaches tenantRole.
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
  if (!row) {
    return c.json({ error: "Forbidden" }, 403);
  }
  c.set("tenantRole", row.role);
  await next();
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
