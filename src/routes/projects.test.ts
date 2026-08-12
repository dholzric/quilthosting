// Same idiom as src/routes/pages.test.ts and credentials.test.ts: dispatch
// through the exported app with a thin stand-in for tenantMiddleware, and a
// keyword-routed fake D1 that records every write.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { projectRoutes } from "./projects";
import type { Env, Tenant, TenantVariables } from "../types";

const TENANT_ID = "tenant-1";

function harness(opts: { project?: Record<string, unknown>; role?: string } = {}) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  // Every statement the routes prepare, in order. The tenant-scoping test
  // below asserts against this rather than trusting the routes.
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM projects")) return opts.project ?? null;
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              writes.push({ sql, binds });
              return { success: true };
            },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { writes.push({ sql, binds: [] }); return { success: true }; },
      };
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables & { tenantRole: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, slug: "stitchstudio", settings_json: "{}" } as Tenant);
    c.set("tenantRole", opts.role ?? "owner");
    await next();
  });
  app.route("/", projectRoutes);
  return { app, writes, prepared, env: { DB: db } as unknown as Env };
}

describe("projects admin API", () => {
  it("refuses a non-owner role", async () => {
    const { app, env } = harness({ role: "member", project: { id: "p1", status: "submitted" } });
    const res = await app.request("/p1", { method: "PATCH", body: JSON.stringify({ status: "estimated" }) }, env);
    expect(res.status).toBe(403);
  });

  it("rejects an illegal status transition with 409, not 500", async () => {
    const { app, env } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed" }) },
      env
    );
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain("submitted -> completed");
  });

  it("accepts a legal transition", async () => {
    const { app, env, writes } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "signed", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "in_progress" }) },
      env
    );
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.sql.includes("UPDATE projects"))).toBe(true);
  });

  it("scopes EVERY statement touching projects to the tenant", async () => {
    // The Global Constraints require `WHERE tenant_id = ?` on every query;
    // this asserts it against the SQL the routes actually prepare, rather
    // than trusting that they do. `prepared` is populated by the harness
    // above — see the `prepare(sql)` hook, which records each statement.
    const { app, env, prepared } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    await app.request("/p1", {}, env);
    await app.request("/", {}, env);

    const projectStatements = prepared.filter((sql) => /\bprojects\b/.test(sql));
    expect(projectStatements.length).toBeGreaterThan(0);
    for (const sql of projectStatements) {
      expect(sql).toMatch(/tenant_id\s*=\s*\?/);
    }
  });

  it("recomputes totals from the saved lines rather than trusting the client", async () => {
    const { app, env, writes } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1/lines",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [
            { kind: "service", description: "Quilting", quantity: 1, unit_cents: 10000, amount_cents: 10000 },
            { kind: "addon", description: "Thread", quantity: 1, unit_cents: 1200, amount_cents: 1200 },
          ],
          // A client claiming the total is $1 must not be believed.
          total_cents: 100,
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const update = writes.find((w) => w.sql.includes("UPDATE projects SET subtotal_cents"));
    expect(update).toBeDefined();
    expect(update!.binds).toContain(11200);
  });
});
