// src/middleware/permissions.test.ts
// requirePermission dispatched through a tiny Hono app mounted the same way
// src/index.ts mounts tenantApp (`/api/tenants/:tenantId`), with a stub
// upstream middleware standing in for requireAuth + tenantMiddleware +
// requireTenantAccess (which set `tenantRole`). Same idiom as
// src/routes/credentials.test.ts. No D1, no live Worker.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requirePermission } from "./permissions";
import type { Env } from "../types";

function buildApp(role: string | undefined) {
  const tenantApp = new Hono<{ Bindings: Env; Variables: { tenantRole: string } }>();
  tenantApp.use("*", async (c, next) => {
    if (role !== undefined) c.set("tenantRole", role);
    await next();
  });
  tenantApp.use("*", requirePermission);
  // Catch-all sub-routes so a passthrough is observable as 200 + area echo.
  for (const area of ["pages", "api-keys", "events", "members", "team", "billing", "credentials"]) {
    const sub = new Hono<{ Bindings: Env }>();
    sub.all("/", (c) => c.json({ ok: true, area }));
    sub.all("/*", (c) => c.json({ ok: true, area }));
    tenantApp.route(`/${area}`, sub);
  }
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/tenants/:tenantId", tenantApp);
  return app;
}

const env = {} as Env;

async function call(role: string | undefined, method: string, path: string) {
  const app = buildApp(role);
  return app.request(`/api/tenants/tenant-1${path}`, { method }, env);
}

describe("requirePermission", () => {
  it("viewer POST /pages -> 403", async () => {
    const res = await call("viewer", "POST", "/pages");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; role: string; required: { area: string; roles: string[] } };
    expect(body.error).toBe("Forbidden");
    expect(body.role).toBe("viewer");
    expect(body.required.area).toBe("pages");
    expect(body.required.roles).toEqual(expect.arrayContaining(["owner", "admin"]));
    expect(body.required.roles).not.toContain("viewer");
  });

  it("viewer POST /api-keys -> 403", async () => {
    expect((await call("viewer", "POST", "/api-keys")).status).toBe(403);
  });

  it("viewer GET /api-keys -> 403", async () => {
    expect((await call("viewer", "GET", "/api-keys")).status).toBe(403);
  });

  it("viewer GET /pages and GET /team pass through", async () => {
    expect((await call("viewer", "GET", "/pages")).status).toBe(200);
    expect((await call("viewer", "GET", "/team")).status).toBe(200);
  });

  it("viewer GET /members/export.csv -> 403", async () => {
    expect((await call("viewer", "GET", "/members/export.csv")).status).toBe(403);
    expect((await call("viewer", "GET", "/members")).status).toBe(200);
  });

  it("events POST /events passes through", async () => {
    const res = await call("events", "POST", "/events");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, area: "events" });
  });

  it("events POST /events/ev1/check-in passes through, GET registrations.csv -> 403", async () => {
    expect((await call("events", "POST", "/events/ev1/check-in")).status).toBe(200);
    expect((await call("events", "GET", "/events/ev1/registrations.csv")).status).toBe(403);
  });

  it("membership POST /members passes through", async () => {
    expect((await call("membership", "POST", "/members")).status).toBe(200);
    expect((await call("membership", "PATCH", "/members/m1")).status).toBe(200);
  });

  it("membership POST /pages -> 403", async () => {
    expect((await call("membership", "POST", "/pages")).status).toBe(403);
  });

  it("membership GET /billing and /credentials -> 403", async () => {
    expect((await call("membership", "GET", "/billing")).status).toBe(403);
    expect((await call("membership", "GET", "/credentials")).status).toBe(403);
  });

  it("missing role -> 403 (fail closed)", async () => {
    const res = await call(undefined, "GET", "/pages");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { role: string | null };
    expect(body.role).toBeNull();
  });

  it("unknown role -> 403", async () => {
    expect((await call("superuser", "GET", "/pages")).status).toBe(403);
  });

  it("owner anything passes through", async () => {
    for (const [m, p] of [
      ["POST", "/pages"],
      ["POST", "/api-keys"],
      ["DELETE", "/api-keys/k1"],
      ["GET", "/credentials"],
      ["PUT", "/credentials/stripe"],
      ["POST", "/billing/checkout"],
      ["GET", "/members/export.csv"],
    ] as const) {
      const res = await call("owner", m, p);
      expect(res.status, `${m} ${p}`).toBe(200);
    }
  });

  it("admin and platform pass through like owner", async () => {
    expect((await call("admin", "POST", "/api-keys")).status).toBe(200);
    expect((await call("platform", "POST", "/api-keys")).status).toBe(200);
  });

  it("OPTIONS passes through regardless of role", async () => {
    expect((await call("viewer", "OPTIONS", "/api-keys")).status).toBe(200);
    expect((await call(undefined, "OPTIONS", "/api-keys")).status).toBe(200);
  });
});
