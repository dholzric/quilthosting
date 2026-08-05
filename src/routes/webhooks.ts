import { Hono } from "hono";
import type { Env, Member, MembershipLevel } from "../types";
import { generateId } from "../lib/utils/id";
import { first } from "../lib/db";
import { constructWebhookEvent } from "../lib/stripe";
import { sendEmail, welcomeEmail } from "../lib/email";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

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
    const tenantId = meta.tenant_id;
    const memberId = meta.member_id;
    const relatedId = meta.related_id;
    const paymentType = meta.type;

    if (!tenantId || !memberId) {
      console.warn("Missing metadata on checkout session", session.id);
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
        memberId,
        paymentType || "dues",
        session.amount_total || 0,
        session.payment_intent || session.id,
        `Checkout ${session.id}`,
        relatedId || null,
        now,
        now
      )
      .run();

    if (paymentType === "event" && relatedId) {
      await c.env.DB.prepare(
        `UPDATE event_registrations
         SET amount_paid_cents = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
        .bind(session.amount_total || 0, now, relatedId, tenantId)
        .run();
    }

    if (paymentType === "dues" && relatedId) {
      const level = await first<MembershipLevel>(
        c.env.DB.prepare(
          "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?"
        ).bind(relatedId, tenantId)
      );

      if (level) {
        const membershipId = generateId();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + level.duration_months);

        await c.env.DB.prepare(
          `INSERT INTO memberships
           (id, tenant_id, member_id, level_id, start_date, end_date, status,
            amount_paid_cents, stripe_subscription_id, auto_renew, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
        )
          .bind(
            membershipId,
            tenantId,
            memberId,
            level.id,
            now,
            endDate.toISOString(),
            session.amount_total || level.price_cents,
            session.subscription || null,
            level.renewal_type === "auto" ? 1 : 0,
            now,
            now
          )
          .run();

        await c.env.DB.prepare(
          "UPDATE members SET status = 'active', updated_at = ? WHERE id = ?"
        )
          .bind(now, memberId)
          .run();

        const member = await first<Member>(
          c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
        );
        const tenant = await first<{ name: string }>(
          c.env.DB.prepare("SELECT name FROM tenants WHERE id = ?").bind(tenantId)
        );

        if (member && tenant) {
          const { subject, html } = welcomeEmail({
            guildName: tenant.name,
            firstName: member.first_name ?? undefined,
            portalUrl: `${c.env.APP_URL}/portal`,
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

  if (type === "invoice.paid") {
    console.log("Invoice paid", data?.id);
  }

  return c.json({ received: true });
});
