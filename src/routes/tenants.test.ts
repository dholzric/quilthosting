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

// ---------------------------------------------------------------------------
// Onboarding (first-run): POST / seeds a starter site in ONE batch and marks
// subdomain provisioning pending; GET /:id/onboarding computes the checklist;
// POST /:id/onboarding/dismiss persists the flag; the domain retry endpoint
// is owner/admin only.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { domainRoutes } from "./domain";
import { SAMPLE_MARKER } from "../lib/starterSite";
import type { Tenant, TenantVariables } from "../types";

/** Fake D1 for the create flow: records batch() statements and answers the
 * few reads POST / and the onboarding endpoints make. */
function fakeCreateDb(opts: {
  slugTaken?: boolean;
  membershipRole?: string | null;
  platformAdmin?: boolean;
  tenantRow?: Record<string, unknown> | null;
  counts?: { pages?: number; sample?: number; levels?: number; paid?: number; members?: number; team?: number };
} = {}) {
  const batches: { sql: string; binds: unknown[] }[][] = [];
  const runs: { sql: string; binds: unknown[] }[] = [];
  const counts = opts.counts || {};
  const stmt = (sql: string, binds: unknown[]) => ({
    sql,
    binds,
    async first<T = Row>(): Promise<T> {
      if (sql.startsWith("SELECT id FROM tenants WHERE slug")) {
        return (opts.slugTaken ? { id: "other" } : null) as T;
      }
      if (sql.includes("SELECT role FROM tenant_users")) {
        return (opts.membershipRole ? { role: opts.membershipRole } : null) as T;
      }
      if (sql.includes("is_platform_admin")) {
        return { is_platform_admin: opts.platformAdmin ? 1 : 0 } as T;
      }
      if (sql.startsWith("SELECT * FROM tenants")) {
        return (opts.tenantRow === undefined
          ? {
              id: binds[0],
              name: "Prairie Star",
              slug: "prairie-star",
              custom_domain: null,
              tenant_type: "guild",
              settings_json: "{}",
              domain_status: "pending",
              domain_error: null,
              onboarding_json: null,
            }
          : opts.tenantRow) as T;
      }
      if (sql.includes("FROM pages") && sql.includes("LIKE")) return { n: counts.sample ?? 0 } as T;
      if (sql.includes("FROM pages")) return { n: counts.pages ?? 0 } as T;
      if (sql.includes("FROM membership_levels")) return { n: counts.levels ?? 0, paid: counts.paid ?? 0 } as T;
      if (sql.includes("FROM members")) return { n: counts.members ?? 0 } as T;
      if (sql.includes("COUNT(*) AS n FROM tenant_users")) return { n: counts.team ?? 0 } as T;
      return null as T;
    },
    async all() {
      return { results: [] };
    },
    async run() {
      runs.push({ sql, binds });
      return { success: true, meta: { changes: 1 } };
    },
  });
  const db = {
    prepare(sql: string) {
      return { bind: (...binds: unknown[]) => stmt(sql, binds) };
    },
    async batch(stmts: { sql: string; binds: unknown[] }[]) {
      batches.push(stmts.map((s) => ({ sql: s.sql, binds: s.binds })));
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { db, batches, runs };
}

const APP_URL = "https://quilthosting.com";

describe("POST /api/tenants — starter site + subdomain status", () => {
  it("inserts tenant + owner + 5 starter pages in one batch, domain_status pending, and returns public_url", async () => {
    const { db, batches, runs } = fakeCreateDb();
    // No CLOUDFLARE_API_TOKEN -> provisioning records 'skipped' via run().
    const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await tenantRoutes.request(
      "/",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "  Prairie Star  ",
          slug: "Prairie-Star!",
          city: "Lincoln, NE",
          meeting_info: "2nd Tuesdays at 6:30 pm",
        }),
      },
      env
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch).toHaveLength(7);
    expect(batch[0].sql).toMatch(/^INSERT INTO tenants/);
    expect(batch[0].sql).toContain("domain_status");
    expect(batch[0].sql).toContain("'pending'");
    expect(batch[0].sql).toContain("trial_ends_at");
    // name trimmed, slug normalized, theme seeded
    expect(batch[0].binds[1]).toBe("Prairie Star");
    expect(batch[0].binds[2]).toBe("prairie-star");
    expect(JSON.parse(String(batch[0].binds[3])).theme.primary).toMatch(/^#/);
    expect(batch[1].sql).toMatch(/^INSERT INTO tenant_users/);
    expect(batch[1].binds).toEqual([batch[0].binds[0], USER_ID, expect.any(String)]);

    const pageInserts = batch.slice(2);
    expect(pageInserts).toHaveLength(5);
    const tenantId = batch[0].binds[0];
    const slugs = pageInserts.map((p) => p.binds[2]);
    expect(slugs).toEqual(["home", "about", "why-join", "meetings", "contact"]);
    for (const p of pageInserts) {
      expect(p.sql).toMatch(/^INSERT INTO pages/);
      expect(p.binds[1]).toBe(tenantId);
      // page_type 'page', show_in_nav 1, is_members_only 0, published 1 are SQL literals
      expect(p.sql).toContain("'page', 1, NULL, 0, 1,");
      expect(String(p.binds[5])).toContain(SAMPLE_MARKER); // blocks_json
      expect(JSON.parse(String(p.binds[4])).html).toContain(SAMPLE_MARKER); // content_json
    }
    expect(JSON.stringify(pageInserts)).toContain("Lincoln, NE");
    expect(JSON.stringify(pageInserts)).toContain("2nd Tuesdays at 6:30 pm");

    // Response contract
    expect(body.domain_status).toBe("pending");
    expect(body.domain_error).toBeNull();
    expect(body.public_url).toBe("https://quilthosting.com/g/prairie-star");
    expect(body.subdomain_url).toBe("https://prairie-star.quilthosting.com");

    // Provisioning ran detached (no executionCtx in tests) and, with no CF
    // token, persisted 'skipped'.
    await new Promise((r) => setTimeout(r, 0));
    const statusWrite = runs.find((r) => r.sql.includes("domain_status = ?"));
    expect(statusWrite).toBeDefined();
    expect(statusWrite?.binds[0]).toBe("skipped");
    expect(statusWrite?.binds[3]).toBe(tenantId);
  });

  it("rejects over-long city / meeting_info before touching the DB", async () => {
    const { db, batches } = fakeCreateDb();
    const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const tooLongCity = await tenantRoutes.request(
      "/",
      { method: "POST", headers, body: JSON.stringify({ name: "G", slug: "gg", city: "x".repeat(121) }) },
      env
    );
    expect(tooLongCity.status).toBe(400);
    const tooLongMeeting = await tenantRoutes.request(
      "/",
      { method: "POST", headers, body: JSON.stringify({ name: "G", slug: "gg", meeting_info: "x".repeat(301) }) },
      env
    );
    expect(tooLongMeeting.status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it("409s on a taken slug without writing", async () => {
    const { db, batches } = fakeCreateDb({ slugTaken: true });
    const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await tenantRoutes.request(
      "/",
      { method: "POST", headers, body: JSON.stringify({ name: "G", slug: "taken" }) },
      env
    );
    expect(res.status).toBe(409);
    expect(batches).toHaveLength(0);
  });
});

describe("GET /api/tenants/:id — public_url", () => {
  it("prefers the subdomain once active and the /g/ path while pending", async () => {
    const headers = await authHeader();
    const pending = fakeCreateDb({ membershipRole: "viewer" });
    let res = await tenantRoutes.request(`/${TENANT_ID}`, { headers }, {
      DB: pending.db, JWT_SECRET, APP_URL,
    } as unknown as Env);
    expect(res.status).toBe(200);
    let body = (await res.json()) as Record<string, unknown>;
    expect(body.public_url).toBe("https://quilthosting.com/g/prairie-star");
    expect(body.domain_status).toBe("pending");

    const active = fakeCreateDb({
      membershipRole: "viewer",
      tenantRow: { id: TENANT_ID, slug: "prairie-star", custom_domain: null, settings_json: "{}", domain_status: "active" },
    });
    res = await tenantRoutes.request(`/${TENANT_ID}`, { headers }, {
      DB: active.db, JWT_SECRET, APP_URL,
    } as unknown as Env);
    body = (await res.json()) as Record<string, unknown>;
    expect(body.public_url).toBe("https://prairie-star.quilthosting.com");
  });
});

describe("GET /api/tenants/:id/onboarding + dismiss", () => {
  it("returns computed steps for a member and 403 for a stranger", async () => {
    const headers = await authHeader();
    const member = fakeCreateDb({ membershipRole: "membership", counts: { pages: 5, sample: 5, team: 1 } });
    const res = await tenantRoutes.request(`/${TENANT_ID}/onboarding`, { headers }, {
      DB: member.db, JWT_SECRET, APP_URL,
    } as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      steps: { key: string; done: boolean }[];
      public_url: string;
      ready_for_members: boolean;
      dismissed: boolean;
    };
    expect(body.steps.map((s) => s.key)).toEqual([
      "site_seeded", "sample_content_replaced", "logo", "level", "payments", "first_member", "team_invited", "domain",
    ]);
    expect(body.steps[0].done).toBe(true);
    expect(body.steps[1].done).toBe(false);
    expect(body.ready_for_members).toBe(false);
    expect(body.dismissed).toBe(false);
    expect(body.public_url).toBe("https://quilthosting.com/g/prairie-star");

    const stranger = fakeCreateDb({ membershipRole: null });
    const denied = await tenantRoutes.request(`/${TENANT_ID}/onboarding`, { headers }, {
      DB: stranger.db, JWT_SECRET, APP_URL,
    } as unknown as Env);
    expect(denied.status).toBe(403);
  });

  it("platform admins can read it too", async () => {
    const headers = await authHeader();
    const admin = fakeCreateDb({ membershipRole: null, platformAdmin: true });
    const res = await tenantRoutes.request(`/${TENANT_ID}/onboarding`, { headers }, {
      DB: admin.db, JWT_SECRET, APP_URL,
    } as unknown as Env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("platform");
  });

  it("dismiss persists onboarding_json and undo clears it", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const { db, runs } = fakeCreateDb({ membershipRole: "owner" });
    const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
    let res = await tenantRoutes.request(
      `/${TENANT_ID}/onboarding/dismiss`,
      { method: "POST", headers, body: "{}" },
      env
    );
    expect(res.status).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toContain("onboarding_json = ?");
    expect(JSON.parse(String(runs[0].binds[0])).dismissed_at).toEqual(expect.any(String));
    expect(runs[0].binds[2]).toBe(TENANT_ID);

    res = await tenantRoutes.request(
      `/${TENANT_ID}/onboarding/dismiss`,
      { method: "POST", headers, body: JSON.stringify({ undo: true }) },
      env
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(String(runs[1].binds[0]))).toEqual({});

    const stranger = fakeCreateDb({ membershipRole: null });
    const denied = await tenantRoutes.request(
      `/${TENANT_ID}/onboarding/dismiss`,
      { method: "POST", headers, body: "{}" },
      { DB: stranger.db, JWT_SECRET, APP_URL } as unknown as Env
    );
    expect(denied.status).toBe(403);
    expect(stranger.runs).toHaveLength(0);
  });
});

describe("POST /api/tenants/:tenantId/domain/retry — guard + status", () => {
  function buildDomainApp(role: string, db: unknown) {
    const app = new Hono<{ Bindings: Env; Variables: TenantVariables & { tenantRole: string } }>();
    app.use("*", async (c, next) => {
      c.set("tenant", { id: TENANT_ID, slug: "prairie-star", custom_domain: null } as Tenant);
      c.set("tenantRole", role);
      await next();
    });
    app.route("/", domainRoutes);
    return { app, env: { DB: db, APP_URL } as unknown as Env };
  }

  it("viewer -> 403 and no write", async () => {
    const { db, runs } = fakeCreateDb();
    const { app, env } = buildDomainApp("viewer", db);
    const res = await app.request("/retry", { method: "POST" }, env);
    expect(res.status).toBe(403);
    expect(runs).toHaveLength(0);
  });

  it("admin without a CF token -> skipped, persisted", async () => {
    const { db, runs } = fakeCreateDb();
    const { app, env } = buildDomainApp("admin", db);
    const res = await app.request("/retry", { method: "POST" }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.domain_status).toBe("skipped");
    expect(body.ok).toBe(false);
    expect(body.path_url).toBe("https://quilthosting.com/g/prairie-star");
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toContain("domain_status = ?");
    expect(runs[0].binds.slice(0, 2)).toEqual(["skipped", null]);
  });
});
