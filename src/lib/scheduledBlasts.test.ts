// src/lib/scheduledBlasts.test.ts
// runScheduledBlasts must be safe under overlapping one-minute ticks: only
// due rows are selected, and each is claimed with a conditional UPDATE that
// a concurrent tick loses (meta.changes = 0).
import { describe, it, expect } from "vitest";
import { runScheduledBlasts } from "./scheduledBlasts";
import type { Env } from "../types";

function fakeDb(rows: { id: string; send_at: string; status: string }[]) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const stmt = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    async run() {
      calls.push({ sql, binds });
      const [id, now] = binds as [string, string];
      const row = rows.find((r) => r.id === id);
      if (row && row.status === "scheduled" && row.send_at <= now) {
        row.status = "queued";
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
    async first() {
      return null;
    },
    async all() {
      calls.push({ sql, binds });
      const now = binds[0] as string;
      return { results: rows.filter((r) => r.status === "scheduled" && r.send_at <= now) };
    },
  });
  return { calls, rows, prepare: (sql: string) => stmt(sql, []) };
}

describe("runScheduledBlasts", () => {
  const now = "2026-09-08T12:00:00.000Z";

  it("queues only due scheduled blasts", async () => {
    const db = fakeDb([
      { id: "due", send_at: "2026-09-08T11:59:00.000Z", status: "scheduled" },
      { id: "future", send_at: "2026-09-08T12:01:00.000Z", status: "scheduled" },
      { id: "already", send_at: "2026-09-08T11:00:00.000Z", status: "queued" },
    ]);
    const r = await runScheduledBlasts({ DB: db } as unknown as Env, now);
    expect(r).toEqual({ sent_blasts: 1, emails: 0, errors: [] });
    expect(db.rows.map((x) => x.status)).toEqual(["queued", "scheduled", "queued"]);
    const select = db.calls[0];
    expect(select.sql).toContain("status = 'scheduled'");
    expect(select.sql).toContain("send_at <= ?");
    expect(select.binds).toEqual([now]);
    const claim = db.calls[1];
    expect(claim.sql).toContain("WHERE id = ? AND status = 'scheduled'");
    expect(claim.sql).toContain("send_at <= ?");
    expect(claim.binds).toEqual(["due", now]);
  });

  it("a concurrent tick that loses the conditional claim counts nothing", async () => {
    const shared = [{ id: "due", send_at: "2026-09-08T11:59:00.000Z", status: "scheduled" }];
    const dbA = fakeDb(shared);
    const dbB = fakeDb(shared);
    // Both ticks SELECT before either claims: emulate by running the selects
    // first, then racing the claims through the shared row.
    const [a, b] = await Promise.all([
      runScheduledBlasts({ DB: dbA } as unknown as Env, now),
      runScheduledBlasts({ DB: dbB } as unknown as Env, now),
    ]);
    expect(a.sent_blasts + b.sent_blasts).toBe(1);
    expect(shared[0].status).toBe("queued");
  });

  it("re-running after the claim is a no-op", async () => {
    const db = fakeDb([{ id: "due", send_at: "2026-09-08T11:59:00.000Z", status: "scheduled" }]);
    const env = { DB: db } as unknown as Env;
    expect((await runScheduledBlasts(env, now)).sent_blasts).toBe(1);
    expect((await runScheduledBlasts(env, now)).sent_blasts).toBe(0);
  });
});
