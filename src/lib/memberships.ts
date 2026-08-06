import type { MembershipLevel } from "../types";
import { generateId } from "./utils/id";
import { first } from "./db";

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
};

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
    const end = new Date(startDate);
    end.setMonth(end.getMonth() + (params.level.duration_months || 12));
    endDate = end.toISOString();
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
 */
export async function extendMembership(
  db: D1Database,
  membershipId: string,
  durationMonths: number,
  now: string
): Promise<string | null> {
  const row = await first<{ end_date: string | null }>(
    db.prepare("SELECT end_date FROM memberships WHERE id = ?").bind(membershipId)
  );
  if (!row) return null;

  const base = row.end_date && new Date(row.end_date) > new Date(now)
    ? new Date(row.end_date)
    : new Date(now);
  base.setMonth(base.getMonth() + (durationMonths || 12));
  const newEnd = base.toISOString();

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
