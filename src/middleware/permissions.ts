// src/middleware/permissions.ts
// Enforces src/lib/permissions.ts for everything mounted under
// /api/tenants/:tenantId. Must run after requireTenantAccess (which sets
// `tenantRole`); fails closed (403) when the role is missing.
//
// Wire-up (src/index.ts):
//   tenantApp.use("*", requireTenantAccess);
//   tenantApp.use("*", requirePermission);   // <- add this line
import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { canAccess, rolesAllowed, splitTenantPath } from "../lib/permissions";

export const requirePermission = createMiddleware<{
  Bindings: Env;
  Variables: { tenantRole: string };
}>(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "OPTIONS") {
    await next();
    return;
  }

  // c.get() returns undefined at runtime when requireTenantAccess did not run.
  const role = c.get("tenantRole") as string | undefined;

  let tenantId: string | undefined;
  try {
    tenantId = c.req.param("tenantId");
  } catch {
    tenantId = undefined;
  }
  const { area, subPath } = splitTenantPath(c.req.path, tenantId);

  if (!role || !canAccess(role, area, method, subPath)) {
    return c.json(
      {
        error: "Forbidden",
        required: {
          area,
          method,
          roles: rolesAllowed(area, method, subPath),
        },
        role: role ?? null,
      },
      403
    );
  }
  await next();
});
