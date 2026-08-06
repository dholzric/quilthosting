import { Hono } from "hono";
import type { Env, Event, MembershipLevel, Member, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId, generateTicketCode } from "../lib/utils/id";
import { createCheckoutSession } from "../lib/stripe";
import { sendEmail, welcomeEmail, eventConfirmationEmail } from "../lib/email";
import { formatMoney } from "../lib/utils/money";

export const publicRoutes = new Hono<{ Bindings: Env }>();

async function getTenantBySlug(db: D1Database, slug: string) {
  return first<Tenant>(
    db
      .prepare("SELECT * FROM tenants WHERE slug = ? AND status = 'active'")
      .bind(slug)
  );
}

// GET /public/:slug/levels
publicRoutes.get("/:slug/levels", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const levels = await all<MembershipLevel>(
    c.env.DB.prepare(
      `SELECT id, name, description, price_cents, duration_months, benefits_json, sort_order
       FROM membership_levels
       WHERE tenant_id = ? AND status = 'active' AND is_public = 1
       ORDER BY sort_order, name`
    ).bind(tenant.id)
  );

  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    levels,
  });
});

// GET /public/:slug/events
publicRoutes.get("/:slug/events", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const events = await all<Event>(
    c.env.DB.prepare(
      `SELECT id, title, description, location, start_at, end_at,
              member_price_cents, non_member_price_cents, capacity, registration_open
       FROM events
       WHERE tenant_id = ? AND is_public = 1 AND start_at >= datetime('now')
       ORDER BY start_at ASC
       LIMIT 50`
    ).bind(tenant.id)
  );

  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    events,
  });
});

// GET /public/:slug/events/:eventId
publicRoutes.get("/:slug/events/:eventId", async (c) => {
  const slug = c.req.param("slug");
  const eventId = c.req.param("eventId");

  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const event = await first<Event>(
    c.env.DB.prepare(
      "SELECT * FROM events WHERE id = ? AND tenant_id = ? AND is_public = 1"
    ).bind(eventId, tenant.id)
  );

  if (!event) return c.json({ error: "Event not found" }, 404);
  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    event,
  });
});

/**
 * POST /public/:slug/join
 * Creates (or finds) a member and starts Stripe Checkout for dues.
 */
// Legacy checkout return URLs (older Stripe sessions still point here)
publicRoutes.get("/:slug/join/success", (c) =>
  c.redirect(`/g/${c.req.param("slug")}?joined=1`)
);
publicRoutes.get("/:slug/join", (c) =>
  c.redirect(`/g/${c.req.param("slug")}${c.req.query("cancelled") ? "?cancelled=1" : ""}`)
);

publicRoutes.post("/:slug/join", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const body = await c.req.json<{
    level_id: string;
    email: string;
    first_name?: string;
    last_name?: string;
    custom_fields?: Record<string, string>;
  }>();

  // Only keep answers for fields this guild actually defined
  let customJson = "{}";
  if (body.custom_fields && typeof body.custom_fields === "object") {
    let settings: any = {};
    try { settings = JSON.parse(tenant.settings_json || "{}"); } catch {}
    const allowed = new Set(
      (settings.custom_fields || []).map((f: any) => f && f.key).filter(Boolean)
    );
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.custom_fields)) {
      if (allowed.has(k) && typeof v === "string") filtered[k] = v.slice(0, 500);
    }
    customJson = JSON.stringify(filtered);
  }

  if (!body.level_id || !body.email) {
    return c.json({ error: "level_id and email are required" }, 400);
  }

  const email = body.email.toLowerCase().trim();

  const level = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(body.level_id, tenant.id)
  );
  if (!level) {
    return c.json({ error: "Membership level not found" }, 404);
  }

  // Find or create member
  let member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, email)
  );

  const now = new Date().toISOString();

  if (!member) {
    const memberId = generateId();
    await c.env.DB.prepare(
      `INSERT INTO members
       (id, tenant_id, email, first_name, last_name, custom_fields_json, status, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
      .bind(
        memberId,
        tenant.id,
        email,
        body.first_name ?? null,
        body.last_name ?? null,
        customJson,
        now,
        now,
        now
      )
      .run();

    member = await first<Member>(
      c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
    );
  } else if (customJson !== "{}") {
    let current: Record<string, string> = {};
    try { current = JSON.parse(member.custom_fields_json || "{}"); } catch {}
    await c.env.DB.prepare(
      "UPDATE members SET custom_fields_json = ?, updated_at = ? WHERE id = ?"
    )
      .bind(JSON.stringify({ ...current, ...JSON.parse(customJson) }), now, member.id)
      .run();
  }

  if (!member) {
    return c.json({ error: "Failed to create member" }, 500);
  }

  // Free membership — activate immediately
  if (level.price_cents === 0) {
    const membershipId = generateId();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + level.duration_months);

    await c.env.DB.prepare(
      `INSERT INTO memberships
       (id, tenant_id, member_id, level_id, start_date, end_date, status, amount_paid_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`
    )
      .bind(
        membershipId,
        tenant.id,
        member.id,
        level.id,
        now,
        endDate.toISOString(),
        now,
        now
      )
      .run();

    await c.env.DB.prepare(
      "UPDATE members SET status = 'active', updated_at = ? WHERE id = ?"
    )
      .bind(now, member.id)
      .run();

    const portalUrl = `${c.env.APP_URL}/portal`;
    const { subject, html } = welcomeEmail({
      guildName: tenant.name,
      firstName: member.first_name ?? undefined,
      portalUrl,
    });
    await sendEmail(c.env, { to: email, subject, html });

    return c.json({
      status: "active",
      member_id: member.id,
      membership_id: membershipId,
      message: "Membership activated (free level)",
    });
  }

  // Paid — Stripe Checkout
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(
      { error: "Payments not configured. Set STRIPE_SECRET_KEY." },
      503
    );
  }

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const session = await createCheckoutSession(c.env, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    memberId: member.id,
    email,
    name:
      [body.first_name, body.last_name].filter(Boolean).join(" ") || undefined,
    amountCents: level.price_cents,
    description: `${tenant.name} – ${level.name} Membership`,
    type: "dues",
    relatedId: level.id,
    successUrl: `${baseUrl}/g/${tenant.slug}?joined=1`,
    cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
    mode: level.renewal_type === "auto" ? "subscription" : "payment",
    interval: level.duration_months >= 12 ? "year" : "month",
  });

  return c.json({
    status: "checkout",
    checkout_url: session.url,
    session_id: session.id,
    member_id: member.id,
  });
});

/**
 * POST /public/:slug/events/:eventId/register
 * Register for an event (free or paid via Stripe).
 */
publicRoutes.post("/:slug/events/:eventId/register", async (c) => {
  const slug = c.req.param("slug");
  const eventId = c.req.param("eventId");

  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const event = await first<Event>(
    c.env.DB.prepare(
      "SELECT * FROM events WHERE id = ? AND tenant_id = ? AND is_public = 1"
    ).bind(eventId, tenant.id)
  );
  if (!event) return c.json({ error: "Event not found" }, 404);
  if (!event.registration_open) {
    return c.json({ error: "Registration is closed" }, 400);
  }

  const body = await c.req.json<{
    email: string;
    name?: string;
  }>();

  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }

  const email = body.email.toLowerCase().trim();

  // Member pricing is decided server-side: only active members qualify
  const memberRow = await first<{ id: string; status: string }>(
    c.env.DB.prepare(
      "SELECT id, status FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, email)
  );
  const memberId = memberRow?.id ?? null;
  const priceCents =
    memberRow?.status === "active"
      ? event.member_price_cents
      : event.non_member_price_cents;

  // Capacity check
  if (event.capacity) {
    const countRow = await first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM event_registrations
         WHERE event_id = ? AND tenant_id = ? AND status IN ('registered', 'checked_in')`
      ).bind(eventId, tenant.id)
    );
    const current = countRow?.cnt ?? 0;
    if (current >= event.capacity) {
      if (event.waitlist_enabled) {
        // Fall through to waitlist
      } else {
        return c.json({ error: "Event is full" }, 400);
      }
    }
  }

  // Already registered?
  const existing = await first(
    c.env.DB.prepare(
      `SELECT id FROM event_registrations
       WHERE event_id = ? AND tenant_id = ? AND email = ?
         AND status IN ('registered', 'waitlist', 'checked_in')`
    ).bind(eventId, tenant.id, email)
  );
  if (existing) {
    return c.json({ error: "Already registered for this event" }, 409);
  }

  const now = new Date().toISOString();
  const regId = generateId();
  const ticketCode = generateTicketCode("EV");

  // Determine status (waitlist if full)
  let status = "registered";
  if (event.capacity) {
    const countRow = await first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM event_registrations
         WHERE event_id = ? AND tenant_id = ? AND status IN ('registered', 'checked_in')`
      ).bind(eventId, tenant.id)
    );
    if ((countRow?.cnt ?? 0) >= event.capacity && event.waitlist_enabled) {
      status = "waitlist";
    } else if ((countRow?.cnt ?? 0) >= event.capacity) {
      return c.json({ error: "Event is full" }, 400);
    }
  }

  // Free or waitlist — register immediately
  if (priceCents === 0 || status === "waitlist") {
    await c.env.DB.prepare(
      `INSERT INTO event_registrations
       (id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents, ticket_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
      .bind(
        regId,
        tenant.id,
        eventId,
        memberId,
        email,
        body.name ?? null,
        status,
        ticketCode,
        now,
        now
      )
      .run();

    if (status === "registered") {
      const eventDate = new Date(event.start_at).toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "short",
      });
      const { subject, html } = eventConfirmationEmail({
        guildName: tenant.name,
        firstName: body.name?.split(" ")[0],
        eventTitle: event.title,
        eventDate,
        eventLocation: event.location ?? undefined,
      });
      await sendEmail(c.env, { to: email, subject, html });
    }

    return c.json({
      status,
      registration_id: regId,
      ticket_code: ticketCode,
      message:
        status === "waitlist"
          ? "Added to waitlist"
          : "Registered successfully",
    });
  }

  // Paid registration — Stripe Checkout
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  // Drop any stale unpaid attempt for this email so retries aren't blocked
  await c.env.DB.prepare(
    `DELETE FROM event_registrations
     WHERE event_id = ? AND tenant_id = ? AND email = ? AND status = 'pending_payment'`
  )
    .bind(eventId, tenant.id, email)
    .run();

  // Held as pending_payment until the Stripe webhook confirms payment
  await c.env.DB.prepare(
    `INSERT INTO event_registrations
     (id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents, ticket_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', 0, ?, ?, ?)`
  )
    .bind(
      regId,
      tenant.id,
      eventId,
      memberId,
      email,
      body.name ?? null,
      ticketCode,
      now,
      now
    )
    .run();

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  let session;
  try {
    session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId: memberId ?? undefined,
      email,
      name: body.name,
      amountCents: priceCents,
      description: `${tenant.name} – ${event.title}`,
      type: "event",
      relatedId: regId,
      successUrl: `${baseUrl}/g/${tenant.slug}?registered=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
    });
  } catch (err) {
    await c.env.DB.prepare(
      "DELETE FROM event_registrations WHERE id = ? AND tenant_id = ?"
    )
      .bind(regId, tenant.id)
      .run();
    console.error("Checkout session failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }

  return c.json({
    status: "checkout",
    checkout_url: session.url,
    session_id: session.id,
    registration_id: regId,
    ticket_code: ticketCode,
  });
});

// GET /public/:slug/pages — published public pages (no members-only)
publicRoutes.get("/:slug/pages", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const rows = await all<{ slug: string; title: string; content_json: string }>(
    c.env.DB.prepare(
      `SELECT slug, title, content_json FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
       ORDER BY sort_order, title`
    ).bind(tenant.id)
  );
  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    pages: rows.map((p) => ({
      slug: p.slug,
      title: p.title,
      html: (JSON.parse(p.content_json || "{}").html as string) || "",
    })),
  });
});

/**
 * POST /public/:slug/donate — one-off donation via Stripe Checkout
 */
publicRoutes.post("/:slug/donate", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const body = await c.req.json<{ amount_cents: number; email?: string; name?: string }>();
  const amount = Math.floor(Number(body.amount_cents));
  if (!Number.isFinite(amount) || amount < 100 || amount > 1000000) {
    return c.json({ error: "Amount must be between $1 and $10,000" }, 400);
  }
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }
  const email = (body.email || "").toLowerCase().trim();
  let memberId: string | undefined;
  if (email) {
    const member = await first<{ id: string }>(
      c.env.DB.prepare(
        "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
      ).bind(tenant.id, email)
    );
    memberId = member?.id;
  }
  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  let session;
  try {
    session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId,
      email: email || "donor@example.com",
      name: body.name,
      amountCents: amount,
      description: `Donation to ${tenant.name}`,
      type: "donation",
      successUrl: `${baseUrl}/g/${tenant.slug}?donated=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
    });
  } catch (err) {
    console.error("Donation checkout failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }
  return c.json({ status: "checkout", checkout_url: session.url });
});

/**
 * GET /public/:slug/info — guild profile for the public page:
 * description, contact, links, join custom fields.
 */
publicRoutes.get("/:slug/info", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  let settings: any = {};
  try { settings = JSON.parse(tenant.settings_json || "{}"); } catch {}
  const profile = settings.profile || {};
  const joinFields = (settings.custom_fields || []).filter(
    (f: any) => f && f.key && f.show_on_join
  );
  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    profile: {
      description: profile.description || "",
      contact_email: profile.contact_email || "",
      location: profile.location || "",
      website: profile.website || "",
      facebook: profile.facebook || "",
      meeting_info: profile.meeting_info || "",
      donations_enabled: profile.donations_enabled !== false,
    },
    join_fields: joinFields,
  });
});
