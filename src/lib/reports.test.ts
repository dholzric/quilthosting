// src/lib/reports.test.ts
// Aggregation math for the trends report and the monthly board-report job.
// Pure unit tests: the month arithmetic, the rate formulas and the
// row -> series alignment are exercised on fixed rows, and the job runs
// against a keyword-routed fake D1 with a stubbed provider call (same idiom
// as renewals.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../types";

const email = vi.hoisted(() => ({
  sendEmail: vi.fn(
    async (_env: unknown, _params: unknown): Promise<Record<string, unknown>> => ({
      id: "msg",
      success: true,
    })
  ),
}));
vi.mock("./email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email")>()),
  sendEmail: email.sendEmail,
}));

import {
  REPORT_MONTH_CHOICES,
  DEFAULT_REPORT_MONTHS,
  parseMonths,
  monthKeys,
  reportRange,
  revenueSource,
  alignMonthly,
  renewalRate,
  churnRate,
  readReportSettings,
  hasReportsFeature,
  summaryStatements,
  buildSummary,
  runMonthlyBoardReports,
} from "./reports";

describe("parseMonths", () => {
  it("defaults to 12 and only accepts the offered windows", () => {
    expect(DEFAULT_REPORT_MONTHS).toBe(12);
    expect(REPORT_MONTH_CHOICES).toEqual([6, 12, 24]);
    expect(parseMonths(undefined)).toBe(12);
    expect(parseMonths(null)).toBe(12);
    expect(parseMonths("")).toBe(12);
    expect(parseMonths("6")).toBe(6);
    expect(parseMonths("24")).toBe(24);
  });

  it("falls back to the default for junk and out-of-range values", () => {
    for (const junk of ["abc", "0", "-6", "13", "999", "6.5", "1e3"]) {
      expect(parseMonths(junk), junk).toBe(12);
    }
  });
});

describe("monthKeys / reportRange", () => {
  it("returns ascending YYYY-MM keys ending with the anchor month", () => {
    const keys = monthKeys(new Date("2026-09-08T12:00:00Z"), 6);
    expect(keys).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  });

  it("crosses the year boundary correctly", () => {
    const keys = monthKeys(new Date("2026-02-15T00:00:00Z"), 4);
    expect(keys).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("builds a half-open [from, to) range covering exactly those months", () => {
    const r = reportRange(new Date("2026-09-08T12:00:00Z"), 12);
    expect(r.months).toBe(12);
    expect(r.keys).toHaveLength(12);
    expect(r.keys[0]).toBe("2025-10");
    expect(r.keys[11]).toBe("2026-09");
    expect(r.from).toBe("2025-10-01");
    expect(r.to).toBe("2026-10-01");
  });
});

describe("revenueSource", () => {
  it("maps the four payment types onto report buckets", () => {
    expect(revenueSource("dues")).toBe("dues");
    expect(revenueSource("event")).toBe("events");
    expect(revenueSource("store")).toBe("store");
    expect(revenueSource("donation")).toBe("donations");
  });

  it("puts anything else in `other`", () => {
    expect(revenueSource("invoice")).toBe("other");
    expect(revenueSource("")).toBe("other");
    expect(revenueSource("DUES")).toBe("other");
  });
});

describe("alignMonthly", () => {
  const keys = ["2026-01", "2026-02", "2026-03"];

  it("fills missing months with zero and keeps order", () => {
    const rows = [
      { month: "2026-03", cnt: 5 },
      { month: "2026-01", cnt: 2 },
    ];
    expect(alignMonthly(keys, rows, "cnt")).toEqual([2, 0, 5]);
  });

  it("ignores rows outside the window and coerces nulls to 0", () => {
    const rows = [
      { month: "2025-12", cnt: 99 },
      { month: "2026-02", cnt: null },
    ];
    expect(alignMonthly(keys, rows, "cnt")).toEqual([0, 0, 0]);
  });

  it("returns all zeros for no rows", () => {
    expect(alignMonthly(keys, [], "cnt")).toEqual([0, 0, 0]);
  });
});

describe("renewalRate / churnRate", () => {
  it("renewal rate is renewals over renewals + lapses", () => {
    expect(renewalRate(9, 1)).toBeCloseTo(0.9, 6);
    expect(renewalRate(0, 4)).toBe(0);
    expect(renewalRate(4, 0)).toBe(1);
  });

  it("churn rate is lapses over the members who could have lapsed", () => {
    expect(churnRate(2, 18)).toBeCloseTo(0.1, 6);
    expect(churnRate(0, 30)).toBe(0);
  });

  it("returns 0 rather than NaN when there is nothing to divide", () => {
    expect(renewalRate(0, 0)).toBe(0);
    expect(churnRate(0, 0)).toBe(0);
    expect(renewalRate(-1, -1)).toBe(0);
    expect(churnRate(-1, -1)).toBe(0);
  });
});

describe("settings readers", () => {
  it("reads settings.reports.monthly, defaulting to off", () => {
    expect(readReportSettings(null).monthly).toBe(false);
    expect(readReportSettings("{}").monthly).toBe(false);
    expect(readReportSettings("not json").monthly).toBe(false);
    expect(readReportSettings('{"reports":{"monthly":true}}').monthly).toBe(true);
    expect(readReportSettings('{"reports":{"monthly":"yes"}}').monthly).toBe(false);
    expect(readReportSettings('{"reports":42}').monthly).toBe(false);
  });

  it("never gates the Reports screen — it existed before the switch", () => {
    expect(hasReportsFeature(null)).toBe(true);
    expect(hasReportsFeature("{}")).toBe(true);
    expect(hasReportsFeature('{"features":{}}')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// summaryStatements / buildSummary
// ---------------------------------------------------------------------------

function fakeStatementDb() {
  const seen: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          seen.push({ sql, binds });
          return { sql, binds };
        },
      };
    },
  } as unknown as D1Database;
  return { db, seen };
}

const RANGE = reportRange(new Date("2026-09-08T00:00:00Z"), 6);

describe("summaryStatements", () => {
  it("prepares one bound statement per series, all scoped to the tenant and range", () => {
    const { db, seen } = fakeStatementDb();
    const stmts = summaryStatements(db, "t1", RANGE);
    expect(stmts).toHaveLength(seen.length);
    expect(stmts.length).toBeGreaterThanOrEqual(8);
    for (const s of seen) {
      expect(s.binds[0]).toBe("t1");
      expect(s.sql).toContain("tenant_id = ?");
    }
    // Every windowed statement carries the half-open range.
    const windowed = seen.filter((s) => s.binds.length > 1);
    for (const s of windowed) {
      expect(s.binds).toContain(RANGE.from);
      expect(s.binds).toContain(RANGE.to);
    }
  });

  it("reuses the stats.ts revenue-by-type and top-events shapes", () => {
    const { seen } = (() => {
      const f = fakeStatementDb();
      summaryStatements(f.db, "t1", RANGE);
      return f;
    })();
    const sql = seen.map((s) => s.sql).join("\n---\n");
    expect(sql).toContain("SUM(amount_cents)");
    expect(sql).toContain("status = 'succeeded'");
    expect(sql).toContain("status IN ('registered','checked_in')");
    expect(sql).toContain("GROUP BY e.id ORDER BY registrations DESC");
  });
});

function r<T>(results: T[]) {
  return { results, success: true, meta: {} } as unknown as D1Result<T>;
}

describe("buildSummary", () => {
  const range = reportRange(new Date("2026-03-15T00:00:00Z"), 3); // 2026-01..2026-03
  const results = [
    r([
      { status: "active", cnt: 40 },
      { status: "lapsed", cnt: 6 },
      { status: "pending", cnt: 2 },
    ]),
    r([
      { month: "2026-01", cnt: 3 },
      { month: "2026-03", cnt: 5 },
    ]),
    r([{ month: "2026-02", cnt: 2 }]),
    r([
      { month: "2026-01", total_cents: 10000, payments: 4 },
      { month: "2026-03", total_cents: 25000, payments: 9 },
    ]),
    r([
      { type: "dues", total_cents: 30000, payments: 10 },
      { type: "event", total_cents: 4000, payments: 2 },
      { type: "mystery", total_cents: 1000, payments: 1 },
    ]),
    r([{ month: "2026-02", cnt: 12 }]),
    r([
      { title: "Retreat", registrations: 12 },
      { title: "Sew day", registrations: 4 },
    ]),
    r([{ cnt: 8 }]),
  ];

  it("returns the documented contract", () => {
    const s = buildSummary(results as D1Result<any>[], range, { monthlyEmail: true });
    expect(s.months).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(s.members.total).toBe(48);
    expect(s.members.active).toBe(40);
    expect(s.members.new_by_month).toEqual([3, 0, 5]);
    expect(s.members.lapsed_by_month).toEqual([0, 2, 0]);
    expect(s.revenue.by_month).toEqual([10000, 0, 25000]);
    expect(s.revenue.by_source).toEqual({
      dues: 30000,
      events: 4000,
      store: 0,
      donations: 0,
      other: 1000,
    });
    expect(s.events.attendance_by_month).toEqual([0, 12, 0]);
    expect(s.events.top).toEqual([
      { title: "Retreat", registrations: 12 },
      { title: "Sew day", registrations: 4 },
    ]);
    expect(s.monthly_email).toBe(true);
  });

  it("computes the rates from the same rows", () => {
    const s = buildSummary(results as D1Result<any>[], range, { monthlyEmail: false });
    // 8 renewals, 2 lapses in the window
    expect(s.renewal_rate).toBeCloseTo(8 / 10, 6);
    // 2 lapses against 40 still-active members
    expect(s.churn_rate).toBeCloseTo(2 / 42, 6);
    expect(s.monthly_email).toBe(false);
  });

  it("survives an entirely empty tenant", () => {
    const empty = [r([]), r([]), r([]), r([]), r([]), r([]), r([]), r([])] as D1Result<any>[];
    const s = buildSummary(empty, range, { monthlyEmail: false });
    expect(s.members).toMatchObject({ total: 0, active: 0 });
    expect(s.members.new_by_month).toEqual([0, 0, 0]);
    expect(s.revenue.by_month).toEqual([0, 0, 0]);
    expect(s.revenue.total_cents).toBe(0);
    expect(s.renewal_rate).toBe(0);
    expect(s.churn_rate).toBe(0);
    expect(s.events.top).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runMonthlyBoardReports
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function jobDb(state: {
  tenants: Row[];
  staff?: Record<string, Row[]>;
  logs?: Row[];
  throwFor?: string;
}) {
  const logs = state.logs ?? [];
  const staff = state.staff ?? {};
  const inserted: Row[] = [];
  const db = {
    prepare(sql: string) {
      const run = (binds: unknown[]) => ({
        async first() {
          if (sql.includes("FROM email_logs")) {
            const [tenantId, template] = binds as string[];
            return logs.find((l) => l.tenant_id === tenantId && l.template === template) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM tenants")) return { results: state.tenants };
          if (sql.includes("FROM tenant_users")) {
            const tenantId = binds[0] as string;
            if (state.throwFor && tenantId === state.throwFor) {
              throw new Error("boom");
            }
            return { results: staff[tenantId] ?? [] };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO email_logs")) {
            const row = {
              tenant_id: binds[1],
              template: binds[4],
              to_email: binds[3],
            };
            logs.push(row);
            inserted.push(row);
          }
          return { success: true, meta: {} };
        },
      });
      return {
        bind: (...binds: unknown[]) => run(binds),
        ...run([]),
      };
    },
    async batch(stmts: any[]) {
      // Every summary statement resolves to an empty result set; the math is
      // covered by buildSummary's own tests.
      return stmts.map(() => ({ results: [], success: true, meta: {} }));
    },
  } as unknown as D1Database;
  return { db, inserted, logs };
}

function env(db: D1Database): Env {
  return {
    DB: db,
    APP_URL: "https://quilthosting.com",
    RESEND_API_KEY: "re_test",
  } as unknown as Env;
}

const ON = JSON.stringify({ features: { reports: true }, reports: { monthly: true } });
const FIRST = new Date("2026-09-01T08:00:00Z");

beforeEach(() => {
  email.sendEmail.mockClear();
  email.sendEmail.mockResolvedValue({ id: "msg", success: true });
});

describe("runMonthlyBoardReports", () => {
  it("does nothing on any day but the first of the month", async () => {
    const { db } = jobDb({
      tenants: [{ id: "t1", name: "Prairie Star", slug: "prairie", settings_json: ON }],
      staff: { t1: [{ email: "chair@example.test", role: "owner" }] },
    });
    const res = await runMonthlyBoardReports(env(db), { now: new Date("2026-09-08T08:00:00Z") });
    expect(res.ran).toBe(false);
    expect(res.emails_sent).toBe(0);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("emails every owner/admin when the feature and the toggle are both on", async () => {
    const { db, inserted } = jobDb({
      tenants: [{ id: "t1", name: "Prairie Star", slug: "prairie", settings_json: ON }],
      staff: {
        t1: [
          { email: "owner@example.test", role: "owner" },
          { email: "admin@example.test", role: "admin" },
        ],
      },
    });
    const res = await runMonthlyBoardReports(env(db), { now: FIRST });
    expect(res.ran).toBe(true);
    expect(res.emails_sent).toBe(2);
    expect(res.tenants_sent).toBe(1);
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    const params = email.sendEmail.mock.calls[0][1] as any;
    expect(params.to).toBe("owner@example.test");
    expect(params.kind).toBe("transactional");
    expect(params.tenantId).toBe("t1");
    // Board report covers the month that just ended.
    expect(params.subject).toContain("August 2026");
    expect(params.subject).toContain("Prairie Star");
    expect(params.html).toContain("Prairie Star");
    expect(params.html).not.toContain("attachment");
    expect(inserted).toHaveLength(2);
    expect(inserted[0].template).toBe("board_report_2026-08");
  });

  it("sends nothing when the monthly toggle is off", async () => {
    const { db } = jobDb({
      tenants: [
        {
          id: "t1",
          name: "Prairie Star",
          slug: "prairie",
          settings_json: JSON.stringify({ reports: { monthly: false } }),
        },
      ],
      staff: { t1: [{ email: "owner@example.test", role: "owner" }] },
    });
    const res = await runMonthlyBoardReports(env(db), { now: FIRST });
    expect(res.ran).toBe(true);
    expect(res.emails_sent).toBe(0);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when the monthly toggle is off", async () => {
    const { db } = jobDb({
      tenants: [
        {
          id: "t1",
          name: "Prairie Star",
          slug: "prairie",
          settings_json: JSON.stringify({ features: { reports: true } }),
        },
      ],
      staff: { t1: [{ email: "owner@example.test", role: "owner" }] },
    });
    const res = await runMonthlyBoardReports(env(db), { now: FIRST });
    expect(res.emails_sent).toBe(0);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("does not send twice for the same month", async () => {
    const { db } = jobDb({
      tenants: [{ id: "t1", name: "Prairie Star", slug: "prairie", settings_json: ON }],
      staff: { t1: [{ email: "owner@example.test", role: "owner" }] },
      logs: [{ tenant_id: "t1", template: "board_report_2026-08", to_email: "owner@example.test" }],
    });
    const res = await runMonthlyBoardReports(env(db), { now: FIRST });
    expect(res.emails_sent).toBe(0);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("one broken tenant never aborts the run", async () => {
    const { db } = jobDb({
      tenants: [
        { id: "bad", name: "Broken", slug: "broken", settings_json: ON },
        { id: "t2", name: "Nine Patch", slug: "ninepatch", settings_json: ON },
      ],
      staff: { t2: [{ email: "owner2@example.test", role: "owner" }] },
      throwFor: "bad",
    });
    const res = await runMonthlyBoardReports(env(db), { now: FIRST });
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain("bad");
    expect(res.emails_sent).toBe(1);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("records a failed provider send without throwing", async () => {
    email.sendEmail.mockResolvedValue({ id: "", success: false, error: "nope" });
    const { db, logs } = jobDb({
      tenants: [{ id: "t1", name: "Prairie Star", slug: "prairie", settings_json: ON }],
      staff: { t1: [{ email: "owner@example.test", role: "owner" }] },
    });
    const res = await runMonthlyBoardReports(env(db), { now: FIRST });
    expect(res.emails_sent).toBe(0);
    expect(res.errors.length).toBe(1);
    expect(logs.some((l) => l.template === "board_report_2026-08")).toBe(true);
  });

  it("never throws even if the tenant query explodes", async () => {
    const broken = {
      prepare() {
        throw new Error("no DB");
      },
    } as unknown as D1Database;
    const res = await runMonthlyBoardReports(env(broken), { now: FIRST });
    expect(res.emails_sent).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
