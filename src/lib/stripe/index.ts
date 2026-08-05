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
  relatedId?: string;
  successUrl: string;
  cancelUrl: string;
  mode?: "payment" | "subscription";
  interval?: "month" | "year";
};

export async function createCheckoutSession(
  env: Env,
  params: CreateCheckoutParams
): Promise<{ id: string; url: string }> {
  const body: Record<string, string | number | undefined> = {
    mode: params.mode || "payment",
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer_email: params.email,
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

  if (params.mode === "subscription" && params.interval) {
    body["line_items[0][price_data][recurring][interval]"] = params.interval;
  }

  const session = await stripeRequest(env, "POST", "/checkout/sessions", body);

  return {
    id: session.id,
    url: session.url,
  };
}

export async function constructWebhookEvent(
  env: Env,
  payload: string,
  signatureHeader: string
): Promise<StripeResponse | null> {
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
