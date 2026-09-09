// src/lib/memberships.test.ts
//
// Phase 4, Task A. Two jobs:
//
//   1. Pin the promise that made the dues policy safe to ship: every caller
//      that does NOT pass a policy gets exactly the membership it got
//      before this phase — same computed end date, same INSERT, same
//      UPDATE. If that ever stops being true, a guild that never touched
//      its levels would silently get new renewal dates.
//   2. Cover the policy-aware paths: a calendar-year level ends December
//      31, and renewing it rolls to the NEXT December 31 rather than
//      handing back the one the member already has.
import { describe, it, expect } from "vitest";
import type { MembershipLevel } from "../types";
import {
  computeMembershipEnd,
  activateMembership,
  extendMembership,
} from "./memberships";
import { readDuesPolicy, type DuesPolicy } from "./dues";

const NOW = "2026-10-15T12:00:00.000Z";

function level(over: Partial<MembershipLevel> = {}): MembershipLevel {
  return {
    id: "lvl-1",
    tenant_id: "t1",
    name: "Individual",
    description: null,
    price_cents: 3500,
    duration_months: 12,
    renewal_type: "manual",
    benefits_json: "[]",
    is_public: 1,
    sort_order: 0,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    ...over,
  } as MembershipLevel;
}

/** Records every statement so a test can read back what was written. */
function fakeDb(endDate: string | null = null) {
  const runs: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              return sql.includes("SELECT end_date") ? { end_date: endDate } : null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const inserted = () => runs.find((r) => r.sql.includes("INSERT INTO memberships"));
  const updatedEnd = () =>
    runs.find((r) => r.sql.includes("UPDATE memberships SET end_date"));
  return { db, runs, inserted, updatedEnd };
}

describe("computeMembershipEnd — unchanged by the dues policy work", () => {
  it("measures a full term from the start date when it is in the future", () => {
    expect(computeMembershipEnd("2027-02-01T00:00:00.000Z", 12, NOW)).toBe(
      "2028-02-01T00:00:00.000Z"
    );
  });

  it("measures from today when the start date is historical (CSV import)", () => {
    expect(computeMembershipEnd("2019-03-02T00:00:00.000Z", 12, NOW)).toBe(
      "2027-10-15T12:00:00.000Z"
    );
  });

  it("honors a non-default duration", () => {
    expect(computeMembershipEnd(NOW, 6, NOW)).toBe("2027-04-15T12:00:00.000Z");
  });

  it("treats a missing duration as twelve months", () => {
    expect(computeMembershipEnd(NOW, null, NOW)).toBe("2027-10-15T12:00:00.000Z");
  });

  it("throws a RangeError on an unreadable start date", () => {
    expect(() => computeMembershipEnd("whenever", 12, NOW)).toThrow(RangeError);
  });
});

describe("activateMembership without a policy is byte-identical to before", () => {
  it("writes exactly computeMembershipEnd's answer", async () => {
    const { db, inserted } = fakeDb();
    await activateMembership(db, {
      tenantId: "t1",
      memberId: "mem-1",
      level: level(),
      amountPaidCents: 3500,
      now: NOW,
    });
    // binds: id, tenant, member, level, start, end, amount, sub, autoRenew, created, updated
    expect(inserted()!.binds[4]).toBe(NOW);
    expect(inserted()!.binds[5]).toBe(computeMembershipEnd(NOW, 12, NOW));
    expect(inserted()!.binds[5]).toBe("2027-10-15T12:00:00.000Z");
  });

  it("is unchanged for a historical start date too", async () => {
    const { db, inserted } = fakeDb();
    await activateMembership(db, {
      tenantId: "t1",
      memberId: "mem-1",
      level: level(),
      amountPaidCents: 3500,
      now: NOW,
      startDate: "2019-03-02T00:00:00.000Z",
    });
    expect(inserted()!.binds[4]).toBe("2019-03-02T00:00:00.000Z");
    expect(inserted()!.binds[5]).toBe(
      computeMembershipEnd("2019-03-02T00:00:00.000Z", 12, NOW)
    );
  });

  it("still lets an explicit endDate win, including null", async () => {
    const { db, inserted } = fakeDb();
    await activateMembership(db, {
      tenantId: "t1",
      memberId: "mem-1",
      level: level(),
      amountPaidCents: 0,
      now: NOW,
      endDate: null,
    });
    expect(inserted()!.binds[5]).toBeNull();
  });

  it("an anniversary policy changes nothing", async () => {
    const { db, inserted } = fakeDb();
    await activateMembership(db, {
      tenantId: "t1",
      memberId: "mem-1",
      level: level(),
      amountPaidCents: 3500,
      now: NOW,
      policy: readDuesPolicy(level()),
    });
    expect(inserted()!.binds[5]).toBe(computeMembershipEnd(NOW, 12, NOW));
  });
});

describe("activateMembership with a fixed-year policy", () => {
  const calendar: DuesPolicy = readDuesPolicy({
    term_mode: "calendar",
    duration_months: 12,
  });

  it("ends December 31 of the year they joined", async () => {
    const { db, inserted } = fakeDb();
    await activateMembership(db, {
      tenantId: "t1",
      memberId: "mem-1",
      level: level(),
      amountPaidCents: 1750,
      now: NOW,
      policy: calendar,
    });
    expect(inserted()!.binds[5]).toBe("2026-12-31T23:59:59.999Z");
  });

  it("gives two members who joined months apart the same end date", async () => {
    const ends: unknown[] = [];
    for (const now of ["2026-01-03T09:00:00.000Z", "2026-12-20T21:15:00.000Z"]) {
      const { db, inserted } = fakeDb();
      await activateMembership(db, {
        tenantId: "t1",
        memberId: "mem",
        level: level(),
        amountPaidCents: 3500,
        now,
        policy: calendar,
      });
      ends.push(inserted()!.binds[5]);
    }
    expect(ends[0]).toBe(ends[1]);
    expect(ends[0]).toBe("2026-12-31T23:59:59.999Z");
  });
});

describe("extendMembership", () => {
  it("without a policy adds the duration to the current end date (unchanged)", async () => {
    // Reference = the exact math extendMembership carried before phase 4,
    // recomputed here rather than written as a literal: Date#setMonth works
    // in the host's LOCAL zone, so the answer for a UTC-midnight end date
    // shifts by a day west of Greenwich. That quirk is pre-existing behavior
    // this task must not change, so the test reproduces it instead of
    // asserting a timezone-dependent constant.
    const reference = (endDate: string, months: number) => {
      const base = new Date(endDate) > new Date(NOW) ? new Date(endDate) : new Date(NOW);
      base.setMonth(base.getMonth() + months);
      return base.toISOString();
    };
    const { db, updatedEnd } = fakeDb("2027-03-01T00:00:00.000Z");
    const newEnd = await extendMembership(db, "ms-1", 12, NOW);
    expect(newEnd).toBe(reference("2027-03-01T00:00:00.000Z", 12));
    expect(updatedEnd()!.binds[0]).toBe(newEnd);
  });

  it("without a policy starts from today when the term already lapsed", async () => {
    const { db } = fakeDb("2020-01-01T00:00:00.000Z");
    expect(await extendMembership(db, "ms-1", 12, NOW)).toBe("2027-10-15T12:00:00.000Z");
  });

  it("returns null for a membership that does not exist", async () => {
    const db = {
      prepare: () => ({ bind: () => ({ async first() { return null; } }) }),
    } as unknown as D1Database;
    expect(await extendMembership(db, "nope", 12, NOW)).toBeNull();
  });

  it("rolls a calendar year to the NEXT December 31, not the current one", async () => {
    const calendar = readDuesPolicy({ term_mode: "calendar", duration_months: 12 });
    const { db } = fakeDb("2026-12-31T23:59:59.999Z");
    expect(await extendMembership(db, "ms-1", 12, NOW, calendar)).toBe(
      "2027-12-31T23:59:59.999Z"
    );
  });

  it("re-anchors a lapsed calendar membership to the current year", async () => {
    const calendar = readDuesPolicy({ term_mode: "calendar", duration_months: 12 });
    const { db } = fakeDb("2024-12-31T23:59:59.999Z");
    expect(await extendMembership(db, "ms-1", 12, NOW, calendar)).toBe(
      "2026-12-31T23:59:59.999Z"
    );
  });

  it("rolls a fixed-date year to the next anchor", async () => {
    const july = readDuesPolicy({
      term_mode: "fixed_date",
      term_anchor: "07-01",
      duration_months: 12,
    });
    const { db } = fakeDb("2027-06-30T23:59:59.999Z");
    expect(await extendMembership(db, "ms-1", 12, NOW, july)).toBe(
      "2028-06-30T23:59:59.999Z"
    );
  });
});
