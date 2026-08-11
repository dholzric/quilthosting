// src/routes/tenants.test.ts
// Mechanical verification for Task 13's core constraint: the tenant-owner
// PATCH (this file's /:id handler) must accept public_launched but must
// NEVER accept tenant_type -- a tenant owner who could flip their own guild
// to "business" would drop their member cap (src/lib/plans.ts) and gain the
// public-launch toggle. tenant_type only moves via
// PATCH /api/platform/tenants/:id (see src/routes/platform.test.ts), gated
// by requirePlatformAdmin.
//
// This dispatches real requests through the exported `tenantRoutes` Hono
// app (same idiom as src/routes/credentials.test.ts), with a real signed
// JWT (requireAuth is baked into tenantRoutes itself, unlike credentialRoutes
// which relies on an external middleware chain) and a keyword-routed fake D1
// that returns canned rows per query shape and records every write.
import { describe, it, expect } from "vitest";
import { tenantRoutes } from "./tenants";
import { signJwt } from "../lib/auth";
import type { Env } from "../types";

const JWT_SECRET = "test-secret-not-used-in-prod";
const USER_ID = "user-1";
const TENANT_ID = "tenant-1";

type Row = Record<string, unknown> | null;

/** Keyword-routed D1 stand-in: inspects the SQL text to decide what to
 * return, and records every UPDATE's SQL + bound params so tests can assert
 * on exactly what was written. */
function fakeDb(opts: { membershipRole: string | null }) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first<T = Row>(): Promise<T> {
              if (sql.includes("FROM tenant_users")) {
                return (opts.membershipRole
                  ? { role: opts.membershipRole }
                  : null) as T;
              }
              if (sql.startsWith("UPDATE tenants")) {
                // Not used as a first() target in this route, but keep safe.
                return null as T;
              }
              if (sql.startsWith("SELECT * FROM tenants")) {
                // Post-write read-back: reflect only what PATCH actually
                // wrote (public_launched), never tenant_type -- if the
                // route ever started honoring tenant_type this fake would
                // need updating, but the point of the test is the SET
                // clause capture below, not this echo.
                return {
                  id: TENANT_ID,
                  tenant_type: "guild",
                  public_launched: 0,
                  name: "Stitch Studio",
                } as T;
              }
              return null as T;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.startsWith("UPDATE tenants")) {
                writes.push({ sql, binds });
              }
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
    { sub: USER_ID, email: "owner@example.test" },
    JWT_SECRET
  );
  return { Authorization: `Bearer ${token}` };
}

describe("PATCH /api/tenants/:id — allow-list", () => {
  it("accepts public_launched and writes it, ignoring an accompanying tenant_type", async () => {
    const { db, writes } = fakeDb({ membershipRole: "owner" });
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await tenantRoutes.request(
      `/${TENANT_ID}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ public_launched: 1, tenant_type: "business" }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain("public_launched = ?");
    // The whole point: tenant_type must never reach the SET clause here.
    expect(writes[0].sql).not.toContain("tenant_type");
    expect(writes[0].binds).not.toContain("business");
  });

  it("silently drops a body containing ONLY tenant_type (no recognized field -> 400, not a write)", async () => {
    const { db, writes } = fakeDb({ membershipRole: "admin" });
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await tenantRoutes.request(
      `/${TENANT_ID}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ tenant_type: "business" }),
      },
      env
    );
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("rejects a non-member/non-admin actor with 403 before touching the DB", async () => {
    const { db, writes } = fakeDb({ membershipRole: null });
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await tenantRoutes.request(
      `/${TENANT_ID}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ public_launched: 1 }),
      },
      env
    );
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});
