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
        stmts.map(async (s) => {
          if (!/^\s*SELECT/i.test(s.sql)) return { success: true, meta: { changes: 1 } };
          // A SELECT that matches nothing returns no rows, not one null row —
          // callers that map over results (loadSiteData) crash on the latter.
          const row = await stmt(s.sql, s.binds).first();
          return { success: true, results: row == null ? [] : [row], meta: { changes: 0 } };
        })
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

  // next_actions rides on this endpoint rather than a second one (see the
  // route comment): the dashboard fetches it once and gets both answers.
  it("carries at most three ranked next_action cards derived from the same rows", async () => {
    const headers = await authHeader();
    const { db } = fakeCreateDb({
      membershipRole: "owner",
      counts: { pages: 5, sample: 5, team: 1 },
    });
    const res = await tenantRoutes.request(`/${TENANT_ID}/onboarding`, { headers }, {
      DB: db, JWT_SECRET, APP_URL,
    } as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      next_actions: {
        id: string;
        title: string;
        body: string;
        cta: { label: string; href: string };
        severity: string;
      }[];
    };
    expect(Array.isArray(body.next_actions)).toBe(true);
    expect(body.next_actions.length).toBeLessThanOrEqual(3);
    // A brand-new guild: no level, sample copy everywhere, empty calendar.
    expect(body.next_actions.map((a) => a.id)).toEqual([
      "add_level",
      "sample_copy",
      "add_event",
    ]);
    for (const a of body.next_actions) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.body.length).toBeGreaterThan(0);
      expect(a.cta.href).toMatch(/^#[a-z-]+$/);
      expect(["do", "consider", "celebrate"]).toContain(a.severity);
    }
  });

  it("a stranger gets no next_actions either", async () => {
    const headers = await authHeader();
    const stranger = fakeCreateDb({ membershipRole: null });
    const res = await tenantRoutes.request(`/${TENANT_ID}/onboarding`, { headers }, {
      DB: stranger.db, JWT_SECRET, APP_URL,
    } as unknown as Env);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("next_actions");
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

  // One renderer since v0.61.0: "sections" is the only accepted value, and
  // "legacy" — the classic guild.html shell — is now rejected like any other
  // unknown name, so a tenant cannot be put back onto a renderer that is gone.
  it("accepts only the sections renderer, rejecting legacy and anything else", async () => {
    for (const renderer of ["wordpress", "legacy"]) {
      const bad = await patchSettings({ site: { renderer } });
      expect(bad.res.status, renderer).toBe(400);
      expect(bad.writes).toHaveLength(0);
      expect(bad.body.issues.some((i: any) => i.path === "settings.site.renderer")).toBe(true);
    }
    const ok = await patchSettings({ site: { renderer: "sections", other: 1 } });
    expect(ok.res.status).toBe(200);
    const stored = JSON.parse(ok.writes[0].binds[0] as string);
    expect(stored.site).toEqual({ renderer: "sections", other: 1 });
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
      features: { waivers: true, recipes: false },
    });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    const stored = JSON.parse(writes[0].binds[0] as string);
    expect(stored.ui).toEqual({ advanced: true });
    expect(stored.features).toEqual({ waivers: true, recipes: false });
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
    const { res, writes, body } = await patchSettings({ features: { waivers: "yes" } });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
    expect(body.issues.some((i: any) => i.path === "settings.features.waivers")).toBe(true);
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

// ---------------------------------------------------------------------------
// GET /:id/design-preview — a design the tenant has not saved, rendered by the
// real renderer for the Design panel's "see it full size" dialog. Read-only:
// swatches and a name are not enough to choose a design from.
// ---------------------------------------------------------------------------

describe("GET /api/tenants/:id/design-preview", () => {
  const envFor = (db: unknown) => ({ DB: db, JWT_SECRET, APP_URL }) as unknown as Env;
  const get = async (db: unknown, qs = "") =>
    tenantRoutes.request(`/${TENANT_ID}/design-preview${qs}`, { headers: await authHeader() }, envFor(db));

  it("renders a kit's sample home with the guild's own name, uncacheable and noindex", async () => {
    const { db, runs, batches } = fakeCreateDb({
      membershipRole: "viewer",
      tenantRow: { id: TENANT_ID, name: "Prairie Star", slug: "prairie-star", tenant_type: "guild", settings_json: "{}" },
    });
    const res = await get(db, "?kit=heritage");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("X-Design-Preview")).toBe("heritage/heritage-madder/cream");
    const html = await res.text();
    expect(html).toContain("Prairie Star");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain("--qh-bg");
    // A preview writes nothing.
    expect(runs).toHaveLength(0);
    expect(batches.flat().filter((b) => !/^\s*SELECT/i.test(b.sql))).toHaveLength(0);
  });

  it("applies a palette and a page tone on top of the kit", async () => {
    const { db } = fakeCreateDb({ membershipRole: "owner" });
    const paper = await get(db, "?kit=heritage&palette=modern-electric");
    expect(paper.headers.get("X-Design-Preview")).toBe("heritage/modern-electric/paper");
    const deep = await get(db, "?kit=heritage&palette=modern-electric&ground=deep");
    expect(deep.headers.get("X-Design-Preview")).toBe("heritage/modern-electric/deep");
    // The tone is the point: the two pages must not be the same bytes.
    expect(await deep.text()).not.toBe(await paper.text());
  });

  it("rejects an unknown palette, tone or type pair rather than rendering something else", async () => {
    const { db } = fakeCreateDb({ membershipRole: "owner" });
    for (const qs of ["?palette=nope", "?ground=neon", "?typePair=comic"]) {
      const res = await get(db, qs);
      expect(res.status, qs).toBe(400);
    }
  });

  it("falls back to the tenant's own kit, then to one its audience can use", async () => {
    const onKit = fakeCreateDb({
      membershipRole: "owner",
      tenantRow: { id: TENANT_ID, name: "G", slug: "g", tenant_type: "guild", settings_json: JSON.stringify({ site: { kit: "prairie" } }) },
    });
    expect((await get(onKit.db)).headers.get("X-Design-Preview")).toMatch(/^prairie\//);
    const noKit = fakeCreateDb({ membershipRole: "owner" });
    expect((await get(noKit.db)).status).toBe(200);
  });

  it("is closed to a stranger who is not a platform admin", async () => {
    const { db } = fakeCreateDb({ membershipRole: null, platformAdmin: false });
    expect((await get(db, "?kit=heritage")).status).toBe(403);
    const admin = fakeCreateDb({ membershipRole: null, platformAdmin: true });
    expect((await get(admin.db, "?kit=heritage")).status).toBe(200);
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

    expect(body.families).toHaveLength(8);
    expect(body.families[0]).toEqual({ id: "heritage", label: "Heritage" });

    // Page tone travels with each palette and as its own list, so the admin
    // never has to mirror the labels.
    expect(madder.ground).toBe("cream");
    expect(body.palettes.find((p: any) => p.id === "modern-electric").ground).toBe("paper");
    expect(body.grounds.map((g: any) => g.id)).toEqual(["paper", "cream", "tinted", "deep"]);
    for (const g of body.grounds) {
      expect(g.label.length, g.id).toBeGreaterThan(2);
      expect(g.hint.length, g.id).toBeGreaterThan(20);
    }
    // Two palettes on different tones must not paint the same page — the
    // complaint this axis answers.
    const grounds = new Set(body.palettes.filter((p: any) => !p.dark).map((p: any) => p.roles.bg));
    expect(grounds.size).toBeGreaterThan(10);

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
    expect(body.renderer).toBe("sections");
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

import { kitSettingsJson, kitById } from "../lib/site/kits";

const LOGO_ID = "Fi1e_Id-9";

async function createRequest(db: unknown, body: Record<string, unknown>) {
  const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
  const headers = { ...(await authHeader()), "Content-Type": "application/json" };
  return tenantRoutes.request("/", { method: "POST", headers, body: JSON.stringify(body) }, env);
}

describe("POST /api/tenants — logo, palette and kit applied at creation", () => {
  it("persists a chosen kit, a library palette and the logo under BOTH settings keys", async () => {
    const { db, batches } = fakeCreateDb();
    const res = await createRequest(db, {
      name: "Prairie Star",
      slug: "prairie-star",
      kit: "minimal",
      palette: "jewel-emerald",
      logo_file_id: LOGO_ID,
    });
    expect(res.status).toBe(201);
    expect(batches).toHaveLength(1);
    const settings = JSON.parse(String(batches[0][0].binds[3]));
    expect(settings.site.kit).toBe("minimal");
    expect(settings.site.renderer).toBe("sections");
    expect(settings.design.palette.id).toBe("jewel-emerald");
    expect(settings.design.palette.input.brand).toBe("#1c6b4a");
    // The kit's own non-palette design survives the palette override.
    const minimal = kitById("minimal");
    expect(settings.design.typePair).toBe(JSON.parse(kitSettingsJson(minimal!)).design.typePair);
    // onboarding.ts hasLogo() reads either key; the site renderer reads assets.
    expect(settings.profile.logo_file_id).toBe(LOGO_ID);
    expect(settings.assets.logo_file_id).toBe(LOGO_ID);
    // Minimal seeds four pages, so: tenant + owner + 4.
    expect(batches[0]).toHaveLength(6);
  });

  it("accepts four custom colours instead of a palette id", async () => {
    const { db, batches } = fakeCreateDb();
    const res = await createRequest(db, {
      name: "Prairie Star",
      slug: "prairie-star",
      palette: { brand: "#123456", brandAlt: "#223344", accent: "#ffcc00", neutral: "#111111" },
    });
    expect(res.status).toBe(201);
    const settings = JSON.parse(String(batches[0][0].binds[3]));
    expect(settings.design.palette.input).toEqual({
      brand: "#123456",
      brandAlt: "#223344",
      accent: "#ffcc00",
      neutral: "#111111",
    });
    expect(settings.design.palette.id).toBeUndefined();
  });

  it("rejects an unknown palette id and a bad colour before writing anything", async () => {
    const unknown = fakeCreateDb();
    const res = await createRequest(unknown.db, { name: "G", slug: "gg", palette: "not-a-palette" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).issues[0].path).toContain("palette");
    expect(unknown.batches).toHaveLength(0);

    const bad = fakeCreateDb();
    const res2 = await createRequest(bad.db, {
      name: "G",
      slug: "gg",
      palette: { brand: "puce", brandAlt: "#223344", accent: "#ffcc00", neutral: "#111111" },
    });
    expect(res2.status).toBe(400);
    expect(bad.batches).toHaveLength(0);
  });

  it("rejects a logo_file_id that is not a file id", async () => {
    const { db, batches } = fakeCreateDb();
    const res = await createRequest(db, { name: "G", slug: "gg", logo_file_id: "../../etc/passwd" });
    expect(res.status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it("seeds no logo or palette keys when neither is sent (unchanged behaviour)", async () => {
    const { db, batches } = fakeCreateDb();
    expect((await createRequest(db, { name: "G", slug: "gg" })).status).toBe(201);
    const settings = JSON.parse(String(batches[0][0].binds[3]));
    expect(settings.profile).toBeUndefined();
    expect(settings.assets).toBeUndefined();
    expect(settings.design.palette.id).toBe(JSON.parse(kitSettingsJson(kitById("heritage")!)).design.palette.id);
  });
});

describe("GET /api/tenants/:id/first-run", () => {
  const guildRow = (settings_json: string) => ({
    id: TENANT_ID,
    name: "Prairie Star",
    slug: "prairie-star",
    custom_domain: null,
    tenant_type: "guild",
    settings_json,
    domain_status: "pending",
    domain_error: null,
  });

  async function firstRun(db: unknown) {
    const env = { DB: db, JWT_SECRET, APP_URL } as unknown as Env;
    return tenantRoutes.request(`/${TENANT_ID}/first-run`, { headers: await authHeader() }, env);
  }

  it("resumes on 'pick a design' for a freshly created guild", async () => {
    const { db } = fakeCreateDb({
      membershipRole: "owner",
      tenantRow: guildRow(kitSettingsJson(kitById("heritage")!)),
    });
    const res = await firstRun(db);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      done: false,
      step: 2,
      guild: {
        slug: "prairie-star",
        public_url: "https://quilthosting.com/g/prairie-star",
        kit: "heritage",
        has_logo: false,
        has_palette: false,
      },
    });
  });

  it("is done once the guild has a logo", async () => {
    const settings = JSON.parse(kitSettingsJson(kitById("prairie")!));
    settings.profile = { logo_file_id: LOGO_ID };
    const { db } = fakeCreateDb({ membershipRole: "membership", tenantRow: guildRow(JSON.stringify(settings)) });
    const body = (await (await firstRun(db)).json()) as any;
    expect(body).toMatchObject({ done: true, step: 4 });
    expect(body.guild).toMatchObject({ kit: "prairie", has_logo: true });
  });

  it("is 403 for a non-member and 404 for a missing guild", async () => {
    const outsider = fakeCreateDb({ membershipRole: null });
    expect((await firstRun(outsider.db)).status).toBe(403);
    const missing = fakeCreateDb({ membershipRole: "owner", tenantRow: null });
    expect((await firstRun(missing.db)).status).toBe(404);
  });
});
