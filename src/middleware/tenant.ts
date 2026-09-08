import { createMiddleware } from "hono/factory";
import type { Env, Tenant, TenantVariables } from "../types";
import { first } from "../lib/db";
import { getTenantByHost } from "../lib/tenantHost";

export const tenantMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: TenantVariables & { user?: { id: string }; tenantRole?: string };
}>(async (c, next) => {
  const host = c.req.header("host") || "";
  const headerSlug = c.req.header("x-tenant-slug");
  const paramId = c.req.param("tenantId");
  const user = c.get("user");

  let tenant: Tenant | null = null;

  if (paramId && user?.id) {
    // Admin API path: fetch the tenant AND the caller's role in one D1 round
    // trip. requireTenantAccess skips its own lookup when tenantRole is
    // already set, which removes one sequential query from every admin call.
    const row = await first<Tenant & { __role: string | null }>(
      c.env.DB.prepare(
        `SELECT t.*, tu.role AS __role
         FROM tenants t
         LEFT JOIN tenant_users tu ON tu.tenant_id = t.id AND tu.user_id = ?
         WHERE t.id = ?`
      ).bind(user.id, paramId)
    );
    if (row) {
      const { __role, ...rest } = row;
      tenant = rest as Tenant;
      if (__role) c.set("tenantRole", __role);
    }
  } else if (paramId) {
    tenant = await first<Tenant>(
      c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(paramId)
    );
  } else if (headerSlug) {
    tenant = await first<Tenant>(
      c.env.DB.prepare(
        "SELECT * FROM tenants WHERE slug = ? AND status = 'active'"
      ).bind(headerSlug)
    );
  } else {
    tenant = await getTenantByHost(c.env.DB, host, c.env.APP_URL);
  }

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  if (tenant.status !== "active") {
    return c.json({ error: "Guild is not active" }, 403);
  }

  c.set("tenant", tenant);
  await next();
});
