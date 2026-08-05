import { Hono } from "hono";
import type { Env, Event, MembershipLevel, Member, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId, generateTicketCode } from "../lib/utils/id";
import { createCheckoutSession } from "../lib/stripe";
import { sendEmail, welcomeEmail, eventConfirmationEmail } from "../lib/email";

export const publicRoutes = new Hono<{ Bindings: Env }>();

async function getTenantBySlug(db: D1Database, slug: string) {
  return first<Tenant>(
    db.prepare("SELECT * FROM tenants WHERE slug = ? AND status = 'active'").bind(slug)
  );
}

publicRoutes.get("/:slug/levels", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const levels = await all<MembershipLevel>(
    c.env.DB.prepare(
      `SELECT id, name, description, price_cents, duration_months, benefits_json, sort_order
       FROM membership_levels WHERE tenant_id = ? AND status = 'active' AND is_public = 1
       ORDER BY sort_order, name`
    ).bind(tenant.id)
  );
  return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, levels });
});

publicRoutes.get("/:slug/events", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const events = await all<Event>(
    c.env.DB.prepare(
      `SELECT id, title, description, location, start_at, end_at,
              member_price_cents, non_member_price_cents, capacity, registration_open
       FROM events WHERE tenant_id = ? AND is_public = 1 AND start_at >= datetime('now')
       ORDER BY start_at ASC LIMIT 50`
    ).bind(tenant.id)
  );
  return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, events });
});

publicRoutes.get("/:slug/events/:eventId", async (c) => {
  const slug = c.req.param("slug");
  const eventId = c.req.param("eventId");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const event = await first<Event>(
    c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND tenant_id = ? AND is_public = 1").bind(eventId, tenant.id)
  );
  if (!event) return c.json({ error: "Event not found" }, 404);
  return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, event });
});

publicRoutes.post("/:slug/join", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const body = await c.req.json<{ level_id: string; email: string; first_name?: string; last_name?: string }>();
  if (!body.level_id || !body.email) return c.json({ error: "level_id and email are required" }, 400);
  const email = body.email.toLowerCase().trim();
  const level = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(body.level_id, tenant.id)
  );
  if (!level) return c.json({ error: "Membership level not found" }, 404);
  let member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE tenant_id = ? AND email = ?").bind(tenant.id, email)
  );
  const now = new Date().toISOString();
  if (!member) {
    const memberId = generateId();
    await c.env.DB.prepare(
      `INSERT INTO members (id, tenant_id, email, first_name, last_name, status, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(memberId, tenant.id, email, body.first_name ?? null, body.last_name ?? null, now, now, now).run();
    member = await first<Member>(c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId));
  }
  if (!member) return c.json({ error: "Failed to create member" }, 500);
  if (level.price_cents === 0) {
    const membershipId = generateId();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + level.duration_months);
    await c.env.DB.prepare(
      `INSERT INTO memberships (id, tenant_id, member_id, level_id, start_date, end_date, status, amount_paid_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`
    ).bind(membershipId, tenant.id, member.id, level.id, now, endDate.toISOString(), now, now).run();
    await c.env.DB.prepare("UPDATE members SET status = 'active', updated_at = ? WHERE id = ?").bind(now, member.id).run();
    const { subject, html } = welcomeEmail({
      guildName: tenant.name,
      firstName: member.first_name ?? undefined,
      portalUrl: `${c.env.APP_URL}/portal`,
    });
    await sendEmail(c.env, { to: email, subject, html });
    return c.json({ status: "active", member_id: member.id, membership_id: membershipId });
  }
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: "Payments not configured" }, 503);
  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const session = await createCheckoutSession(c.env, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    memberId: member.id,
    email,
    amountCents: level.price_cents,
    description: `${tenant.name} – ${level.name} Membership`,
    type: "dues",
    relatedId: level.id,
    successUrl: `${baseUrl}/public/${tenant.slug}/join/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/public/${tenant.slug}/join?cancelled=1`,
    mode: level.renewal_type === "auto" ? "subscription" : "payment",
    interval: level.duration_months >= 12 ? "year" : "month",
  });
  return c.json({ status: "checkout", checkout_url: session.url, session_id: session.id, member_id: member.id });
});

publicRoutes.post("/:slug/events/:eventId/register", async (c) => {
  const slug = c.req.param("slug");
  const eventId = c.req.param("eventId");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const event = await first<Event>(
    c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND tenant_id = ? AND is_public = 1").bind(eventId, tenant.id)
  );
  if (!event) return c.json({ error: "Event not found" }, 404);
  if (!event.registration_open) return c.json({ error: "Registration is closed" }, 400);
  const body = await c.req.json<{ email: string; name?: string; member_id?: string; is_member?: boolean }>();
  if (!body.email) return c.json({ error: "email is required" }, 400);
  const email = body.email.toLowerCase().trim();
  const priceCents = body.is_member ? event.member_price_cents : event.non_member_price_cents;
  const existing = await first(
    c.env.DB.prepare(
      `SELECT id FROM event_registrations WHERE event_id = ? AND tenant_id = ? AND email = ?
         AND status IN ('registered', 'waitlist', 'checked_in')`
    ).bind(eventId, tenant.id, email)
  );
  if (existing) return c.json({ error: "Already registered for this event" }, 409);
  const now = new Date().toISOString();
  const regId = generateId();
  const ticketCode = generateTicketCode("EV");
  let status = "registered";
  if (event.capacity) {
    const countRow = await first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM event_registrations
         WHERE event_id = ? AND tenant_id = ? AND status IN ('registered', 'checked_in')`
      ).bind(eventId, tenant.id)
    );
    if ((countRow?.cnt ?? 0) >= event.capacity) {
      if (event.waitlist_enabled) status = "waitlist";
      else return c.json({ error: "Event is full" }, 400);
    }
  }
  if (priceCents === 0 || status === "waitlist") {
    await c.env.DB.prepare(
      `INSERT INTO event_registrations
       (id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents, ticket_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).bind(regId, tenant.id, eventId, body.member_id ?? null, email, body.name ?? null, status, ticketCode, now, now).run();
    if (status === "registered") {
      const eventDate = new Date(event.start_at).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
      const { subject, html } = eventConfirmationEmail({
        guildName: tenant.name,
        firstName: body.name?.split(" ")[0],
        eventTitle: event.title,
        eventDate,
        eventLocation: event.location ?? undefined,
      });
      await sendEmail(c.env, { to: email, subject, html });
    }
    return c.json({ status, registration_id: regId, ticket_code: ticketCode });
  }
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: "Payments not configured" }, 503);
  await c.env.DB.prepare(
    `INSERT INTO event_registrations
     (id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents, ticket_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'registered', 0, ?, ?, ?)`
  ).bind(regId, tenant.id, eventId, body.member_id ?? null, email, body.name ?? null, ticketCode, now, now).run();
  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const session = await createCheckoutSession(c.env, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    memberId: body.member_id,
    email,
    name: body.name,
    amountCents: priceCents,
    description: `${tenant.name} – ${event.title}`,
    type: "event",
    relatedId: regId,
    successUrl: `${baseUrl}/public/${tenant.slug}/events/${eventId}?registered=1`,
    cancelUrl: `${baseUrl}/public/${tenant.slug}/events/${eventId}?cancelled=1`,
    mode: "payment",
  });
  return c.json({ status: "checkout", checkout_url: session.url, session_id: session.id, registration_id: regId, ticket_code: ticketCode });
});
