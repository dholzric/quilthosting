import type { Env } from "../../types";
import { GUILD_PLAN_PRICE_CENTS } from "../plans";

const STRIPE_API = "https://api.stripe.com/v1";

type StripeResponse = Record<string, any>;

async function stripeRequest(
  env: Env,
  method: string,
  path: string,
  body?: Record<string, string | number | undefined | null>
): Promise<StripeResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
  };

  let requestBody: string | undefined;

  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null) {
        params.append(k, String(v));
      }
    }
    requestBody = params.toString();
  }

  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: requestBody,
  });

  const data = (await res.json()) as StripeResponse;

  if (!res.ok) {
    console.error("Stripe error", data);
    throw new Error(data.error?.message || "Stripe request failed");
  }

  return data;
}

/** Optional platform fee in basis points (100 = 1%). Default 0 — no markup. */
export function platformFeeBps(env: Env): number {
  const raw = (env as Env & { STRIPE_PLATFORM_FEE_BPS?: string }).STRIPE_PLATFORM_FEE_BPS;
  const n = raw != null ? Number(raw) : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 3000); // cap 30%
}

export function applicationFeeAmount(env: Env, amountCents: number): number | undefined {
  const bps = platformFeeBps(env);
  if (bps <= 0 || amountCents <= 0) return undefined;
  const fee = Math.floor((amountCents * bps) / 10000);
  // Leave at least $0.50 for the connected account when amount is large enough
  if (amountCents > 50) return Math.min(fee, amountCents - 50);
  return fee > 0 ? fee : undefined;
}

export type CheckoutLineItem = {
  name: string;
  amountCents: number;
  quantity?: number;
};

export type CreateCheckoutParams = {
  tenantId: string;
  tenantSlug: string;
  memberId?: string;
  email: string;
  name?: string;
  amountCents: number;
  description: string;
  type: "dues" | "event" | "store" | "donation";
  relatedId?: string;
  /** Optional quantity for store purchases (metadata). */
  quantity?: number;
  /** Multi-SKU cart lines (store). When set, overrides single line_items[0]. */
  lineItems?: CheckoutLineItem[];
  /** Extra metadata (order id, tax, etc.) */
  extraMetadata?: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  mode?: "payment" | "subscription";
  interval?: "month" | "year";
  /** Connected Express account — destination charges so funds land in the guild's bank. */
  stripeAccountId?: string | null;
  /** Existing Stripe customer (card update / renewals). */
  customerId?: string | null;
};

export async function createCheckoutSession(
  env: Env,
  params: CreateCheckoutParams
): Promise<{ id: string; url: string }> {
  const body: Record<string, string | number | undefined> = {
    mode: params.mode || "payment",
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    // Guilds are their own merchant of record when using Connect; opt out of Managed Payments.
    "managed_payments[enabled]": "false",
    "metadata[tenant_id]": params.tenantId,
    "metadata[type]": params.type,
    "metadata[email]": params.email,
  };

  if (params.customerId) {
    body.customer = params.customerId;
  } else {
    body.customer_email = params.email;
  }

  if (params.lineItems?.length) {
    params.lineItems.slice(0, 20).forEach((li, i) => {
      body[`line_items[${i}][price_data][currency]`] = "usd";
      body[`line_items[${i}][price_data][unit_amount]`] = Math.max(0, Math.floor(li.amountCents));
      body[`line_items[${i}][price_data][product_data][name]`] = li.name.slice(0, 200);
      body[`line_items[${i}][quantity]`] = Math.max(1, Math.floor(li.quantity || 1));
    });
  } else {
    body["line_items[0][price_data][currency]"] = "usd";
    body["line_items[0][price_data][unit_amount]"] = params.amountCents;
    body["line_items[0][price_data][product_data][name]"] = params.description;
    body["line_items[0][quantity]"] = 1;
  }

  if (params.memberId) body["metadata[member_id]"] = params.memberId;
  if (params.relatedId) body["metadata[related_id]"] = params.relatedId;
  if (params.quantity != null && params.quantity > 0) {
    body["metadata[quantity]"] = String(params.quantity);
  }
  if (params.extraMetadata) {
    for (const [k, v] of Object.entries(params.extraMetadata)) {
      if (v != null && v !== "") body[`metadata[${k}]`] = String(v).slice(0, 500);
    }
  }

  const connected = params.stripeAccountId?.startsWith("acct_")
    ? params.stripeAccountId
    : null;

  if (connected) {
    body["metadata[stripe_account_id]"] = connected;
    const fee = applicationFeeAmount(env, params.amountCents);

    if (params.mode === "subscription") {
      // Destination subscription: guild receives net, optional % fee to platform
      body["subscription_data[transfer_data][destination]"] = connected;
      const bps = platformFeeBps(env);
      if (bps > 0) {
        body["subscription_data[application_fee_percent]"] = (bps / 100).toFixed(2);
      }
      body["subscription_data[metadata][tenant_id]"] = params.tenantId;
      body["subscription_data[metadata][type]"] = params.type;
      body["subscription_data[metadata][stripe_account_id]"] = connected;
      if (params.memberId) {
        body["subscription_data[metadata][member_id]"] = params.memberId;
      }
      if (params.relatedId) {
        body["subscription_data[metadata][related_id]"] = params.relatedId;
      }
    } else {
      // One-time destination charge
      body["payment_intent_data[transfer_data][destination]"] = connected;
      if (fee != null && fee > 0) {
        body["payment_intent_data[application_fee_amount]"] = fee;
      }
    }
  } else if (params.mode === "subscription") {
    // Platform-collected (sandbox / no Connect yet)
    body["subscription_data[metadata][tenant_id]"] = params.tenantId;
    body["subscription_data[metadata][type]"] = params.type;
    if (params.memberId) {
      body["subscription_data[metadata][member_id]"] = params.memberId;
    }
    if (params.relatedId) {
      body["subscription_data[metadata][related_id]"] = params.relatedId;
    }
  }

  if (params.mode === "subscription" && params.interval) {
    body["line_items[0][price_data][recurring][interval]"] = params.interval;
  }

  const session = await stripeRequest(env, "POST", "/checkout/sessions", body);

  return {
    id: session.id,
    url: session.url,
  };
}

/**
 * Platform billing: guild pays QuiltHosting $24/mo.
 * Money stays on the platform account (not Connect).
 */
export async function createPlatformSubscriptionCheckout(
  env: Env,
  params: {
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    email: string;
    customerId?: string | null;
    successUrl: string;
    cancelUrl: string;
  }
): Promise<{ id: string; url: string }> {
  const priceId = (env as Env & { STRIPE_GUILD_PRICE_ID?: string }).STRIPE_GUILD_PRICE_ID;
  const body: Record<string, string | number | undefined> = {
    mode: "subscription",
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    "managed_payments[enabled]": "false",
    "metadata[tenant_id]": params.tenantId,
    "metadata[type]": "platform",
    "metadata[plan]": "starter",
    "subscription_data[metadata][tenant_id]": params.tenantId,
    "subscription_data[metadata][type]": "platform",
    "subscription_data[metadata][plan]": "starter",
    "line_items[0][quantity]": 1,
  };

  if (params.customerId) {
    body.customer = params.customerId;
  } else {
    body.customer_email = params.email;
  }

  if (priceId) {
    body["line_items[0][price]"] = priceId;
  } else {
    body["line_items[0][price_data][currency]"] = "usd";
    body["line_items[0][price_data][unit_amount]"] = GUILD_PLAN_PRICE_CENTS;
    body["line_items[0][price_data][recurring][interval]"] = "month";
    body["line_items[0][price_data][product_data][name]"] =
      `QuiltHosting Guild plan — ${params.tenantName}`;
  }

  const session = await stripeRequest(env, "POST", "/checkout/sessions", body);
  return { id: session.id, url: session.url };
}

// --- Stripe Connect Express ---

export async function createConnectExpressAccount(
  env: Env,
  params: { email?: string; tenantId: string; tenantSlug: string }
): Promise<string> {
  const account = await stripeRequest(env, "POST", "/accounts", {
    type: "express",
    country: "US",
    email: params.email,
    "capabilities[card_payments][requested]": "true",
    "capabilities[transfers][requested]": "true",
    "metadata[tenant_id]": params.tenantId,
    "metadata[tenant_slug]": params.tenantSlug,
  });
  return account.id as string;
}

export async function createAccountLink(
  env: Env,
  params: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
    type?: "account_onboarding" | "account_update";
  }
): Promise<string> {
  const link = await stripeRequest(env, "POST", "/account_links", {
    account: params.accountId,
    refresh_url: params.refreshUrl,
    return_url: params.returnUrl,
    type: params.type || "account_onboarding",
  });
  return link.url as string;
}

export async function retrieveConnectAccount(
  env: Env,
  accountId: string
): Promise<StripeResponse> {
  return stripeRequest(env, "GET", `/accounts/${accountId}`);
}

export async function createConnectLoginLink(
  env: Env,
  accountId: string
): Promise<string> {
  const link = await stripeRequest(
    env,
    "POST",
    `/accounts/${accountId}/login_links`,
    {}
  );
  return link.url as string;
}

export async function createBillingPortalSession(
  env: Env,
  params: {
    customerId: string;
    returnUrl: string;
    /** Deep-link into payment method update when supported by portal configuration */
    flow?: "payment_method_update";
  }
): Promise<string> {
  const body: Record<string, string | number | undefined> = {
    customer: params.customerId,
    return_url: params.returnUrl,
  };
  if (params.flow === "payment_method_update") {
    body["flow_data[type]"] = "payment_method_update";
  }
  try {
    const session = await stripeRequest(env, "POST", "/billing_portal/sessions", body);
    return session.url as string;
  } catch (e) {
    // Portal config may not allow flow_data — fall back to default portal
    if (params.flow) {
      const session = await stripeRequest(env, "POST", "/billing_portal/sessions", {
        customer: params.customerId,
        return_url: params.returnUrl,
      });
      return session.url as string;
    }
    throw e;
  }
}

export async function cancelSubscription(
  env: Env,
  subscriptionId: string
): Promise<StripeResponse> {
  return stripeRequest(env, "DELETE", `/subscriptions/${subscriptionId}`);
}

/** Retrieve a subscription (to get customer id for portal card updates). */
export async function retrieveSubscription(
  env: Env,
  subscriptionId: string
): Promise<StripeResponse> {
  return stripeRequest(env, "GET", `/subscriptions/${subscriptionId}`);
}

/** Create Stripe Billing Portal session focused on payment method update. */
export async function createCustomerPortalSession(
  env: Env,
  params: {
    customerId: string;
    returnUrl: string;
    flow?: "payment_method_update";
  }
): Promise<string> {
  return createBillingPortalSession(env, {
    ...params,
    flow: params.flow ?? "payment_method_update",
  });
}

const WEBHOOK_TOLERANCE_SECONDS = 300;

export async function constructWebhookEvent(
  env: Env,
  payload: string,
  signatureHeader: string
): Promise<StripeResponse | null> {
  if (!signatureHeader || !env.STRIPE_WEBHOOK_SECRET) {
    console.warn("Missing Stripe webhook signature or secret");
    return null;
  }

  let timestamp = "";
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k === "t") timestamp = v;
    else if (k === "v1") signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return null;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    console.warn("Stripe webhook timestamp outside tolerance");
    return null;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`)
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (!signatures.includes(expected)) {
    console.warn("Stripe webhook signature mismatch");
    return null;
  }

  try {
    return JSON.parse(payload) as StripeResponse;
  } catch {
    return null;
  }
}

export { stripeRequest };
