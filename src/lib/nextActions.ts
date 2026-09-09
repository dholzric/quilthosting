/**
 * "What should I do next?" — the dashboard's primary content.
 *
 * The onboarding checklist (src/lib/onboarding.ts) answers "is my guild set
 * up?" once. This answers a different question every week: of everything that
 * is true about this guild right now, what are the three things most worth a
 * volunteer's next ten minutes?
 *
 * Same idiom as computeOnboarding: nothing is stored. Every card is derived
 * from real rows at request time through ONE batched query set, so the advice
 * can never drift out of date and there is no state to migrate.
 *
 * Ranking, in bands:
 *   10-19  money and delivery are broken — dues cannot arrive, or email did
 *          not reach people. These come first, always.
 *   20-29  the public site looks unfinished — visitors can see it.
 *   30-39  growth and upkeep — worth doing, safe to skip today.
 *   90     nothing to do: one short card naming what is healthy.
 *
 * At most three cards come back, and the celebration is never mixed in with
 * work. Copy is deliberately in volunteer language.
 */

import type { Tenant } from "../types";
import { SAMPLE_MARKER } from "./starterSite";
import { isBusiness } from "./tenantType";
import { activeMemberLimitForTenant } from "./plans";
import { activeMembershipFilter } from "./households";
import { stripControlChars } from "./sanitize";

export type NextActionSeverity = "do" | "consider" | "celebrate";

export type NextAction = {
  /** Stable snake_case key; used by the admin for test hooks, never shown. */
  id: string;
  title: string;
  body: string;
  /** One button. `href` is "#<admin page>", the same form onboarding uses. */
  cta: { label: string; href: string };
  severity: NextActionSeverity;
};

/** Tenant row plus the onboarding columns; identical shape to OnboardingTenant. */
export type NextActionsTenant = Tenant & {
  domain_status?: string | null;
  domain_error?: string | null;
  onboarding_json?: string | null;
};

/** Everything the cards are computed from. Pure input, so ranking is testable. */
export type NextActionSignals = {
  /** Pages still carrying the starter-kit sample wording. */
  samplePages: number;
  levelCount: number;
  paidLevelCount: number;
  /** Events starting within the next 60 days. */
  eventsNext60: number;
  activeMembers: number;
  /** Active members bulk email must skip (opted out, bounced, complained). */
  membersWithoutConsent: number;
  /** Memberships ending within 30 days — reminders are already going out. */
  renewalsDue30: number;
  /** Earliest end date still in the future, ISO, or null. */
  soonestRenewalEnd: string | null;
  failedBlast: { id: string; subject: string; errorCount: number } | null;
  now: Date;
};

export const MAX_NEXT_ACTIONS = 3;

/** Reminders start this many days before a membership ends (src/lib/renewals.ts). */
const FIRST_REMINDER_DAYS = 30;
/** How far ahead the "reminders start soon" card looks. */
const REMINDER_HEADS_UP_DAYS = 21;
/** How close to the free cap counts as "nearly full". */
const CAP_WARNING_SLACK = 3;
const EVENT_HORIZON_DAYS = 60;
const DAY_MS = 86400000;

type RankedAction = NextAction & { rank: number };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "October 20" — or "October 20, 2027" when it is not the current year. */
function humanDate(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? base : `${base}, ${d.getUTCFullYear()}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Officer-written text (an email subject) shown back to them — never markup. */
function safeText(s: string, max = 80): string {
  const clean = stripControlChars(String(s || "")).trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The whole catalogue, ranked. Pure: give it signals and a tenant row and it
 * tells you what to show. Exported so the ranking rules can be tested without
 * a database.
 */
export function buildNextActions(
  signals: NextActionSignals,
  tenant: NextActionsTenant
): NextAction[] {
  const business = isBusiness(tenant);
  const org = business ? "business" : "guild";
  const people = business ? "customers" : "members";
  const sitePage = business ? "#site-pages" : "#pages";
  const cards: RankedAction[] = [];

  // --- Band 1: money and delivery ------------------------------------------

  // A guild with no level has nowhere for anyone to join. Businesses sell
  // products and services instead, so this never applies to them.
  if (!business && signals.levelCount === 0) {
    cards.push({
      rank: 10,
      id: "add_level",
      severity: "do",
      title: "Add a membership level",
      body:
        "Nobody can join yet, because there is nothing to join. One level is enough to start — " +
        "for example, Individual at $35 a year. It takes about a minute and you can change it later.",
      cta: { label: "Add a level", href: "#levels" },
    });
  }

  if (signals.paidLevelCount > 0 && !tenant.stripe_account_id) {
    cards.push({
      rank: 11,
      id: "connect_payouts",
      severity: "do",
      title: "Connect your bank account so dues can be paid",
      body:
        `You charge for membership, but there is nowhere for the money to land yet. ` +
        `Connecting takes a few minutes, and payments go straight to your ${org}'s own bank account.`,
      cta: { label: "Connect payouts", href: "#settings" },
    });
  }

  if (signals.failedBlast && signals.failedBlast.errorCount > 0) {
    const n = signals.failedBlast.errorCount;
    cards.push({
      rank: 12,
      id: "email_failures",
      severity: "do",
      title: `${plural(n, "person", "people")} did not get your last email`,
      body:
        `"${safeText(signals.failedBlast.subject)}" reached most of your list, but ` +
        `${n === 1 ? "one address" : `${n} addresses`} failed. ` +
        "You can send it again to just those people — nobody gets it twice.",
      cta: { label: "Review that email", href: "#comms" },
    });
  }

  const memberLimit = activeMemberLimitForTenant(tenant);
  if (memberLimit != null) {
    const room = memberLimit - signals.activeMembers;
    if (room <= 0) {
      cards.push({
        rank: 13,
        id: "member_cap",
        severity: "do",
        title: `You have filled all ${memberLimit} free member slots`,
        body:
          `New people can still be added and their details are safe, but they cannot be marked ` +
          `active until you move to the Guild plan. Everything you already have stays exactly as it is.`,
        cta: { label: "See the plans", href: "#settings" },
      });
    } else if (room <= CAP_WARNING_SLACK) {
      cards.push({
        rank: 33,
        id: "member_cap",
        severity: "consider",
        title: `Room for ${plural(room, "more member", "more members")} on the free plan`,
        body:
          `You are close to the ${memberLimit}-member limit. Nothing breaks when you reach it — ` +
          `new people are simply saved rather than made active until you move to the Guild plan. ` +
          `You can skip this for now.`,
        cta: { label: "See the plans", href: "#settings" },
      });
    }
  }

  // --- Band 2: the public site looks unfinished ----------------------------

  if (signals.samplePages > 0) {
    const n = signals.samplePages;
    cards.push({
      rank: 20,
      id: "sample_copy",
      severity: "do",
      title: `Replace the sample wording on ${plural(n, "page", "pages")}`,
      body:
        "Your website still shows the placeholder text we wrote to get you started, and visitors " +
        "will notice it. Start with the home page — a few sentences in your own words makes the " +
        "biggest difference.",
      cta: { label: "Edit your website", href: sitePage },
    });
  }

  // --- Band 3: growth and upkeep -------------------------------------------

  if (signals.eventsNext60 === 0) {
    cards.push({
      rank: 30,
      id: "add_event",
      severity: "consider",
      title: `Nothing is on the calendar for the next ${EVENT_HORIZON_DAYS} days`,
      body:
        "Your next meeting is the easiest thing to put up, and an empty calendar is the first " +
        "thing visitors look at. You can skip this for now if your season has not started.",
      cta: { label: "Add an event", href: "#events" },
    });
  }

  const renewal = renewalCard(signals, org);
  if (renewal) cards.push(renewal);

  if (signals.membersWithoutConsent > 0) {
    const n = signals.membersWithoutConsent;
    cards.push({
      rank: 32,
      id: "email_consent",
      severity: "consider",
      title: `${plural(n, "member does", "members do")} not receive your newsletters`,
      body:
        `${n === 1 ? "One person has" : "They have"} unsubscribed, or mail to ` +
        `${n === 1 ? "that address" : "those addresses"} bounced, so newsletters skip ` +
        `${n === 1 ? "them" : "them"}. Renewal notices and receipts still get through. ` +
        "Ask at your next meeting whether anyone wants back on the list.",
      cta: { label: "See your members", href: "#members" },
    });
  }

  if (cards.length > 0) {
    return cards
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_NEXT_ACTIONS)
      .map(({ rank: _rank, ...card }) => card);
  }

  // --- Band 4: nothing to do ------------------------------------------------

  const good: string[] = [];
  if (signals.activeMembers > 0) {
    good.push(`${signals.activeMembers} active ${signals.activeMembers === 1 ? people.replace(/s$/, "") : people}`);
  }
  if (!business && signals.levelCount > 0) {
    good.push(plural(signals.levelCount, "membership level", "membership levels"));
  }
  if (signals.eventsNext60 > 0) {
    good.push(`${plural(signals.eventsNext60, "event", "events")} coming up`);
  }
  const summary = good.length > 0 ? `You have ${listOf(good)}. ` : "";
  return [
    {
      id: "all_clear",
      severity: "celebrate",
      title: "Nothing needs you today",
      body:
        `${summary}Your website is in your own words, everyone can be reached by email, and ` +
        "money is set up to reach you. Enjoy the quiet — we will say something when that changes.",
      cta: { label: "Look at your website", href: sitePage },
    },
  ];
}

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * Renewal reminders go out automatically 30/14/7/1 days before a membership
 * ends. Officers are startled by mail they did not send, so tell them either
 * that it is happening now or that it starts soon, and offer a preview.
 */
function renewalCard(signals: NextActionSignals, org: string): RankedAction | null {
  if (signals.renewalsDue30 > 0) {
    const n = signals.renewalsDue30;
    return {
      rank: 31,
      id: "renewal_reminders",
      severity: "consider",
      title: "Renewal reminders are going out now",
      body:
        `${plural(n, "membership ends", "memberships end")} in the next 30 days. ` +
        `We email each person 30, 14, 7 and 1 day beforehand, signed by your ${org}. ` +
        "Send yourself a preview so you know exactly what they see.",
      cta: { label: "Preview the reminder", href: "#comms" },
    };
  }
  if (!signals.soonestRenewalEnd) return null;
  const ends = new Date(signals.soonestRenewalEnd);
  if (Number.isNaN(ends.getTime())) return null;
  const firstReminder = ends.getTime() - FIRST_REMINDER_DAYS * DAY_MS;
  const days = Math.ceil((firstReminder - signals.now.getTime()) / DAY_MS);
  if (days < 0 || days > REMINDER_HEADS_UP_DAYS) return null;
  return {
    rank: 31,
    id: "renewal_reminders",
    severity: "consider",
    title:
      days === 0
        ? "Renewal reminders start today"
        : `Renewal reminders start in ${plural(days, "day", "days")}`,
    body:
      `The first membership runs out on ${humanDate(signals.soonestRenewalEnd, signals.now)}, and ` +
      "reminders begin 30 days before that. Send yourself a preview so there are no surprises.",
    cta: { label: "Preview the reminder", href: "#comms" },
  };
}

type Row = Record<string, unknown> | null;

const num = (row: Row, key: string): number => Number((row || {})[key] || 0);

/**
 * Load every signal in one batched round trip, then rank. `now` is injectable
 * so tests are not clock-dependent.
 */
export async function nextActions(
  db: D1Database,
  tenant: NextActionsTenant,
  now: Date = new Date()
): Promise<NextAction[]> {
  const like = `%${SAMPLE_MARKER}%`;
  const nowIso = now.toISOString();
  const horizonIso = new Date(now.getTime() + EVENT_HORIZON_DAYS * DAY_MS).toISOString();
  const due30Iso = new Date(now.getTime() + FIRST_REMINDER_DAYS * DAY_MS).toISOString();

  const stmts = [
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM pages
          WHERE tenant_id = ? AND (blocks_json LIKE ? OR content_json LIKE ?)`
      )
      .bind(tenant.id, like, like),
    db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN price_cents > 0 THEN 1 ELSE 0 END) AS paid
           FROM membership_levels WHERE tenant_id = ? AND status = 'active'`
      )
      .bind(tenant.id),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE tenant_id = ? AND start_at >= ? AND start_at <= ?`
      )
      .bind(tenant.id, nowIso, horizonIso),
    db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN m.email_opt_out_at IS NOT NULL
                           OR EXISTS (SELECT 1 FROM email_suppressions s
                                       WHERE s.email = m.email
                                         AND (s.tenant_id IS NULL OR s.tenant_id = m.tenant_id))
                         THEN 1 ELSE 0 END) AS no_consent
           FROM members m WHERE m.tenant_id = ? AND ${activeMembershipFilter("m")}`
      )
      .bind(tenant.id),
    db
      .prepare(
        `SELECT MIN(end_date) AS soonest,
                SUM(CASE WHEN end_date <= ? THEN 1 ELSE 0 END) AS due30
           FROM memberships
          WHERE tenant_id = ? AND status = 'active'
            AND end_date IS NOT NULL AND end_date >= ?`
      )
      .bind(due30Iso, tenant.id, nowIso),
    db
      .prepare(
        `SELECT id, subject, error_count FROM blasts
          WHERE tenant_id = ? AND error_count > 0 AND status IN ('partial', 'failed')
          ORDER BY created_at DESC LIMIT 1`
      )
      .bind(tenant.id),
  ];

  // Test fakes may not implement batch(); fall back to sequential firsts
  // (same accommodation as computeOnboarding).
  const results: { results?: unknown[] }[] =
    typeof (db as { batch?: unknown }).batch === "function"
      ? await db.batch(stmts)
      : await Promise.all(stmts.map(async (s) => ({ results: [await s.first()] })));
  const row = (i: number) => ((results[i]?.results?.[0] || null) as Row);

  const levels = row(1);
  const members = row(3);
  const renewals = row(4);
  const blast = row(5);

  return buildNextActions(
    {
      samplePages: num(row(0), "n"),
      levelCount: num(levels, "n"),
      paidLevelCount: num(levels, "paid"),
      eventsNext60: num(row(2), "n"),
      activeMembers: num(members, "n"),
      membersWithoutConsent: num(members, "no_consent"),
      renewalsDue30: num(renewals, "due30"),
      soonestRenewalEnd:
        renewals && typeof renewals.soonest === "string" ? renewals.soonest : null,
      failedBlast: blast
        ? {
            id: String(blast.id ?? ""),
            subject: String(blast.subject ?? ""),
            errorCount: num(blast, "error_count"),
          }
        : null,
      now,
    },
    tenant
  );
}
