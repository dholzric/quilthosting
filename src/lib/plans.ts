import type { Plan, Tenant } from "../types";
import { first } from "./db";

/** Free / Starter tier: max active members before upgrade required. */
export const FREE_ACTIVE_MEMBER_LIMIT = 30;

/** Guild plan monthly price in cents ($24). */
export const GUILD_PLAN_PRICE_CENTS = 2400;

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

export function isPaidPlan(plan: string | null | undefined): boolean {
  return plan === "starter" || plan === "pro";
}

export function activeMemberLimit(plan: string | null | undefined): number | null {
  if (isPaidPlan(plan)) return null;
  return FREE_ACTIVE_MEMBER_LIMIT;
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
  tenant: Pick<Tenant, "id" | "plan">,
  memberId?: string | null
): Promise<void> {
  const limit = activeMemberLimit(tenant.plan);
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
