// src/routes/platform.test.ts
// Mechanical verification for the new PATCH /api/platform/tenants/:id
// route: this is the ONLY place tenant_type is settable (see
// src/routes/tenants.test.ts for the tenant-owner PATCH's rejection of it),
// and it must stay behind requirePlatformAdmin.
//
// Same idiom as src/routes/credentials.test.ts / tenants.test.ts: real
// requests through the exported `platformRoutes` Hono app, a real signed
// JWT (requireAuth + requirePlatformAdmin are both baked into
// platformRoutes), and a keyword-routed fake D1.
import { describe, it, expect } from "vitest";
import { platformRoutes } from "./platform";
import { signJwt } from "../lib/auth";
import type { Env } from "../types";

const JWT_SECRET = "test-secret-not-used-in-prod";
const USER_ID = "user-1";
const TENANT_ID = "tenant-1";

function fakeDb(opts: { isPlatformAdmin: boolean; tenantExists: boolean }) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first<T = Record<string, unknown> | null>(): Promise<T> {
              if (sql.includes("is_platform_admin FROM users")) {
                return { is_platform_admin: opts.isPlatformAdmin ? 1 : 0 } as T;
              }
              if (sql.startsWith("SELECT id FROM tenants")) {
                return (opts.tenantExists ? { id: TENANT_ID } : null) as T;
              }
              if (sql.startsWith("SELECT * FROM tenants")) {
                return { id: TENANT_ID, tenant_type: "business" } as T;
              }
              return null as T;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.startsWith("UPDATE tenants")) writes.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { db, writes };
}

async function authHeader() {
  const token = await signJwt(
    { sub: USER_ID, email: "platform@example.test" },
    JWT_SECRET
  );
  return { Authorization: `Bearer ${token}` };
}

describe("PATCH /api/platform/tenants/:id", () => {
  it("sets tenant_type when the actor is a platform admin", async () => {
    const { db, writes } = fakeDb({ isPlatformAdmin: true, tenantExists: true });
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await platformRoutes.request(
      `/tenants/${TENANT_ID}`,
      { method: "PATCH", headers, body: JSON.stringify({ tenant_type: "business" }) },
      env
    );
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain("tenant_type = ?");
    expect(writes[0].binds[0]).toBe("business");
  });

  it("rejects a non-platform-admin actor with 403 before touching the DB", async () => {
    const { db, writes } = fakeDb({ isPlatformAdmin: false, tenantExists: true });
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await platformRoutes.request(
      `/tenants/${TENANT_ID}`,
      { method: "PATCH", headers, body: JSON.stringify({ tenant_type: "business" }) },
      env
    );
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("rejects an invalid tenant_type value with 400", async () => {
    const { db, writes } = fakeDb({ isPlatformAdmin: true, tenantExists: true });
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await platformRoutes.request(
      `/tenants/${TENANT_ID}`,
      { method: "PATCH", headers, body: JSON.stringify({ tenant_type: "enterprise" }) },
      env
    );
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("404s for a tenant id that does not exist", async () => {
    const { db, writes } = fakeDb({ isPlatformAdmin: true, tenantExists: false });
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await platformRoutes.request(
      `/tenants/nope`,
      { method: "PATCH", headers, body: JSON.stringify({ tenant_type: "guild" }) },
      env
    );
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });
});
