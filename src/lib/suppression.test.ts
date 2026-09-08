// src/lib/suppression.test.ts
// Suppression lookups (global vs tenant vs member opt-out, transactional vs
// marketing), idempotent inserts, and unsubscribe token round-trip/tamper.
// Pure-unit: an in-memory D1 stand-in routes each SQL string to a handler.
import { describe, it, expect } from "vitest";
import {
  isSuppressed,
  suppress,
  optOutMember,
  unsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
} from "./suppression";

type SuppRow = { tenant_id: string | null; email: string; scope: string; reason: string };

/** Minimal D1: suppression table + members.email_opt_out_at in memory. */
function fakeDb(state: { supp: SuppRow[]; optOut: Record<string, string | null> }) {
  const stmt = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    async run() {
      if (sql.includes("INSERT OR IGNORE INTO email_suppressions")) {
        const [, tenant_id, email, reason, scope] = binds as [string, string | null, string, string, string];
        const dup = state.supp.some(
          (r) => r.email === email && r.scope === scope && (r.tenant_id ?? null) === (tenant_id ?? null)
        );
        if (dup) return { success: true, meta: { changes: 0 } };
        state.supp.push({ tenant_id, email, reason, scope });
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("UPDATE members SET email_opt_out_at")) {
        const [ts, , tenantId, email] = binds as [string, string, string, string];
        const key = `${tenantId}:${email}`;
        if (key in state.optOut && !state.optOut[key]) {
          state.optOut[key] = ts;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      throw new Error(`unexpected run: ${sql}`);
    },
    async first() {
      if (sql.includes("FROM email_suppressions")) {
        const email = binds[0] as string;
        const tenantId = binds[binds.length - 1] as string;
        const scopes = binds.slice(1, -1) as string[];
        const hits = state.supp.filter(
          (r) =>
            r.email === email &&
            scopes.includes(r.scope) &&
            (r.tenant_id === null || r.tenant_id === tenantId)
        );
        hits.sort((a, b) => (a.scope === "all" ? 0 : 1) - (b.scope === "all" ? 0 : 1));
        return hits[0] ?? null;
      }
      if (sql.includes("SELECT email_opt_out_at FROM members")) {
        const [tenantId, email] = binds as [string, string];
        const key = `${tenantId}:${email}`;
        return key in state.optOut ? { email_opt_out_at: state.optOut[key] } : null;
      }
      throw new Error(`unexpected first: ${sql}`);
    },
    async all() {
      return { results: [] };
    },
  });
  return { prepare: (sql: string) => stmt(sql, []) } as unknown as D1Database;
}

describe("isSuppressed", () => {
  it("global scope=all blocks both transactional and marketing, for any tenant", async () => {
    const db = fakeDb({
      supp: [{ tenant_id: null, email: "bounced@example.test", scope: "all", reason: "bounce" }],
      optOut: {},
    });
    expect(await isSuppressed(db, "t1", "Bounced@Example.test", "transactional")).toEqual({
      suppressed: true,
      reason: "bounce",
    });
    expect(await isSuppressed(db, "t2", "bounced@example.test", "marketing")).toMatchObject({
      suppressed: true,
    });
    expect(await isSuppressed(db, null, "bounced@example.test", "transactional")).toMatchObject({
      suppressed: true,
    });
  });

  it("tenant marketing suppression blocks only that tenant's marketing mail", async () => {
    const db = fakeDb({
      supp: [{ tenant_id: "t1", email: "a@example.test", scope: "marketing", reason: "complaint" }],
      optOut: {},
    });
    expect(await isSuppressed(db, "t1", "a@example.test", "marketing")).toEqual({
      suppressed: true,
      reason: "complaint",
    });
    expect(await isSuppressed(db, "t1", "a@example.test", "transactional")).toEqual({
      suppressed: false,
    });
    expect(await isSuppressed(db, "t2", "a@example.test", "marketing")).toEqual({
      suppressed: false,
    });
  });

  it("member opt-out blocks marketing but not transactional", async () => {
    const db = fakeDb({
      supp: [],
      optOut: { "t1:m@example.test": "2026-09-01T00:00:00Z" },
    });
    expect(await isSuppressed(db, "t1", "m@example.test", "marketing")).toEqual({
      suppressed: true,
      reason: "opt_out",
    });
    expect(await isSuppressed(db, "t1", "m@example.test", "transactional")).toEqual({
      suppressed: false,
    });
  });

  it("clean address is not suppressed; empty address is", async () => {
    const db = fakeDb({ supp: [], optOut: { "t1:ok@example.test": null } });
    expect(await isSuppressed(db, "t1", "ok@example.test", "marketing")).toEqual({
      suppressed: false,
    });
    expect((await isSuppressed(db, "t1", "  ", "marketing")).suppressed).toBe(true);
  });
});

describe("suppress / optOutMember", () => {
  it("suppress is idempotent on (tenant, email, scope)", async () => {
    const state = { supp: [] as SuppRow[], optOut: {} };
    const db = fakeDb(state);
    const a = await suppress(db, { tenantId: "t1", email: "X@Example.test", reason: "unsubscribe" });
    const b = await suppress(db, { tenantId: "t1", email: "x@example.test", reason: "unsubscribe" });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(state.supp).toHaveLength(1);
    expect(state.supp[0]).toMatchObject({ email: "x@example.test", scope: "marketing" });
    // A global row for the same address is a distinct key.
    const g = await suppress(db, { tenantId: null, email: "x@example.test", reason: "bounce", scope: "all" });
    expect(g.inserted).toBe(true);
  });

  it("optOutMember sets email_opt_out_at once", async () => {
    const state = { supp: [] as SuppRow[], optOut: { "t1:m@example.test": null as string | null } };
    const db = fakeDb(state);
    expect((await optOutMember(db, "t1", "M@example.test")).changes).toBe(1);
    expect((await optOutMember(db, "t1", "m@example.test")).changes).toBe(0);
    expect(state.optOut["t1:m@example.test"]).toBeTruthy();
  });
});

describe("unsubscribe tokens", () => {
  const secret = "test-secret-do-not-use";

  it("round-trips tenant + normalized email", async () => {
    const token = await unsubscribeToken(secret, "tenant-1", "  Member@Example.TEST ");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyUnsubscribeToken(secret, token)).toEqual({
      tenantId: "tenant-1",
      email: "member@example.test",
    });
    expect(await unsubscribeUrl("https://quilthosting.com/", secret, "tenant-1", "member@example.test")).toBe(
      `https://quilthosting.com/u/${token}`
    );
  });

  it("is deterministic (old links keep working) and has no expiry", async () => {
    const a = await unsubscribeToken(secret, "t", "a@b.test");
    const b = await unsubscribeToken(secret, "t", "a@b.test");
    expect(a).toBe(b);
  });

  it("rejects tampered payload, tampered signature, wrong secret, and junk", async () => {
    const token = await unsubscribeToken(secret, "tenant-1", "member@example.test");
    const [payload, sig] = token.split(".");
    const otherPayload = (await unsubscribeToken(secret, "tenant-2", "member@example.test")).split(".")[0];
    expect(await verifyUnsubscribeToken(secret, `${otherPayload}.${sig}`)).toBeNull();
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(await verifyUnsubscribeToken(secret, `${payload}.${flipped}`)).toBeNull();
    expect(await verifyUnsubscribeToken("other-secret", token)).toBeNull();
    expect(await verifyUnsubscribeToken(secret, "")).toBeNull();
    expect(await verifyUnsubscribeToken(secret, "nodot")).toBeNull();
    expect(await verifyUnsubscribeToken(secret, "!!!.???")).toBeNull();
    expect(await verifyUnsubscribeToken("", token)).toBeNull();
  });
});
