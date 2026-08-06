import { Hono } from "hono";
import type { Env, Member, MembershipLevel, Event } from "../types";
import { all, first } from "../lib/db";
import { extractBearer, verifyJwt } from "../lib/auth";
import { generateId } from "../lib/utils/id";
import { createCheckoutSession } from "../lib/stripe";

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
       ORDER BY m.created_at DESC
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

  if (level.price_cents === 0) {
    // Free renew
    const now = new Date().toISOString();
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

    return c.json({ status: "active", membership_id: membershipId });
  }

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
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
    successUrl: `${baseUrl}/portal.html?slug=${tenant.slug}&renewed=1`,
    cancelUrl: `${baseUrl}/portal.html?slug=${tenant.slug}&cancelled=1`,
    mode: level.renewal_type === "auto" ? "subscription" : "payment",
    interval: level.duration_months >= 12 ? "year" : "month",
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
    custom_fields?: Record<string, string>;
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

// GET /api/portal/:slug/directory — active members, names only
portalRoutes.get("/:slug/directory", async (c) => {
  const ctx = await requireGuildMember(c, c.req.param("slug"));
  if ("error" in ctx) return ctx.error;
  const rows = await all<{ first_name: string | null; last_name: string | null; joined_at: string | null }>(
    c.env.DB.prepare(
      `SELECT first_name, last_name, joined_at FROM members
       WHERE tenant_id = ? AND status = 'active'
       ORDER BY last_name, first_name LIMIT 500`
    ).bind(ctx.tenant.id)
  );
  return c.json({ tenant: { name: ctx.tenant.name }, members: rows });
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
