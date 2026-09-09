import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Member, MembershipLevel } from "../types";
import { generateId } from "../lib/utils/id";
import { first } from "../lib/db";
import { constructWebhookEvent } from "../lib/stripe";
import {
  sendEmail,
  welcomeEmail,
  eventConfirmationEmail,
  paymentReceiptEmail,
  paymentFailedEmail,
} from "../lib/email";
import { formatMoney } from "../lib/utils/money";
import { portalUrl } from "../lib/memberships";
import {
  buildActivateMembershipStatements,
  buildFulfillOrderStatements,
  buildLegacyProductDecrementStatement,
  buildReleaseOrderStatements,
  buildReleaseSeatStatement,
  findPaymentByStripeRef,
  parseOrderItems,
} from "../lib/fulfillment";
import { prepareEvent, scheduleDispatch } from "../lib/webhookOutbox";
import { enqueueTrigger } from "../lib/automations/triggers";
import type { WebhookEventName } from "../lib/webhookEvents";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

type StripeObject = Record<string, any>;
type WaitUntilCtx = { waitUntil(p: Promise<unknown>): void } | undefined;

/**
 * How long a `processing` inbox row is trusted to be genuinely in flight.
 * A concurrent redelivery inside this window is acknowledged without work
 * (the first worker owns it; if that worker actually died, Stripe retries
 * again later and the stale row is re-claimed then).
 */
const INFLIGHT_LEASE_MS = 5 * 60_000;

export type StripeEventClaim = "claimed" | "done" | "in_flight";

/**
 * Stripe event inbox (PAY-1). INSERT OR IGNORE is the concurrency claim:
 * exactly one delivery of an event id gets `meta.changes === 1`. Every other
 * delivery reads the row and either short-circuits (done / fresh in-flight)
 * or re-claims it (failed / stale in-flight) so the idempotent processing
 * below can run again.
 */
export async function claimStripeEvent(
  db: D1Database,
  eventId: string,
  type: string,
  now: string
): Promise<StripeEventClaim> {
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO stripe_events (id, type, status, attempts, received_at)
       VALUES (?, ?, 'processing', 1, ?)`
    )
    .bind(eventId, type, now)
    .run();
  if ((ins.meta?.changes ?? 0) > 0) return "claimed";

  const row = await first<{ status: string; received_at: string }>(
    db.prepare(`SELECT status, received_at FROM stripe_events WHERE id = ?`).bind(eventId)
  );
  if (!row) return "claimed"; // vanished between insert and read; nothing to defer to
  if (row.status === "done") return "done";
  if (row.status === "processing") {
    const started = Date.parse(row.received_at);
    if (Number.isFinite(started) && Date.now() - started < INFLIGHT_LEASE_MS) {
      return "in_flight";
    }
  }
  const re = await db
    .prepare(
      `UPDATE stripe_events
       SET status = 'processing', attempts = attempts + 1, received_at = ?, last_error = NULL
       WHERE id = ? AND status <> 'done'`
    )
    .bind(now, eventId)
    .run();
  return (re.meta?.changes ?? 0) > 0 ? "claimed" : "done";
}

async function markStripeEvent(
  db: D1Database,
  eventId: string,
  status: "done" | "failed",
  error?: string
): Promise<void> {
  const now = new Date().toISOString();
  if (status === "done") {
    await db
      .prepare(
        `UPDATE stripe_events SET status = 'done', processed_at = ?, last_error = NULL WHERE id = ?`
      )
      .bind(now, eventId)
      .run();
  } else {
    await db
      .prepare(`UPDATE stripe_events SET status = 'failed', last_error = ? WHERE id = ?`)
      .bind((error || "unknown error").slice(0, 2000), eventId)
      .run();
  }
}

/** Hono throws when no ExecutionContext is attached (unit tests); treat as absent. */
function execCtx(c: Context<{ Bindings: Env }>): WaitUntilCtx {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

webhookRoutes.post("/stripe", async (c) => {
  const signature = c.req.header("stripe-signature") || "";
  const payload = await c.req.text();

  const event = await constructWebhookEvent(c.env, payload, signature);
  if (!event) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const type = event.type as string;
  const eventId = typeof event.id === "string" && event.id ? event.id : null;
  console.log("Stripe webhook:", type, eventId);

  if (eventId) {
    const claim = await claimStripeEvent(c.env.DB, eventId, type, new Date().toISOString());
    if (claim !== "claimed") {
      console.log("Stripe webhook deduped", { eventId, claim });
      return c.json({ received: true, deduped: claim });
    }
  }

  try {
    await processStripeEvent(c.env, execCtx(c), event);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("Stripe webhook processing failed", { type, eventId, message });
    if (eventId) {
      try {
        await markStripeEvent(c.env.DB, eventId, "failed", message);
      } catch (e2) {
        console.error("stripe_events: could not record failure", e2);
      }
    }
    // Non-2xx => Stripe redelivers. Safe now: every step above is idempotent.
    return c.json({ error: "Webhook processing failed; will retry" }, 500);
  }

  if (eventId) {
    try {
      await markStripeEvent(c.env.DB, eventId, "done");
    } catch (e) {
      // The work is committed; a missed 'done' stamp only costs a re-claim
      // that finds everything already fulfilled.
      console.error("stripe_events: could not mark done", eventId, e);
    }
  }
  return c.json({ received: true });
});

async function processStripeEvent(
  env: Env,
  ctx: WaitUntilCtx,
  event: StripeObject
): Promise<void> {
  const type = event.type as string;
  const data = (event.data?.object ?? {}) as StripeObject;

  switch (type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(env, ctx, data);
    case "checkout.session.expired":
      return handleCheckoutExpired(env, data);
    case "customer.subscription.deleted":
    case "customer.subscription.updated":
      return handleSubscriptionChange(env, type, data);
    case "account.updated":
      if (typeof data.id === "string") {
        console.log("Connect account.updated", data.id, {
          charges: data.charges_enabled,
          payouts: data.payouts_enabled,
        });
      }
      return;
    case "invoice.paid":
      return handleInvoicePaid(env, data);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(env, data);
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

/**
 * Two idempotent steps:
 *   1. RECORD: INSERT OR IGNORE the payments row (unique on stripe ref), then
 *      read it back. Any retry lands on the same row.
 *   2. FULFILL: if fulfilled_at IS NULL, apply every side effect plus the
 *      outbox events plus `SET fulfilled_at` in ONE atomic batch. Each
 *      statement is conditional, so a concurrent second run is a no-op.
 * Emails are sent after the commit, best-effort, and never fail the event.
 */
async function handleCheckoutCompleted(
  env: Env,
  ctx: WaitUntilCtx,
  session: StripeObject
): Promise<void> {
  const db = env.DB;
  const meta = (session.metadata || {}) as Record<string, string | undefined>;
  const tenantId = meta.tenant_id;
  const memberId = meta.member_id;
  const relatedId = meta.related_id;
  const paymentType = meta.type;
  const now = new Date().toISOString();
  const sessionId = typeof session.id === "string" ? session.id : null;

  // Platform billing: guild pays QuiltHosting (not member dues). Idempotent.
  if (paymentType === "platform" && tenantId) {
    const customerId = (typeof session.customer === "string" && session.customer) || null;
    const subId = (typeof session.subscription === "string" && session.subscription) || null;
    const plan = meta.plan || "starter";
    await db
      .prepare(
        `UPDATE tenants SET
           plan = ?,
           stripe_customer_id = coalesce(?, stripe_customer_id),
           stripe_subscription_id = coalesce(?, stripe_subscription_id),
           updated_at = ?
         WHERE id = ?`
      )
      .bind(plan === "pro" ? "pro" : "starter", customerId, subId, now, tenantId)
      .run();
    console.log("Platform plan activated", { tenantId, plan, subId });
    return;
  }

  // member_id is optional: non-member event registrations have none
  if (!tenantId || (paymentType === "dues" && !memberId)) {
    console.warn("Missing metadata on checkout session", sessionId);
    return;
  }

  const stripeRef =
    (typeof session.payment_intent === "string" && session.payment_intent) || sessionId;
  if (!stripeRef) {
    console.warn("checkout.session.completed without id or payment_intent");
    return;
  }
  const amountTotal = Number(session.amount_total ?? 0) || 0;

  // --- Step 1: record ------------------------------------------------------
  await db
    .prepare(
      `INSERT OR IGNORE INTO payments
       (id, tenant_id, member_id, type, amount_cents, currency, stripe_payment_intent_id,
        status, description, related_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'usd', ?, 'succeeded', ?, ?, ?, ?)`
    )
    .bind(
      generateId(),
      tenantId,
      memberId || null,
      paymentType || "dues",
      amountTotal,
      stripeRef,
      `Checkout ${sessionId ?? stripeRef}`,
      relatedId || null,
      now,
      now
    )
    .run();

  const payment = await findPaymentByStripeRef(db, [stripeRef, sessionId]);
  if (!payment) {
    throw new Error(`payments row missing after insert for ${stripeRef}`);
  }
  if (payment.fulfilled_at) {
    console.log("checkout.session.completed already fulfilled", stripeRef);
    return;
  }
  const paymentId = payment.id;

  // --- Step 2: fulfill (one batch) ----------------------------------------
  const stmts: D1PreparedStatement[] = [];
  const outboxIds: string[] = [];
  const afterCommit: Array<() => Promise<void>> = [];
  // Set when this checkout confirms an event seat, so the automation trigger
  // can fire after the fulfilment batch commits.
  let paidRegistration: { id: string; eventId: string } | null = null;

  const addEvent = (name: WebhookEventName, payload: Record<string, unknown>) => {
    const ev = prepareEvent(env, tenantId, name, payload);
    if (!ev) {
      // Schema failure is a programming error, and deterministic: retrying
      // would never help, so do not block fulfillment on it.
      console.error(`stripe webhook: prepareEvent failed for ${name}; event dropped`);
      return;
    }
    stmts.push(ev.stmt);
    outboxIds.push(ev.id);
  };

  const customerEmail =
    meta.email || (typeof session.customer_email === "string" ? session.customer_email : "") || "";

  if (paymentType) {
    addEvent("payment.succeeded", {
      type: paymentType,
      amount_cents: amountTotal,
      email: customerEmail || null,
      related_id: relatedId ?? null,
      source: "stripe",
    });
  }

  if (paymentType === "donation" || paymentType === "store") {
    if (paymentType === "store") {
      const orderId = meta.order_id;
      if (orderId) {
        const order = await first<{ items_json: string }>(
          db
            .prepare(`SELECT items_json FROM store_orders WHERE id = ? AND tenant_id = ?`)
            .bind(orderId, tenantId)
        );
        if (order) {
          stmts.push(
            ...buildFulfillOrderStatements(db, {
              tenantId,
              orderId,
              paymentId,
              lines: parseOrderItems(order.items_json),
              stripeSessionId: sessionId,
              now,
            })
          );
        } else {
          console.warn("store order missing for checkout", { orderId, tenantId });
        }
      } else if (relatedId) {
        // Legacy single-product session (created before /buy used orders).
        stmts.push(
          buildLegacyProductDecrementStatement(db, {
            tenantId,
            productId: relatedId,
            quantity: Math.max(1, Math.floor(Number(meta.quantity) || 1)),
            paymentId,
            now,
          })
        );
      }
    }
    if (customerEmail) {
      afterCommit.push(async () => {
        const tenant = await first<{ name: string }>(
          db.prepare("SELECT name FROM tenants WHERE id = ?").bind(tenantId)
        );
        if (!tenant) return;
        const { subject, html } = paymentReceiptEmail({
          guildName: tenant.name,
          description:
            paymentType === "store" ? `Store order` : `Donation to ${tenant.name}`,
          amountFormatted: formatMoney(amountTotal),
          typeLabel: paymentType === "store" ? "purchase" : "donation",
        });
        await sendEmail(env, { to: customerEmail, subject, html });
      });
    }
  }

  if (paymentType === "event" && relatedId) {
    const reg = await first<{
      email: string;
      name: string | null;
      ticket_code: string | null;
      event_id: string;
      status: string;
    }>(
      db
        .prepare(
          `SELECT email, name, ticket_code, event_id, status FROM event_registrations
           WHERE id = ? AND tenant_id = ?`
        )
        .bind(relatedId, tenantId)
    );
    if (reg) {
      if (reg.status === "cancelled") {
        // The hold expired and was released before this (late) webhook
        // arrived, but the attendee has paid: seat them anyway and let the
        // admin sort out capacity, rather than keeping money for no seat.
        console.warn("event registration paid after hold release; re-seating", relatedId);
      }
      stmts.push(
        db
          .prepare(
            `UPDATE event_registrations
             SET amount_paid_cents = ?, status = 'registered', hold_expires_at = NULL, updated_at = ?
             WHERE id = ? AND tenant_id = ? AND status IN ('pending_payment', 'registered', 'cancelled')`
          )
          .bind(amountTotal, now, relatedId, tenantId)
      );
      // A paid registration is confirmed here, not on the public route, so
      // this is the only place `event_registered` can fire for it.
      paidRegistration = { id: relatedId, eventId: reg.event_id };
      const eventRow = await first<{ title: string; start_at: string; location: string | null }>(
        db
          .prepare("SELECT title, start_at, location FROM events WHERE id = ? AND tenant_id = ?")
          .bind(reg.event_id, tenantId)
      );
      addEvent("event.registration", {
        registration_id: relatedId,
        event_id: reg.event_id,
        event_title: eventRow?.title ?? "",
        email: reg.email,
        name: reg.name ?? null,
        status: "registered",
        amount_paid_cents: amountTotal,
        ticket_code: reg.ticket_code ?? null,
        source: "stripe",
      });
      if (eventRow) {
        afterCommit.push(async () => {
          const tenant = await first<{ name: string }>(
            db.prepare("SELECT name FROM tenants WHERE id = ?").bind(tenantId)
          );
          if (!tenant) return;
          const eventDate = new Date(eventRow.start_at).toLocaleString("en-US", {
            dateStyle: "full",
            timeStyle: "short",
          });
          const { subject, html } = eventConfirmationEmail({
            guildName: tenant.name,
            firstName: reg.name?.split(" ")[0],
            eventTitle: eventRow.title,
            eventDate,
            eventLocation: eventRow.location ?? undefined,
            amountFormatted: formatMoney(amountTotal),
            ticketCode: reg.ticket_code ?? undefined,
          });
          await sendEmail(env, { to: reg.email, subject, html });
        });
      }
    } else {
      console.warn("event registration missing for checkout", { relatedId, tenantId });
    }
  }

  if (paymentType === "dues" && relatedId && memberId) {
    const level = await first<MembershipLevel>(
      db
        .prepare("SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?")
        .bind(relatedId, tenantId)
    );
    const member = await first<Member>(
      db.prepare("SELECT * FROM members WHERE id = ? AND tenant_id = ?").bind(memberId, tenantId)
    );
    if (level && member) {
      const activation = buildActivateMembershipStatements(db, {
        tenantId,
        memberId,
        level,
        amountPaidCents: amountTotal || level.price_cents,
        paymentId,
        stripeSubscriptionId:
          (typeof session.subscription === "string" && session.subscription) || null,
        autoRenew: level.renewal_type === "auto",
        now,
      });
      stmts.push(...activation.stmts);
      addEvent("membership.activated", {
        member_id: memberId,
        email: member.email,
        level_id: level.id,
        level_name: level.name,
        membership_id: activation.membershipId,
        source: "stripe",
      });
      addEvent("member.activated", {
        member_id: memberId,
        email: member.email,
        level_id: level.id,
        source: "stripe",
      });
      afterCommit.push(async () => {
        const tenant = await first<{ name: string; slug: string }>(
          db.prepare("SELECT name, slug FROM tenants WHERE id = ?").bind(tenantId)
        );
        if (!tenant) return;
        const { subject, html } = welcomeEmail({
          guildName: tenant.name,
          firstName: member.first_name ?? undefined,
          portalUrl: portalUrl(env.APP_URL, tenant.slug),
        });
        await sendEmail(env, { to: member.email, subject, html });
        try {
          const { enrollMemberActivated } = await import("../lib/automations");
          await enrollMemberActivated(env, tenantId, memberId);
        } catch (e) {
          console.warn("automation enroll failed", e);
        }
      });
    } else {
      console.warn("dues checkout: level or member missing", { relatedId, memberId, tenantId });
    }
  }

  // The stamp goes LAST so its meta.changes tells us whether THIS batch won.
  stmts.push(
    db
      .prepare(
        `UPDATE payments SET fulfilled_at = ?, updated_at = ? WHERE id = ? AND fulfilled_at IS NULL`
      )
      .bind(now, now, paymentId)
  );

  // Any failure here propagates to the inbox catch => 500 => Stripe retries,
  // and the retry finds fulfilled_at still NULL and runs this again.
  const results = await db.batch(stmts);
  const stamped = results[results.length - 1]?.meta?.changes ?? 0;
  if (!stamped) {
    console.log("checkout.session.completed fulfilled concurrently; no-op", stripeRef);
    return;
  }

  for (const id of outboxIds) await scheduleDispatch(env, ctx, id);
  // Additive and post-commit: fulfilment is already stamped above, and
  // enqueueTrigger never throws, so an automation can never cost a payer
  // their membership, seat or order.
  await enqueueTrigger(env, tenantId, "payment_received", { id: paymentId, amountCents: amountTotal });
  if (paidRegistration) {
    await enqueueTrigger(env, tenantId, "event_registered", {
      id: paidRegistration.id,
      eventId: paidRegistration.eventId,
    });
  }
  for (const fn of afterCommit) {
    try {
      await fn();
    } catch (e) {
      console.error("stripe webhook: post-commit side effect failed", e);
    }
  }
}

// ---------------------------------------------------------------------------
// checkout.session.expired — release seat / stock holds
// ---------------------------------------------------------------------------

async function handleCheckoutExpired(env: Env, session: StripeObject): Promise<void> {
  const db = env.DB;
  const meta = (session.metadata || {}) as Record<string, string | undefined>;
  const tenantId = meta.tenant_id;
  if (!tenantId) return;
  const now = new Date().toISOString();

  if (meta.type === "event" && meta.related_id) {
    const r = await buildReleaseSeatStatement(db, tenantId, meta.related_id, now).run();
    console.log("checkout.session.expired: seat hold released", {
      registrationId: meta.related_id,
      changed: r.meta?.changes ?? 0,
    });
    return;
  }

  if (meta.type === "store" && meta.order_id) {
    const order = await first<{ items_json: string }>(
      db
        .prepare(`SELECT items_json FROM store_orders WHERE id = ? AND tenant_id = ?`)
        .bind(meta.order_id, tenantId)
    );
    if (!order) return;
    const results = await db.batch(
      buildReleaseOrderStatements(db, {
        tenantId,
        orderId: meta.order_id,
        lines: parseOrderItems(order.items_json),
        now,
        status: "expired",
      })
    );
    console.log("checkout.session.expired: order released", {
      orderId: meta.order_id,
      changed: results[results.length - 1]?.meta?.changes ?? 0,
    });
  }
}

// ---------------------------------------------------------------------------
// customer.subscription.* — platform plan state (idempotent UPDATEs)
// ---------------------------------------------------------------------------

async function handleSubscriptionChange(
  env: Env,
  type: string,
  sub: StripeObject
): Promise<void> {
  const subId = sub?.id as string | undefined;
  const meta = (sub?.metadata || {}) as Record<string, string | undefined>;
  const tenantId = meta.tenant_id;
  const now = new Date().toISOString();

  if (meta.type !== "platform" || !tenantId) return;

  if (type === "customer.subscription.deleted" || sub.status === "canceled") {
    await env.DB.prepare(
      `UPDATE tenants SET plan = 'free', stripe_subscription_id = null, updated_at = ?
       WHERE id = ?`
    )
      .bind(now, tenantId)
      .run();
    console.log("Platform plan cancelled", tenantId);
  } else if (sub.status === "active" || sub.status === "trialing") {
    await env.DB.prepare(
      `UPDATE tenants SET plan = 'starter', stripe_subscription_id = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(subId, now, tenantId)
      .run();
  }
}

// ---------------------------------------------------------------------------
// invoice.paid — subscription renewals (member dues)
// ---------------------------------------------------------------------------

async function handleInvoicePaid(env: Env, invoice: StripeObject): Promise<void> {
  const db = env.DB;
  const invoiceId = invoice?.id as string | undefined;
  const subscriptionId =
    (typeof invoice?.subscription === "string" && invoice.subscription) || null;
  const billingReason = invoice?.billing_reason as string | undefined;
  const amountPaid = Number(invoice?.amount_paid || 0);
  const now = new Date().toISOString();
  const invMeta = (invoice?.subscription_details?.metadata || invoice?.metadata || {}) as Record<
    string,
    string | undefined
  >;
  const firstLineMeta = (invoice?.lines?.data?.[0]?.metadata || {}) as Record<
    string,
    string | undefined
  >;

  // Platform plan invoice — keep plan active; no member payment row
  if (invMeta.type === "platform" || firstLineMeta.type === "platform") {
    const tenantId = invMeta.tenant_id || firstLineMeta.tenant_id;
    if (tenantId && subscriptionId) {
      await db
        .prepare(
          `UPDATE tenants SET plan = 'starter', stripe_subscription_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(subscriptionId, now, tenantId)
        .run();
    }
    return;
  }

  // Also match platform by tenant stripe_subscription_id
  if (subscriptionId) {
    const platformTenant = await first<{ id: string }>(
      db.prepare("SELECT id FROM tenants WHERE stripe_subscription_id = ?").bind(subscriptionId)
    );
    if (platformTenant) {
      await db
        .prepare(`UPDATE tenants SET plan = 'starter', updated_at = ? WHERE id = ?`)
        .bind(now, platformTenant.id)
        .run();
      return;
    }
  }

  if (!invoiceId) return;
  // A 'failed' row for this invoice (from invoice.payment_failed) is NOT
  // "already processed": Stripe retries the same invoice, and when the retry
  // collects, this handler flips that row to succeeded and extends.
  const existingPayment = await first<{ id: string; status: string }>(
    db.prepare(`SELECT id, status FROM payments WHERE stripe_invoice_id = ? LIMIT 1`).bind(invoiceId)
  );
  if (existingPayment && existingPayment.status !== "failed") {
    console.log("invoice.paid already processed", invoiceId);
    return;
  }

  // First invoice is normally handled by checkout.session.completed.
  // Only create membership if we somehow missed checkout; never double-extend.
  if (billingReason === "subscription_create" && subscriptionId) {
    const existing = await first<{ id: string }>(
      db
        .prepare(`SELECT id FROM memberships WHERE stripe_subscription_id = ? LIMIT 1`)
        .bind(subscriptionId)
    );
    if (existing) {
      console.log("invoice.paid subscription_create: membership exists, skip extend", invoiceId);
      return;
    }
    console.warn("invoice.paid subscription_create with no membership — waiting for checkout handler");
    return;
  }

  if (billingReason !== "subscription_cycle" || !subscriptionId) {
    console.log("invoice.paid ignored", { billingReason, subscriptionId, invoiceId });
    return;
  }

  const membership = await first<{
    id: string;
    tenant_id: string;
    member_id: string;
    level_id: string;
    end_date: string | null;
  }>(
    db
      .prepare(
        `SELECT id, tenant_id, member_id, level_id, end_date FROM memberships
         WHERE stripe_subscription_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(subscriptionId)
  );
  if (!membership) {
    console.warn("invoice.paid: no membership for subscription", subscriptionId);
    return;
  }

  const level = await first<MembershipLevel>(
    db
      .prepare("SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?")
      .bind(membership.level_id, membership.tenant_id)
  );
  const duration = level?.duration_months || 12;
  const base =
    membership.end_date && new Date(membership.end_date) > new Date(now)
      ? new Date(membership.end_date)
      : new Date(now);
  base.setMonth(base.getMonth() + duration);
  const newEnd = base.toISOString();

  // Extend + reactivate + record, atomically. The extension is guarded by
  // "this invoice is not yet recorded as anything but failed" so a retry
  // after a partial failure can never extend twice; the INSERT is unique on
  // invoice id, and the trailing UPDATE promotes a prior 'failed' row (the
  // INSERT is ignored in that case) to the successful payment.
  const paymentIntentId =
    (typeof invoice.payment_intent === "string" && invoice.payment_intent) || null;
  const guard = `NOT EXISTS (SELECT 1 FROM payments WHERE stripe_invoice_id = ? AND status <> 'failed')`;
  await db.batch([
    db
      .prepare(
        `UPDATE memberships SET end_date = ?, status = 'active', updated_at = ?
         WHERE id = ? AND ${guard}`
      )
      .bind(newEnd, now, membership.id, invoiceId),
    db
      .prepare(`UPDATE members SET status = 'active', updated_at = ? WHERE id = ?`)
      .bind(now, membership.member_id),
    db
      .prepare(
        `INSERT OR IGNORE INTO payments
         (id, tenant_id, member_id, type, amount_cents, currency, stripe_payment_intent_id,
          stripe_invoice_id, status, description, related_id, fulfilled_at, created_at, updated_at)
         VALUES (?, ?, ?, 'dues', ?, 'usd', ?, ?, 'succeeded', ?, ?, ?, ?, ?)`
      )
      .bind(
        generateId(),
        membership.tenant_id,
        membership.member_id,
        amountPaid,
        paymentIntentId,
        invoiceId,
        `Subscription renewal ${invoiceId}`,
        membership.level_id,
        now,
        now,
        now
      ),
    db
      .prepare(
        `UPDATE payments SET status = 'succeeded', amount_cents = ?,
           stripe_payment_intent_id = coalesce(?, stripe_payment_intent_id),
           description = ?, fulfilled_at = ?, updated_at = ?
         WHERE stripe_invoice_id = ? AND status = 'failed'`
      )
      .bind(amountPaid, paymentIntentId, `Subscription renewal ${invoiceId}`, now, now, invoiceId),
  ]);

  console.log("invoice.paid: extended membership", membership.id);
}

// ---------------------------------------------------------------------------
// invoice.payment_failed — auto-renew charge declined (member dues)
// ---------------------------------------------------------------------------

/**
 * Records one `payments` row with status='failed' per invoice (INSERT OR
 * IGNORE against the unique stripe_invoice_id index) and, only when that
 * insert won, emails the member a transactional "update your card" notice.
 * A redelivery — or Stripe's next failed retry of the same invoice — finds
 * the row and does nothing, so the member is told once per invoice. The
 * membership itself is left alone: Stripe keeps retrying, and the daily
 * renewal job lapses it if the end date passes unpaid.
 */
async function handleInvoicePaymentFailed(env: Env, invoice: StripeObject): Promise<void> {
  const db = env.DB;
  const invoiceId = invoice?.id as string | undefined;
  const subscriptionId =
    (typeof invoice?.subscription === "string" && invoice.subscription) || null;
  const invMeta = (invoice?.subscription_details?.metadata || invoice?.metadata || {}) as Record<
    string,
    string | undefined
  >;
  const firstLineMeta = (invoice?.lines?.data?.[0]?.metadata || {}) as Record<
    string,
    string | undefined
  >;
  if (!invoiceId || !subscriptionId) return;

  // Platform (guild -> QuiltHosting) invoices are not member dues.
  if (invMeta.type === "platform" || firstLineMeta.type === "platform") {
    console.warn("invoice.payment_failed: platform subscription", { invoiceId, subscriptionId });
    return;
  }
  const platformTenant = await first<{ id: string }>(
    db.prepare("SELECT id FROM tenants WHERE stripe_subscription_id = ?").bind(subscriptionId)
  );
  if (platformTenant) {
    console.warn("invoice.payment_failed: platform subscription", {
      invoiceId,
      tenantId: platformTenant.id,
    });
    return;
  }

  const membership = await first<{
    id: string;
    tenant_id: string;
    member_id: string;
    level_id: string;
  }>(
    db
      .prepare(
        `SELECT id, tenant_id, member_id, level_id FROM memberships
         WHERE stripe_subscription_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(subscriptionId)
  );
  if (!membership) {
    console.warn("invoice.payment_failed: no membership for subscription", subscriptionId);
    return;
  }

  const amountDue = Number(invoice?.amount_due ?? invoice?.amount_remaining ?? 0) || 0;
  const now = new Date().toISOString();
  // Bind order matters for the unique-ref idiom: stripe_payment_intent_id is
  // left NULL so the failed attempt never collides with the PI a later
  // successful charge records.
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO payments
       (id, tenant_id, member_id, type, amount_cents, currency, stripe_payment_intent_id,
        stripe_invoice_id, status, description, related_id, created_at, updated_at)
       VALUES (?, ?, ?, 'dues', ?, 'usd', ?, ?, 'failed', ?, ?, ?, ?)`
    )
    .bind(
      generateId(),
      membership.tenant_id,
      membership.member_id,
      amountDue,
      null,
      invoiceId,
      `Subscription renewal failed ${invoiceId}`,
      membership.level_id,
      now,
      now
    )
    .run();
  if ((ins.meta?.changes ?? 0) === 0) {
    console.log("invoice.payment_failed already recorded", invoiceId);
    return;
  }

  // Post-record side effect: best-effort, never fails the event.
  try {
    const member = await first<{ email: string; first_name: string | null }>(
      db
        .prepare("SELECT email, first_name FROM members WHERE id = ? AND tenant_id = ?")
        .bind(membership.member_id, membership.tenant_id)
    );
    const tenant = await first<{ name: string; slug: string }>(
      db.prepare("SELECT name, slug FROM tenants WHERE id = ?").bind(membership.tenant_id)
    );
    if (!member?.email || !tenant) return;
    const { subject, html } = paymentFailedEmail({
      guildName: tenant.name,
      firstName: member.first_name ?? undefined,
      amountFormatted: formatMoney(amountDue),
      renewUrl: portalUrl(env.APP_URL, tenant.slug, { renew: "1" }),
    });
    const sent = await sendEmail(env, {
      to: member.email,
      subject,
      html,
      tenantId: membership.tenant_id,
      tags: [{ name: "template", value: "payment_failed" }],
    });
    try {
      await db
        .prepare(
          `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
           VALUES (?, ?, ?, ?, 'payment_failed', ?, ?, ?)`
        )
        .bind(
          generateId(),
          membership.tenant_id,
          membership.member_id,
          member.email,
          sent.id || null,
          sent.success ? "sent" : "failed",
          now
        )
        .run();
    } catch (e) {
      console.warn("email_logs insert failed", e);
    }
  } catch (e) {
    console.error("invoice.payment_failed: notice failed", e);
  }
}
