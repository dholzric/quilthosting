import { createMiddleware } from "hono/factory";
import type { Env, Tenant, TenantVariables } from "../types";
import { first } from "../lib/db";
import { getTenantByHost } from "../lib/tenantHost";

export const tenantMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: TenantVariables;
}>(async (c, next) => {
  const host = c.req.header("host") || "";
  const headerSlug = c.req.header("x-tenant-slug");
  const paramId = c.req.param("tenantId");

  let tenant: Tenant | null = null;

  if (paramId) {
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
