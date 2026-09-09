// src/lib/reports.ts
//
// Trend reporting: the month-window arithmetic, the aggregation SQL, and the
// monthly board-report job.
//
// Why this exists: exporting a CSV and opening it in a spreadsheet is the
// Wild Apricot answer to "how are we doing?" (GLMUpgrades.md C3). A volunteer
// treasurer should be able to answer that question from a screen, and the
// board should get the same numbers in an email once a month without anyone
// remembering to produce them.
//
// Two rules shape this file:
//
//  1. ONE round trip. D1 serialises statements issued from the same request,
//     so `Promise.all` over eight queries still pays eight network hops.
//     `summaryStatements` returns bound statements and `buildSummary` reads
//     the results positionally, so the route can hand the whole set to a
//     single `DB.batch(...)` (same discipline as src/lib/site/data.ts).
//  2. Reuse the SQL. The revenue-by-type, revenue-by-month, top-events and
//     members-by-status shapes are the ones src/routes/stats.ts already runs
//     for the dashboard and the annual statement, parameterised on a
//     half-open [from, to) date range instead of a calendar year, so the two
//     screens can never disagree about what a dollar is.
//
// `features.reports` lives in `settings.features` (Task A's src/lib/features.ts
// owns the catalog and the schema). That module does not exist yet, so
// `hasReportsFeature` below reads the same key with a small local reader; when
// features.ts lands, this can delegate to `hasFeature(settings, "reports")`
// with no change to callers.

import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import { sendEmail, boardReportEmail } from "./email";
import { formatMoney } from "./utils/money";

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** Windows the Reports screen offers; anything else falls back to the default. */
export const REPORT_MONTH_CHOICES = [6, 12, 24] as const;
export const DEFAULT_REPORT_MONTHS = 12;

/** How many months the monthly board report covers. */
export const BOARD_REPORT_MONTHS = 12;

/** Most rows the "top events" table returns (same cap as stats.ts /annual). */
export const TOP_EVENTS_LIMIT = 10;

export type ReportRange = {
  months: number;
  /** Ascending "YYYY-MM" keys; every series is aligned to this. */
  keys: string[];
  /** Inclusive lower bound, "YYYY-MM-DD". */
  from: string;
  /** Exclusive upper bound, "YYYY-MM-DD". */
  to: string;
};

/** `?months=` -> one of REPORT_MONTH_CHOICES, defaulting to 12. */
export function parseMonths(raw: string | null | undefined): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return DEFAULT_REPORT_MONTHS;
  const n = Number(raw.trim());
  return (REPORT_MONTH_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_REPORT_MONTHS;
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** Ascending "YYYY-MM" keys, `months` long, ending with the anchor's month. */
export function monthKeys(anchor: Date, months: number): string[] {
  const count = Math.max(1, Math.floor(months));
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth(); // 0-based
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - i, 1));
    keys.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`);
  }
  return keys;
}

/** The half-open [from, to) date range covering exactly those months. */
export function reportRange(anchor: Date, months: number): ReportRange {
  const keys = monthKeys(anchor, months);
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  return {
    months: keys.length,
    keys,
    from: keys[0] + "-01",
    to: `${end.getUTCFullYear()}-${pad2(end.getUTCMonth() + 1)}-01`,
  };
}

/** "2026-08" -> "August 2026", for email subjects and screen labels. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// Aggregation helpers (pure)
// ---------------------------------------------------------------------------

export type RevenueSource = "dues" | "events" | "store" | "donations" | "other";

/** payments.type (see PaymentType in src/types.ts) -> report bucket. */
export function revenueSource(type: string): RevenueSource {
  switch (type) {
    case "dues":
      return "dues";
    case "event":
      return "events";
    case "store":
      return "store";
    case "donation":
      return "donations";
    default:
      return "other";
  }
}

export const REVENUE_SOURCES: readonly RevenueSource[] = [
  "dues",
  "events",
  "store",
  "donations",
  "other",
];

/**
 * Turn `GROUP BY substr(<col>,1,7)` rows into a dense series aligned to
 * `keys`. Missing months are 0; rows outside the window are dropped; null and
 * non-finite values count as 0 so a sparkline never renders NaN.
 */
export function alignMonthly(
  keys: string[],
  rows: readonly Record<string, unknown>[],
  field: string
): number[] {
  const byMonth = new Map<string, number>();
  for (const row of rows || []) {
    const month = String(row.month ?? "");
    if (!month) continue;
    const raw = Number(row[field]);
    byMonth.set(month, Number.isFinite(raw) ? raw : 0);
  }
  return keys.map((k) => byMonth.get(k) ?? 0);
}

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Share of memberships that came up for renewal in the window and were in
 * fact renewed. `renewals` counts memberships created for a member who
 * already had one; `lapses` counts members who went to `lapsed` in the same
 * window. 0 when nothing came up (never NaN).
 */
export function renewalRate(renewals: number, lapses: number): number {
  const r = nonNegative(renewals);
  const l = nonNegative(lapses);
  const denom = r + l;
  return denom > 0 ? r / denom : 0;
}

/**
 * Share of the membership that lapsed during the window: lapses over the
 * members who could have lapsed (those still active plus those who did).
 */
export function churnRate(lapses: number, activeNow: number): number {
  const l = nonNegative(lapses);
  const a = nonNegative(activeNow);
  const denom = l + a;
  return denom > 0 ? l / denom : 0;
}

// ---------------------------------------------------------------------------
// Per-tenant settings
// ---------------------------------------------------------------------------

function parseSettings(settingsJson: string | null | undefined): Record<string, unknown> {
  if (!settingsJson) return {};
  try {
    const s = JSON.parse(settingsJson);
    return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** settings.reports — today just the monthly board-report opt-in. */
export function readReportSettings(settingsJson: string | null | undefined): { monthly: boolean } {
  const reports = parseSettings(settingsJson).reports;
  const monthly =
    reports && typeof reports === "object" && !Array.isArray(reports)
      ? (reports as Record<string, unknown>).monthly
      : undefined;
  return { monthly: monthly === true };
}

/**
 * settings.features.reports. Task A's src/lib/features.ts owns the catalog and
 * the defaults (every key false except `recipes`); until it exists this reads
 * the same key directly. Missing key = off.
 */
export function hasReportsFeature(settingsJson: string | null | undefined): boolean {
  const features = parseSettings(settingsJson).features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return false;
  return (features as Record<string, unknown>).reports === true;
}

// ---------------------------------------------------------------------------
// The one batched query set
// ---------------------------------------------------------------------------

export type TopEvent = { title: string; registrations: number };

export type ReportSummary = {
  months: string[];
  range: ReportRange;
  members: {
    total: number;
    active: number;
    new_by_month: number[];
    lapsed_by_month: number[];
    new_total: number;
    lapsed_total: number;
  };
  renewal_rate: number;
  churn_rate: number;
  renewals: number;
  revenue: {
    by_month: number[];
    by_source: Record<RevenueSource, number>;
    total_cents: number;
    payments: number;
  };
  events: {
    attendance_by_month: number[];
    registrations: number;
    top: TopEvent[];
  };
  monthly_email: boolean;
  generated_at: string;
};

/**
 * The eight statements behind a summary, bound and ready for `DB.batch(...)`.
 * Order matters: buildSummary reads the results positionally.
 *
 * Reused from src/routes/stats.ts: the members-by-status roll-up (dashboard),
 * revenue by month and by type and the top-events join (GET /stats/annual),
 * the `status IN ('registered','checked_in')` registration filter (both).
 * New here: new/lapsed members bucketed by month, registrations bucketed by
 * month, and the renewal count.
 */
export function summaryStatements(
  db: D1Database,
  tenantId: string,
  range: ReportRange
): D1PreparedStatement[] {
  const { from, to } = range;
  return [
    // 0. members by status (stats.ts dashboard)
    db
      .prepare("SELECT status, COUNT(*) cnt FROM members WHERE tenant_id = ? GROUP BY status")
      .bind(tenantId),
    // 1. new members by month
    db
      .prepare(
        `SELECT substr(created_at, 1, 7) month, COUNT(*) cnt
         FROM members
         WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
         GROUP BY month ORDER BY month`
      )
      .bind(tenantId, from, to),
    // 2. lapsed members by month (stats.ts /annual `lapsed`, bucketed)
    db
      .prepare(
        `SELECT substr(updated_at, 1, 7) month, COUNT(*) cnt
         FROM members
         WHERE tenant_id = ? AND status = 'lapsed'
           AND updated_at >= ? AND updated_at < ?
         GROUP BY month ORDER BY month`
      )
      .bind(tenantId, from, to),
    // 3. revenue by month (stats.ts /annual by_month + the dashboard's count)
    db
      .prepare(
        `SELECT substr(created_at, 1, 7) month,
                SUM(amount_cents) total_cents,
                COUNT(*) payments
         FROM payments
         WHERE tenant_id = ? AND status = 'succeeded'
           AND created_at >= ? AND created_at < ?
         GROUP BY month ORDER BY month`
      )
      .bind(tenantId, from, to),
    // 4. revenue by category (stats.ts /annual by_type, verbatim shape)
    db
      .prepare(
        `SELECT type, SUM(amount_cents) total_cents, COUNT(*) payments
         FROM payments
         WHERE tenant_id = ? AND status = 'succeeded'
           AND created_at >= ? AND created_at < ?
         GROUP BY type ORDER BY total_cents DESC`
      )
      .bind(tenantId, from, to),
    // 5. event attendance by month
    db
      .prepare(
        `SELECT substr(created_at, 1, 7) month, COUNT(*) cnt
         FROM event_registrations
         WHERE tenant_id = ? AND status IN ('registered','checked_in')
           AND created_at >= ? AND created_at < ?
         GROUP BY month ORDER BY month`
      )
      .bind(tenantId, from, to),
    // 6. top events (stats.ts /annual topEvents)
    db
      .prepare(
        `SELECT e.title, COUNT(r.id) registrations
         FROM events e LEFT JOIN event_registrations r
           ON r.event_id = e.id AND r.status IN ('registered','checked_in')
         WHERE e.tenant_id = ? AND e.start_at >= ? AND e.start_at < ?
         GROUP BY e.id ORDER BY registrations DESC LIMIT ${TOP_EVENTS_LIMIT}`
      )
      .bind(tenantId, from, to),
    // 7. renewals: a membership created in the window for a member who
    //    already had one. New joins are excluded by the EXISTS clause.
    db
      .prepare(
        `SELECT COUNT(*) cnt FROM memberships m
         WHERE m.tenant_id = ? AND m.created_at >= ? AND m.created_at < ?
           AND EXISTS (
             SELECT 1 FROM memberships p
             WHERE p.tenant_id = m.tenant_id AND p.member_id = m.member_id
               AND p.created_at < m.created_at
           )`
      )
      .bind(tenantId, from, to),
  ];
}

function rowsOf<T>(result: D1Result<unknown> | undefined): T[] {
  return ((result?.results as T[] | undefined) || []) as T[];
}

/** Assemble the JSON contract from the positional results of summaryStatements. */
export function buildSummary(
  results: D1Result<unknown>[],
  range: ReportRange,
  opts: { monthlyEmail: boolean; now?: Date }
): ReportSummary {
  const keys = range.keys;

  const byStatus = rowsOf<{ status: string; cnt: number }>(results[0]);
  const statusMap: Record<string, number> = {};
  for (const r of byStatus) statusMap[r.status] = Number(r.cnt) || 0;
  const total = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const active = statusMap.active || 0;

  const newByMonth = alignMonthly(keys, rowsOf(results[1]), "cnt");
  const lapsedByMonth = alignMonthly(keys, rowsOf(results[2]), "cnt");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const revenueRows = rowsOf<{ month: string; total_cents: number; payments: number }>(results[3]);
  const revenueByMonth = alignMonthly(keys, revenueRows, "total_cents");
  const paymentsCount = sum(alignMonthly(keys, revenueRows, "payments"));

  const bySource = {
    dues: 0,
    events: 0,
    store: 0,
    donations: 0,
    other: 0,
  } as Record<RevenueSource, number>;
  for (const row of rowsOf<{ type: string; total_cents: number }>(results[4])) {
    bySource[revenueSource(String(row.type))] += Number(row.total_cents) || 0;
  }

  const attendanceByMonth = alignMonthly(keys, rowsOf(results[5]), "cnt");
  const top = rowsOf<{ title: string; registrations: number }>(results[6]).map((r) => ({
    title: String(r.title ?? ""),
    registrations: Number(r.registrations) || 0,
  }));
  const renewals = Number(rowsOf<{ cnt: number }>(results[7])[0]?.cnt) || 0;

  const lapsedTotal = sum(lapsedByMonth);
  return {
    months: keys,
    range,
    members: {
      total,
      active,
      new_by_month: newByMonth,
      lapsed_by_month: lapsedByMonth,
      new_total: sum(newByMonth),
      lapsed_total: lapsedTotal,
    },
    renewal_rate: renewalRate(renewals, lapsedTotal),
    churn_rate: churnRate(lapsedTotal, active),
    renewals,
    revenue: {
      by_month: revenueByMonth,
      by_source: bySource,
      total_cents: sum(revenueByMonth),
      payments: paymentsCount,
    },
    events: {
      attendance_by_month: attendanceByMonth,
      registrations: sum(attendanceByMonth),
      top,
    },
    monthly_email: opts.monthlyEmail,
    generated_at: (opts.now ?? new Date()).toISOString(),
  };
}

/** One `DB.batch(...)` round trip for the whole summary. */
export async function loadReportSummary(
  db: D1Database,
  tenantId: string,
  range: ReportRange,
  opts: { monthlyEmail: boolean; now?: Date }
): Promise<ReportSummary> {
  const results = await db.batch(summaryStatements(db, tenantId, range));
  return buildSummary(results as D1Result<unknown>[], range, opts);
}

// ---------------------------------------------------------------------------
// Monthly board report
// ---------------------------------------------------------------------------

export type BoardReportJobResult = {
  /** False when the job was a no-op because today is not the 1st. */
  ran: boolean;
  tenants_considered: number;
  tenants_sent: number;
  emails_sent: number;
  errors: string[];
};

type BoardTenantRow = {
  id: string;
  name: string;
  slug: string;
  settings_json: string | null;
};

/** Percent, rounded to whole numbers, for the email body. */
function pct(rate: number): string {
  return `${Math.round((Number.isFinite(rate) ? rate : 0) * 100)}%`;
}

/**
 * Send each opted-in guild's board a one-page summary of the last twelve
 * months, on the first of the month.
 *
 * Gates, all of which must pass: today is the 1st; `settings.features.reports`
 * is on; `settings.reports.monthly` is true. Recipients are every owner/admin
 * in `tenant_users`. Idempotent per tenant + recipient + month via an
 * `email_logs` row keyed `board_report_YYYY-MM` (same idiom as the renewal
 * series in src/lib/renewals.ts), so a re-run of the daily cron cannot
 * double-send.
 *
 * Never throws: the whole body is guarded and every tenant is guarded again
 * inside the loop, so one guild with a broken settings blob or a provider
 * error cannot abort the daily job for everyone else.
 */
export async function runMonthlyBoardReports(
  env: Env,
  opts: { now?: Date } = {}
): Promise<BoardReportJobResult> {
  const result: BoardReportJobResult = {
    ran: false,
    tenants_considered: 0,
    tenants_sent: 0,
    emails_sent: 0,
    errors: [],
  };
  const now = opts.now ?? new Date();
  if (now.getUTCDate() !== 1) return result;
  result.ran = true;

  // The report covers the twelve months ending with the month that just
  // finished — on the 1st, the current month has no data worth reporting.
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const range = reportRange(anchor, BOARD_REPORT_MONTHS);
  const lastMonth = range.keys[range.keys.length - 1];
  const template = `board_report_${lastMonth}`;
  const appUrl = (env.APP_URL || "https://quilthosting.com").replace(/\/$/, "");

  let tenants: BoardTenantRow[] = [];
  try {
    tenants = await all<BoardTenantRow>(
      env.DB.prepare(
        `SELECT id, name, slug, settings_json FROM tenants WHERE status = 'active'`
      )
    );
  } catch (e) {
    result.errors.push(`tenant list: ${String(e)}`);
    return result;
  }

  for (const tenant of tenants) {
    try {
      if (!hasReportsFeature(tenant.settings_json)) continue;
      if (!readReportSettings(tenant.settings_json).monthly) continue;
      result.tenants_considered++;

      const recipients = await all<{ email: string }>(
        env.DB.prepare(
          `SELECT u.email FROM tenant_users tu
           JOIN users u ON u.id = tu.user_id
           WHERE tu.tenant_id = ? AND tu.role IN ('owner', 'admin')
             AND u.email IS NOT NULL AND u.email <> ''`
        ).bind(tenant.id)
      );
      if (!recipients.length) continue;

      const already = await first(
        env.DB.prepare(
          `SELECT id FROM email_logs WHERE tenant_id = ? AND template = ? LIMIT 1`
        ).bind(tenant.id, template)
      );
      if (already) continue;

      const summary = await loadReportSummary(env.DB, tenant.id, range, {
        monthlyEmail: true,
        now,
      });
      const lastIndex = summary.months.length - 1;
      const { subject, html } = boardReportEmail({
        guildName: tenant.name,
        monthLabel: monthLabel(lastMonth),
        windowLabel: `${monthLabel(summary.months[0])} – ${monthLabel(lastMonth)}`,
        adminUrl: `${appUrl}/admin`,
        members: {
          total: summary.members.total,
          active: summary.members.active,
          joinedThisMonth: summary.members.new_by_month[lastIndex] ?? 0,
          lapsedThisMonth: summary.members.lapsed_by_month[lastIndex] ?? 0,
          joinedInWindow: summary.members.new_total,
          lapsedInWindow: summary.members.lapsed_total,
        },
        renewalRate: pct(summary.renewal_rate),
        churnRate: pct(summary.churn_rate),
        revenue: {
          monthFormatted: formatMoney(summary.revenue.by_month[lastIndex] ?? 0),
          windowFormatted: formatMoney(summary.revenue.total_cents),
          bySource: REVENUE_SOURCES.filter((s) => summary.revenue.by_source[s] > 0).map((s) => ({
            label: s === "other" ? "Other" : s[0].toUpperCase() + s.slice(1),
            amount: formatMoney(summary.revenue.by_source[s]),
          })),
        },
        events: {
          registrationsThisMonth: summary.events.attendance_by_month[lastIndex] ?? 0,
          registrationsInWindow: summary.events.registrations,
          top: summary.events.top.slice(0, 5),
        },
      });

      let sentForTenant = 0;
      for (const rec of recipients) {
        const send = await sendEmail(env, {
          to: rec.email,
          subject,
          html,
          kind: "transactional",
          tenantId: tenant.id,
          guildName: tenant.name,
          tags: [
            { name: "template", value: template },
            { name: "tenant", value: tenant.slug },
          ],
        });
        try {
          await env.DB.prepare(
            `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              generateId(),
              tenant.id,
              null,
              rec.email,
              template,
              send.id || null,
              send.success ? "sent" : "failed",
              new Date().toISOString()
            )
            .run();
        } catch (e) {
          console.warn("board report email_logs insert failed", e);
        }
        if (send.success) {
          sentForTenant++;
          result.emails_sent++;
        } else {
          result.errors.push(`board report ${tenant.slug} ${rec.email}: ${send.error}`);
        }
      }
      if (sentForTenant) result.tenants_sent++;
    } catch (e) {
      // One guild's failure must never abort the daily job.
      result.errors.push(`board report tenant ${tenant.id}: ${String(e)}`);
    }
  }

  return result;
}
