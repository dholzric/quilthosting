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
    db.prepare("SELECT id, name, slug, status FROM tenants WHERE slug = ? AND status = 'active'").bind(slug)
  );
}

portalRoutes.get("/:slug/me", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE tenant_id = ? AND email = ?").bind(tenant.id, user.email)
  );
  if (!member) {
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      member: null,
      membership: null,
      message: "Not a member of this guild yet",
    });
  }
  const membership = await first(
    c.env.DB.prepare(
      `SELECT m.id, m.level_id, m.start_date, m.end_date, m.status,
              l.name as level_name, l.price_cents
       FROM memberships m JOIN membership_levels l ON l.id = m.level_id
       WHERE m.member_id = ? AND m.tenant_id = ?
       ORDER BY m.created_at DESC LIMIT 1`
    ).bind(member.id, tenant.id)
  );
  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    member,
    membership,
    user: { email: user.email, name: user.name },
  });
});

portalRoutes.get("/:slug/events", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const events = await all<Event>(
    c.env.DB.prepare(
      `SELECT * FROM events WHERE tenant_id = ? AND start_at >= datetime('now') ORDER BY start_at ASC LIMIT 50`
    ).bind(tenant.id)
  );
  const member = await first<Member>(
    c.env.DB.prepare("SELECT id, status FROM members WHERE tenant_id = ? AND email = ?").bind(tenant.id, user.email)
  );
  let myRegs: any[] = [];
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
    is_member: !!member && (member as any).status === "active",
  });
});

portalRoutes.get("/:slug/invoices", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const member = await first<Member>(
    c.env.DB.prepare("SELECT id FROM members WHERE tenant_id = ? AND email = ?").bind(tenant.id, user.email)
  );
  if (!member) return c.json({ invoices: [] });
  const invoices = await all(
    c.env.DB.prepare(
      `SELECT id, type, amount_cents, currency, status, description, created_at
       FROM payments WHERE tenant_id = ? AND member_id = ?
       ORDER BY created_at DESC LIMIT 50`
    ).bind(tenant.id, member.id)
  );
  return c.json({ invoices });
});

portalRoutes.post("/:slug/renew", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const body = await c.req.json<{ level_id?: string }>();
  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE tenant_id = ? AND email = ?").bind(tenant.id, user.email)
  );
  if (!member) return c.json({ error: "Not a member — use join instead" }, 400);
  let levelId = body.level_id;
  if (!levelId) {
    const last = await first<{ level_id: string }>(
      c.env.DB.prepare(
        `SELECT level_id FROM memberships WHERE member_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 1`
      ).bind(member.id, tenant.id)
    );
    levelId = last?.level_id;
  }
  if (!levelId) return c.json({ error: "No membership level specified" }, 400);
  const level = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(levelId, tenant.id)
  );
  if (!level) return c.json({ error: "Level not found" }, 404);
  if (level.price_cents === 0) {
    const now = new Date().toISOString();
    const membershipId = generateId();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + level.duration_months);
    await c.env.DB.prepare(
      `INSERT INTO memberships
       (id, tenant_id, member_id, level_id, start_date, end_date, status, amount_paid_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`
    ).bind(membershipId, tenant.id, member.id, level.id, now, endDate.toISOString(), now, now).run();
    await c.env.DB.prepare("UPDATE members SET status = 'active', updated_at = ? WHERE id = ?").bind(now, member.id).run();
    return c.json({ status: "active", membership_id: membershipId });
  }
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: "Payments not configured" }, 503);
  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const session = await createCheckoutSession(c.env, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    memberId: member.id,
    email: member.email,
    amountCents: level.price_cents,
    description: `${tenant.name} – ${level.name} Renewal`,
    type: "dues",
    relatedId: level.id,
    successUrl: `${baseUrl}/portal.html?slug=${tenant.slug}&renewed=1`,
    cancelUrl: `${baseUrl}/portal.html?slug=${tenant.slug}&cancelled=1`,
    mode: level.renewal_type === "auto" ? "subscription" : "payment",
    interval: level.duration_months >= 12 ? "year" : "month",
  });
  return c.json({ status: "checkout", checkout_url: session.url, session_id: session.id });
});

portalRoutes.patch("/:slug/profile", async (c) => {
  const user = await requirePortalUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const body = await c.req.json<{ first_name?: string; last_name?: string; phone?: string }>();
  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE tenant_id = ? AND email = ?").bind(tenant.id, user.email)
  );
  if (!member) return c.json({ error: "Not a member" }, 404);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE members SET first_name = coalesce(?, first_name), last_name = coalesce(?, last_name),
     phone = coalesce(?, phone), updated_at = ? WHERE id = ?`
  ).bind(body.first_name ?? null, body.last_name ?? null, body.phone ?? null, now, member.id).run();
  const updated = await first<Member>(c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(member.id));
  return c.json({ member: updated });
});
