import type { Plan, Tenant } from "../types";
import { first } from "./db";
import { isBusiness } from "./tenantType";

/** Free / Starter tier: max active members before upgrade required. */
export const FREE_ACTIVE_MEMBER_LIMIT = 30;

/** Guild plan monthly price in cents ($24). */
export const GUILD_PLAN_PRICE_CENTS = 2400;

/** New guilds get this many days of Guild features free. */
export const TRIAL_DAYS = 30;

export function planLabel(plan: string | null | undefined): string {
  switch (plan) {
    case "starter":
      return "Guild";
    case "pro":
      return "Council";
    default:
      return "Starter (free)";
  }
}

export function isTrialActive(
  tenant: Pick<Tenant, "trial_ends_at"> | { trial_ends_at?: string | null }
): boolean {
  const ends = tenant.trial_ends_at;
  if (!ends) return false;
  return new Date(ends).getTime() > Date.now();
}

/** Plan used for limits: trial counts as paid (starter). */
export function effectivePlan(
  tenant: Pick<Tenant, "plan" | "trial_ends_at" | "stripe_subscription_id">
): Plan {
  if (isPaidPlan(tenant.plan)) return tenant.plan as Plan;
  if (isTrialActive(tenant)) return "starter";
  return "free";
}

export function isPaidPlan(plan: string | null | undefined): boolean {
  return plan === "starter" || plan === "pro";
}

export function activeMemberLimit(
  plan: string | null | undefined
): number | null {
  if (isPaidPlan(plan)) return null;
  return FREE_ACTIVE_MEMBER_LIMIT;
}

export function activeMemberLimitForTenant(
  tenant: Pick<Tenant, "plan" | "trial_ends_at" | "stripe_subscription_id"> & {
    tenant_type?: string | null;
  }
): number | null {
  // Businesses have customers, not members. The free-plan member cap is a
  // membership-organisation concept and does not apply to them.
  if (isBusiness(tenant)) return null;
  return activeMemberLimit(effectivePlan(tenant));
}

export async function countActiveMembers(
  db: D1Database,
  tenantId: string
): Promise<number> {
  const row = await first<{ cnt: number }>(
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM members
         WHERE tenant_id = ? AND status = 'active'`
      )
      .bind(tenantId)
  );
  return row?.cnt ?? 0;
}

/**
 * Throws a structured error object if free plan is at capacity.
 * Call before activating a member who is not already active.
 */
export async function assertCanActivateMember(
  db: D1Database,
  tenant: Pick<Tenant, "id" | "plan" | "trial_ends_at" | "stripe_subscription_id">,
  memberId?: string | null
): Promise<void> {
  const limit = activeMemberLimitForTenant(tenant);
  if (limit == null) return;

  if (memberId) {
    const existing = await first<{ status: string }>(
      db
        .prepare("SELECT status FROM members WHERE id = ? AND tenant_id = ?")
        .bind(memberId, tenant.id)
    );
    // Renewing / re-activating an already-active member does not consume a slot
    if (existing?.status === "active") return;
  }

  const count = await countActiveMembers(db, tenant.id);
  if (count >= limit) {
    const err = new Error(
      `Free plan is limited to ${limit} active members. Upgrade to the Guild plan for unlimited members.`
    ) as Error & { status: number; code: string };
    err.status = 402;
    err.code = "plan_limit";
    throw err;
  }
}

export function planFromStripe(plan: Plan | string): Plan {
  if (plan === "starter" || plan === "pro" || plan === "free") return plan;
  return "free";
}
