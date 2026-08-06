import { Hono } from "hono";
import type { Env, Member, MembershipLevel } from "../types";
import { generateId } from "../lib/utils/id";
import { first } from "../lib/db";
import { constructWebhookEvent } from "../lib/stripe";
import {
  sendEmail,
  welcomeEmail,
  eventConfirmationEmail,
} from "../lib/email";
import { formatMoney } from "../lib/utils/money";
import {
  activateMembership,
  extendMembership,
  portalUrl,
} from "../lib/memberships";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

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

    const now = new Date().toISOString();

    const paymentId = generateId();
    await c.env.DB.prepare(
      `INSERT INTO payments
       (id, tenant_id, member_id, type, amount_cents, currency, stripe_payment_intent_id,
        status, description, related_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'usd', ?, 'succeeded', ?, ?, ?, ?)`
    )
      .bind(
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
      )
      .run();

    if (paymentType === "event" && relatedId) {
      await c.env.DB.prepare(
        `UPDATE event_registrations
         SET amount_paid_cents = ?, status = 'registered', updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status IN ('pending_payment', 'registered')`
      )
        .bind(session.amount_total || 0, now, relatedId, tenantId)
        .run();

      // Confirmation email with ticket (free path already emails; paid waits for webhook)
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
        }
      }
    }
  }

  // Subscription renewals (and first invoice if checkout webhook was missed)
  if (type === "invoice.paid") {
    const invoice = data;
    const invoiceId = invoice?.id as string | undefined;
    const subscriptionId =
      (typeof invoice?.subscription === "string" && invoice.subscription) ||
      null;
    const billingReason = invoice?.billing_reason as string | undefined;
    const amountPaid = Number(invoice?.amount_paid || 0);
    const now = new Date().toISOString();

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
