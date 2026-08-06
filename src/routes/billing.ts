import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";
import { first } from "../lib/db";
import {
  countActiveMembers,
  FREE_ACTIVE_MEMBER_LIMIT,
  GUILD_PLAN_PRICE_CENTS,
  isPaidPlan,
  planLabel,
} from "../lib/plans";
import {
  createAccountLink,
  createBillingPortalSession,
  createConnectExpressAccount,
  createConnectLoginLink,
  createPlatformSubscriptionCheckout,
  cancelSubscription,
  retrieveConnectAccount,
} from "../lib/stripe";

export const billingRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables & TenantVariables & { tenantRole: string };
}>();

function requireOwnerAdmin(c: { get: (k: "tenantRole") => string }) {
  const role = c.get("tenantRole");
  return role === "owner" || role === "admin";
}

// GET /api/tenants/:tenantId/billing — plan + Connect status summary
billingRoutes.get("/", async (c) => {
  const tenant = c.get("tenant") as Tenant & {
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
  };
  // Refresh row for billing columns
  const row = await first<
    Tenant & {
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
    }
  >(
    c.env.DB.prepare(
      `SELECT id, name, slug, plan, status, stripe_account_id,
              stripe_customer_id, stripe_subscription_id
       FROM tenants WHERE id = ?`
    ).bind(tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);

  const activeMembers = await countActiveMembers(c.env.DB, tenant.id);
  const limit = isPaidPlan(row.plan) ? null : FREE_ACTIVE_MEMBER_LIMIT;

  let connect: {
    account_id: string | null;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    details_submitted: boolean;
    email?: string;
  } = {
    account_id: row.stripe_account_id,
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
  };

  if (row.stripe_account_id) {
    try {
      const acct = await retrieveConnectAccount(c.env, row.stripe_account_id);
      connect = {
        account_id: row.stripe_account_id,
        charges_enabled: !!acct.charges_enabled,
        payouts_enabled: !!acct.payouts_enabled,
        details_submitted: !!acct.details_submitted,
        email: acct.email,
      };
    } catch (e) {
      console.warn("Connect account retrieve failed", e);
    }
  }

  return c.json({
    plan: row.plan,
    plan_label: planLabel(row.plan),
    active_members: activeMembers,
    active_member_limit: limit,
    at_limit: limit != null && activeMembers >= limit,
    guild_price_cents: GUILD_PLAN_PRICE_CENTS,
    stripe_customer_id: row.stripe_customer_id,
    stripe_subscription_id: row.stripe_subscription_id,
    connect,
    // Platform-collected payments allowed only when Connect is not ready (sandbox / setup)
    payments_mode: connect.charges_enabled ? "connected" : "platform_fallback",
  });
});

// POST /api/tenants/:tenantId/billing/connect — start or resume Express onboarding
billingRoutes.post("/connect", async (c) => {
  if (!requireOwnerAdmin(c)) {
    return c.json({ error: "Only owners and admins can connect Stripe" }, 403);
  }
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  const tenant = c.get("tenant");
  const user = c.get("user");
  const base = (c.env.APP_URL || "").replace(/\/$/, "");
  const returnUrl = `${base}/admin#billing=return`;
  const refreshUrl = `${base}/admin#billing=refresh`;

  let accountId = tenant.stripe_account_id;
  if (!accountId) {
    accountId = await createConnectExpressAccount(c.env, {
      email: user.email,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
    });
    await c.env.DB.prepare(
      `UPDATE tenants SET stripe_account_id = ?, updated_at = ? WHERE id = ?`
    )
      .bind(accountId, new Date().toISOString(), tenant.id)
      .run();
  }

  const url = await createAccountLink(c.env, {
    accountId,
    refreshUrl,
    returnUrl,
  });

  return c.json({ url, account_id: accountId });
});

// POST /api/tenants/:tenantId/billing/connect/dashboard — Express login link
billingRoutes.post("/connect/dashboard", async (c) => {
  if (!requireOwnerAdmin(c)) {
    return c.json({ error: "Only owners and admins can open Stripe" }, 403);
  }
  const tenant = c.get("tenant");
  if (!tenant.stripe_account_id) {
    return c.json({ error: "Connect Stripe first" }, 400);
  }
  try {
    const url = await createConnectLoginLink(c.env, tenant.stripe_account_id);
    return c.json({ url });
  } catch (e: any) {
    return c.json(
      {
        error:
          e.message ||
          "Stripe Express dashboard is available after onboarding is complete",
      },
      502
    );
  }
});

// POST /api/tenants/:tenantId/billing/upgrade — Checkout for Guild plan ($24/mo)
billingRoutes.post("/upgrade", async (c) => {
  if (!requireOwnerAdmin(c)) {
    return c.json({ error: "Only owners and admins can upgrade" }, 403);
  }
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  const tenant = c.get("tenant") as Tenant & {
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
  };
  const user = c.get("user");
  const row = await first<{
    plan: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    name: string;
    slug: string;
  }>(
    c.env.DB.prepare(
      `SELECT plan, stripe_customer_id, stripe_subscription_id, name, slug
       FROM tenants WHERE id = ?`
    ).bind(tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  if (isPaidPlan(row.plan) && row.stripe_subscription_id) {
    return c.json({ error: "Already on a paid plan", plan: row.plan }, 400);
  }

  const base = (c.env.APP_URL || "").replace(/\/$/, "");
  try {
    const session = await createPlatformSubscriptionCheckout(c.env, {
      tenantId: tenant.id,
      tenantSlug: row.slug,
      tenantName: row.name,
      email: user.email,
      customerId: row.stripe_customer_id,
      successUrl: `${base}/admin#billing=upgraded`,
      cancelUrl: `${base}/admin#billing=cancelled`,
    });
    return c.json({ status: "checkout", checkout_url: session.url });
  } catch (e: any) {
    console.error("Platform upgrade checkout failed", e);
    return c.json({ error: e.message || "Checkout failed" }, 502);
  }
});

// POST /api/tenants/:tenantId/billing/portal — Stripe Customer Portal
billingRoutes.post("/portal", async (c) => {
  if (!requireOwnerAdmin(c)) {
    return c.json({ error: "Only owners and admins can manage billing" }, 403);
  }
  const tenant = c.get("tenant");
  const row = await first<{ stripe_customer_id: string | null }>(
    c.env.DB.prepare(
      "SELECT stripe_customer_id FROM tenants WHERE id = ?"
    ).bind(tenant.id)
  );
  if (!row?.stripe_customer_id) {
    return c.json({ error: "No billing customer yet — upgrade first" }, 400);
  }
  const base = (c.env.APP_URL || "").replace(/\/$/, "");
  try {
    const url = await createBillingPortalSession(c.env, {
      customerId: row.stripe_customer_id,
      returnUrl: `${base}/admin#billing=portal`,
    });
    return c.json({ url });
  } catch (e: any) {
    return c.json({ error: e.message || "Portal unavailable" }, 502);
  }
});

// POST /api/tenants/:tenantId/billing/cancel — cancel platform sub at period end via API
// (Prefer Customer Portal; this is a simple cancel-now fallback.)
billingRoutes.post("/cancel", async (c) => {
  if (!requireOwnerAdmin(c)) {
    return c.json({ error: "Only owners and admins can cancel" }, 403);
  }
  const tenant = c.get("tenant");
  const myRole = c.get("tenantRole");
  if (myRole !== "owner") {
    return c.json({ error: "Only the owner can cancel the plan" }, 403);
  }
  const row = await first<{ stripe_subscription_id: string | null }>(
    c.env.DB.prepare(
      "SELECT stripe_subscription_id FROM tenants WHERE id = ?"
    ).bind(tenant.id)
  );
  if (!row?.stripe_subscription_id) {
    return c.json({ error: "No active subscription" }, 400);
  }
  try {
    await cancelSubscription(c.env, row.stripe_subscription_id);
  } catch (e: any) {
    return c.json({ error: e.message || "Cancel failed" }, 502);
  }
  // Webhook will set plan=free; also flip optimistically
  await c.env.DB.prepare(
    `UPDATE tenants SET plan = 'free', stripe_subscription_id = null, updated_at = ?
     WHERE id = ?`
  )
    .bind(new Date().toISOString(), tenant.id)
    .run();
  return c.json({ ok: true, plan: "free" });
});
