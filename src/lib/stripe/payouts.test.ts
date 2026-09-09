// src/lib/stripe/payouts.test.ts
//
// A tenant with no connected Stripe account must not be able to take money.
//
// Every type createCheckoutSession handles — dues, event, store, donation — is
// the GUILD's money. With no connected account there is no destination on the
// charge, so Stripe puts it in the PLATFORM's balance: the member is charged,
// the guild is never paid, and QuiltMap holds funds it has no record of owing.
// A live guild with payouts unconnected was one click from exactly that.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createCheckoutSession, PayoutsNotConnectedError } from "./index";
import type { Env } from "../../types";

const env = { STRIPE_SECRET_KEY: "sk_test_x", APP_URL: "https://quilthosting.com" } as unknown as Env;
const base = {
  tenantId: "t1",
  tenantSlug: "guild",
  email: "member@example.test",
  amountCents: 5500,
  description: "Quilting class",
  type: "event" as const,
  successUrl: "https://quilthosting.com/ok",
  cancelUrl: "https://quilthosting.com/no",
};

afterEach(() => vi.unstubAllGlobals());

describe("createCheckoutSession without a connected account", () => {
  it("refuses, and never reaches Stripe", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const stripeAccountId of [undefined, null, "", "not-an-account", "cus_123"]) {
      await expect(createCheckoutSession(env, { ...base, stripeAccountId })).rejects.toBeInstanceOf(
        PayoutsNotConnectedError
      );
    }
    expect(fetchSpy, "no request should be made").not.toHaveBeenCalled();
  });

  it("proceeds with a real connected account, and sends the destination", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/x" }), { status: 200 });
    });
    const out = await createCheckoutSession(env, { ...base, stripeAccountId: "acct_123" });
    expect(out).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/x" });
    // The destination is what sends the money to the guild rather than us.
    expect(decodeURIComponent(calls[0])).toContain("payment_intent_data[transfer_data][destination]=acct_123");
  });
});
