// Stripe webhook inbox + idempotent fulfillment (PAY-1).
//
// Same fake-D1 idiom as public.test.ts: dispatch through the exported Hono
// app with a stateful fake D1 that records every statement and simulates
// the handful of tables the handler touches (stripe_events, payments,
// event_registrations), so assertions check what actually committed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";

// Signature verification is exercised by the real constructWebhookEvent; here
// the payload is trusted so the tests can focus on inbox + fulfillment.
vi.mock("../lib/stripe", () => ({
  constructWebhookEvent: vi.fn(async (_env: unknown, payload: string) => JSON.parse(payload)),
}));

// Templates are the real ones; only the provider call is stubbed so tests
// can count notices without RESEND_API_KEY.
const email = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_env: unknown, _params: unknown) => ({ id: "msg_1", success: true })),
}));
vi.mock("../lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/email")>()),
  sendEmail: email.sendEmail,
}));

import { webhookRoutes } from "./webhooks";

const TENANT_ID = "tenant-1";
type Row = Record<string, any>;

function changes(n: number) {
  return { success: true, meta: { changes: n } };
}

function harness(
  opts: {
    stripeEvents?: Record<string, { status: string; received_at: string; attempts?: number }>;
    registrations?: Record<string, Row>;
    orders?: Record<string, Row>;
    level?: Row | null;
    member?: Row | null;
    /** memberships row matched by stripe_subscription_id (invoice.* handlers). */
    membership?: Row | null;
    /** Throw when a batch containing these SQL fragments runs; fires once per fragment. */
    failBatchOnce?: string[];
  } = {}
) {
  const stripeEvents = new Map(Object.entries(opts.stripeEvents ?? {}));
  const payments = new Map<
    string,
    { id: string; fulfilled_at: string | null; status: string; amount_cents?: unknown }
  >();
  const registrations = new Map(Object.entries(opts.registrations ?? {}));
  const orders = new Map(Object.entries(opts.orders ?? {}));
  const runs: { sql: string; binds: unknown[]; changes: number }[] = [];
  const batches: { sql: string; binds: unknown[] }[][] = [];
  const pendingFailures = new Set(opts.failBatchOnce ?? []);

  function exec(sql: string, binds: unknown[]) {
    let n = 1;
    if (sql.startsWith("INSERT OR IGNORE INTO stripe_events")) {
      const [id, type, now] = binds as string[];
      if (stripeEvents.has(id)) n = 0;
      else stripeEvents.set(id, { status: "processing", received_at: now, attempts: 1, type } as any);
    } else if (sql.includes("UPDATE stripe_events") && sql.includes("attempts = attempts + 1")) {
      const row = stripeEvents.get(binds[1] as string);
      if (!row || row.status === "done") n = 0;
      else {
        row.status = "processing";
        row.received_at = binds[0] as string;
        row.attempts = (row.attempts ?? 1) + 1;
      }
    } else if (sql.includes("UPDATE stripe_events SET status = 'done'")) {
      const row = stripeEvents.get(binds[1] as string);
      if (row) row.status = "done";
      else n = 0;
    } else if (sql.includes("UPDATE stripe_events SET status = 'failed'")) {
      const row = stripeEvents.get(binds[1] as string);
      if (row) row.status = "failed";
      else n = 0;
    } else if (sql.startsWith("INSERT OR IGNORE INTO payments")) {
      // binds[5] is the unique Stripe ref in every INSERT the handler issues
      // (payment_intent / session id for checkout, invoice id for invoice.*).
      const ref = binds[5] as string;
      if (payments.has(ref)) n = 0;
      else {
        payments.set(ref, {
          id: binds[0] as string,
          fulfilled_at: sql.includes("fulfilled_at") ? "stamped" : null,
          status: sql.includes("'failed'") ? "failed" : "succeeded",
          amount_cents: binds[3],
        });
      }
    } else if (sql.includes("UPDATE payments SET status = 'succeeded'")) {
      const p = payments.get(binds[5] as string);
      if (p && p.status === "failed") {
        p.status = "succeeded";
        p.amount_cents = binds[0];
        p.fulfilled_at = binds[3] as string;
      } else n = 0;
    } else if (sql.includes("UPDATE memberships SET end_date")) {
      const invoiceId = binds[3] as string;
      const p = payments.get(invoiceId);
      if (p && p.status !== "failed") n = 0;
      else if (opts.membership) (opts.membership as Row).end_date = binds[0];
    } else if (sql.includes("UPDATE payments SET fulfilled_at")) {
      const id = binds[2] as string;
      const p = [...payments.values()].find((x) => x.id === id);
      if (!p || p.fulfilled_at) n = 0;
      else p.fulfilled_at = binds[0] as string;
    } else if (sql.includes("UPDATE event_registrations") && sql.includes("status = 'registered'")) {
      const reg = registrations.get(binds[2] as string);
      if (reg && ["pending_payment", "registered", "cancelled"].includes(reg.status)) {
        reg.status = "registered";
        reg.amount_paid_cents = binds[0];
      } else n = 0;
    } else if (sql.includes("UPDATE event_registrations SET status = 'cancelled'")) {
      const reg = registrations.get(binds[1] as string);
      if (reg && reg.status === "pending_payment") reg.status = "cancelled";
      else n = 0;
    } else if (sql.includes("UPDATE store_orders SET status = ?")) {
      const o = orders.get(binds[2] as string);
      if (o && o.status === "pending" && o.reserved_at) {
        o.status = binds[0];
        o.reserved_at = null;
      } else n = 0;
    } else if (sql.includes("UPDATE store_orders SET") && sql.includes("status = 'paid'")) {
      const o = orders.get(binds[3] as string);
      if (o && o.status !== "paid") o.status = "paid";
      else n = 0;
    }
    runs.push({ sql, binds, changes: n });
    return changes(n);
  }

  function firstRow(sql: string, binds: unknown[]): Row | null {
    if (sql.includes("FROM stripe_events")) return stripeEvents.get(binds[0] as string) ?? null;
    if (sql.includes("FROM payments")) {
      for (const b of binds as string[]) {
        const p = payments.get(b);
        if (p) return { id: p.id, fulfilled_at: p.fulfilled_at, status: p.status };
      }
      return null;
    }
    if (sql.includes("FROM event_registrations")) return registrations.get(binds[0] as string) ?? null;
    if (sql.includes("FROM events")) {
      return { title: "Spring Retreat", start_at: "2026-10-01T15:00:00.000Z", location: null };
    }
    if (sql.includes("FROM memberships")) {
      return opts.membership && opts.membership.stripe_subscription_id === binds[0]
        ? opts.membership
        : null;
    }
    // Platform-plan lookup by subscription: no tenant pays through these tests.
    if (sql.includes("FROM tenants") && sql.includes("stripe_subscription_id")) return null;
    if (sql.includes("FROM tenants")) return { name: "Test Guild", slug: "testguild" };
    if (sql.includes("FROM store_orders")) return orders.get(binds[0] as string) ?? null;
    if (sql.includes("FROM membership_levels")) return opts.level ?? null;
    if (sql.includes("FROM members")) return opts.member ?? null;
    return null;
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            __sql: sql,
            __binds: binds,
            async first() {
              return firstRow(sql, binds);
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return exec(sql, binds);
            },
          };
        },
      };
    },
    async batch(stmts: { __sql: string; __binds: unknown[]; run: () => Promise<unknown> }[]) {
      const recorded = stmts.map((s) => ({ sql: s.__sql, binds: s.__binds }));
      batches.push(recorded);
      for (const frag of [...pendingFailures]) {
        if (recorded.some((r) => r.sql.includes(frag))) {
          pendingFailures.delete(frag);
          throw new Error(`D1_ERROR: injected failure on batch containing ${frag}`);
        }
      }
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  };

  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/webhooks", webhookRoutes);
  const env = {
    DB: db,
    APP_URL: "https://quilthosting.com",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  } as unknown as Env;

  const deliver = (event: Row) =>
    app.request(
      "/api/webhooks/stripe",
      {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=stub", "Content-Type": "application/json" },
        body: JSON.stringify(event),
      },
      env
    );

  const fulfillmentBatches = () =>
    batches.filter((b) => b.some((s) => s.sql.includes("UPDATE payments SET fulfilled_at")));

  return { app, env, deliver, runs, batches, fulfillmentBatches, stripeEvents, payments, registrations, orders };
}

function checkoutCompleted(over: Partial<Row> = {}, meta: Row = {}): Row {
  return {
    id: over.eventId ?? "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        payment_intent: "pi_1",
        amount_total: 2500,
        customer_email: "jo@example.com",
        metadata: {
          tenant_id: TENANT_ID,
          type: "event",
          related_id: "reg-1",
          email: "jo@example.com",
          ...meta,
        },
        ...over.session,
      },
    },
  };
}

function invoiceEvent(
  type: "invoice.paid" | "invoice.payment_failed",
  over: { eventId?: string; metadata?: Row } = {}
): Row {
  return {
    id: over.eventId ?? "evt_inv",
    type,
    data: {
      object: {
        id: "in_1",
        subscription: "sub_1",
        billing_reason: "subscription_cycle",
        amount_due: 3500,
        amount_paid: type === "invoice.paid" ? 3500 : 0,
        payment_intent: "pi_inv_1",
        metadata: over.metadata ?? {},
        lines: { data: [{ metadata: {} }] },
      },
    },
  };
}

const pendingReg = () => ({
  "reg-1": {
    id: "reg-1",
    email: "jo@example.com",
    name: "Jo Quilter",
    ticket_code: "EV-1",
    event_id: "ev-1",
    status: "pending_payment",
  },
});

describe("POST /api/webhooks/stripe — inbox + idempotent fulfillment", () => {
  beforeEach(() => {
    email.sendEmail.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("(a) the same checkout.session.completed delivered twice records one payment and runs one fulfillment batch", async () => {
    const h = harness({ registrations: pendingReg() });

    const r1 = await h.deliver(checkoutCompleted());
    expect(r1.status).toBe(200);
    const r2 = await h.deliver(checkoutCompleted());
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ received: true, deduped: "done" });

    expect(h.payments.size).toBe(1);
    expect(h.fulfillmentBatches().length).toBe(1);
    expect(h.registrations.get("reg-1")!.status).toBe("registered");
    expect(h.stripeEvents.get("evt_1")!.status).toBe("done");
  });

  it("fulfillment batch carries the reg flip, both outbox events, and the fulfilled_at stamp LAST — atomically", async () => {
    const h = harness({ registrations: pendingReg() });
    await h.deliver(checkoutCompleted());

    const [batch] = h.fulfillmentBatches();
    const sqls = batch.map((s) => s.sql);
    expect(sqls.filter((s) => s.startsWith("INSERT INTO webhook_outbox")).length).toBe(2);
    expect(sqls.some((s) => s.includes("UPDATE event_registrations") && s.includes("status = 'registered'"))).toBe(true);
    expect(sqls[sqls.length - 1]).toContain("UPDATE payments SET fulfilled_at");
    // The stamp is conditional so a concurrent run cannot both "win".
    expect(sqls[sqls.length - 1]).toContain("fulfilled_at IS NULL");
    // The reg flip is conditional on the row still being unpaid/pending.
    const regFlip = sqls.find((s) => s.includes("UPDATE event_registrations"))!;
    expect(regFlip).toMatch(/status IN \('pending_payment'/);
    // Payment is recorded BEFORE the batch, with OR IGNORE against the unique ref index.
    const insert = h.runs.find((r) => r.sql.startsWith("INSERT OR IGNORE INTO payments"))!;
    expect(insert).toBeTruthy();
    expect(insert.binds[5]).toBe("pi_1");
  });

  it("(b) a concurrent delivery that finds a fresh in-flight inbox row returns 200 without touching payments", async () => {
    const h = harness({
      stripeEvents: { evt_1: { status: "processing", received_at: new Date().toISOString() } },
      registrations: pendingReg(),
    });
    const r = await h.deliver(checkoutCompleted());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, deduped: "in_flight" });
    expect(h.payments.size).toBe(0);
    expect(h.fulfillmentBatches().length).toBe(0);
    expect(h.registrations.get("reg-1")!.status).toBe("pending_payment");
  });

  it("a STALE in-flight row (older than the lease) is re-claimed and processed", async () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const h = harness({
      stripeEvents: { evt_1: { status: "processing", received_at: stale } },
      registrations: pendingReg(),
    });
    const r = await h.deliver(checkoutCompleted());
    expect(r.status).toBe(200);
    expect(h.stripeEvents.get("evt_1")!.attempts).toBe(2);
    expect(h.stripeEvents.get("evt_1")!.status).toBe("done");
    expect(h.registrations.get("reg-1")!.status).toBe("registered");
  });

  it("(c) a crash after the payment INSERT returns 500 (so Stripe retries) and the retry fulfills without a second payment", async () => {
    const h = harness({
      registrations: pendingReg(),
      failBatchOnce: ["UPDATE payments SET fulfilled_at"],
    });

    const r1 = await h.deliver(checkoutCompleted());
    expect(r1.status).toBe(500);
    expect(h.payments.size).toBe(1);
    expect([...h.payments.values()][0].fulfilled_at).toBeNull();
    expect(h.registrations.get("reg-1")!.status).toBe("pending_payment");
    expect(h.stripeEvents.get("evt_1")!.status).toBe("failed");
    const failMark = h.runs.find((x) => x.sql.includes("SET status = 'failed'"))!;
    expect(failMark.binds[0]).toMatch(/injected failure/);

    const r2 = await h.deliver(checkoutCompleted());
    expect(r2.status).toBe(200);
    expect(h.payments.size).toBe(1);
    expect([...h.payments.values()][0].fulfilled_at).not.toBeNull();
    expect(h.registrations.get("reg-1")!.status).toBe("registered");
    expect(h.fulfillmentBatches().length).toBe(2); // one failed, one succeeded
    expect(h.stripeEvents.get("evt_1")!.status).toBe("done");
    expect(h.stripeEvents.get("evt_1")!.attempts).toBe(2);
  });

  it("a payment already fulfilled (e.g. a redelivery under a NEW event id) is a no-op", async () => {
    const h = harness({ registrations: pendingReg() });
    await h.deliver(checkoutCompleted());
    const r = await h.deliver(checkoutCompleted({ eventId: "evt_2" }));
    expect(r.status).toBe(200);
    expect(h.payments.size).toBe(1);
    expect(h.fulfillmentBatches().length).toBe(1);
  });

  it("(d) checkout.session.expired releases an event seat hold (pending_payment -> cancelled only)", async () => {
    const h = harness({ registrations: pendingReg() });
    const r = await h.deliver({
      id: "evt_exp",
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_1",
          metadata: { tenant_id: TENANT_ID, type: "event", related_id: "reg-1" },
        },
      },
    });
    expect(r.status).toBe(200);
    expect(h.registrations.get("reg-1")!.status).toBe("cancelled");
    const rel = h.runs.find((x) => x.sql.includes("UPDATE event_registrations SET status = 'cancelled'"))!;
    expect(rel.sql).toContain("status = 'pending_payment'");
    expect(rel.changes).toBe(1);
  });

  it("(d) checkout.session.expired restocks and expires a reserved store order in one guarded batch", async () => {
    const h = harness({
      orders: {
        "ord-1": {
          id: "ord-1",
          status: "pending",
          reserved_at: "2026-09-08T00:00:00.000Z",
          items_json: JSON.stringify([
            { product_id: "prod-A", quantity: 2 },
            { product_id: "prod-B", quantity: 1 },
          ]),
        },
      },
    });
    const r = await h.deliver({
      id: "evt_exp2",
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_2",
          metadata: { tenant_id: TENANT_ID, type: "store", order_id: "ord-1" },
        },
      },
    });
    expect(r.status).toBe(200);
    const batch = h.batches.find((b) => b.some((s) => s.sql.includes("inventory = inventory + ?")))!;
    expect(batch).toBeTruthy();
    const restocks = batch.filter((s) => s.sql.includes("inventory = inventory + ?"));
    expect(restocks.map((s) => [s.binds[0], s.binds[2]])).toEqual([
      [2, "prod-A"],
      [1, "prod-B"],
    ]);
    for (const s of restocks) expect(s.sql).toMatch(/status = 'pending' AND reserved_at IS NOT NULL/);
    expect(batch[batch.length - 1].sql).toContain("UPDATE store_orders SET status = ?");
    expect(h.orders.get("ord-1")!.status).toBe("expired");
  });

  it("store order fulfillment flips the order to paid without a second decrement for reserved stock", async () => {
    const h = harness({
      orders: {
        "ord-1": {
          id: "ord-1",
          status: "pending",
          reserved_at: "2026-09-08T00:00:00.000Z",
          items_json: JSON.stringify([{ product_id: "prod-A", quantity: 2 }]),
        },
      },
    });
    const r = await h.deliver(
      checkoutCompleted({}, { type: "store", related_id: "ord-1", order_id: "ord-1" })
    );
    expect(r.status).toBe(200);
    const [batch] = h.fulfillmentBatches();
    const dec = batch.find((s) => s.sql.includes("inventory - ?"))!;
    // The decrement exists but is guarded so it only applies when stock is
    // NOT currently reserved (legacy order / released hold) and the payment
    // is still unfulfilled.
    expect(dec.sql).toContain("reserved_at IS NULL");
    expect(dec.sql).toContain("fulfilled_at IS NULL");
    expect(batch.some((s) => s.sql.includes("status = 'paid'"))).toBe(true);
    expect(h.orders.get("ord-1")!.status).toBe("paid");
  });

  it("dues fulfillment batches the membership activation (guarded INSERT) with the payment stamp", async () => {
    const h = harness({
      level: {
        id: "lvl-1",
        name: "Regular",
        price_cents: 4000,
        duration_months: 12,
        renewal_type: "manual",
      },
      member: { id: "mem-1", email: "jo@example.com", first_name: "Jo" },
    });
    const r = await h.deliver(
      checkoutCompleted({}, { type: "dues", related_id: "lvl-1", member_id: "mem-1" })
    );
    expect(r.status).toBe(200);
    const [batch] = h.fulfillmentBatches();
    const ins = batch.find((s) => s.sql.includes("INSERT INTO memberships"))!;
    expect(ins.sql).toMatch(/SELECT[\s\S]*WHERE EXISTS \(SELECT 1 FROM payments WHERE id = \? AND fulfilled_at IS NULL\)/);
    expect(batch.filter((s) => s.sql.startsWith("INSERT INTO webhook_outbox")).length).toBe(3);
    expect(batch[batch.length - 1].sql).toContain("UPDATE payments SET fulfilled_at");
  });

  it("(e) invoice.payment_failed records ONE failed payment and sends ONE notice across redelivery and a second failed attempt", async () => {
    const h = harness({
      membership: { id: "ms-1", tenant_id: TENANT_ID, member_id: "mem-1", level_id: "lvl-1", stripe_subscription_id: "sub_1" },
      member: { id: "mem-1", email: "jo@example.com", first_name: "Jo" },
    });
    // Same event id twice (Stripe redelivery), then Stripe's next retry of
    // the same invoice under a new event id.
    expect((await h.deliver(invoiceEvent("invoice.payment_failed", { eventId: "evt_f1" }))).status).toBe(200);
    expect((await h.deliver(invoiceEvent("invoice.payment_failed", { eventId: "evt_f1" }))).status).toBe(200);
    expect((await h.deliver(invoiceEvent("invoice.payment_failed", { eventId: "evt_f2" }))).status).toBe(200);

    const inserts = h.runs.filter((r) => r.sql.startsWith("INSERT OR IGNORE INTO payments"));
    expect(inserts.length).toBe(2); // second attempt tried and was ignored
    expect(inserts.filter((r) => r.changes === 1).length).toBe(1);
    expect(h.payments.get("in_1")).toMatchObject({ status: "failed", amount_cents: 3500 });
    expect(inserts[0].sql).toContain("'failed'");
    // Keyed by invoice id, never by a payment intent (no PI collision later).
    expect(inserts[0].binds[4]).toBeNull();
    expect(inserts[0].binds[5]).toBe("in_1");

    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    const params = email.sendEmail.mock.calls[0][1] as Row;
    expect(params.to).toBe("jo@example.com");
    expect(params.subject).toMatch(/payment failed/i);
    expect(params.html).toContain("https://quilthosting.com/portal?slug=testguild&renew=1");
    expect(h.runs.filter((r) => r.sql.includes("INSERT INTO email_logs")).length).toBe(1);
    // The membership itself is untouched: Stripe keeps retrying.
    expect(h.runs.some((r) => r.sql.includes("UPDATE memberships"))).toBe(false);
  });

  it("(e) invoice.paid after a failed attempt promotes the failed row to succeeded and extends the membership once", async () => {
    const membership = { id: "ms-1", tenant_id: TENANT_ID, member_id: "mem-1", level_id: "lvl-1", stripe_subscription_id: "sub_1", end_date: "2026-12-31T00:00:00.000Z" };
    const h = harness({
      membership,
      member: { id: "mem-1", email: "jo@example.com", first_name: "Jo" },
      level: { id: "lvl-1", duration_months: 12 },
    });
    await h.deliver(invoiceEvent("invoice.payment_failed", { eventId: "evt_f1" }));
    expect((await h.deliver(invoiceEvent("invoice.paid", { eventId: "evt_p1" }))).status).toBe(200);

    expect(h.payments.size).toBe(1);
    expect(h.payments.get("in_1")).toMatchObject({ status: "succeeded", amount_cents: 3500 });
    expect(membership.end_date.slice(0, 10)).toBe("2027-12-31");
    const batch = h.batches.find((b) => b.some((s) => s.sql.includes("UPDATE memberships SET end_date")))!;
    expect(batch[0].sql).toContain("status <> 'failed'");
    expect(batch[batch.length - 1].sql).toContain("UPDATE payments SET status = 'succeeded'");

    // Redelivery of the paid event: nothing extends twice.
    await h.deliver(invoiceEvent("invoice.paid", { eventId: "evt_p2" }));
    expect(membership.end_date.slice(0, 10)).toBe("2027-12-31");
    expect(h.batches.filter((b) => b.some((s) => s.sql.includes("UPDATE memberships SET end_date"))).length).toBe(1);
  });

  it("(e) invoice.payment_failed for a platform subscription records nothing and emails nobody", async () => {
    const h = harness({ membership: null });
    const r = await h.deliver(
      invoiceEvent("invoice.payment_failed", { eventId: "evt_f3", metadata: { type: "platform", tenant_id: TENANT_ID } })
    );
    expect(r.status).toBe(200);
    expect(h.payments.size).toBe(0);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable payload with 400 and never touches the inbox", async () => {
    const { constructWebhookEvent } = await import("../lib/stripe");
    (constructWebhookEvent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const h = harness();
    const r = await h.deliver(checkoutCompleted());
    expect(r.status).toBe(400);
    expect(h.runs.length).toBe(0);
  });
});

describe("paid dues honour the level's membership year", () => {
  it("a calendar-year level ends on its anchor, not a year from the payment", async () => {
    const { buildActivateMembershipStatements } = await import("../lib/fulfillment");
    const db = {
      prepare(sql: string) {
        return { bind: (...binds: unknown[]) => ({ sql, binds }) };
      },
    } as unknown as D1Database;
    const level = {
      id: "lvl", tenant_id: "t1", name: "Annual", description: null,
      price_cents: 3500, duration_months: 12, renewal_type: "manual" as const,
      term_mode: "calendar", term_anchor: null, proration: "none", grace_days: 0,
      benefits_json: "[]", is_public: 1, sort_order: 0, status: "active",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    };
    const { stmts } = buildActivateMembershipStatements(db, {
      tenantId: "t1", memberId: "m1", level, amountPaidCents: 3500,
      paymentId: "p1", stripeSubscriptionId: null, autoRenew: false,
      now: "2026-10-15T12:00:00.000Z",
    });
    const insert = (stmts as unknown as { sql: string; binds: unknown[] }[]).find((s) =>
      s.sql.includes("INSERT INTO memberships")
    )!;
    const endDate = String(insert.binds.find((b) => String(b).startsWith("2026-12-31")) || "");
    expect(endDate).toMatch(/^2026-12-31/);
  });

  it("an untouched anniversary level is unchanged", async () => {
    const { buildActivateMembershipStatements } = await import("../lib/fulfillment");
    const db = {
      prepare(sql: string) {
        return { bind: (...binds: unknown[]) => ({ sql, binds }) };
      },
    } as unknown as D1Database;
    const level = {
      id: "lvl", tenant_id: "t1", name: "Annual", description: null,
      price_cents: 3500, duration_months: 12, renewal_type: "manual" as const,
      benefits_json: "[]", is_public: 1, sort_order: 0, status: "active",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    };
    const { stmts } = buildActivateMembershipStatements(db, {
      tenantId: "t1", memberId: "m1", level, amountPaidCents: 3500,
      paymentId: "p1", stripeSubscriptionId: null, autoRenew: false,
      now: "2026-10-15T12:00:00.000Z",
    });
    const insert = (stmts as unknown as { sql: string; binds: unknown[] }[]).find((s) =>
      s.sql.includes("INSERT INTO memberships")
    )!;
    expect(insert.binds.some((b) => String(b).startsWith("2027-10-15"))).toBe(true);
  });
});
