// src/lib/dues.test.ts
//
// Phase 4, Task A: the dues policy engine. A guild sells a membership YEAR,
// not "twelve months from whenever you signed up", so `membership_levels`
// now carries a policy (term_mode, term_anchor, proration, grace_days) and
// this module owns every date and price it implies.
//
// The invariant that outranks everything else here: a level nobody edits
// keeps today's behavior exactly. `readDuesPolicy` on a row that predates
// migration 0030 must produce the anniversary policy, and the anniversary
// branch of `computeTermEnd` must agree with `computeMembershipEnd`
// character for character on every input.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDuesPolicy,
  computeTermEnd,
  prorateCents,
  describePolicy,
  lapseDate,
  anniversaryTermEnd,
  TERM_MODES,
  PRORATIONS,
  type DuesPolicy,
} from "./dues";
import { computeMembershipEnd } from "./memberships";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");

/** Just the calendar day, which is what a member and a treasurer read. */
const day = (iso: string) => iso.slice(0, 10);

function policy(over: Partial<DuesPolicy> = {}): DuesPolicy {
  return {
    termMode: "anniversary",
    termAnchor: null,
    durationMonths: 12,
    proration: "none",
    graceDays: 0,
    ...over,
  };
}

describe("readDuesPolicy", () => {
  it("reads a pre-migration level as today's behavior", () => {
    expect(readDuesPolicy({ duration_months: 12 })).toEqual({
      termMode: "anniversary",
      termAnchor: null,
      durationMonths: 12,
      proration: "none",
      graceDays: 0,
    });
  });

  it("reads the columns migration 0030 adds", () => {
    expect(
      readDuesPolicy({
        term_mode: "fixed_date",
        term_anchor: "07-01",
        duration_months: 12,
        proration: "half_year",
        grace_days: 30,
      })
    ).toEqual({
      termMode: "fixed_date",
      termAnchor: "07-01",
      durationMonths: 12,
      proration: "half_year",
      graceDays: 30,
    });
  });

  it("falls back to anniversary for an unknown mode", () => {
    expect(readDuesPolicy({ term_mode: "quarterly", duration_months: 12 }).termMode).toBe(
      "anniversary"
    );
  });

  it("keeps calendar's anchor null (January 1 is implied)", () => {
    const p = readDuesPolicy({ term_mode: "calendar", term_anchor: "07-01", duration_months: 12 });
    expect(p.termMode).toBe("calendar");
    expect(p.termAnchor).toBeNull();
  });

  it("treats fixed_date without a usable anchor as the calendar year", () => {
    expect(readDuesPolicy({ term_mode: "fixed_date", duration_months: 12 }).termMode).toBe(
      "calendar"
    );
    expect(
      readDuesPolicy({ term_mode: "fixed_date", term_anchor: "13-99", duration_months: 12 })
        .termMode
    ).toBe("calendar");
  });

  it("cannot prorate an anniversary level (there is no shared year to prorate into)", () => {
    expect(
      readDuesPolicy({ term_mode: "anniversary", proration: "half_year", duration_months: 12 })
        .proration
    ).toBe("none");
  });

  it("clamps nonsense duration and grace values instead of throwing", () => {
    expect(readDuesPolicy({ duration_months: 0 }).durationMonths).toBe(12);
    expect(readDuesPolicy({ duration_months: 999 }).durationMonths).toBe(12);
    expect(readDuesPolicy({ duration_months: 6 }).durationMonths).toBe(6);
    expect(readDuesPolicy({ duration_months: 12, grace_days: -5 }).graceDays).toBe(0);
    expect(readDuesPolicy({ duration_months: 12, grace_days: 5000 }).graceDays).toBe(0);
    expect(readDuesPolicy({ duration_months: 12, grace_days: 30 }).graceDays).toBe(30);
  });

  it("exports the value lists the route and the admin share", () => {
    expect(TERM_MODES).toEqual(["anniversary", "calendar", "fixed_date"]);
    expect(PRORATIONS).toEqual(["none", "half_year", "monthly"]);
  });
});

describe("computeTermEnd — anniversary is today's math, untouched", () => {
  const cases: Array<[string, number, string]> = [
    ["2026-05-01T00:00:00.000Z", 12, "2026-05-01T00:00:00.000Z"],
    ["2019-03-02T00:00:00.000Z", 12, "2026-05-01T00:00:00.000Z"], // past start -> from now
    ["2027-02-01T00:00:00.000Z", 12, "2026-05-01T00:00:00.000Z"], // future start kept
    ["2026-01-31T00:00:00.000Z", 1, "2026-01-31T00:00:00.000Z"], // month-end rollover
    ["2026-05-01T00:00:00.000Z", 6, "2026-05-01T00:00:00.000Z"],
  ];

  it("agrees with computeMembershipEnd on every input", () => {
    for (const [start, months, now] of cases) {
      expect(computeTermEnd(policy({ durationMonths: months }), start, now)).toBe(
        computeMembershipEnd(start, months, now)
      );
      expect(anniversaryTermEnd(start, months, now)).toBe(
        computeMembershipEnd(start, months, now)
      );
    }
  });

  it("throws the same RangeError on an unreadable start date", () => {
    expect(() => computeTermEnd(policy(), "not-a-date", "2026-05-01T00:00:00.000Z")).toThrow(
      RangeError
    );
    expect(() => computeTermEnd(policy(), "not-a-date", "2026-05-01T00:00:00.000Z")).toThrow(
      /is not a valid date/
    );
  });
});

describe("computeTermEnd — calendar year", () => {
  const cal = policy({ termMode: "calendar" });

  it("ends December 31 of the year the term runs into, whenever they joined", () => {
    const jan = computeTermEnd(cal, "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    const dec = computeTermEnd(cal, "2026-12-20T00:00:00.000Z", "2026-12-20T00:00:00.000Z");
    expect(day(jan)).toBe("2026-12-31");
    expect(day(dec)).toBe("2026-12-31");
    expect(jan).toBe(dec);
  });

  it("gives a start exactly on the anchor a full year, not a zero-length term", () => {
    expect(day(computeTermEnd(cal, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"))).toBe(
      "2026-12-31"
    );
  });

  it("ends at the last moment of December 31 so the day itself is still covered", () => {
    expect(computeTermEnd(cal, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z")).toBe(
      "2026-12-31T23:59:59.999Z"
    );
  });

  it("measures a historical start from today (the CSV-import rule)", () => {
    expect(day(computeTermEnd(cal, "2019-03-02T00:00:00.000Z", "2026-05-01T00:00:00.000Z"))).toBe(
      "2026-12-31"
    );
  });

  it("keeps a deliberately future start's own term", () => {
    expect(day(computeTermEnd(cal, "2027-02-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"))).toBe(
      "2027-12-31"
    );
  });
});

describe("computeTermEnd — fixed date", () => {
  const july = policy({ termMode: "fixed_date", termAnchor: "07-01" });

  it("ends the day before the next anchor", () => {
    expect(day(computeTermEnd(july, "2026-03-10T00:00:00.000Z", "2026-03-10T00:00:00.000Z"))).toBe(
      "2026-06-30"
    );
    expect(day(computeTermEnd(july, "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:00.000Z"))).toBe(
      "2027-06-30"
    );
  });

  it("gives a start exactly on the anchor a full term", () => {
    expect(day(computeTermEnd(july, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"))).toBe(
      "2027-06-30"
    );
  });

  it("treats a start later in the anchor day as still on the anchor", () => {
    expect(day(computeTermEnd(july, "2026-07-01T18:30:00.000Z", "2026-07-01T18:30:00.000Z"))).toBe(
      "2027-06-30"
    );
  });

  it("clamps a February 29 anchor to February 28 in a non-leap year", () => {
    const leapling = policy({ termMode: "fixed_date", termAnchor: "02-29" });
    // 2027 is not a leap year: the anchor lands on February 28, so the term
    // ends February 27.
    expect(
      day(computeTermEnd(leapling, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"))
    ).toBe("2027-02-27");
    // 2028 IS a leap year: the anchor is real, so the term ends February 28.
    expect(
      day(computeTermEnd(leapling, "2027-06-01T00:00:00.000Z", "2027-06-01T00:00:00.000Z"))
    ).toBe("2028-02-28");
  });
});

describe("prorateCents", () => {
  const half = policy({ termMode: "calendar", proration: "half_year" });
  const monthly = policy({ termMode: "calendar", proration: "monthly" });

  it("charges the full price when the level does not prorate", () => {
    expect(prorateCents(policy({ termMode: "calendar" }), 3500, "2026-10-01T00:00:00.000Z")).toBe(
      3500
    );
  });

  it("never prorates an anniversary level", () => {
    expect(
      prorateCents(
        readDuesPolicy({ term_mode: "anniversary", proration: "half_year", duration_months: 12 }),
        3500,
        "2026-10-01T00:00:00.000Z"
      )
    ).toBe(3500);
  });

  it("half_year charges full before the midpoint and ceil(price/2) from it on", () => {
    expect(prorateCents(half, 3500, "2026-01-03T00:00:00.000Z")).toBe(3500);
    expect(prorateCents(half, 3500, "2026-06-30T00:00:00.000Z")).toBe(3500);
    expect(prorateCents(half, 3500, "2026-07-01T00:00:00.000Z")).toBe(1750);
    expect(prorateCents(half, 3500, "2026-12-20T00:00:00.000Z")).toBe(1750);
  });

  it("half_year rounds a half cent up, never down", () => {
    expect(prorateCents(half, 3501, "2026-08-01T00:00:00.000Z")).toBe(1751);
    expect(prorateCents(half, 1, "2026-08-01T00:00:00.000Z")).toBe(1);
  });

  it("monthly charges for the months left in the year", () => {
    expect(prorateCents(monthly, 3500, "2026-01-01T00:00:00.000Z")).toBe(3500); // 12/12
    expect(prorateCents(monthly, 3500, "2026-10-15T00:00:00.000Z")).toBe(875); // 3/12
    expect(prorateCents(monthly, 3600, "2026-07-01T00:00:00.000Z")).toBe(1800); // 6/12
    expect(prorateCents(monthly, 3500, "2026-12-20T00:00:00.000Z")).toBe(292); // ceil(3500/12)
  });

  it("monthly counts from the anchor of a fixed-date year", () => {
    const julyMonthly = policy({
      termMode: "fixed_date",
      termAnchor: "07-01",
      proration: "monthly",
    });
    // Year runs July 1 -> June 30; joining October 1 leaves nine months.
    expect(prorateCents(julyMonthly, 3600, "2026-10-01T00:00:00.000Z")).toBe(2700);
  });

  it("stays inside [0, price] and returns whole cents", () => {
    for (const p of [half, monthly]) {
      for (const start of [
        "2026-01-01T00:00:00.000Z",
        "2026-06-30T23:59:59.999Z",
        "2026-12-31T23:59:59.999Z",
      ]) {
        const cents = prorateCents(p, 3500, start);
        expect(Number.isInteger(cents)).toBe(true);
        expect(cents).toBeGreaterThanOrEqual(0);
        expect(cents).toBeLessThanOrEqual(3500);
      }
    }
    expect(prorateCents(half, 0, "2026-08-01T00:00:00.000Z")).toBe(0);
  });
});

describe("describePolicy", () => {
  it("says what an anniversary year does", () => {
    expect(describePolicy(policy())).toBe(
      "The membership year starts the day someone joins and runs 12 months."
    );
    expect(describePolicy(policy({ durationMonths: 1 }))).toContain("runs 1 month.");
  });

  it("says what a calendar year does", () => {
    expect(describePolicy(policy({ termMode: "calendar" }))).toBe(
      "The membership year runs January 1 to December 31. Everyone pays the full price, whenever they join."
    );
  });

  it("names the anchor and the day before it for a fixed date", () => {
    expect(describePolicy(policy({ termMode: "fixed_date", termAnchor: "07-01" }))).toContain(
      "runs July 1 to June 30."
    );
  });

  it("names the midpoint date for half-year proration", () => {
    const text = describePolicy(policy({ termMode: "calendar", proration: "half_year" }));
    expect(text).toContain("July 1");
    expect(text).toContain("half");
    expect(text).toContain("Renewals always cost the full price.");
  });

  it("explains monthly proration without arithmetic", () => {
    const text = describePolicy(policy({ termMode: "calendar", proration: "monthly" }));
    expect(text).toContain("months left");
    expect(text).toContain("Renewals always cost the full price.");
  });

  it("mentions a grace period, with the right plural", () => {
    expect(describePolicy(policy({ termMode: "calendar", graceDays: 30 }))).toContain(
      "stay active for 30 days after they end."
    );
    expect(describePolicy(policy({ termMode: "calendar", graceDays: 1 }))).toContain(
      "stay active for 1 day after they end."
    );
    expect(describePolicy(policy({ termMode: "calendar" }))).not.toContain("stay active for");
  });
});

describe("lapseDate", () => {
  it("is the end date itself when there is no grace period", () => {
    expect(lapseDate(policy(), "2026-12-31T23:59:59.999Z")).toBe("2026-12-31T23:59:59.999Z");
  });

  it("adds the grace days", () => {
    expect(day(lapseDate(policy({ graceDays: 30 }), "2026-12-31T23:59:59.999Z"))).toBe(
      "2027-01-30"
    );
    expect(day(lapseDate(policy({ graceDays: 1 }), "2026-12-31T23:59:59.999Z"))).toBe("2027-01-01");
  });

  it("throws on an unreadable end date rather than inventing one", () => {
    expect(() => lapseDate(policy({ graceDays: 30 }), "someday")).toThrow(RangeError);
  });
});

// ——— the client mirror in public/admin.html ———
//
// The Levels editor shows describePolicy under the radio buttons as the
// officer clicks, so the sentence has to exist twice. Same guard as the
// money mirror: extract the block from the real file, evaluate it, and run
// both copies over one table.

const CLIENT_BLOCK_RE =
  /\/\* ——— DUES POLICY \(client mirror of src\/lib\/dues\.ts\) — begin ——— \*\/([\s\S]*?)\/\* ——— DUES POLICY — end ——— \*\//;

type ClientDues = {
  qhReadDuesPolicy: (level: Record<string, unknown>) => DuesPolicy;
  qhDescribePolicy: (p: DuesPolicy) => string;
};

function clientDues(): ClientDues {
  const m = CLIENT_BLOCK_RE.exec(ADMIN);
  if (!m) throw new Error("DUES POLICY client mirror block not found in public/admin.html");
  return new Function(`${m[1]}
    return { qhReadDuesPolicy, qhDescribePolicy };`)() as ClientDues;
}

const MIRROR_TABLE: DuesPolicy[] = [
  policy(),
  policy({ durationMonths: 6 }),
  policy({ termMode: "calendar" }),
  policy({ termMode: "calendar", proration: "half_year" }),
  policy({ termMode: "calendar", proration: "monthly", graceDays: 30 }),
  policy({ termMode: "fixed_date", termAnchor: "07-01" }),
  policy({ termMode: "fixed_date", termAnchor: "07-01", proration: "half_year", graceDays: 1 }),
  policy({ termMode: "fixed_date", termAnchor: "09-15", proration: "monthly" }),
  policy({ termMode: "fixed_date", termAnchor: "02-29" }),
];

describe("public/admin.html mirrors the dues policy sentence", () => {
  it("the block exists and stands alone (no admin globals)", () => {
    expect(() => clientDues()).not.toThrow();
  });

  it("describes every policy exactly as the server does", () => {
    const c = clientDues();
    for (const p of MIRROR_TABLE) {
      expect(c.qhDescribePolicy(p), JSON.stringify(p)).toBe(describePolicy(p));
    }
  });

  it("normalizes a level row exactly as the server does", () => {
    const c = clientDues();
    const rows: Record<string, unknown>[] = [
      { duration_months: 12 },
      { term_mode: "calendar", term_anchor: "07-01", duration_months: 12, proration: "half_year" },
      { term_mode: "fixed_date", duration_months: 12 },
      { term_mode: "fixed_date", term_anchor: "07-01", duration_months: 12, grace_days: 30 },
      { term_mode: "anniversary", proration: "monthly", duration_months: 12 },
      { term_mode: "nonsense", duration_months: 999, grace_days: -1 },
    ];
    for (const row of rows) {
      expect(c.qhReadDuesPolicy(row), JSON.stringify(row)).toEqual(readDuesPolicy(row as never));
    }
  });
});
