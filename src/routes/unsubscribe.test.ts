// src/routes/unsubscribe.test.ts
// GET shows a form and writes nothing; POST (form or RFC 8058 one-click)
// opts the member out + inserts a suppression, idempotently; bad tokens 400.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { unsubscribeRoutes } from "./unsubscribe";
import { unsubscribeToken } from "../lib/suppression";
import type { Env } from "../types";

const JWT_SECRET = "unit-test-secret";

function fakeDb() {
  const state = {
    supp: [] as { tenant_id: string | null; email: string; scope: string; reason: string; source: string | null }[],
    members: [{ tenant_id: "t1", email: "member@example.test", email_opt_out_at: null as string | null }],
    writes: 0,
  };
  const stmt = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    async run() {
      state.writes++;
      if (sql.includes("INSERT OR IGNORE INTO email_suppressions")) {
        const [, tenant_id, email, reason, scope, source] = binds as [string, string | null, string, string, string, string | null];
        if (state.supp.some((r) => r.tenant_id === tenant_id && r.email === email && r.scope === scope)) {
          return { success: true, meta: { changes: 0 } };
        }
        state.supp.push({ tenant_id, email, reason, scope, source });
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("UPDATE members SET email_opt_out_at")) {
        const [ts, , tenantId, email] = binds as [string, string, string, string];
        const m = state.members.find((r) => r.tenant_id === tenantId && r.email === email);
        if (m && !m.email_opt_out_at) {
          m.email_opt_out_at = ts;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      throw new Error(`unexpected run: ${sql}`);
    },
    async first() {
      if (sql.includes("FROM tenants")) return { name: "Test Guild" };
      return null;
    },
    async all() {
      return { results: [] };
    },
  });
  return { state, prepare: (sql: string) => stmt(sql, []) };
}

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/u", unsubscribeRoutes);
  return a;
}

describe("/u/:token", () => {
  it("GET renders a confirmation form and writes nothing", async () => {
    const db = fakeDb();
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const token = await unsubscribeToken(JWT_SECRET, "t1", "member@example.test");
    const res = await app().request(`/u/${token}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="POST"');
    expect(html).toContain("Test Guild");
    expect(html).toContain("member@example.test");
    expect(html).not.toMatch(/<script|https?:\/\/[^"']+\.(css|js)/);
    expect(db.state.writes).toBe(0);
    expect(db.state.members[0].email_opt_out_at).toBeNull();
  });

  it("POST opts out + suppresses, and a second POST is a no-op", async () => {
    const db = fakeDb();
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const token = await unsubscribeToken(JWT_SECRET, "t1", "member@example.test");
    const res = await app().request(
      `/u/${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Gmail" },
        body: "confirm=1",
      },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("unsubscribed");
    expect(db.state.members[0].email_opt_out_at).toBeTruthy();
    expect(db.state.supp).toEqual([
      { tenant_id: "t1", email: "member@example.test", scope: "marketing", reason: "unsubscribe", source: "unsubscribe:Gmail" },
    ]);
    const firstOptOut = db.state.members[0].email_opt_out_at;

    const again = await app().request(`/u/${token}`, { method: "POST" }, env);
    expect(again.status).toBe(200);
    expect(db.state.supp).toHaveLength(1);
    expect(db.state.members[0].email_opt_out_at).toBe(firstOptOut);
  });

  it("accepts the RFC 8058 one-click body", async () => {
    const db = fakeDb();
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const token = await unsubscribeToken(JWT_SECRET, "t1", "member@example.test");
    const res = await app().request(
      `/u/${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
      env
    );
    expect(res.status).toBe(200);
    expect(db.state.members[0].email_opt_out_at).toBeTruthy();
    expect(db.state.supp).toHaveLength(1);
  });

  it("rejects a tampered or foreign-secret token with 400 and no writes", async () => {
    const db = fakeDb();
    const env = { DB: db, JWT_SECRET } as unknown as Env;
    const good = await unsubscribeToken(JWT_SECRET, "t1", "member@example.test");
    const forged = await unsubscribeToken("other-secret", "t1", "member@example.test");
    const [payload] = good.split(".");
    for (const bad of [forged, `${payload}.AAAA`, "garbage"]) {
      const res = await app().request(`/u/${bad}`, { method: "POST" }, env);
      expect(res.status).toBe(400);
    }
    expect(db.state.writes).toBe(0);
  });
});
