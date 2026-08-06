import { Hono } from "hono";
import type { Env, Event, MembershipLevel, Member, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId, generateTicketCode } from "../lib/utils/id";
import { createCheckoutSession } from "../lib/stripe";
import { sendEmail, welcomeEmail, eventConfirmationEmail } from "../lib/email";
import { formatMoney } from "../lib/utils/money";
import { activateMembership, portalUrl } from "../lib/memberships";
import { assertCanActivateMember } from "../lib/plans";
import { rateLimit } from "../middleware/rateLimit";
import {
  parseEventSettings,
  validateAnswers,
} from "../lib/eventQuestions";

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.use("/:slug/join", rateLimit({ keyPrefix: "join", limit: 30, windowSeconds: 600 }));
publicRoutes.use("/:slug/donate", rateLimit({ keyPrefix: "donate", limit: 20, windowSeconds: 600 }));
publicRoutes.use(
  "/:slug/events/:eventId/register",
  rateLimit({ keyPrefix: "ereg", limit: 40, windowSeconds: 600 })
);
publicRoutes.use(
  "/:slug/products/:productId/buy",
  rateLimit({ keyPrefix: "buy", limit: 30, windowSeconds: 600 })
);

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
              member_price_cents, non_member_price_cents, capacity, registration_open,
              settings_json
       FROM events
       WHERE tenant_id = ? AND is_public = 1 AND start_at >= datetime('now')
       ORDER BY start_at ASC
       LIMIT 50`
    ).bind(tenant.id)
  );

  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    events: events.map((e) => ({
      ...e,
      questions: parseEventSettings(e.settings_json).questions || [],
    })),
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
    event: {
      ...event,
      questions: parseEventSettings(event.settings_json).questions || [],
    },
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
    try {
      await assertCanActivateMember(c.env.DB, tenant, member.id);
    } catch (e: any) {
      return c.json(
        { error: e.message || "Plan limit reached", code: e.code || "plan_limit" },
        e.status || 402
      );
    }
    const membershipId = await activateMembership(c.env.DB, {
      tenantId: tenant.id,
      memberId: member.id,
      level,
      amountPaidCents: 0,
      now,
    });

    const { subject, html } = welcomeEmail({
      guildName: tenant.name,
      firstName: member.first_name ?? undefined,
      portalUrl: portalUrl(c.env.APP_URL, tenant.slug),
    });
    await sendEmail(c.env, { to: email, subject, html });
    try {
      const { enrollMemberActivated } = await import("../lib/automations");
      await enrollMemberActivated(c.env, tenant.id, member.id);
    } catch {
      /* optional */
    }

    return c.json({
      status: "active",
      member_id: member.id,
      membership_id: membershipId,
      message: "Membership activated (free level)",
    });
  }

  // Paid — Stripe Checkout (Connect destination when guild has linked account)
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(
      { error: "Payments not configured. Set STRIPE_SECRET_KEY." },
      503
    );
  }

  try {
    await assertCanActivateMember(c.env.DB, tenant, member.id);
  } catch (e: any) {
    return c.json(
      { error: e.message || "Plan limit reached", code: e.code || "plan_limit" },
      e.status || 402
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
    stripeAccountId: tenant.stripe_account_id,
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
    custom_answers?: Record<string, string>;
  }>();

  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }

  const email = body.email.toLowerCase().trim();

  const questions = parseEventSettings(event.settings_json).questions || [];
  const validated = validateAnswers(questions, body.custom_answers);
  if (!validated.ok) {
    return c.json({ error: validated.error }, 400);
  }
  const answersJson = JSON.stringify(validated.answers);

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

  // Capacity check — hold seats for pending Stripe checkouts too
  if (event.capacity) {
    const countRow = await first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM event_registrations
         WHERE event_id = ? AND tenant_id = ? AND status IN ('registered', 'checked_in', 'pending_payment')`
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

  // Determine status (waitlist if full) — count pending_payment so paid seats are held
  let status = "registered";
  if (event.capacity) {
    const countRow = await first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM event_registrations
         WHERE event_id = ? AND tenant_id = ? AND status IN ('registered', 'checked_in', 'pending_payment')`
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
       (id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents, ticket_code, custom_answers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
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
        answersJson,
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
        ticketCode,
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
     (id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents, ticket_code, custom_answers_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', 0, ?, ?, ?, ?)`
  )
    .bind(
      regId,
      tenant.id,
      eventId,
      memberId,
      email,
      body.name ?? null,
      ticketCode,
      answersJson,
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
      stripeAccountId: tenant.stripe_account_id,
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

// GET /public/:slug/pages — published public pages (no members-only; not blog posts)
publicRoutes.get("/:slug/pages", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const { contentFromPage } = await import("../lib/blocks");
  try {
    const rows = await all<{
      slug: string;
      title: string;
      content_json: string;
      blocks_json?: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT slug, title, content_json, blocks_json FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(page_type, 'page') = 'page'
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      pages: rows.map((p) => ({
        slug: p.slug,
        title: p.title,
        html: contentFromPage(p).html,
      })),
    });
  } catch {
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
  }
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
      stripeAccountId: tenant.stripe_account_id,
    });
  } catch (err) {
    console.error("Donation checkout failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }
  return c.json({ status: "checkout", checkout_url: session.url });
});

/**
 * GET /public/:slug/products — active store items
 */
publicRoutes.get("/:slug/products", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  try {
    const rows = await all<{
      id: string;
      name: string;
      description: string | null;
      price_cents: number;
      inventory: number | null;
    }>(
      c.env.DB.prepare(
        `SELECT id, name, description, price_cents, inventory FROM products
         WHERE tenant_id = ? AND is_active = 1
           AND (inventory IS NULL OR inventory > 0)
         ORDER BY sort_order, name`
      ).bind(tenant.id)
    );
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      products: rows,
    });
  } catch {
    return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, products: [] });
  }
});

/**
 * POST /public/:slug/products/:productId/buy
 */
publicRoutes.post("/:slug/products/:productId/buy", async (c) => {
  const slug = c.req.param("slug");
  const productId = c.req.param("productId");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const product = await first<{
    id: string;
    name: string;
    price_cents: number;
    inventory: number | null;
    is_active: number;
  }>(
    c.env.DB.prepare(
      "SELECT * FROM products WHERE id = ? AND tenant_id = ?"
    ).bind(productId, tenant.id)
  );
  if (!product || !product.is_active) {
    return c.json({ error: "Product not found" }, 404);
  }
  if (product.inventory !== null && product.inventory <= 0) {
    return c.json({ error: "Sold out" }, 400);
  }

  const body = await c.req.json<{
    email: string;
    name?: string;
    quantity?: number;
  }>();
  const email = (body.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) {
    return c.json({ error: "email is required" }, 400);
  }
  const qty = Math.min(10, Math.max(1, Math.floor(Number(body.quantity) || 1)));
  if (product.inventory !== null && qty > product.inventory) {
    return c.json({ error: `Only ${product.inventory} left` }, 400);
  }

  if (product.price_cents === 0) {
    // Free item — record payment-like fulfillment and decrement stock
    const now = new Date().toISOString();
    if (product.inventory !== null) {
      await c.env.DB.prepare(
        `UPDATE products SET inventory = inventory - ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND inventory >= ?`
      )
        .bind(qty, now, product.id, tenant.id, qty)
        .run();
    }
    let memberId: string | null = null;
    const member = await first<{ id: string }>(
      c.env.DB.prepare(
        "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
      ).bind(tenant.id, email)
    );
    memberId = member?.id ?? null;
    await c.env.DB.prepare(
      `INSERT INTO payments
       (id, tenant_id, member_id, type, amount_cents, currency, status, description, related_id, created_at, updated_at)
       VALUES (?, ?, ?, 'store', 0, 'usd', 'succeeded', ?, ?, ?, ?)`
    )
      .bind(
        generateId(),
        tenant.id,
        memberId,
        `${product.name} × ${qty} (free)`,
        product.id,
        now,
        now
      )
      .run();
    return c.json({
      status: "fulfilled",
      message: `You're all set — ${product.name} is free.`,
    });
  }

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  let memberId: string | undefined;
  const member = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, email)
  );
  memberId = member?.id;

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const amount = product.price_cents * qty;
  try {
    const session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId,
      email,
      name: body.name,
      amountCents: amount,
      description:
        qty > 1
          ? `${tenant.name} – ${product.name} × ${qty}`
          : `${tenant.name} – ${product.name}`,
      type: "store",
      relatedId: product.id,
      quantity: qty,
      successUrl: `${baseUrl}/g/${tenant.slug}?purchased=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
      stripeAccountId: tenant.stripe_account_id,
    });
    return c.json({
      status: "checkout",
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error("Store checkout failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }
});

/**
 * GET /public/:slug/info — guild profile for the public page:
 * description, contact, links, join custom fields, logo.
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
  const logoUrl = profile.logo_file_id
    ? `/public/${tenant.slug}/logo`
    : null;
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
      directory_public: !!profile.directory_public,
      logo_file_id: profile.logo_file_id || null,
      logo_url: logoUrl,
    },
    join_fields: joinFields,
  });
});

/**
 * GET /public/:slug/logo — public guild logo image
 */
publicRoutes.get("/:slug/logo", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Not found" }, 404);
  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  const logoFileId = settings.profile?.logo_file_id as string | undefined;
  if (!logoFileId) return c.json({ error: "No logo" }, 404);
  const row = await first<{ r2_key: string; content_type: string | null }>(
    c.env.DB.prepare(
      `SELECT r2_key, content_type FROM files WHERE id = ? AND tenant_id = ?`
    ).bind(logoFileId, tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type || "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

/**
 * GET /public/:slug/directory — optional public member directory (with showcase)
 */
publicRoutes.get("/:slug/directory", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  if (!settings.profile?.directory_public) {
    return c.json({ error: "Directory is not public" }, 403);
  }
  try {
    const members = await all<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      bio: string | null;
      photo_file_id: string | null;
      showcase_json: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT id, first_name, last_name, bio, photo_file_id, showcase_json FROM members
         WHERE tenant_id = ? AND status = 'active'
           AND coalesce(directory_visible, 1) = 1
         ORDER BY last_name, first_name LIMIT 500`
      ).bind(tenant.id)
    );
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      members: members.map((m) => {
        let showcase: Record<string, string> = {};
        try {
          showcase = JSON.parse(m.showcase_json || "{}");
        } catch {}
        return {
          id: m.id,
          first_name: m.first_name,
          last_name: m.last_name,
          bio: m.bio,
          photo_url: m.photo_file_id
            ? `/public/${tenant.slug}/member-photo/${m.photo_file_id}`
            : null,
          showcase,
        };
      }),
    });
  } catch {
    const members = await all<{
      first_name: string | null;
      last_name: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT first_name, last_name FROM members
         WHERE tenant_id = ? AND status = 'active'
           AND coalesce(directory_visible, 1) = 1
         ORDER BY last_name, first_name LIMIT 500`
      ).bind(tenant.id)
    );
    return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, members });
  }
});

/** Public photo file (member showcase) */
publicRoutes.get("/:slug/member-photo/:fileId", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Not found" }, 404);
  const fileId = c.req.param("fileId");
  const member = await first(
    c.env.DB.prepare(
      `SELECT id FROM members WHERE tenant_id = ? AND photo_file_id = ?
         AND coalesce(directory_visible, 1) = 1 AND status = 'active'`
    ).bind(tenant.id, fileId)
  );
  if (!member) return c.json({ error: "Not found" }, 404);
  const row = await first<{ r2_key: string; content_type: string | null }>(
    c.env.DB.prepare(
      `SELECT r2_key, content_type FROM files WHERE id = ? AND tenant_id = ?`
    ).bind(fileId, tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

/** Site theme + nav for public guild page */
publicRoutes.get("/:slug/site", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  let navPages: Array<{ slug: string; title: string; nav_label: string | null }> = [];
  try {
    navPages = await all(
      c.env.DB.prepare(
        `SELECT slug, title, nav_label FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(show_in_nav, 1) = 1 AND coalesce(page_type, 'page') = 'page'
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
  } catch {
    navPages = [];
  }
  const taxRateBps = Number(settings.store?.tax_rate_bps || 0) || 0;
  return c.json({
    theme: settings.theme || {},
    nav: settings.nav || [],
    nav_pages: navPages,
    store: {
      tax_rate_bps: taxRateBps,
      tax_label: settings.store?.tax_label || "Sales tax",
    },
  });
});

/** Blog posts (public pages with page_type=blog_post) */
publicRoutes.get("/:slug/blog", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  try {
    const posts = await all(
      c.env.DB.prepare(
        `SELECT slug, title, content_json, blocks_json, updated_at, created_at
         FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(page_type, 'page') = 'blog_post'
         ORDER BY created_at DESC LIMIT 50`
      ).bind(tenant.id)
    );
    const { contentFromPage } = await import("../lib/blocks");
    return c.json({
      posts: posts.map((p: any) => ({
        slug: p.slug,
        title: p.title,
        html: contentFromPage(p).html,
        updated_at: p.updated_at,
        created_at: p.created_at,
      })),
    });
  } catch {
    return c.json({ posts: [] });
  }
});

/** Public form / survey by slug */
publicRoutes.get("/:slug/forms/:formSlug", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const form = await first<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    fields_json: string;
    form_type: string;
  }>(
    c.env.DB.prepare(
      `SELECT id, name, slug, description, fields_json, form_type FROM forms
       WHERE tenant_id = ? AND slug = ? AND published = 1 AND is_public = 1`
    ).bind(tenant.id, c.req.param("formSlug"))
  );
  if (!form) return c.json({ error: "Form not found" }, 404);
  let fields = [];
  try {
    fields = JSON.parse(form.fields_json || "[]");
  } catch {}
  return c.json({
    form: {
      id: form.id,
      name: form.name,
      slug: form.slug,
      description: form.description,
      form_type: form.form_type,
      fields,
    },
  });
});

publicRoutes.post("/:slug/forms/:formSlug", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const form = await first<{ id: string; fields_json: string }>(
    c.env.DB.prepare(
      `SELECT id, fields_json FROM forms
       WHERE tenant_id = ? AND slug = ? AND published = 1 AND is_public = 1`
    ).bind(tenant.id, c.req.param("formSlug"))
  );
  if (!form) return c.json({ error: "Form not found" }, 404);
  const { normalizeFormFields, validateFormAnswers } = await import("../lib/forms");
  let fields = normalizeFormFields([]);
  try {
    fields = normalizeFormFields(JSON.parse(form.fields_json || "[]"));
  } catch {}
  const body = await c.req.json<{
    email?: string;
    name?: string;
    answers?: unknown;
  }>();
  const validated = validateFormAnswers(fields, body.answers || body);
  if (!validated.ok) return c.json({ error: validated.error }, 400);
  const id = generateId();
  const now = new Date().toISOString();
  let memberId: string | null = null;
  const email = (body.email || "").toLowerCase().trim();
  if (email) {
    const m = await first<{ id: string }>(
      c.env.DB.prepare(
        `SELECT id FROM members WHERE tenant_id = ? AND email = ?`
      ).bind(tenant.id, email)
    );
    memberId = m?.id ?? null;
  }
  await c.env.DB.prepare(
    `INSERT INTO form_responses (id, tenant_id, form_id, member_id, email, name, answers_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      form.id,
      memberId,
      email || null,
      body.name?.trim() || null,
      JSON.stringify(validated.answers),
      now
    )
    .run();
  try {
    const { emitTenantEvent } = await import("../lib/outboundWebhooks");
    await emitTenantEvent(c.env, tenant.id, "form.response", {
      form_id: form.id,
      response_id: id,
      email: email || null,
      answers: validated.answers,
    });
  } catch { /* optional */ }
  return c.json({ ok: true, id }, 201);
});

/**
 * POST /public/:slug/cart/checkout — multi-SKU cart with tax
 */
publicRoutes.post("/:slug/cart/checkout", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const body = await c.req.json<{
    email: string;
    name?: string;
    items: Array<{ product_id: string; quantity?: number }>;
  }>();
  const email = (body.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) {
    return c.json({ error: "email is required" }, 400);
  }
  if (!Array.isArray(body.items) || !body.items.length) {
    return c.json({ error: "Cart is empty" }, 400);
  }

  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  const taxRateBps = Math.max(0, Math.min(2500, Number(settings.store?.tax_rate_bps) || 0));

  const cartLines: Array<{
    product_id: string;
    name: string;
    quantity: number;
    unit_cents: number;
    taxable: boolean;
    line_cents: number;
  }> = [];

  for (const raw of body.items.slice(0, 20)) {
    const product = await first<{
      id: string;
      name: string;
      price_cents: number;
      inventory: number | null;
      is_active: number;
      taxable?: number;
    }>(
      c.env.DB.prepare(
        `SELECT * FROM products WHERE id = ? AND tenant_id = ?`
      ).bind(raw.product_id, tenant.id)
    );
    if (!product || !product.is_active) {
      return c.json({ error: `Product not found: ${raw.product_id}` }, 400);
    }
    const qty = Math.min(20, Math.max(1, Math.floor(Number(raw.quantity) || 1)));
    if (product.inventory !== null && qty > product.inventory) {
      return c.json({ error: `Only ${product.inventory} left of ${product.name}` }, 400);
    }
    cartLines.push({
      product_id: product.id,
      name: product.name,
      quantity: qty,
      unit_cents: product.price_cents,
      taxable: product.taxable !== 0,
      line_cents: product.price_cents * qty,
    });
  }

  const subtotal = cartLines.reduce((s, l) => s + l.line_cents, 0);
  const taxableBase = cartLines
    .filter((l) => l.taxable)
    .reduce((s, l) => s + l.line_cents, 0);
  const taxCents = Math.floor((taxableBase * taxRateBps) / 10000);
  const total = subtotal + taxCents;

  const orderId = generateId();
  const now = new Date().toISOString();
  let memberId: string | undefined;
  const member = await first<{ id: string }>(
    c.env.DB.prepare(
      `SELECT id FROM members WHERE tenant_id = ? AND email = ?`
    ).bind(tenant.id, email)
  );
  memberId = member?.id;

  await c.env.DB.prepare(
    `INSERT INTO store_orders
     (id, tenant_id, member_id, email, status, subtotal_cents, tax_cents, total_cents, items_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      orderId,
      tenant.id,
      memberId ?? null,
      email,
      subtotal,
      taxCents,
      total,
      JSON.stringify(cartLines),
      now,
      now
    )
    .run();

  if (total === 0) {
    await c.env.DB.prepare(
      `UPDATE store_orders SET status = 'paid', updated_at = ? WHERE id = ?`
    )
      .bind(now, orderId)
      .run();
    for (const l of cartLines) {
      await c.env.DB.prepare(
        `UPDATE products SET inventory = inventory - ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND inventory IS NOT NULL AND inventory >= ?`
      )
        .bind(l.quantity, now, l.product_id, tenant.id, l.quantity)
        .run();
    }
    return c.json({ status: "fulfilled", order_id: orderId, message: "Order complete (free)." });
  }

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const lineItems = cartLines.map((l) => ({
    name: l.name,
    amountCents: l.unit_cents,
    quantity: l.quantity,
  }));
  if (taxCents > 0) {
    lineItems.push({
      name: settings.store?.tax_label || "Sales tax",
      amountCents: taxCents,
      quantity: 1,
    });
  }

  try {
    const session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId,
      email,
      name: body.name,
      amountCents: total,
      description: `${tenant.name} store order`,
      type: "store",
      relatedId: orderId,
      lineItems,
      extraMetadata: {
        order_id: orderId,
        tax_cents: String(taxCents),
        subtotal_cents: String(subtotal),
      },
      successUrl: `${baseUrl}/g/${tenant.slug}?purchased=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
      stripeAccountId: tenant.stripe_account_id,
    });
    await c.env.DB.prepare(
      `UPDATE store_orders SET stripe_session_id = ?, updated_at = ? WHERE id = ?`
    )
      .bind(session.id, now, orderId)
      .run();
    return c.json({
      status: "checkout",
      checkout_url: session.url,
      session_id: session.id,
      order_id: orderId,
      subtotal_cents: subtotal,
      tax_cents: taxCents,
      total_cents: total,
    });
  } catch (err) {
    console.error("Cart checkout failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }
});
