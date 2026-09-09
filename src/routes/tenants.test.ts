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
      // Read statements (computeOnboarding batches its counts) answer through
      // the same keyword router as first(); writes just report one change.
      return Promise.all(
        stmts.map(async (s) =>
          /^\s*SELECT/i.test(s.sql)
            ? { success: true, results: [await stmt(s.sql, s.binds).first()], meta: { changes: 0 } }
            : { success: true, meta: { changes: 1 } }
        )
      );
    },
  };
  return { db, batches, runs };
}

const APP_URL = "https://quilthosting.com";

describe("POST /api/tenants — starter site + subdomain status", () => {
  it("inserts tenant + owner + the 8 Heritage kit pages in one batch, domain_status pending, and returns public_url", async () => {
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
    expect(batch).toHaveLength(10);
    expect(batch[0].sql).toMatch(/^INSERT INTO tenants/);
    expect(batch[0].sql).toContain("domain_status");
    expect(batch[0].sql).toContain("'pending'");
    expect(batch[0].sql).toContain("trial_ends_at");
    // name trimmed, slug normalized, theme seeded
    expect(batch[0].binds[1]).toBe("Prairie Star");
    expect(batch[0].binds[2]).toBe("prairie-star");
    // settings carry the kit design and start the guild on the new renderer
    const seeded = JSON.parse(String(batch[0].binds[3]));
    expect(seeded.design.palette.input.brand).toMatch(/^#/);
    expect(seeded.site.renderer).toBe("sections");
    expect(seeded.site.kit).toBe("heritage");
    expect(batch[1].sql).toMatch(/^INSERT INTO tenant_users/);
    expect(batch[1].binds).toEqual([batch[0].binds[0], USER_ID, expect.any(String)]);

    const pageInserts = batch.slice(2);
    expect(pageInserts).toHaveLength(8);
    const tenantId = batch[0].binds[0];
    const slugs = pageInserts.map((p) => p.binds[2]);
    expect(slugs).toEqual(["home", "about", "why-join", "meetings", "community", "newsletter", "gallery", "contact"]);
    for (const p of pageInserts) {
      expect(p.sql).toMatch(/^INSERT INTO pages/);
      expect(p.binds[1]).toBe(tenantId);
      // page_type 'page' and published 1 are SQL literals; nav/members flags are bound
      expect(p.sql).toContain("'page', 1, NULL, NULL, 0)");
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

describe("redactSettingsForRole — provider secrets stay with owner/admin", () => {
  const row = {
    id: "t1",
    settings_json: JSON.stringify({
      profile: { description: "x" },
      twilio: { account_sid: "AC123", auth_token: "supersecret", from_number: "+15550100" },
    }),
  };
  it("masks twilio.auth_token for viewer/membership/events roles", async () => {
    const { redactSettingsForRole } = await import("./tenants");
    for (const role of ["viewer", "membership", "events", null, undefined]) {
      const out = redactSettingsForRole(row, role as string | null | undefined);
      const s = JSON.parse(out.settings_json!);
      expect(s.twilio.auth_token).not.toBe("supersecret");
      expect(s.twilio.account_sid).toBe("AC123");
      expect(s.profile.description).toBe("x");
    }
  });
  it("leaves owner/admin/platform untouched", async () => {
    const { redactSettingsForRole } = await import("./tenants");
    for (const role of ["owner", "admin", "platform"]) {
      expect(redactSettingsForRole(row, role)).toBe(row);
    }
  });
  it("tolerates missing or unparsable settings", async () => {
    const { redactSettingsForRole } = await import("./tenants");
    expect(redactSettingsForRole({ settings_json: null }, "viewer").settings_json).toBeNull();
    expect(redactSettingsForRole({ settings_json: "{nope" }, "viewer").settings_json).toBe("{nope");
  });
});

// ---------------------------------------------------------------------------
// Design panel (site foundation Task 11): PATCH validates settings.design
// through siteDesignSchema and settings.site.renderer against the two
// renderer names; GET /:id/design-options hands the admin the palette /
// type-pair / pattern library so it never hard-codes it.
// ---------------------------------------------------------------------------
import { DEFAULT_DESIGN } from "../lib/site/design/tokens";

async function patchSettings(settings: unknown, role = "owner") {
  const { db, writes } = fakeDb({ membershipRole: role });
  const env = { DB: db, JWT_SECRET } as unknown as Env;
  const headers = { ...(await authHeader()), "Content-Type": "application/json" };
  const res = await tenantRoutes.request(
    `/${TENANT_ID}`,
    { method: "PATCH", headers, body: JSON.stringify({ settings }) },
    env
  );
  return { res, writes, body: await res.json().catch(() => ({})) as any };
}

describe("PATCH /api/tenants/:id — settings.design and settings.site.renderer", () => {
  it("rejects an unknown type pair with 400 and an issue path under settings.design", async () => {
    const { res, writes, body } = await patchSettings({ design: { typePair: "comic-sans" } });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
    expect(body.error).toBeTruthy();
    expect(body.issues.some((i: any) => i.path === "settings.design.typePair")).toBe(true);
  });

  it("rejects an unknown library palette id", async () => {
    const { res, body } = await patchSettings({ design: { palette: { id: "no-such-palette" } } });
    expect(res.status).toBe(400);
    expect(body.issues.some((i: any) => i.path === "settings.design.palette.id")).toBe(true);
  });

  it("round-trips a valid design: palette id resolved to its inputs, defaults filled, other settings kept", async () => {
    const { res, writes } = await patchSettings({
      other: "keep",
      design: { palette: { id: "heritage-indigo" }, typePair: "lora-karla", header: { cta: "donate" } },
    });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    const stored = JSON.parse(writes[0].binds[0] as string);
    expect(stored.other).toBe("keep");
    expect(stored.design.typePair).toBe("lora-karla");
    expect(stored.design.palette.id).toBe("heritage-indigo");
    expect(stored.design.palette.input.brand).toBe("#2c3e6b");
    expect(stored.design.header.cta).toBe("donate");
    expect(stored.design.header.sticky).toBe(DEFAULT_DESIGN.header.sticky);
    expect(stored.design.shape).toEqual(DEFAULT_DESIGN.shape);
    expect(stored.design.pattern).toEqual(DEFAULT_DESIGN.pattern);
    // updated_at is bumped alongside.
    expect(writes[0].sql).toContain("updated_at = ?");
  });

  it("accepts a custom palette given as four colours", async () => {
    const { res, writes } = await patchSettings({
      design: { palette: { input: { brand: "#123456", brandAlt: "#654321", accent: "#abcdef", neutral: "#222" } } },
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(writes[0].binds[0] as string);
    expect(stored.design.palette.id).toBeUndefined();
    expect(stored.design.palette.input.neutral).toBe("#222222");
  });

  it("rejects a renderer outside {legacy, sections} and accepts both valid values", async () => {
    const bad = await patchSettings({ site: { renderer: "wordpress" } });
    expect(bad.res.status).toBe(400);
    expect(bad.writes).toHaveLength(0);
    expect(bad.body.issues.some((i: any) => i.path === "settings.site.renderer")).toBe(true);
    for (const renderer of ["legacy", "sections"]) {
      const ok = await patchSettings({ site: { renderer, other: 1 } });
      expect(ok.res.status).toBe(200);
      const stored = JSON.parse(ok.writes[0].binds[0] as string);
      expect(stored.site).toEqual({ renderer, other: 1 });
    }
  });

  it("rejects a non-object settings body", async () => {
    const { res, writes } = await patchSettings("nope");
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 Task A: the same PATCH carries the two switches. settings.ui is the
// Simple/Advanced sidebar switch, settings.features the capability flags.
// Both are validated (junk is a 400 with a field path, never a silently
// stored bad value) and both must survive alongside every other settings key
// the admin sends in the merged object.
// ---------------------------------------------------------------------------
describe("PATCH /api/tenants/:id — settings.ui and settings.features", () => {
  it("stores both switches and keeps unrelated settings keys", async () => {
    const { res, writes } = await patchSettings({
      profile: { description: "keep me" },
      ui: { advanced: true },
      features: { reports: true, recipes: false },
    });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    const stored = JSON.parse(writes[0].binds[0] as string);
    expect(stored.ui).toEqual({ advanced: true });
    expect(stored.features).toEqual({ reports: true, recipes: false });
    expect(stored.profile.description).toBe("keep me");
  });

  it("rejects a non-boolean advanced with an issue under settings.ui", async () => {
    const { res, writes, body } = await patchSettings({ ui: { advanced: "yes" } });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
    expect(body.issues.some((i: any) => i.path === "settings.ui.advanced")).toBe(true);
  });

  it("rejects a non-object ui", async () => {
    const { res, writes } = await patchSettings({ ui: "advanced" });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("rejects a non-boolean feature value with an issue under settings.features", async () => {
    const { res, writes, body } = await patchSettings({ features: { reports: "yes" } });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
    expect(body.issues.some((i: any) => i.path === "settings.features.reports")).toBe(true);
  });

  it("drops an unknown feature key instead of failing the save", async () => {
    const { res, writes } = await patchSettings({ features: { teleport: true, bom: true } });
    expect(res.status).toBe(200);
    const stored = JSON.parse(writes[0].binds[0] as string);
    expect(stored.features).toEqual({ bom: true });
  });

  it("leaves settings alone when neither switch is present (the off path is unchanged)", async () => {
    const { res, writes } = await patchSettings({ profile: { description: "hi" } });
    expect(res.status).toBe(200);
    const stored = JSON.parse(writes[0].binds[0] as string);
    expect(stored).toEqual({ profile: { description: "hi" } });
    expect(stored.ui).toBeUndefined();
    expect(stored.features).toBeUndefined();
  });
});

describe("GET /api/tenants/:id/design-options", () => {
  it("returns the library plus the tenant's current design and renderer", async () => {
    const { db } = fakeCreateDb({
      membershipRole: "viewer",
      tenantRow: {
        id: TENANT_ID,
        tenant_type: "guild",
        settings_json: JSON.stringify({
          design: { palette: { id: "naturals-sage" }, typePair: "manrope" },
          site: { renderer: "legacy" },
        }),
      },
    });
    const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
    const res = await tenantRoutes.request(`/${TENANT_ID}/design-options`, { headers: await authHeader() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.palettes.length).toBeGreaterThanOrEqual(24);
    const madder = body.palettes.find((p: any) => p.id === "heritage-madder");
    expect(madder.family).toBe("heritage");
    expect(madder.input.brand).toBe("#9b2c2c");
    for (const role of ["bg", "ink", "primary", "onPrimary", "accent", "dark"]) {
      expect(madder.roles[role]).toMatch(/^#[0-9a-f]{6}$/);
    }

    expect(body.families).toHaveLength(7);
    expect(body.families[0]).toEqual({ id: "heritage", label: "Heritage" });

    expect(body.typePairs.length).toBeGreaterThanOrEqual(11);
    const lora = body.typePairs.find((p: any) => p.id === "lora-karla");
    expect(lora.display).toBe("lora");
    expect(lora.body).toBe("karla");
    expect(lora.sample).toContain("nine-patch");
    expect(lora.fontsHref).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=Lora.*family=Karla/);
    expect(lora.displayStack).toContain("'Lora'");
    const system = body.typePairs.find((p: any) => p.id === "system");
    expect(system.fontsHref).toBeNull();

    expect(body.patterns.map((p: any) => p.id)).toEqual(["none", "nine-patch", "flying-geese", "log-cabin", "churn-dash", "bear-paw"]);
    expect(body.patterns[0].dataUri).toBe("none");
    expect(body.patterns[1].dataUri).toMatch(/^url\("data:image\/svg\+xml;utf8,/);

    expect(body.defaults).toEqual(DEFAULT_DESIGN);
    // Kits ("Browse designs"): id/name/character plus the design the kit's
    // defaults resolve to, so the admin can apply one without knowing kits.
    expect(body.kits.length).toBeGreaterThanOrEqual(1);
    const heritage = body.kits.find((k: any) => k.id === "heritage");
    expect(heritage.name).toBe("Heritage");
    expect(heritage.audience).toBe("guild");
    expect(heritage.character.length).toBeGreaterThan(10);
    expect(heritage.design.palette.id).toBe("heritage-madder");
    expect(heritage.design.palette.input.brand).toBe("#9b2c2c");
    expect(heritage.design.pattern.id).toBe("log-cabin");
    expect(body.current.palette.id).toBe("naturals-sage");
    expect(body.current.typePair).toBe("manrope");
    expect(body.current.shape).toEqual(DEFAULT_DESIGN.shape);
    expect(body.renderer).toBe("legacy");
  });

  it("defaults current to DEFAULT_DESIGN and renderer to sections when settings carry neither", async () => {
    const { db } = fakeCreateDb({ membershipRole: "owner" });
    const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
    const res = await tenantRoutes.request(`/${TENANT_ID}/design-options`, { headers: await authHeader() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.current).toEqual(DEFAULT_DESIGN);
    expect(body.renderer).toBe("sections");
  });

  it("is 403 for a stranger who is not a platform admin", async () => {
    const { db } = fakeCreateDb({ membershipRole: null, platformAdmin: false });
    const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
    const res = await tenantRoutes.request(`/${TENANT_ID}/design-options`, { headers: await authHeader() }, env);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// "Try the new design" (phase 2 Task D): GET /:id/site/upgrade previews the
// composed home, POST /:id/site/upgrade converts every page in one batch
// with a pre_upgrade snapshot per page, POST /:id/site/downgrade restores
// those snapshots. Owner/admin/platform only; 409 when already on the
// requested renderer.
// ---------------------------------------------------------------------------

const LEGACY_SETTINGS = {
  theme: { primary: "#336699", font: "serif", style: "classic" },
  profile: { description: "A friendly guild in Lincoln.", meeting_info: "2nd Tuesdays, 6:30 pm", location: "Grange Hall" },
  site: { renderer: "legacy" },
};

const ABOUT_BLOCKS_JSON = JSON.stringify([
  { type: "heading", text: "About us", level: 2 },
  { type: "text", html: "<p>We have quilted together since 1982.</p>" },
  { type: "button", label: "Join", href: "/membership" },
]);

const pageRow = (id: string, slug: string, blocksJson: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  slug,
  title: slug[0].toUpperCase() + slug.slice(1),
  blocks_json: blocksJson,
  content_json: JSON.stringify({ html: `<p>${slug} html</p>` }),
  page_type: "page",
  published: 1,
  show_in_nav: 1,
  nav_label: null,
  is_members_only: 0,
  sort_order: 0,
  ...extra,
});

/** Fake D1 for the site upgrade/downgrade routes: canned tenant, pages and
 * pre_upgrade revisions; records every batch and run. */
function fakeSiteDb(opts: {
  role?: string | null;
  platformAdmin?: boolean;
  settings?: Record<string, unknown>;
  pages?: Record<string, unknown>[];
  revisions?: Record<string, unknown>[];
} = {}) {
  const batches: { sql: string; binds: unknown[] }[][] = [];
  const runs: { sql: string; binds: unknown[] }[] = [];
  const settings = opts.settings ?? LEGACY_SETTINGS;
  const stmt = (sql: string, binds: unknown[]) => ({
    sql,
    binds,
    async first<T = Row>(): Promise<T> {
      if (sql.includes("SELECT role FROM tenant_users")) {
        return (opts.role ? { role: opts.role } : null) as T;
      }
      if (sql.includes("is_platform_admin")) return { is_platform_admin: opts.platformAdmin ? 1 : 0 } as T;
      if (sql.startsWith("SELECT * FROM tenants")) {
        return {
          id: TENANT_ID,
          name: "Prairie Star Quilters",
          slug: "prairie-star",
          custom_domain: null,
          tenant_type: "guild",
          public_launched: 0,
          settings_json: JSON.stringify(settings),
          status: "active",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as T;
      }
      return null as T;
    },
    async all<T = Row>(): Promise<{ results: T[] }> {
      if (sql.includes("FROM page_revisions")) return { results: (opts.revisions ?? []) as T[] };
      if (sql.includes("FROM pages")) return { results: (opts.pages ?? []) as T[] };
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
      return stmts.map((s) => (/^\s*SELECT/i.test(s.sql) ? { success: true, results: [], meta: { changes: 0 } } : { success: true, meta: { changes: 1 } }));
    },
  };
  return { db, batches, runs };
}

async function siteRequest(
  db: unknown,
  path: string,
  init: { method?: string; body?: unknown } = {}
) {
  const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
  const headers = { ...(await authHeader()), "Content-Type": "application/json" };
  const res = await tenantRoutes.request(
    `/${TENANT_ID}${path}`,
    { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    env
  );
  return res;
}

describe("GET /api/tenants/:id/site/upgrade", () => {
  it("lists what the upgrade would write and flags the home it would create", async () => {
    const { db, batches } = fakeSiteDb({ role: "owner", pages: [pageRow("p1", "about", ABOUT_BLOCKS_JSON)] });
    const res = await siteRequest(db, "/site/upgrade");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.renderer).toBe("legacy");
    expect(body.created_home).toBe(true);
    expect(body.kit).toBeNull();
    expect(body.pages.map((p: any) => p.slug)).toEqual(["about", "home"]);
    expect(body.pages[0].id).toBe("p1");
    expect(body.pages[0].section_count).toBe(2);
    expect(body.pages[1].id).toBeNull();
    expect(batches).toHaveLength(0);
  });

  it("?preview=1 renders the composed home through the site renderer without writing, no-store", async () => {
    const { db, batches, runs } = fakeSiteDb({ role: "admin", pages: [pageRow("p1", "about", ABOUT_BLOCKS_JSON)] });
    const res = await siteRequest(db, "/site/upgrade?preview=1&kit=heritage");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('class="qh-site"');
    expect(html).toContain("Prairie Star Quilters");
    expect(html).toContain("A friendly guild in Lincoln.");
    expect(html).toContain("2nd Tuesdays, 6:30 pm");
    // Heritage kit palette drives the preview's design vars.
    expect(html).toContain("#9b2c2c");
    expect(html).toContain('<meta name="robots" content="noindex">');
    // Reads only: the page list, the nav, one data batch of SELECTs.
    expect(runs).toHaveLength(0);
    expect(batches.flat().every((s) => /^\s*SELECT/i.test(s.sql))).toBe(true);
  });

  it("rejects an unknown kit with 400", async () => {
    const { db } = fakeSiteDb({ role: "owner" });
    const res = await siteRequest(db, "/site/upgrade?kit=nope");
    expect(res.status).toBe(400);
  });

  it("is 403 for roles below admin and for strangers; platform admins are allowed", async () => {
    for (const role of ["membership", "events", "viewer"]) {
      const { db } = fakeSiteDb({ role });
      expect((await siteRequest(db, "/site/upgrade")).status).toBe(403);
    }
    const stranger = fakeSiteDb({ role: null });
    expect((await siteRequest(stranger.db, "/site/upgrade")).status).toBe(403);
    const platform = fakeSiteDb({ role: null, platformAdmin: true });
    expect((await siteRequest(platform.db, "/site/upgrade")).status).toBe(200);
  });
});

describe("POST /api/tenants/:id/site/upgrade", () => {
  it("snapshots, converts and switches the renderer in ONE batch, creating the home", async () => {
    const pages = [pageRow("p1", "about", ABOUT_BLOCKS_JSON), pageRow("p2", "contact", JSON.stringify([{ type: "contact_form", formSlug: "hello" }]))];
    const { db, batches, runs } = fakeSiteDb({ role: "owner", pages });
    const res = await siteRequest(db, "/site/upgrade", { method: "POST", body: { kit: "heritage" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.renderer).toBe("sections");
    expect(body.kit).toBe("heritage");
    expect(body.created_home).toBe(true);
    expect(body.pages.map((p: any) => p.slug)).toEqual(["about", "contact", "home"]);
    expect(body.pages[2].id).toEqual(expect.any(String));

    expect(runs).toHaveLength(0);
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    // 2 pages x (snapshot + update) + home insert + tenant update
    expect(batch.map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "INSERT INTO page_revisions",
      "UPDATE pages SET",
      "INSERT INTO page_revisions",
      "UPDATE pages SET",
      "INSERT INTO pages",
      "UPDATE tenants SET",
    ]);

    // Snapshot: the same column list pages.ts writes, kind pre_upgrade, the ORIGINAL blocks and html.
    const snap = batch[0];
    expect(snap.sql).toContain("(id, tenant_id, page_id, kind, title, blocks_json, content_json, created_by, created_at)");
    expect(snap.binds.slice(1, 9)).toEqual([TENANT_ID, "p1", "pre_upgrade", "About", ABOUT_BLOCKS_JSON, pages[0].content_json, USER_ID, expect.any(String)]);

    // Converted page: a section document in blocks_json, rendered html in content_json.
    const upd = batch[1];
    expect(upd.sql).toContain("blocks_json = ?");
    expect(upd.sql).toContain("content_json = ?");
    expect(upd.sql).toContain("updated_at = ?");
    expect(upd.sql).toContain("WHERE id = ? AND tenant_id = ?");
    const doc = JSON.parse(String(upd.binds[0]));
    expect(doc[0]).toMatchObject({ type: "rich_text", heading: "About us", style: { bg: "none" } });
    expect(doc[1]).toMatchObject({ type: "cta", label: "Join", style: { bg: "tint" } });
    const html = JSON.parse(String(upd.binds[1])).html;
    expect(html).toContain("About us");
    expect(html).toContain("qh-s");
    expect(upd.binds.slice(-2)).toEqual(["p1", TENANT_ID]);

    // Created home: same column list as the create route, published, first in nav.
    const home = batch[4];
    expect(home.sql).toContain("(id, tenant_id, slug, title, content_json, blocks_json, show_in_nav, nav_label,");
    expect(home.sql).toContain("'page', 1, NULL, NULL, 0)");
    expect(home.binds[1]).toBe(TENANT_ID);
    expect(home.binds[2]).toBe("home");
    expect(home.binds[3]).toBe("Home");
    const homeDoc = JSON.parse(String(home.binds[5]));
    expect(homeDoc.map((s: any) => s.type)).toEqual(["hero", "meeting_info", "membership_levels", "events", "blog_teaser", "join_band"]);
    expect(homeDoc[0].title).toBe("Prairie Star Quilters");
    expect(JSON.parse(String(home.binds[4])).html).toContain("Prairie Star Quilters");
    expect(home.binds[0]).toBe(body.pages[2].id);

    // Tenant: renderer sections, kit, timestamp, created-home marker, previous legacy; design = kit defaults.
    const tenant = batch[5];
    expect(tenant.sql).toContain("settings_json = ?");
    expect(tenant.sql).toContain("updated_at = ?");
    expect(tenant.binds[2]).toBe(TENANT_ID);
    const settings = JSON.parse(String(tenant.binds[0]));
    expect(settings.theme).toEqual(LEGACY_SETTINGS.theme);
    expect(settings.profile).toEqual(LEGACY_SETTINGS.profile);
    expect(settings.site).toEqual({
      renderer: "sections",
      kit: "heritage",
      upgraded_at: expect.any(String),
      upgrade_created_home: true,
      previous: { renderer: "legacy" },
    });
    expect(settings.design.palette.id).toBe("heritage-madder");
    expect(settings.design.palette.input.brand).toBe("#9b2c2c");
  });

  it("without a kit migrates the legacy theme and completes an existing home instead of inserting one", async () => {
    const { db, batches } = fakeSiteDb({ role: "owner", pages: [pageRow("h", "home", ABOUT_BLOCKS_JSON)] });
    const res = await siteRequest(db, "/site/upgrade", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.created_home).toBe(false);
    expect(body.kit).toBeNull();
    const batch = batches[0];
    expect(batch.map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual(["INSERT INTO page_revisions", "UPDATE pages SET", "UPDATE tenants SET"]);
    const doc = JSON.parse(String(batch[1].binds[0]));
    expect(doc[0]).toMatchObject({ type: "hero", variant: "minimal", title: "About us" });
    expect(doc.slice(-3).map((s: any) => s.type)).toEqual(["events", "membership_levels", "join_band"]);
    const settings = JSON.parse(String(batch[2].binds[0]));
    expect(settings.site.kit).toBeNull();
    expect(settings.site.upgrade_created_home).toBe(false);
    expect(settings.design.palette.input.brand).toBe("#336699");
  });

  it("is 409 when the guild is already on the section renderer, 400 for an unknown kit, 403 below admin -- none of them write", async () => {
    const already = fakeSiteDb({ role: "owner", settings: { site: { renderer: "sections" } } });
    const r1 = await siteRequest(already.db, "/site/upgrade", { method: "POST", body: {} });
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as any).renderer).toBe("sections");
    expect(already.batches).toHaveLength(0);

    const badKit = fakeSiteDb({ role: "owner" });
    expect((await siteRequest(badKit.db, "/site/upgrade", { method: "POST", body: { kit: "quilt-shop" } })).status).toBe(400);
    expect(badKit.batches).toHaveLength(0);

    const viewer = fakeSiteDb({ role: "viewer" });
    expect((await siteRequest(viewer.db, "/site/upgrade", { method: "POST", body: {} })).status).toBe(403);
    expect(viewer.batches).toHaveLength(0);
  });
});

describe("POST /api/tenants/:id/site/downgrade", () => {
  const UPGRADED_SETTINGS = {
    ...LEGACY_SETTINGS,
    design: { palette: { id: "heritage-madder" } },
    site: { renderer: "sections", kit: "heritage", upgraded_at: "t", upgrade_created_home: true, previous: { renderer: "legacy" } },
  };

  it("restores every page from its NEWEST pre_upgrade revision byte-for-byte, deletes the created home, sets legacy", async () => {
    const sectionsJson = JSON.stringify([{ type: "rich_text", variant: "prose", html: "<p>new</p>", style: { bg: "none" }, id: "s_0" }]);
    const pages = [
      pageRow("p1", "about", sectionsJson),
      pageRow("hx", "home", sectionsJson),
      pageRow("p3", "never-snapshotted", sectionsJson),
    ];
    const older = JSON.stringify([{ type: "text", html: "<p>older</p>" }]);
    const revisions = [
      { id: "r2", page_id: "p1", title: "About (then)", blocks_json: ABOUT_BLOCKS_JSON, content_json: '{"html":"<p>about html</p>"}', created_at: "2026-02-01T00:00:00.000Z" },
      { id: "r1", page_id: "p1", title: "About (older)", blocks_json: older, content_json: '{"html":"<p>old</p>"}', created_at: "2026-01-01T00:00:00.000Z" },
    ];
    const { db, batches } = fakeSiteDb({ role: "admin", settings: UPGRADED_SETTINGS, pages, revisions });
    const res = await siteRequest(db, "/site/downgrade", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.renderer).toBe("legacy");
    expect(body.restored).toEqual(["p1"]);
    expect(body.deleted_home).toBe(true);

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "UPDATE pages SET",
      "DELETE FROM page_revisions",
      "DELETE FROM page_redirects",
      "DELETE FROM pages",
      "UPDATE tenants SET",
    ]);
    const restore = batch[0];
    expect(restore.sql).toContain("title = ?");
    expect(restore.sql).toContain("blocks_json = ?");
    expect(restore.sql).toContain("content_json = ?");
    expect(restore.binds[0]).toBe("About (then)");
    expect(restore.binds[1]).toBe(ABOUT_BLOCKS_JSON);
    expect(restore.binds[2]).toBe('{"html":"<p>about html</p>"}');
    expect(restore.binds.slice(-2)).toEqual(["p1", TENANT_ID]);
    expect(batch[1].binds).toEqual([TENANT_ID, "hx"]);
    expect(batch[2].binds).toEqual([TENANT_ID, "home", "home"]);
    expect(batch[3].binds).toEqual(["hx", TENANT_ID]);
    const settings = JSON.parse(String(batch[4].binds[0]));
    expect(settings.site).toEqual({ renderer: "legacy", downgraded_at: expect.any(String), previous: { renderer: "sections", kit: "heritage" } });
    expect(settings.theme).toEqual(LEGACY_SETTINGS.theme);
  });

  it("keeps a home the guild had before the upgrade (it is restored, never deleted)", async () => {
    const settings = { ...UPGRADED_SETTINGS, site: { ...UPGRADED_SETTINGS.site, upgrade_created_home: false } };
    const pages = [pageRow("h", "home", "[]")];
    const revisions = [{ id: "r", page_id: "h", title: "Home", blocks_json: ABOUT_BLOCKS_JSON, content_json: "{}", created_at: "t" }];
    const { db, batches } = fakeSiteDb({ role: "owner", settings, pages, revisions });
    const res = await siteRequest(db, "/site/downgrade", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).deleted_home).toBe(false);
    expect(batches[0].map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual(["UPDATE pages SET", "UPDATE tenants SET"]);
  });

  it("is 409 (and idempotent: no writes) when already on the classic renderer, 403 below admin", async () => {
    const legacy = fakeSiteDb({ role: "owner" });
    const res = await siteRequest(legacy.db, "/site/downgrade", { method: "POST" });
    expect(res.status).toBe(409);
    expect(legacy.batches).toHaveLength(0);
    const events = fakeSiteDb({ role: "events", settings: UPGRADED_SETTINGS });
    expect((await siteRequest(events.db, "/site/downgrade", { method: "POST" })).status).toBe(403);
    expect(events.batches).toHaveLength(0);
  });
});
