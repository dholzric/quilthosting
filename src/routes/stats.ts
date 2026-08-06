import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { stripeRequest } from "../lib/stripe";

export const statsRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

/**
 * GET /api/tenants/:tenantId/stats
 * Dashboard analytics: counts, renewals due, revenue by month.
 * (Trend reporting without CSV exports is a core differentiator vs
 * Wild Apricot — keep this endpoint growing.)
 */
statsRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";

  const [byStatus, newThisMonth, expiring30, upcomingEvents, revenue6mo, regsThisMonth] =
    await Promise.all([
      all<{ status: string; cnt: number }>(
        c.env.DB.prepare(
          "SELECT status, COUNT(*) cnt FROM members WHERE tenant_id = ? GROUP BY status"
        ).bind(tenant.id)
      ),
      first<{ cnt: number }>(
        c.env.DB.prepare(
          "SELECT COUNT(*) cnt FROM members WHERE tenant_id = ? AND created_at >= ?"
        ).bind(tenant.id, monthStart)
      ),
      first<{ cnt: number }>(
        c.env.DB.prepare(
          `SELECT COUNT(*) cnt FROM memberships
           WHERE tenant_id = ? AND status = 'active'
             AND date(end_date) BETWEEN ? AND ?`
        ).bind(tenant.id, today, in30)
      ),
      first<{ cnt: number }>(
        c.env.DB.prepare(
          "SELECT COUNT(*) cnt FROM events WHERE tenant_id = ? AND start_at >= ?"
        ).bind(tenant.id, now.toISOString())
      ),
      all<{ month: string; total_cents: number; payments: number }>(
        c.env.DB.prepare(
          `SELECT substr(created_at, 1, 7) month,
                  SUM(amount_cents) total_cents,
                  COUNT(*) payments
           FROM payments
           WHERE tenant_id = ? AND status = 'succeeded'
             AND created_at >= date('now', '-6 months')
           GROUP BY month ORDER BY month`
        ).bind(tenant.id)
      ),
      first<{ cnt: number }>(
        c.env.DB.prepare(
          `SELECT COUNT(*) cnt FROM event_registrations
           WHERE tenant_id = ? AND created_at >= ?
             AND status IN ('registered', 'checked_in')`
        ).bind(tenant.id, monthStart)
      ),
    ]);

  const statusMap: Record<string, number> = {};
  for (const r of byStatus) statusMap[r.status] = r.cnt;

  return c.json({
    members: {
      total: Object.values(statusMap).reduce((a, b) => a + b, 0),
      active: statusMap.active || 0,
      pending: statusMap.pending || 0,
      lapsed: statusMap.lapsed || 0,
      cancelled: statusMap.cancelled || 0,
      new_this_month: newThisMonth?.cnt || 0,
    },
    renewals_due_30d: expiring30?.cnt || 0,
    upcoming_events: upcomingEvents?.cnt || 0,
    registrations_this_month: regsThisMonth?.cnt || 0,
    revenue_by_month: revenue6mo,
  });
});

export const paymentRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

// GET /api/tenants/:tenantId/payments — recent payments with member info
paymentRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const rows = await all(
    c.env.DB.prepare(
      `SELECT p.id, p.type, p.amount_cents, p.currency, p.status,
              p.description, p.created_at,
              m.email member_email, m.first_name, m.last_name
       FROM payments p
       LEFT JOIN members m ON m.id = p.member_id
       WHERE p.tenant_id = ?
       ORDER BY p.created_at DESC LIMIT ?`
    ).bind(tenant.id, limit)
  );
  return c.json(rows);
});

// GET /api/tenants/:tenantId/payments/export.csv — bookkeeping export
paymentRoutes.get("/export.csv", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all<Record<string, unknown>>(
    c.env.DB.prepare(
      `SELECT p.created_at, p.type, p.description, p.amount_cents, p.currency,
              p.status, p.stripe_payment_intent_id,
              m.email member_email, m.first_name, m.last_name
       FROM payments p LEFT JOIN members m ON m.id = p.member_id
       WHERE p.tenant_id = ? ORDER BY p.created_at`
    ).bind(tenant.id)
  );
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = "date,type,description,amount,currency,status,member_email,member_name,stripe_id";
  const lines = rows.map((r) =>
    [
      String(r.created_at).slice(0, 10),
      r.type,
      r.description,
      ((r.amount_cents as number) / 100).toFixed(2),
      r.currency,
      r.status,
      r.member_email,
      [r.first_name, r.last_name].filter(Boolean).join(" "),
      r.stripe_payment_intent_id,
    ]
      .map(cell)
      .join(",")
  );
  return new Response([header, ...lines].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="payments.csv"',
    },
  });
});

// POST /api/tenants/:tenantId/payments/:paymentId/refund
paymentRoutes.post("/:paymentId/refund", async (c) => {
  const tenant = c.get("tenant");
  const paymentId = c.req.param("paymentId");
  const payment = await first<{
    id: string;
    status: string;
    stripe_payment_intent_id: string | null;
    amount_cents: number;
  }>(
    c.env.DB.prepare(
      "SELECT id, status, stripe_payment_intent_id, amount_cents FROM payments WHERE id = ? AND tenant_id = ?"
    ).bind(paymentId, tenant.id)
  );
  if (!payment) return c.json({ error: "Payment not found" }, 404);
  if (payment.status !== "succeeded") {
    return c.json({ error: `Cannot refund a ${payment.status} payment` }, 400);
  }
  if (!payment.stripe_payment_intent_id || !payment.stripe_payment_intent_id.startsWith("pi_")) {
    return c.json({ error: "No Stripe payment behind this record" }, 400);
  }
  try {
    await stripeRequest(c.env, "POST", "/refunds", {
      payment_intent: payment.stripe_payment_intent_id,
    });
  } catch (e: any) {
    return c.json({ error: e.message || "Stripe refund failed" }, 502);
  }
  await c.env.DB.prepare(
    "UPDATE payments SET status = 'refunded', updated_at = ? WHERE id = ?"
  )
    .bind(new Date().toISOString(), paymentId)
    .run();
  return c.json({ ok: true, refunded_cents: payment.amount_cents });
});
