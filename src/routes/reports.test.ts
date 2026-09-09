// src/routes/reports.test.ts
// GET /api/tenants/:id/reports/summary and PATCH .../reports/settings.
// Dispatches real requests through the exported `reportRoutes` Hono app with
// a thin upstream middleware standing in for tenantMiddleware /
// requireTenantAccess (same idiom as credentials.test.ts). The D1 stand-in
// records what `batch()` was handed so the "one round trip" rule is pinned
// mechanically rather than by prose.
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";
import { reportRoutes } from "./reports";
import { REPORT_MONTH_CHOICES } from "../lib/reports";

type Row = Record<string, any>;

function fakeDb(rows: Row[][] = []) {
  const batches: { count: number }[] = [];
  const updates: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            sql,
            binds,
            async run() {
              updates.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            },
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(stmts: any[]) {
      batches.push({ count: stmts.length });
      return stmts.map((_s, i) => ({
        results: rows[i] ?? [],
        success: true,
        meta: {},
      }));
    },
  } as unknown as D1Database;
  return { db, batches, updates };
}

function buildApp(tenant: Partial<Tenant>, env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: "tenant-1", name: "Prairie Star", slug: "prairie", ...tenant } as Tenant);
    await next();
  });
  app.route("/", reportRoutes);
  return app;
}

function envFor(db: D1Database): Env {
  return { DB: db, APP_URL: "https://quilthosting.com" } as unknown as Env;
}

describe("GET /summary", () => {
  it("answers the documented contract in ONE DB.batch", async () => {
    const { db, batches } = fakeDb([
      [
        { status: "active", cnt: 30 },
        { status: "lapsed", cnt: 3 },
      ],
      [{ month: new Date().toISOString().slice(0, 7), cnt: 4 }],
      [],
      [{ month: new Date().toISOString().slice(0, 7), total_cents: 12000, payments: 3 }],
      [{ type: "dues", total_cents: 12000, payments: 3 }],
      [],
      [{ title: "Retreat", registrations: 9 }],
      [{ cnt: 5 }],
    ]);
    const env = envFor(db);
    const res = await buildApp({}, env).request("/summary", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(batches).toHaveLength(1);
    expect(batches[0].count).toBeGreaterThanOrEqual(8);

    expect(Array.isArray(body.months)).toBe(true);
    expect(body.months).toHaveLength(12);
    expect(body.members).toMatchObject({ total: 33, active: 30 });
    expect(body.members.new_by_month).toHaveLength(12);
    expect(body.members.lapsed_by_month).toHaveLength(12);
    expect(typeof body.renewal_rate).toBe("number");
    expect(typeof body.churn_rate).toBe("number");
    expect(body.revenue.by_month).toHaveLength(12);
    expect(body.revenue.by_source).toMatchObject({ dues: 12000, events: 0, store: 0, donations: 0 });
    expect(body.events.attendance_by_month).toHaveLength(12);
    expect(body.events.top).toEqual([{ title: "Retreat", registrations: 9 }]);
    expect(body.monthly_email).toBe(false);
  });

  it("honours ?months= for each offered window and falls back to 12", async () => {
    for (const months of REPORT_MONTH_CHOICES) {
      const { db } = fakeDb();
      const env = envFor(db);
      const res = await buildApp({}, env).request(`/summary?months=${months}`, {}, env);
      const body = (await res.json()) as any;
      expect(body.months).toHaveLength(months);
      expect(body.range.months).toBe(months);
    }
    const { db } = fakeDb();
    const env = envFor(db);
    const res = await buildApp({}, env).request("/summary?months=nonsense", {}, env);
    expect(((await res.json()) as any).months).toHaveLength(12);
  });

  it("reports the tenant's monthly-email toggle", async () => {
    const { db } = fakeDb();
    const env = envFor(db);
    const res = await buildApp(
      { settings_json: JSON.stringify({ reports: { monthly: true } }) } as Partial<Tenant>,
      env
    ).request("/summary", {}, env);
    expect(((await res.json()) as any).monthly_email).toBe(true);
  });

  it("returns 500 with a message, not a stack, when the batch fails", async () => {
    const db = {
      prepare() {
        return { bind: () => ({}) };
      },
      async batch() {
        throw new Error("D1_ERROR: no such table");
      },
    } as unknown as D1Database;
    const env = envFor(db);
    const res = await buildApp({}, env).request("/summary", {}, env);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toBeTruthy();
  });
});

describe("PATCH /settings", () => {
  it("turns the monthly board report on and writes settings.reports.monthly", async () => {
    const { db, updates } = fakeDb();
    const env = envFor(db);
    const res = await buildApp(
      { settings_json: JSON.stringify({ theme: { primary: "#000" } }) } as Partial<Tenant>,
      env
    ).request(
      "/settings",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthly: true }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, monthly: true });
    expect(updates).toHaveLength(1);
    const written = JSON.parse(updates[0].binds[0] as string);
    expect(written.reports.monthly).toBe(true);
    // Untouched settings survive the read-modify-write.
    expect(written.theme).toEqual({ primary: "#000" });
  });

  it("turns it back off", async () => {
    const { db, updates } = fakeDb();
    const env = envFor(db);
    const res = await buildApp(
      { settings_json: JSON.stringify({ reports: { monthly: true } }) } as Partial<Tenant>,
      env
    ).request(
      "/settings",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthly: false }),
      },
      env
    );
    expect(res.status).toBe(200);
    const written = JSON.parse(updates[0].binds[0] as string);
    expect(written.reports.monthly).toBe(false);
  });

  it("rejects a non-boolean", async () => {
    const { db, updates } = fakeDb();
    const env = envFor(db);
    const res = await buildApp({}, env).request(
      "/settings",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthly: "yes" }),
      },
      env
    );
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("rejects a malformed body", async () => {
    const { db, updates } = fakeDb();
    const env = envFor(db);
    const res = await buildApp({}, env).request(
      "/settings",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{" },
      env
    );
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});
