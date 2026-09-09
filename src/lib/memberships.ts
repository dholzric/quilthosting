import type { MembershipLevel } from "../types";
import { generateId } from "./utils/id";
import { first } from "./db";
import { anniversaryTermEnd, computeTermEnd, type DuesPolicy } from "./dues";

/**
 * Expire every active membership for a member (optionally keeping one id).
 * Keeps history; only status flips.
 */
export async function expireActiveMemberships(
  db: D1Database,
  tenantId: string,
  memberId: string,
  now: string,
  exceptId?: string
): Promise<void> {
  if (exceptId) {
    await db
      .prepare(
        `UPDATE memberships SET status = 'expired', updated_at = ?
         WHERE tenant_id = ? AND member_id = ? AND status = 'active' AND id != ?`
      )
      .bind(now, tenantId, memberId, exceptId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE memberships SET status = 'expired', updated_at = ?
         WHERE tenant_id = ? AND member_id = ? AND status = 'active'`
      )
      .bind(now, tenantId, memberId)
      .run();
  }
}

export type ActivateMembershipParams = {
  tenantId: string;
  memberId: string;
  level: MembershipLevel;
  amountPaidCents: number;
  now?: string;
  startDate?: string;
  endDate?: string | null;
  stripeSubscriptionId?: string | null;
  autoRenew?: boolean;
  /**
   * The level's dues policy (src/lib/dues.ts). Optional on purpose: every
   * caller that does not pass one gets exactly the term it got before phase
   * 4 — same computeMembershipEnd call, same end date, same everything.
   * Pass `readDuesPolicy(level)` to honor a calendar or fixed-date year.
   */
  policy?: DuesPolicy;
};

/**
 * The end date a membership gets when the caller supplies no explicit one:
 * one full term of the level's duration, measured from `max(startDate, now)`.
 *
 * WHY max() AND NOT `startDate` (the bug this replaced): the CSV import
 * passes the member's HISTORICAL join date ("Member Since 2019-03-02" on a
 * Wild Apricot roster) as startDate, and a roster with a Level column but
 * no expiry column reaches here with endDate === undefined. Measuring the
 * term from 2019 produced an end date of 2020 -- already in the past -- so
 * the member was written as `active` and `expired` at the same instant, and
 * the nightly renewal cron (src/lib/renewals.ts) lapsed them and fired the
 * win-back email overnight. A computed end date in the past is never a
 * useful outcome for ANY caller: it is a membership that is simultaneously
 * active and over. "Member Since 2019" on a current-roster file means "this
 * person is a member today", not "their dues lapsed in 2020".
 *
 * WHY NOT simply `now`: a FUTURE startDate is a legitimate, deliberate
 * input (an admin recording a term that begins next month). Measuring from
 * `now` would silently shorten that term. max() keeps a future start intact
 * and only ever moves a PAST start forward to today.
 *
 * `start_date` itself is stored verbatim, so the membership record still
 * carries the date the caller gave it; only the TERM is measured from
 * today. `members.joined_at` is likewise untouched -- see activateMembership
 * below, which only ever coalesces it.
 *
 * PHASE 4: the body moved verbatim to `anniversaryTermEnd` in
 * src/lib/dues.ts so the policy engine's "anniversary" branch and this
 * function are literally the same code and cannot drift apart. The failure
 * mode is unchanged: an unreadable start date still throws a RangeError
 * reading `start date "..." is not a valid date`, which the import route's
 * per-row catch reports as membership_failed. Inventing a term for a row
 * whose start date cannot be read would hide a real data problem.
 */
export function computeMembershipEnd(
  startDate: string,
  durationMonths: number | null | undefined,
  now: string
): string {
  return anniversaryTermEnd(startDate, durationMonths, now);
}

/**
 * Create one active membership, expire prior actives, mark member active.
 * Returns the new membership id.
 */
export async function activateMembership(
  db: D1Database,
  params: ActivateMembershipParams
): Promise<string> {
  const now = params.now || new Date().toISOString();
  const startDate = params.startDate || now;

  let endDate = params.endDate;
  if (endDate === undefined) {
    // No policy passed -> the pre-phase-4 call, byte for byte.
    endDate = params.policy
      ? computeTermEnd(params.policy, startDate, now)
      : computeMembershipEnd(startDate, params.level.duration_months, now);
  }

  const autoRenew =
    params.autoRenew !== undefined
      ? params.autoRenew
        ? 1
        : 0
      : params.level.renewal_type === "auto"
        ? 1
        : 0;

  await expireActiveMemberships(db, params.tenantId, params.memberId, now);

  const membershipId = generateId();
  await db
    .prepare(
      `INSERT INTO memberships
       (id, tenant_id, member_id, level_id, start_date, end_date, status,
        amount_paid_cents, stripe_subscription_id, auto_renew, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    )
    .bind(
      membershipId,
      params.tenantId,
      params.memberId,
      params.level.id,
      startDate,
      endDate,
      params.amountPaidCents,
      params.stripeSubscriptionId ?? null,
      autoRenew,
      now,
      now
    )
    .run();

  await db
    .prepare(
      "UPDATE members SET status = 'active', joined_at = coalesce(joined_at, ?), updated_at = ? WHERE id = ? AND tenant_id = ?"
    )
    .bind(now, now, params.memberId, params.tenantId)
    .run();

  return membershipId;
}

/**
 * Extend an active (or the latest) membership's end date by the level duration.
 * Used for Stripe subscription renewals (invoice.paid / subscription_cycle).
 *
 * `policy` is optional and additive: without it this is the pre-phase-4
 * function, unchanged. With a fixed-year policy the new term runs to the
 * NEXT anchor — note the term start is the millisecond after the old end
 * date, not the end date itself, because a term that ends 23:59:59.999 on
 * December 31 is still inside the year that ends December 31; asking for
 * "the next anchor after December 31" from that instant would hand back the
 * same December 31 the member already has.
 */
export async function extendMembership(
  db: D1Database,
  membershipId: string,
  durationMonths: number,
  now: string,
  policy?: DuesPolicy
): Promise<string | null> {
  const row = await first<{ end_date: string | null }>(
    db.prepare("SELECT end_date FROM memberships WHERE id = ?").bind(membershipId)
  );
  if (!row) return null;

  let newEnd: string;
  if (policy && policy.termMode !== "anniversary") {
    const end = row.end_date ? new Date(row.end_date) : null;
    const stillRunning =
      !!end && !Number.isNaN(end.getTime()) && end.getTime() > new Date(now).getTime();
    const nextTermStart = stillRunning ? new Date(end!.getTime() + 1) : new Date(now);
    newEnd = computeTermEnd(policy, nextTermStart.toISOString(), now);
  } else {
    const base = row.end_date && new Date(row.end_date) > new Date(now)
      ? new Date(row.end_date)
      : new Date(now);
    base.setMonth(base.getMonth() + (durationMonths || 12));
    newEnd = base.toISOString();
  }

  await db
    .prepare(
      `UPDATE memberships SET end_date = ?, status = 'active', updated_at = ? WHERE id = ?`
    )
    .bind(newEnd, now, membershipId)
    .run();

  return newEnd;
}

/** Portal URL for a guild (always includes slug). */
export function portalUrl(appUrl: string, slug: string, extra?: Record<string, string>): string {
  const base = appUrl.replace(/\/$/, "");
  const u = new URL(`${base}/portal`);
  u.searchParams.set("slug", slug);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  }
  return u.toString();
}
