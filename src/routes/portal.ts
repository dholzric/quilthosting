import { Hono } from "hono";
import type { Env, Member, MembershipLevel, Event, Plan } from "../types";
import { all, first } from "../lib/db";
import { extractBearer, verifyJwt } from "../lib/auth";
import { createCheckoutSession } from "../lib/stripe";
import { activateMembership, portalUrl } from "../lib/memberships";
import { assertCanActivateMember } from "../lib/plans";
import { renderReceiptHtml } from "../lib/receipts";

export const portalRoutes = new Hono<{ Bindings: Env }>();

type PortalUser = { id: string; email: string; name?: string };

async function requirePortalUser(c: any): Promise<PortalUser | null> {
  const token = extractBearer(c.req.header("Authorization"));
  if (!token) return null;
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) return null;
  return { id: payload.sub, email: payload.email, name: payload.name };
}

async function getTenantBySlug(db: D1Database, slug: string) {
  return first<{ id: string; name: string; slug: string; status: string }>(
    db
      .prepare("SELECT id, name, slug, status FROM tenants WHERE slug = ? AND status = 'active'")
      .bind(slug)
  );
}

/**
 * GET /api/portal/:slug/me
 * Returns the logged-in user's member profile + active membership for this guild.
 */
portalRoutes.get("/:slug/me", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, user.email)
  );

  if (!member) {
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      member: null,
      membership: null,
      message: "Not a member of this guild yet",
    });
  }

  // Prefer the active membership; fall back to most recent history row
  const membership = await first<{
    id: string;
    level_id: string;
    start_date: string;
    end_date: string | null;
    status: string;
    level_name: string;
    price_cents: number;
  }>(
    c.env.DB.prepare(
      `SELECT m.id, m.level_id, m.start_date, m.end_date, m.status,
              l.name as level_name, l.price_cents
       FROM memberships m
       JOIN membership_levels l ON l.id = m.level_id
       WHERE m.member_id = ? AND m.tenant_id = ?
       ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.created_at DESC
       LIMIT 1`
    ).bind(member.id, tenant.id)
  );

  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    member,
    membership,
    user: { email: user.email, name: user.name },
  });
});

/**
 * GET /api/portal/:slug/events
 * Upcoming events + this member's registrations.
 */
portalRoutes.get("/:slug/events", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const events = await all<Event>(
    c.env.DB.prepare(
      `SELECT * FROM events
       WHERE tenant_id = ? AND start_at >= datetime('now')
       ORDER BY start_at ASC LIMIT 50`
    ).bind(tenant.id)
  );

  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, user.email)
  );

  let myRegs: { event_id: string; status: string; ticket_code: string | null }[] = [];
  if (member) {
    myRegs = await all(
      c.env.DB.prepare(
        `SELECT event_id, status, ticket_code FROM event_registrations
         WHERE tenant_id = ? AND (member_id = ? OR email = ?)
           AND status IN ('registered', 'waitlist', 'checked_in')`
      ).bind(tenant.id, member.id, user.email)
    );
  }

  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    events,
    my_registrations: myRegs,
    is_member: !!member && member.status === "active",
  });
});

/**
 * GET /api/portal/:slug/invoices
 * Payment history for this member.
 */
portalRoutes.get("/:slug/invoices", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, user.email)
  );
  if (!member) return c.json({ invoices: [] });

  const invoices = await all(
    c.env.DB.prepare(
      `SELECT id, type, amount_cents, currency, status, description, created_at
       FROM payments
       WHERE tenant_id = ? AND member_id = ?
       ORDER BY created_at DESC
       LIMIT 50`
    ).bind(tenant.id, member.id)
  );

  return c.json({ invoices });
});

/**
 * GET /api/portal/:slug/receipts/:paymentId
 * Printable receipt HTML for a payment belonging to this member.
 */
portalRoutes.get("/:slug/receipts/:paymentId", async (c) => {
  // Support ?token= so printable receipts open in a new tab without custom headers
  const token =
    extractBearer(c.req.header("Authorization")) || c.req.query("token") || "";
  const payload = token ? await verifyJwt(token, c.env.JWT_SECRET) : null;
  if (!payload) return c.json({ error: "Unauthorized" }, 401);

  const slug = c.req.param("slug");
  const paymentId = c.req.param("paymentId");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, payload.email)
  );
  if (!member) return c.json({ error: "Not a member" }, 403);

  const payment = await first<{
    id: string;
    type: string;
    amount_cents: number;
    currency: string;
    status: string;
    description: string | null;
    created_at: string;
    stripe_payment_intent_id: string | null;
    member_id: string | null;
  }>(
    c.env.DB.prepare(
      `SELECT * FROM payments
       WHERE id = ? AND tenant_id = ? AND member_id = ?`
    ).bind(paymentId, tenant.id, member.id)
  );
  if (!payment) return c.json({ error: "Receipt not found" }, 404);

  const html = renderReceiptHtml({
    guildName: tenant.name,
    receiptId: payment.id,
    date: payment.created_at,
    type: payment.type,
    description: payment.description || "",
    amountCents: payment.amount_cents,
    currency: payment.currency,
    status: payment.status,
    payerName: [member.first_name, member.last_name].filter(Boolean).join(" ") || null,
    payerEmail: member.email,
    stripeRef: payment.stripe_payment_intent_id,
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

/**
 * POST /api/portal/:slug/renew
 * Start Stripe Checkout to renew membership at a given level.
 */
portalRoutes.post("/:slug/renew", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const body = await c.req.json<{ level_id?: string }>();

  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, user.email)
  );
  if (!member) {
    return c.json({ error: "Not a member — use join instead" }, 400);
  }

  // Use specified level or current/last level
  let levelId = body.level_id;
  if (!levelId) {
    const last = await first<{ level_id: string }>(
      c.env.DB.prepare(
        `SELECT level_id FROM memberships
         WHERE member_id = ? AND tenant_id = ?
         ORDER BY created_at DESC LIMIT 1`
      ).bind(member.id, tenant.id)
    );
    levelId = last?.level_id;
  }
  if (!levelId) {
    return c.json({ error: "No membership level specified" }, 400);
  }

  const level = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(levelId, tenant.id)
  );
  if (!level) return c.json({ error: "Level not found" }, 404);

  // Need full tenant for stripe_account_id + plan
  const fullTenant = await first<{
    id: string;
    slug: string;
    name: string;
    plan: Plan;
    stripe_account_id: string | null;
  }>(
    c.env.DB.prepare(
      "SELECT id, slug, name, plan, stripe_account_id FROM tenants WHERE id = ?"
    ).bind(tenant.id)
  );
  if (!fullTenant) return c.json({ error: "Guild not found" }, 404);

  if (level.price_cents === 0) {
    const now = new Date().toISOString();
    try {
      await assertCanActivateMember(c.env.DB, fullTenant, member.id);
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
    return c.json({ status: "active", membership_id: membershipId });
  }

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  try {
    await assertCanActivateMember(c.env.DB, fullTenant, member.id);
  } catch (e: any) {
    return c.json(
      { error: e.message || "Plan limit reached", code: e.code || "plan_limit" },
      e.status || 402
    );
  }

  const session = await createCheckoutSession(c.env, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    memberId: member.id,
    email: member.email,
    name: [member.first_name, member.last_name].filter(Boolean).join(" ") || undefined,
    amountCents: level.price_cents,
    description: `${tenant.name} – ${level.name} Renewal`,
    type: "dues",
    relatedId: level.id,
    successUrl: portalUrl(c.env.APP_URL, tenant.slug, { renewed: "1" }),
    cancelUrl: portalUrl(c.env.APP_URL, tenant.slug, { cancelled: "1" }),
    mode: level.renewal_type === "auto" ? "subscription" : "payment",
    interval: level.duration_months >= 12 ? "year" : "month",
    stripeAccountId: fullTenant.stripe_account_id,
  });

  return c.json({
    status: "checkout",
    checkout_url: session.url,
    session_id: session.id,
  });
});

/**
 * PATCH /api/portal/:slug/profile
 * Update member profile fields.
 */
portalRoutes.patch("/:slug/profile", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const body = await c.req.json<{
    first_name?: string;
    last_name?: string;
    phone?: string;
    directory_visible?: boolean;
    custom_fields?: Record<string, string>;
    bio?: string;
    showcase?: { headline?: string; interests?: string; website?: string };
  }>();

  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, user.email)
  );
  if (!member) return c.json({ error: "Not a member" }, 404);

  let customJson: string | null = null;
  if (body.custom_fields && typeof body.custom_fields === "object") {
    let current: Record<string, string> = {};
    try { current = JSON.parse(member.custom_fields_json || "{}"); } catch {}
    customJson = JSON.stringify({ ...current, ...body.custom_fields });
  }

  const now = new Date().toISOString();
  const dirVis =
    body.directory_visible === undefined
      ? null
      : body.directory_visible
        ? 1
        : 0;
  let showcaseJson: string | null = null;
  if (body.showcase && typeof body.showcase === "object") {
    let current: Record<string, string> = {};
    try {
      current = JSON.parse((member as any).showcase_json || "{}");
    } catch {}
    showcaseJson = JSON.stringify({
      ...current,
      headline: body.showcase.headline != null ? String(body.showcase.headline).slice(0, 120) : current.headline,
      interests: body.showcase.interests != null ? String(body.showcase.interests).slice(0, 500) : current.interests,
      website: body.showcase.website != null ? String(body.showcase.website).slice(0, 300) : current.website,
    });
  }
  try {
    await c.env.DB.prepare(
      `UPDATE members SET
         first_name = coalesce(?, first_name),
         last_name = coalesce(?, last_name),
         phone = coalesce(?, phone),
         custom_fields_json = coalesce(?, custom_fields_json),
         directory_visible = coalesce(?, directory_visible),
         bio = coalesce(?, bio),
         showcase_json = coalesce(?, showcase_json),
         updated_at = ?
       WHERE id = ?`
    )
      .bind(
        body.first_name ?? null,
        body.last_name ?? null,
        body.phone ?? null,
        customJson,
        dirVis,
        body.bio !== undefined ? String(body.bio).slice(0, 2000) : null,
        showcaseJson,
        now,
        member.id
      )
      .run();
  } catch {
    await c.env.DB.prepare(
      `UPDATE members SET
         first_name = coalesce(?, first_name),
         last_name = coalesce(?, last_name),
         phone = coalesce(?, phone),
         custom_fields_json = coalesce(?, custom_fields_json),
         updated_at = ?
       WHERE id = ?`
    )
      .bind(
        body.first_name ?? null,
        body.last_name ?? null,
        body.phone ?? null,
        customJson,
        now,
        member.id
      )
      .run();
  }

  const updated = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(member.id)
  );
  return c.json({ member: updated });
});

// Helper: the logged-in user's member row for this guild (any status but cancelled)
async function requireGuildMember(c: any, slug: string) {
  const user = await requirePortalUser(c);
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401) };
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return { error: c.json({ error: "Guild not found" }, 404) };
  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ? AND status != 'cancelled'"
    ).bind(tenant.id, user.email.toLowerCase())
  );
  if (!member) return { error: c.json({ error: "Not a member of this guild" }, 403) };
  return { user, tenant, member };
}

// GET /api/portal/:slug/directory — active members + showcase
portalRoutes.get("/:slug/directory", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  try {
    const rows = await all<{
      first_name: string | null;
      last_name: string | null;
      joined_at: string | null;
      bio: string | null;
      photo_file_id: string | null;
      showcase_json: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT first_name, last_name, joined_at, bio, photo_file_id, showcase_json FROM members
         WHERE tenant_id = ? AND status = 'active'
           AND coalesce(directory_visible, 1) = 1
         ORDER BY last_name, first_name LIMIT 100 OFFSET ?`
      ).bind(ctx.tenant.id, Math.max(0, Math.min(5000, Number(c.req.query("offset")) || 0)))
    );
    const countRow = await first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM members
         WHERE tenant_id = ? AND status = 'active'
           AND coalesce(directory_visible, 1) = 1`
      ).bind(ctx.tenant.id)
    );
    return c.json({
      tenant: { name: ctx.tenant.name },
      members: rows,
      total: countRow?.cnt ?? rows.length,
      limit: 100,
      offset: Math.max(0, Math.min(5000, Number(c.req.query("offset")) || 0)),
    });
  } catch {
    const rows = await all<{
      first_name: string | null;
      last_name: string | null;
      joined_at: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT first_name, last_name, joined_at FROM members
         WHERE tenant_id = ? AND status = 'active'
         ORDER BY last_name, first_name LIMIT 100`
      ).bind(ctx.tenant.id)
    );
    return c.json({ tenant: { name: ctx.tenant.name }, members: rows, total: rows.length });
  }
});

// POST /api/portal/:slug/cancel-auto-renew — stop Stripe subscription auto-renew
portalRoutes.post("/:slug/cancel-auto-renew", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, user.email)
  );
  if (!member) return c.json({ error: "Not a member" }, 404);

  const membership = await first<{
    id: string;
    stripe_subscription_id: string | null;
    auto_renew: number;
  }>(
    c.env.DB.prepare(
      `SELECT id, stripe_subscription_id, auto_renew FROM memberships
       WHERE member_id = ? AND tenant_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(member.id, tenant.id)
  );
  if (!membership?.stripe_subscription_id) {
    return c.json(
      { error: "No auto-renew subscription on file for this membership" },
      400
    );
  }

  const { cancelSubscription } = await import("../lib/stripe");
  try {
    await cancelSubscription(c.env, membership.stripe_subscription_id);
  } catch (e: any) {
    return c.json({ error: e.message || "Could not cancel with Stripe" }, 502);
  }
  await c.env.DB.prepare(
    `UPDATE memberships SET auto_renew = 0, updated_at = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), membership.id)
    .run();
  return c.json({
    ok: true,
    message: "Auto-renew cancelled. Your membership stays active until the end date.",
  });
});

/**
 * POST /api/portal/:slug/update-card
 * Stripe Customer Portal deep-link to update payment method on file.
 */
portalRoutes.post("/:slug/update-card", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const member = await first<Member & { stripe_customer_id?: string | null }>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, user.email)
  );
  if (!member) return c.json({ error: "Not a member" }, 404);

  const membership = await first<{ stripe_subscription_id: string | null }>(
    c.env.DB.prepare(
      `SELECT stripe_subscription_id FROM memberships
       WHERE member_id = ? AND tenant_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(member.id, tenant.id)
  );
  if (!membership?.stripe_subscription_id) {
    return c.json({ error: "No auto-renew subscription — nothing to update" }, 400);
  }

  const {
    retrieveSubscription,
    createCustomerPortalSession,
  } = await import("../lib/stripe");
  try {
    const sub = await retrieveSubscription(c.env, membership.stripe_subscription_id);
    const customerId =
      (typeof sub.customer === "string" && sub.customer) ||
      member.stripe_customer_id ||
      null;
    if (!customerId) {
      return c.json({ error: "No Stripe customer on file for this membership" }, 400);
    }
    if (!member.stripe_customer_id) {
      try {
        await c.env.DB.prepare(
          `UPDATE members SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`
        )
          .bind(customerId, new Date().toISOString(), member.id)
          .run();
      } catch {
        /* column may not exist */
      }
    }
    const url = await createCustomerPortalSession(c.env, {
      customerId,
      returnUrl: portalUrl(c.env.APP_URL, tenant.slug, { card: "updated" }),
    });
    return c.json({ url });
  } catch (e: any) {
    return c.json({ error: e.message || "Could not open card update portal" }, 502);
  }
});

// --- Members-only forum ---
portalRoutes.get("/:slug/forum/topics", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT t.id, t.title, t.body, t.is_pinned, t.reply_count, t.created_at, t.updated_at,
                m.first_name, m.last_name
         FROM forum_topics t
         LEFT JOIN members m ON m.id = t.member_id
         WHERE t.tenant_id = ?
         ORDER BY t.is_pinned DESC, t.updated_at DESC LIMIT 100`
      ).bind(ctx.tenant.id)
    );
    return c.json({ topics: rows });
  } catch {
    return c.json({ topics: [] });
  }
});

portalRoutes.post("/:slug/forum/topics", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  const body = await c.req.json<{ title: string; body: string }>();
  const title = (body.title || "").trim().slice(0, 200);
  const text = (body.body || "").trim().slice(0, 10000);
  if (!title || !text) return c.json({ error: "title and body required" }, 400);
  const id = (await import("../lib/utils/id")).generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO forum_topics (id, tenant_id, member_id, title, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, ctx.tenant.id, ctx.member.id, title, text, now, now)
    .run();
  return c.json({ id, title }, 201);
});

portalRoutes.get("/:slug/forum/topics/:topicId", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  const topic = await first(
    c.env.DB.prepare(
      `SELECT t.*, m.first_name, m.last_name FROM forum_topics t
       LEFT JOIN members m ON m.id = t.member_id
       WHERE t.id = ? AND t.tenant_id = ?`
    ).bind(c.req.param("topicId"), ctx.tenant.id)
  );
  if (!topic) return c.json({ error: "Not found" }, 404);
  const posts = await all(
    c.env.DB.prepare(
      `SELECT p.id, p.body, p.created_at, m.first_name, m.last_name
       FROM forum_posts p
       LEFT JOIN members m ON m.id = p.member_id
       WHERE p.topic_id = ? ORDER BY p.created_at ASC LIMIT 200`
    ).bind(c.req.param("topicId"))
  );
  return c.json({ topic, posts });
});

portalRoutes.post("/:slug/forum/topics/:topicId/replies", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  const topic = await first(
    c.env.DB.prepare(
      `SELECT id FROM forum_topics WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("topicId"), ctx.tenant.id)
  );
  if (!topic) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ body: string }>();
  const text = (body.body || "").trim().slice(0, 10000);
  if (!text) return c.json({ error: "body required" }, 400);
  const id = (await import("../lib/utils/id")).generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO forum_posts (id, tenant_id, topic_id, member_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, ctx.tenant.id, c.req.param("topicId"), ctx.member.id, text, now)
    .run();
  await c.env.DB.prepare(
    `UPDATE forum_topics SET reply_count = coalesce(reply_count,0) + 1, updated_at = ? WHERE id = ?`
  )
    .bind(now, c.req.param("topicId"))
    .run();
  return c.json({ id }, 201);
});

/** Upload profile photo (raw body, image/*) */
portalRoutes.post("/:slug/photo", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  const contentType = c.req.header("Content-Type") || "image/jpeg";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "Image required" }, 400);
  }
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) {
    return c.json({ error: "Image must be under 5 MB" }, 400);
  }
  const { generateId } = await import("../lib/utils/id");
  const id = generateId();
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const filename = `avatar.${ext}`;
  const key = `${ctx.tenant.id}/${id}/${filename}`;
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType } });
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, ctx.tenant.id, key, filename, contentType, bytes.byteLength, ctx.user.id, now)
    .run();
  try {
    await c.env.DB.prepare(
      `UPDATE members SET photo_file_id = ?, updated_at = ? WHERE id = ?`
    )
      .bind(id, now, ctx.member.id)
      .run();
  } catch {
    return c.json({ error: "Photo column missing — run migration 0008" }, 503);
  }
  return c.json({
    ok: true,
    photo_file_id: id,
    photo_url: `/public/${ctx.tenant.slug}/member-photo/${id}`,
  });
});

// GET /api/portal/:slug/files — guild document library
portalRoutes.get("/:slug/files", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, filename, content_type, size, created_at
       FROM files WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`
    ).bind(ctx.tenant.id)
  );
  return c.json(rows);
});

// GET /api/portal/:slug/files/:fileId — download (?token= supported so plain <a> links work)
portalRoutes.get("/:slug/files/:fileId", async (c) => {
  const token =
    extractBearer(c.req.header("Authorization")) || c.req.query("token") || "";
  const payload = token ? await verifyJwt(token, c.env.JWT_SECRET) : null;
  if (!payload) return c.json({ error: "Unauthorized" }, 401);
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ? AND status != 'cancelled'"
    ).bind(tenant.id, payload.email.toLowerCase())
  );
  if (!member) return c.json({ error: "Not a member of this guild" }, 403);
  const row = await first<{ r2_key: string; filename: string; content_type: string | null }>(
    c.env.DB.prepare(
      "SELECT r2_key, filename, content_type FROM files WHERE id = ? AND tenant_id = ?"
    ).bind(c.req.param("fileId"), tenant.id)
  );
  if (!row) return c.json({ error: "File not found" }, 404);
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "File data missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
    },
  });
});

// GET /api/portal/:slug/pages — published pages incl. members-only
portalRoutes.get("/:slug/pages", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT slug, title, content_json, is_members_only FROM pages
       WHERE tenant_id = ? AND published = 1 ORDER BY sort_order, title`
    ).bind(ctx.tenant.id)
  );
  return c.json(rows);
});

// GET /api/portal/guilds — guilds where this signed-in email is a member
portalRoutes.get("/guilds", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = await all<{ name: string; slug: string; status: string }>(
    c.env.DB.prepare(
      `SELECT t.name, t.slug, m.status FROM members m
       JOIN tenants t ON t.id = m.tenant_id
       WHERE m.email = ? AND m.status != 'cancelled' AND t.status = 'active'
       ORDER BY t.name`
    ).bind(user.email.toLowerCase())
  );
  return c.json({ guilds: rows });
});

// GET /api/portal/:slug/newsletters — read past blasts online
portalRoutes.get("/:slug/newsletters", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  const rows = await all<{ id: string; subject: string; created_at: string; body_html: string }>(
    c.env.DB.prepare(
      `SELECT id, subject, created_at, body_html FROM blasts
       WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`
    ).bind(ctx.tenant.id)
  );
  return c.json(rows);
});
