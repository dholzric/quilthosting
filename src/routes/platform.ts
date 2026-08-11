import { Hono } from "hono";
import type { Env } from "../types";
import { all, first } from "../lib/db";
import {
  requireAuth,
  requirePlatformAdmin,
  type AuthVariables,
} from "../middleware/auth";

/**
 * Platform (super-user) console — QuiltHosting operators only.
 * Gated by users.is_platform_admin.
 */
export const platformRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

platformRoutes.use("*", requireAuth);
platformRoutes.use("*", requirePlatformAdmin);

type StatusCount = { status: string; cnt: number };
type PlanCount = { plan: string; cnt: number };
type MonthRow = { month: string; total_cents: number; payments: number };

/**
 * GET /api/platform/overview
 * Aggregate stats across every tenant + per-guild breakdown.
 */
platformRoutes.get("/overview", async (c) => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const day30ago = new Date(now.getTime() - 30 * 86400000).toISOString();

  const [
    tenantTotal,
    tenantsByStatus,
    tenantsByPlan,
    membersByStatus,
    membersNewMonth,
    activeMemberships,
    expiring30,
    upcomingEvents,
    totalEvents,
    regsThisMonth,
    revenueLifetime,
    revenueMonth,
    revenue6mo,
    paymentsMonth,
    emails30d,
    guilds,
  ] = await Promise.all([
    first<{ cnt: number }>(
      c.env.DB.prepare("SELECT COUNT(*) cnt FROM tenants")
    ),
    all<StatusCount>(
      c.env.DB.prepare(
        "SELECT status, COUNT(*) cnt FROM tenants GROUP BY status"
      )
    ),
    all<PlanCount>(
      c.env.DB.prepare("SELECT plan, COUNT(*) cnt FROM tenants GROUP BY plan")
    ),
    all<StatusCount>(
      c.env.DB.prepare(
        "SELECT status, COUNT(*) cnt FROM members GROUP BY status"
      )
    ),
    first<{ cnt: number }>(
      c.env.DB.prepare(
        "SELECT COUNT(*) cnt FROM members WHERE created_at >= ?"
      ).bind(monthStart)
    ),
    first<{ cnt: number }>(
      c.env.DB.prepare(
        "SELECT COUNT(*) cnt FROM memberships WHERE status = 'active'"
      )
    ),
    first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) cnt FROM memberships
         WHERE status = 'active' AND date(end_date) BETWEEN ? AND ?`
      ).bind(today, in30)
    ),
    first<{ cnt: number }>(
      c.env.DB.prepare(
        "SELECT COUNT(*) cnt FROM events WHERE start_at >= ?"
      ).bind(now.toISOString())
    ),
    first<{ cnt: number }>(
      c.env.DB.prepare("SELECT COUNT(*) cnt FROM events")
    ),
    first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) cnt FROM event_registrations
         WHERE created_at >= ? AND status IN ('registered', 'checked_in')`
      ).bind(monthStart)
    ),
    first<{ total_cents: number | null; payments: number }>(
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) total_cents, COUNT(*) payments
         FROM payments WHERE status = 'succeeded'`
      )
    ),
    first<{ total_cents: number | null; payments: number }>(
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) total_cents, COUNT(*) payments
         FROM payments WHERE status = 'succeeded' AND created_at >= ?`
      ).bind(monthStart)
    ),
    all<MonthRow>(
      c.env.DB.prepare(
        `SELECT substr(created_at, 1, 7) month,
                SUM(amount_cents) total_cents,
                COUNT(*) payments
         FROM payments
         WHERE status = 'succeeded' AND created_at >= date('now', '-6 months')
         GROUP BY month ORDER BY month`
      )
    ),
    first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) cnt FROM payments
         WHERE status = 'succeeded' AND created_at >= ?`
      ).bind(monthStart)
    ),
    first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) cnt FROM email_logs WHERE created_at >= ?`
      ).bind(day30ago)
    ),
    all<{
      id: string;
      name: string;
      slug: string;
      plan: string;
      status: string;
      custom_domain: string | null;
      stripe_account_id: string | null;
      trial_ends_at: string | null;
      created_at: string;
      total_members: number;
      active_members: number;
      pending_members: number;
      lapsed_members: number;
      active_memberships: number;
      upcoming_events: number;
      revenue_lifetime_cents: number;
      revenue_30d_cents: number;
      payments_30d: number;
    }>(
      c.env.DB.prepare(
        `SELECT t.id, t.name, t.slug, t.plan, t.status, t.custom_domain,
                t.stripe_account_id, t.trial_ends_at, t.created_at,
                (SELECT COUNT(*) FROM members m WHERE m.tenant_id = t.id) AS total_members,
                (SELECT COUNT(*) FROM members m WHERE m.tenant_id = t.id AND m.status = 'active') AS active_members,
                (SELECT COUNT(*) FROM members m WHERE m.tenant_id = t.id AND m.status = 'pending') AS pending_members,
                (SELECT COUNT(*) FROM members m WHERE m.tenant_id = t.id AND m.status = 'lapsed') AS lapsed_members,
                (SELECT COUNT(*) FROM memberships ms WHERE ms.tenant_id = t.id AND ms.status = 'active') AS active_memberships,
                (SELECT COUNT(*) FROM events e WHERE e.tenant_id = t.id AND e.start_at >= ?) AS upcoming_events,
                (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p
                  WHERE p.tenant_id = t.id AND p.status = 'succeeded') AS revenue_lifetime_cents,
                (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p
                  WHERE p.tenant_id = t.id AND p.status = 'succeeded' AND p.created_at >= ?) AS revenue_30d_cents,
                (SELECT COUNT(*) FROM payments p
                  WHERE p.tenant_id = t.id AND p.status = 'succeeded' AND p.created_at >= ?) AS payments_30d
         FROM tenants t
         ORDER BY t.name COLLATE NOCASE`
      ).bind(now.toISOString(), day30ago, day30ago)
    ),
  ]);

  const memberStatus: Record<string, number> = {};
  for (const r of membersByStatus) memberStatus[r.status] = r.cnt;
  const tenantStatus: Record<string, number> = {};
  for (const r of tenantsByStatus) tenantStatus[r.status] = r.cnt;
  const planMap: Record<string, number> = {};
  for (const r of tenantsByPlan) planMap[r.plan] = r.cnt;

  return c.json({
    generated_at: now.toISOString(),
    tenants: {
      total: tenantTotal?.cnt || 0,
      by_status: tenantStatus,
      by_plan: planMap,
      active: tenantStatus.active || 0,
    },
    members: {
      total: Object.values(memberStatus).reduce((a, b) => a + b, 0),
      active: memberStatus.active || 0,
      pending: memberStatus.pending || 0,
      lapsed: memberStatus.lapsed || 0,
      cancelled: memberStatus.cancelled || 0,
      new_this_month: membersNewMonth?.cnt || 0,
    },
    memberships: {
      active: activeMemberships?.cnt || 0,
      expiring_30d: expiring30?.cnt || 0,
    },
    events: {
      total: totalEvents?.cnt || 0,
      upcoming: upcomingEvents?.cnt || 0,
    },
    registrations_this_month: regsThisMonth?.cnt || 0,
    revenue: {
      lifetime_cents: revenueLifetime?.total_cents || 0,
      this_month_cents: revenueMonth?.total_cents || 0,
      payments_this_month: paymentsMonth?.cnt || 0,
      by_month: revenue6mo,
    },
    emails_sent_30d: emails30d?.cnt || 0,
    guilds,
  });
});

/** GET /api/platform/tenants — all guilds (lighter list without full aggregates) */
platformRoutes.get("/tenants", async (c) => {
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, name, slug, plan, status, custom_domain, created_at, updated_at,
              stripe_account_id, trial_ends_at
       FROM tenants
       ORDER BY name COLLATE NOCASE`
    )
  );
  return c.json({ tenants: rows });
});

/**
 * PATCH /api/platform/tenants/:id — platform-admin-only tenant type toggle.
 *
 * tenant_type is deliberately kept out of the tenant-owner PATCH
 * (PATCH /api/tenants/:id in src/routes/tenants.ts): a tenant owner who
 * could flip their own guild to "business" would drop their guild's member
 * cap (src/lib/plans.ts) and gain the public-launch toggle. This router has
 * no existing tenant PATCH to attach the field to (only the two GET routes
 * above), so this is a new route -- but it is still gated purely by the
 * `requirePlatformAdmin` middleware already applied to every route on this
 * router (`platformRoutes.use("*", requirePlatformAdmin)` above), not a new
 * check invented for this endpoint.
 */
platformRoutes.patch("/tenants/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ tenant_type?: string }>().catch(() => ({}) as { tenant_type?: string });
  if (body.tenant_type !== "guild" && body.tenant_type !== "business") {
    return c.json({ error: "tenant_type must be 'guild' or 'business'" }, 400);
  }
  const existing = await first<{ id: string }>(
    c.env.DB.prepare("SELECT id FROM tenants WHERE id = ?").bind(id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  await c.env.DB.prepare(
    "UPDATE tenants SET tenant_type = ?, updated_at = ? WHERE id = ?"
  )
    .bind(body.tenant_type, new Date().toISOString(), id)
    .run();
  const tenant = await first(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  return c.json(tenant);
});
