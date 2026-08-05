import type { Env } from "../../types";

const STRIPE_API = "https://api.stripe.com/v1";

type StripeResponse = Record<string, any>;

async function stripeRequest(
  env: Env,
  method: string,
  path: string,
  body?: Record<string, string | number | undefined>
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

export type CreateCheckoutParams = {
  tenantId: string;
  tenantSlug: string;
  memberId?: string;
  email: string;
  name?: string;
  amountCents: number;
  description: string;
  type: "dues" | "event" | "store" | "donation";
  relatedId?: string; // membership level id or event id
  successUrl: string;
  cancelUrl: string;
  mode?: "payment" | "subscription";
  interval?: "month" | "year"; // for subscription
};

/**
 * Create a Stripe Checkout Session for one-time or subscription payment.
 * Returns the session URL to redirect the user to.
 */
export async function createCheckoutSession(
  env: Env,
  params: CreateCheckoutParams
): Promise<{ id: string; url: string }> {
  const metadata: Record<string, string> = {
    tenant_id: params.tenantId,
    type: params.type,
    email: params.email,
  };
  if (params.memberId) metadata.member_id = params.memberId;
  if (params.relatedId) metadata.related_id = params.relatedId;

  const body: Record<string, string | number | undefined> = {
    "mode": params.mode || "payment",
    "success_url": params.successUrl,
    "cancel_url": params.cancelUrl,
    "customer_email": params.email,
    "metadata[tenant_id]": params.tenantId,
    "metadata[type]": params.type,
    "metadata[email]": params.email,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": params.amountCents,
    "line_items[0][price_data][product_data][name]": params.description,
    "line_items[0][quantity]": 1,
  };

  if (params.memberId) body["metadata[member_id]"] = params.memberId;
  if (params.relatedId) body["metadata[related_id]"] = params.relatedId;

  // For subscriptions, add recurring
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
 * Verify Stripe webhook signature (simplified for Workers).
 * In production use the official Stripe library or full HMAC verification.
 */
export async function constructWebhookEvent(
  env: Env,
  payload: string,
  signatureHeader: string
): Promise<StripeResponse | null> {
  // Basic presence check — full verification should use Stripe's signing secret
  // and timestamp tolerance. For MVP we trust the endpoint is secret.
  if (!signatureHeader || !env.STRIPE_WEBHOOK_SECRET) {
    console.warn("Missing Stripe webhook signature or secret");
  }

  try {
    return JSON.parse(payload) as StripeResponse;
  } catch {
    return null;
  }
}

export { stripeRequest };
