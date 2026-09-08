// src/lib/audience.test.ts
// Marketing audiences exclude opted-out / suppressed members at selection
// time; admin counts can include them and always get an opted_out figure.
import { describe, it, expect } from "vitest";
import { countAudience, fetchAudiencePage, MARKETING_ELIGIBLE_SQL } from "./audience";

/** D1 stand-in: records every SQL + binds; counts answer 10 (total) / 7 (eligible). */
function fakeDb() {
  const calls: { sql: string; binds: unknown[]; kind: string }[] = [];
  const stmt = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    async run() {
      calls.push({ sql, binds, kind: "run" });
      return { success: true, meta: { changes: 1 } };
    },
    async first() {
      calls.push({ sql, binds, kind: "first" });
      if (sql.includes("FROM member_groups")) return binds[0] === "g1" ? { id: "g1", name: "Board" } : null;
      if (sql.includes("FROM membership_levels")) return binds[0] === "l1" ? { id: "l1", name: "Regular" } : null;
      if (sql.includes("as cnt")) return { cnt: sql.includes("email_opt_out_at IS NULL") ? 7 : 10 };
      return null;
    },
    async all() {
      calls.push({ sql, binds, kind: "all" });
      return { results: [{ id: "m1", email: "a@example.test", first_name: null, last_name: null, level_name: null, end_date: null }] };
    },
  });
  return { calls, prepare: (sql: string) => stmt(sql, []) } as unknown as D1Database & { calls: typeof calls };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("countAudience", () => {
  it("excludes opted-out/suppressed members by default and reports opted_out", async () => {
    const db = fakeDb();
    const r = await countAudience(db, "t1", "active");
    expect(r).toEqual({ count: 7, label: "active", opted_out: 3 });
    const counts = db.calls.filter((c) => c.sql.includes("as cnt"));
    expect(counts).toHaveLength(2);
    expect(counts[0].sql).not.toContain("email_suppressions");
    expect(norm(counts[1].sql)).toContain(norm(MARKETING_ELIGIBLE_SQL));
    expect(counts[1].binds).toEqual(["t1", "active"]);
  });

  it("includeOptedOut counts everyone but still reports opted_out", async () => {
    const r = await countAudience(fakeDb(), "t1", "all", { includeOptedOut: true });
    expect(r).toEqual({ count: 10, label: "all", opted_out: 3 });
  });

  it("group and level segments resolve labels and apply the same filter", async () => {
    const db = fakeDb();
    expect(await countAudience(db, "t1", "group:g1")).toEqual({ count: 7, label: "group:Board", opted_out: 3 });
    expect(await countAudience(db, "t1", "level:l1")).toEqual({ count: 7, label: "level:Regular", opted_out: 3 });
    const eligible = db.calls.filter((c) => c.sql.includes("as cnt") && c.sql.includes("email_suppressions"));
    expect(eligible).toHaveLength(2);
    expect(eligible.every((c) => c.sql.includes("COUNT(DISTINCT m.id)"))).toBe(true);
    expect(await countAudience(db, "t1", "group:nope")).toEqual({ error: "Group not found", status: 404 });
    expect(await countAudience(db, "t1", "bogus")).toEqual({ error: "Invalid segment", status: 400 });
  });
});

describe("fetchAudiencePage", () => {
  it("applies the eligibility predicate with keyset pagination", async () => {
    const db = fakeDb();
    const rows = await fetchAudiencePage(db, "t1", "lapsed", { limit: 25, afterEmail: "m@example.test" });
    expect(rows).toHaveLength(1);
    const q = db.calls.find((c) => c.kind === "all")!;
    expect(norm(q.sql)).toContain(norm(MARKETING_ELIGIBLE_SQL));
    expect(q.sql).toContain("ORDER BY m.email");
    expect(q.binds).toEqual(["t1", "lapsed", "m@example.test", "m@example.test", 25]);
  });

  it("includeOptedOut drops the predicate (admin preview only)", async () => {
    const db = fakeDb();
    await fetchAudiencePage(db, "t1", "all", { limit: 10, includeOptedOut: true });
    const q = db.calls.find((c) => c.kind === "all")!;
    expect(q.sql).not.toContain("email_suppressions");
    expect(q.sql).toContain("m.status != 'cancelled'");
    expect(q.binds).toEqual(["t1", "", "", 10]);
  });

  it("returns nothing for an unknown group and falls back to 'all' for an unknown status", async () => {
    const db = fakeDb();
    expect(await fetchAudiencePage(db, "t1", "group:nope", { limit: 10 })).toEqual([]);
    expect(await fetchAudiencePage(db, "t1", "weird", { limit: 10 })).toHaveLength(1);
  });
});
