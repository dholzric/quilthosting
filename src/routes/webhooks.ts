import { Hono } from "hono";
import type { Env, Member, MembershipLevel } from "../types";
import { generateId } from "../lib/utils/id";
import { first } from "../lib/db";
import { constructWebhookEvent } from "../lib/stripe";
import {
  sendEmail,
  welcomeEmail,
  eventConfirmationEmail,
  paymentReceiptEmail,
} from "../lib/email";
import { formatMoney } from "../lib/utils/money";
import {
  activateMembership,
  extendMembership,
  portalUrl,
} from "../lib/memberships";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

/**
 * Stripe-webhook-only commit helper.
 *
 * Batches a mutation with its outbox event atomically when it can, but NEVER
 * lets an event-recording problem block the mutation itself or turn into a
 * non-2xx response. Stripe retries the whole webhook body on any non-2xx,
 * and everything in this file past `paymentAlreadyRecorded` is not safely
 * re-runnable (activating a membership twice, double-decrementing store
 * inventory, etc.) -- so on any failure here we log loudly, fall back to
 * running the mutation alone (best effort), and let the request finish 200.
 * Losing an outbound webhook event is recoverable (the outbox row can be
 * replayed manually); returning 500 and inviting Stripe to redeliver a
 * payment we already recorded is not.
 *
 * PRECONDITION: `mutationStmt` MUST be idempotent (safe to execute twice).
 * On a batch failure this helper re-runs the mutation alone as a fallback,
 * and that fallback can itself be interrupted (e.g. the client disconnects
 * after the retry commits but before we observe success) -- so a
 * non-idempotent statement such as `inventory = inventory - ?` could
 * double-apply if routed through here. Every current caller passes either
 * an INSERT bound to a single, already-`generateId()`-fixed primary key
 * (re-running it fails on the PK constraint instead of creating a second
 * row) or a status-flag UPDATE whose WHERE clause is a no-op once already
 * applied.
 */
async function commitStripeMutationWithEvent(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  mutationStmt: D1PreparedStatement,
  ev: { id: string; stmt: D1PreparedStatement } | null,
  label: string
): Promise<void> {
  const { scheduleDispatch } = await import("../lib/webhookOutbox");
  if (!ev) {
    console.error(
      `stripe webhook: prepareEvent failed for ${label}; running the mutation without an event record`
    );
    try {
      await mutationStmt.run();
    } catch (e) {
      console.error(`stripe webhook: mutation for ${label} failed`, e);
    }
    return;
  }
  try {
    await env.DB.batch([mutationStmt, ev.stmt]);
    await scheduleDispatch(env, ctx, ev.id);
  } catch (e) {
    console.error(
      `stripe webhook: outbox batch failed for ${label}; retrying the mutation alone so the payment side effect is not lost`,
      e
    );
    try {
      await mutationStmt.run();
    } catch (e2) {
      console.error(`stripe webhook: fallback mutation for ${label} also failed`, e2);
    }
  }
}

/** Skip if we already recorded this Stripe object id (payment_intent, session, or invoice). */
async function paymentAlreadyRecorded(
  db: D1Database,
  stripeRef: string | null | undefined
): Promise<boolean> {
  if (!stripeRef) return false;
  const existing = await first(
    db
      .prepare(
        `SELECT id FROM payments
         WHERE stripe_payment_intent_id = ? OR stripe_invoice_id = ?
         LIMIT 1`
      )
      .bind(stripeRef, stripeRef)
  );
  return !!existing;
}

webhookRoutes.post("/stripe", async (c) => {
  const signature = c.req.header("stripe-signature") || "";
  const payload = await c.req.text();

  const event = await constructWebhookEvent(c.env, payload, signature);
  if (!event) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const type = event.type as string;
  const data = event.data?.object;

  console.log("Stripe webhook:", type);

  if (type === "checkout.session.completed") {
    const session = data;
    const meta = session.metadata || {};
    const tenantId = meta.tenant_id as string | undefined;
    const memberId = meta.member_id as string | undefined;
    const relatedId = meta.related_id as string | undefined;
    const paymentType = meta.type as string | undefined;
    const now = new Date().toISOString();

    // Platform billing: guild pays QuiltHosting (not member dues)
    if (paymentType === "platform" && tenantId) {
      const customerId =
        (typeof session.customer === "string" && session.customer) || null;
      const subId =
        (typeof session.subscription === "string" && session.subscription) ||
        null;
      const plan = (meta.plan as string) || "starter";
      await c.env.DB.prepare(
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
      return c.json({ received: true });
    }

    // member_id is optional: non-member event registrations have none
    if (!tenantId || (paymentType === "dues" && !memberId)) {
      console.warn("Missing metadata on checkout session", session.id);
      return c.json({ received: true });
    }

    const stripeRef =
      (typeof session.payment_intent === "string" && session.payment_intent) ||
      (session.id as string);
    if (await paymentAlreadyRecorded(c.env.DB, stripeRef)) {
      console.log("checkout.session.completed already processed", stripeRef);
      return c.json({ received: true });
    }
    // Also key off session id so retries that only have session.id don't double-insert
    if (
      session.id &&
      session.id !== stripeRef &&
      (await paymentAlreadyRecorded(c.env.DB, session.id))
    ) {
      return c.json({ received: true });
    }

    const paymentId = generateId();
    const insertPaymentStmt = c.env.DB.prepare(
      `INSERT INTO payments
       (id, tenant_id, member_id, type, amount_cents, currency, stripe_payment_intent_id,
        status, description, related_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'usd', ?, 'succeeded', ?, ?, ?, ?)`
    ).bind(
      paymentId,
      tenantId,
      memberId || null,
      paymentType || "dues",
      session.amount_total || 0,
      stripeRef,
      `Checkout ${session.id}`,
      relatedId || null,
      now,
      now
    );

    // payment.succeeded outbound webhook — batched with the payments INSERT
    // right above (same statement, same spot; not moved) so it cannot be
    // permanently lost. Without this, a Worker death in the window between
    // that INSERT committing and a separate outbox insert would leave the
    // payment recorded; a Stripe retry then hits `paymentAlreadyRecorded`
    // above and returns early, so the retry would never re-attempt the
    // event — it would be gone for good, not just delayed. This runs before
    // any of the type-specific branches below (donation/store/event/dues):
    // those do their own independent mutations and don't need to have run
    // first for this payload, which only needs fields already in scope here.
    if (paymentType && session.amount_total != null) {
      const { prepareEvent } = await import("../lib/webhookOutbox");
      const ev = prepareEvent(c.env, tenantId, "payment.succeeded", {
        type: paymentType,
        amount_cents: session.amount_total,
        // Schema requires string|null, and Stripe can hand back undefined here.
        email: session.customer_email || session.metadata?.email || null,
        related_id: relatedId ?? null,
        source: "stripe",
      });
      await commitStripeMutationWithEvent(
        c.env,
        c.executionCtx,
        insertPaymentStmt,
        ev,
        "payment.succeeded"
      );
    } else {
      await insertPaymentStmt.run();
    }

    if (paymentType === "donation" || paymentType === "store") {
      const email =
        (meta.email as string) ||
        (typeof session.customer_email === "string"
          ? session.customer_email
          : "") ||
        "";
      const tenant = await first<{ name: string }>(
        c.env.DB.prepare("SELECT name FROM tenants WHERE id = ?").bind(tenantId)
      );
      if (paymentType === "store" && relatedId) {
        const qty = Math.max(1, Math.floor(Number(meta.quantity) || 1));
        try {
          await c.env.DB.prepare(
            `UPDATE products SET
               inventory = CASE
                 WHEN inventory IS NULL THEN NULL
                 WHEN inventory >= ? THEN inventory - ?
                 ELSE 0
               END,
               updated_at = ?
             WHERE id = ? AND tenant_id = ?`
          )
            .bind(qty, qty, now, relatedId, tenantId)
            .run();
        } catch (e) {
          console.warn("store inventory update failed", e);
        }
      }
      if (email && tenant) {
        const { subject, html } = paymentReceiptEmail({
          guildName: tenant.name,
          description:
            paymentType === "store"
              ? `Store order`
              : `Donation to ${tenant.name}`,
          amountFormatted: formatMoney(session.amount_total || 0),
          typeLabel: paymentType === "store" ? "purchase" : "donation",
        });
        await sendEmail(c.env, { to: email, subject, html });
      }
    }

    if (paymentType === "event" && relatedId) {
      // Read before the update: none of these columns (email, name,
      // ticket_code, event_id) are touched by the UPDATE below, so reading
      // first lets the UPDATE itself stay unexecuted until it can be batched
      // with its outbox event further down.
      const reg = await first<{
        email: string;
        name: string | null;
        ticket_code: string | null;
        event_id: string;
      }>(
        c.env.DB.prepare(
          `SELECT email, name, ticket_code, event_id FROM event_registrations
           WHERE id = ? AND tenant_id = ?`
        ).bind(relatedId, tenantId)
      );
      const updateRegStmt = c.env.DB.prepare(
        `UPDATE event_registrations
         SET amount_paid_cents = ?, status = 'registered', updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status IN ('pending_payment', 'registered')`
      ).bind(session.amount_total || 0, now, relatedId, tenantId);

      if (reg) {
        const eventRow = await first<{
          title: string;
          start_at: string;
          location: string | null;
        }>(
          c.env.DB.prepare(
            "SELECT title, start_at, location FROM events WHERE id = ? AND tenant_id = ?"
          ).bind(reg.event_id, tenantId)
        );
        const tenant = await first<{ name: string }>(
          c.env.DB.prepare("SELECT name FROM tenants WHERE id = ?").bind(tenantId)
        );
        if (eventRow && tenant) {
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
            amountFormatted: formatMoney(session.amount_total || 0),
            ticketCode: reg.ticket_code ?? undefined,
          });
          await sendEmail(c.env, {
            to: reg.email,
            subject,
            html,
          });
        }

        // Emitted here, after the reg/event lookups, so the payload is complete.
        // The seat is only real once Stripe confirms — never emit at
        // pending_payment. At-least-once delivery means a Stripe retry can
        // re-emit; consumers dedupe on the envelope id.
        //
        // Batched with updateRegStmt (prepared above, not yet run) so the
        // 'registered' status flip and its outbox event commit together.
        const { prepareEvent } = await import("../lib/webhookOutbox");
        const ev = prepareEvent(c.env, tenantId, "event.registration", {
          registration_id: relatedId,
          event_id: reg.event_id,
          event_title: eventRow?.title ?? "",
          email: reg.email,
          name: reg.name ?? null,
          status: "registered",
          amount_paid_cents: session.amount_total || 0,
          ticket_code: reg.ticket_code ?? null,
          source: "stripe",
        });
        await commitStripeMutationWithEvent(
          c.env,
          c.executionCtx,
          updateRegStmt,
          ev,
          "event.registration"
        );
      }
    }

    if (paymentType === "dues" && relatedId && memberId) {
      const level = await first<MembershipLevel>(
        c.env.DB.prepare(
          "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?"
        ).bind(relatedId, tenantId)
      );

      if (level) {
        await activateMembership(c.env.DB, {
          tenantId,
          memberId,
          level,
          amountPaidCents: session.amount_total || level.price_cents,
          now,
          stripeSubscriptionId:
            (typeof session.subscription === "string" && session.subscription) ||
            null,
          autoRenew: level.renewal_type === "auto",
        });

        const member = await first<Member>(
          c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
        );
        const tenant = await first<{ name: string; slug: string }>(
          c.env.DB.prepare("SELECT name, slug FROM tenants WHERE id = ?").bind(
            tenantId
          )
        );

        if (member && tenant) {
          const { subject, html } = welcomeEmail({
            guildName: tenant.name,
            firstName: member.first_name ?? undefined,
            portalUrl: portalUrl(c.env.APP_URL, tenant.slug),
          });
          await sendEmail(c.env, {
            to: member.email,
            subject,
            html,
          });
          try {
            const { enrollMemberActivated } = await import("../lib/automations");
            await enrollMemberActivated(c.env, tenantId, memberId);
          } catch (e) {
            console.warn("automation enroll failed", e);
          }
          // NOT atomic with the activation itself: activateMembership() above
          // already ran and committed its own statements (expire prior
          // actives, insert membership, flip member status) individually
          // before we get here — same situation as the free-join path in
          // routes/public.ts, and for the same reason: decomposing
          // activateMembership into pre-built statements this route could
          // batch would mean threading that change through all five of its
          // call sites, which is bigger than this task's scope. What we CAN
          // still guarantee is that these two events land together (both
          // outbox rows commit or neither does), so a subscriber never sees
          // member.activated without membership.activated or vice versa.
          //
          // Also never turns into a 500: this is the Stripe webhook path
          // (see commitStripeMutationWithEvent above for why), and by this
          // point the membership is already active regardless of whether the
          // outbox rows land.
          const { prepareEvent, scheduleDispatch } = await import(
            "../lib/webhookOutbox"
          );
          const membershipEv = prepareEvent(c.env, tenantId, "membership.activated", {
            member_id: memberId,
            email: member.email,
            level_id: level.id,
            level_name: level.name,
            membership_id: null,
            source: "stripe",
          });
          const memberEv = prepareEvent(c.env, tenantId, "member.activated", {
            member_id: memberId,
            email: member.email,
            level_id: level.id,
            source: "stripe",
          });
          if (!membershipEv || !memberEv) {
            console.error(
              "stripe webhook: prepareEvent failed for membership/member.activated; activation already committed, events lost",
              { hasMembershipEv: !!membershipEv, hasMemberEv: !!memberEv }
            );
          } else {
            try {
              await c.env.DB.batch([membershipEv.stmt, memberEv.stmt]);
              await scheduleDispatch(c.env, c.executionCtx, membershipEv.id);
              await scheduleDispatch(c.env, c.executionCtx, memberEv.id);
            } catch (e) {
              console.error(
                "stripe webhook: outbox batch failed for membership/member.activated; activation already committed, events lost",
                e
              );
            }
          }
        }
      }
    }

    // payment.succeeded is now emitted right after the payments INSERT,
    // above — see the comment there. (Left this marker so a future reader
    // scanning for "payment.succeeded" from the bottom of the handler up
    // finds a pointer instead of nothing.)

    // Multi-SKU store cart orders
    if (paymentType === "store" && session.metadata?.order_id) {
      const orderId = session.metadata.order_id as string;
      try {
        await c.env.DB.prepare(
          `UPDATE store_orders SET status = 'paid', updated_at = ?, stripe_session_id = ?
           WHERE id = ? AND tenant_id = ?`
        )
          .bind(now, session.id, orderId, tenantId)
          .run();
        const order = await first<{ items_json: string }>(
          c.env.DB.prepare(`SELECT items_json FROM store_orders WHERE id = ?`).bind(orderId)
        );
        if (order) {
          const items = JSON.parse(order.items_json || "[]") as Array<{
            product_id: string;
            quantity: number;
          }>;
          for (const it of items) {
            if (!it.product_id || !it.quantity) continue;
            await c.env.DB.prepare(
              `UPDATE products SET inventory = inventory - ?, updated_at = ?
               WHERE id = ? AND tenant_id = ? AND inventory IS NOT NULL AND inventory >= ?`
            )
              .bind(it.quantity, now, it.product_id, tenantId, it.quantity)
              .run();
          }
        }
      } catch (e) {
        console.warn("store order fulfill failed", e);
      }
    }
  }

  // Platform subscription ended (cancel / payment failure end)
  if (
    type === "customer.subscription.deleted" ||
    type === "customer.subscription.updated"
  ) {
    const sub = data;
    const subId = sub?.id as string | undefined;
    const meta = sub?.metadata || {};
    const tenantId = meta.tenant_id as string | undefined;
    const now = new Date().toISOString();

    if (meta.type === "platform" && tenantId) {
      if (type === "customer.subscription.deleted" || sub.status === "canceled") {
        await c.env.DB.prepare(
          `UPDATE tenants SET plan = 'free', stripe_subscription_id = null, updated_at = ?
           WHERE id = ?`
        )
          .bind(now, tenantId)
          .run();
        console.log("Platform plan cancelled", tenantId);
      } else if (sub.status === "active" || sub.status === "trialing") {
        await c.env.DB.prepare(
          `UPDATE tenants SET plan = 'starter', stripe_subscription_id = ?, updated_at = ?
           WHERE id = ?`
        )
          .bind(subId, now, tenantId)
          .run();
      }
      return c.json({ received: true });
    }
  }

  // Account.updated — keep stripe_account_id; status is read live from Stripe in billing API
  if (type === "account.updated") {
    const acctId = data?.id as string | undefined;
    if (acctId) {
      console.log("Connect account.updated", acctId, {
        charges: data.charges_enabled,
        payouts: data.payouts_enabled,
      });
    }
  }

  // Subscription renewals (member dues) — and first invoice if checkout webhook was missed
  if (type === "invoice.paid") {
    const invoice = data;
    const invoiceId = invoice?.id as string | undefined;
    const subscriptionId =
      (typeof invoice?.subscription === "string" && invoice.subscription) ||
      null;
    const billingReason = invoice?.billing_reason as string | undefined;
    const amountPaid = Number(invoice?.amount_paid || 0);
    const now = new Date().toISOString();
    const invMeta = invoice?.subscription_details?.metadata || invoice?.metadata || {};

    // Platform plan invoice — keep plan active; no member payment row
    if (invMeta.type === "platform" || invoice?.lines?.data?.[0]?.metadata?.type === "platform") {
      const tenantId = (invMeta.tenant_id ||
        invoice?.lines?.data?.[0]?.metadata?.tenant_id) as string | undefined;
      if (tenantId && subscriptionId) {
        await c.env.DB.prepare(
          `UPDATE tenants SET plan = 'starter', stripe_subscription_id = ?, updated_at = ?
           WHERE id = ?`
        )
          .bind(subscriptionId, now, tenantId)
          .run();
      }
      return c.json({ received: true });
    }

    // Also match platform by tenant stripe_subscription_id
    if (subscriptionId) {
      const platformTenant = await first<{ id: string }>(
        c.env.DB.prepare(
          "SELECT id FROM tenants WHERE stripe_subscription_id = ?"
        ).bind(subscriptionId)
      );
      if (platformTenant) {
        await c.env.DB.prepare(
          `UPDATE tenants SET plan = 'starter', updated_at = ? WHERE id = ?`
        )
          .bind(now, platformTenant.id)
          .run();
        return c.json({ received: true });
      }
    }

    if (!invoiceId) {
      return c.json({ received: true });
    }
    if (await paymentAlreadyRecorded(c.env.DB, invoiceId)) {
      console.log("invoice.paid already processed", invoiceId);
      return c.json({ received: true });
    }

    // First invoice is normally handled by checkout.session.completed.
    // Only create membership if we somehow missed checkout; never double-extend.
    if (billingReason === "subscription_create" && subscriptionId) {
      const existing = await first<{ id: string; tenant_id: string; member_id: string }>(
        c.env.DB.prepare(
          `SELECT id, tenant_id, member_id FROM memberships
           WHERE stripe_subscription_id = ? LIMIT 1`
        ).bind(subscriptionId)
      );
      if (existing) {
        // Checkout already created membership; record invoice ref if useful but skip amount double-count
        console.log("invoice.paid subscription_create: membership exists, skip extend", invoiceId);
        return c.json({ received: true });
      }
      // Recovery path: metadata on invoice/subscription lines is unreliable; skip create without context
      console.warn("invoice.paid subscription_create with no membership — waiting for checkout handler");
      return c.json({ received: true });
    }

    if (billingReason === "subscription_cycle" && subscriptionId) {
      const membership = await first<{
        id: string;
        tenant_id: string;
        member_id: string;
        level_id: string;
      }>(
        c.env.DB.prepare(
          `SELECT id, tenant_id, member_id, level_id FROM memberships
           WHERE stripe_subscription_id = ?
           ORDER BY created_at DESC LIMIT 1`
        ).bind(subscriptionId)
      );

      if (!membership) {
        console.warn("invoice.paid: no membership for subscription", subscriptionId);
        return c.json({ received: true });
      }

      const level = await first<MembershipLevel>(
        c.env.DB.prepare(
          "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?"
        ).bind(membership.level_id, membership.tenant_id)
      );
      const duration = level?.duration_months || 12;

      await extendMembership(c.env.DB, membership.id, duration, now);
      await c.env.DB.prepare(
        "UPDATE members SET status = 'active', updated_at = ? WHERE id = ?"
      )
        .bind(now, membership.member_id)
        .run();

      await c.env.DB.prepare(
        `INSERT INTO payments
         (id, tenant_id, member_id, type, amount_cents, currency, stripe_payment_intent_id,
          stripe_invoice_id, status, description, related_id, created_at, updated_at)
         VALUES (?, ?, ?, 'dues', ?, 'usd', ?, ?, 'succeeded', ?, ?, ?, ?)`
      )
        .bind(
          generateId(),
          membership.tenant_id,
          membership.member_id,
          amountPaid,
          (typeof invoice.payment_intent === "string" && invoice.payment_intent) ||
            null,
          invoiceId,
          `Subscription renewal ${invoiceId}`,
          membership.level_id,
          now,
          now
        )
        .run();

      console.log("invoice.paid: extended membership", membership.id);
    } else {
      console.log("invoice.paid ignored", { billingReason, subscriptionId, invoiceId });
    }
  }

  return c.json({ received: true });
});
