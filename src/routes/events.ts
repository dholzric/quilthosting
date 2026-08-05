import { Hono } from "hono";
import type { Env, Event, TenantVariables } from "../types";
import { generateId, generateTicketCode } from "../lib/utils/id";
import { all, first } from "../lib/db";
import { createCheckoutSession } from "../lib/stripe";
import { sendEmail, eventConfirmationEmail } from "../lib/email";
import { formatMoney } from "../lib/utils/money";

export const eventRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type Registration = {
  id: string;
  tenant_id: string;
  event_id: string;
  member_id: string | null;
  email: string;
  name: string | null;
  status: string;
  amount_paid_cents: number;
  ticket_code: string | null;
  created_at: string;
};

// GET /api/tenants/:tenantId/events
eventRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const upcoming = c.req.query("upcoming") === "1";

  let query = "SELECT * FROM events WHERE tenant_id = ?";
  const params: (string | number)[] = [tenant.id];

  if (upcoming) {
    query += " AND start_at >= datetime('now')";
  }
  query += " ORDER BY start_at ASC LIMIT 100";

  const events = await all<Event>(c.env.DB.prepare(query).bind(...params));
  return c.json(events);
});

// POST /api/tenants/:tenantId/events
eventRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    title: string;
    description?: string;
    location?: string;
    start_at: string;
    end_at?: string;
    capacity?: number;
    member_price_cents?: number;
    non_member_price_cents?: number;
    is_public?: boolean;
    waitlist_enabled?: boolean;
  }>();

  if (!body.title || !body.start_at) {
    return c.json({ error: "title and start_at are required" }, 400);
  }

  const id = generateId();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO events
     (id, tenant_id, title, description, location, start_at, end_at, capacity,
      member_price_cents, non_member_price_cents, is_public, waitlist_enabled,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      body.title,
      body.description ?? null,
      body.location ?? null,
      body.start_at,
      body.end_at ?? null,
      body.capacity ?? null,
      body.member_price_cents ?? 0,
      body.non_member_price_cents ?? 0,
      body.is_public === false ? 0 : 1,
      body.waitlist_enabled ? 1 : 0,
      now,
      now
    )
    .run();

  const event = await first<Event>(
    c.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id)
  );
  return c.json(event, 201);
});

// GET /api/tenants/:tenantId/events/:eventId
eventRoutes.get("/:eventId", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");

  const event = await first<Event>(
    c.env.DB.prepare(
      "SELECT * FROM events WHERE id = ? AND tenant_id = ?"
    ).bind(eventId, tenant.id)
  );

  if (!event) return c.json({ error: "Not found" }, 404);
  return c.json(event);
});

// PATCH /api/tenants/:tenantId/events/:eventId
eventRoutes.patch("/:eventId", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const body = await c.req.json();

  const existing = await first<Event>(
    c.env.DB.prepare(
      "SELECT * FROM events WHERE id = ? AND tenant_id = ?"
    ).bind(eventId, tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE events SET
       title = coalesce(?, title),
       description = coalesce(?, description),
       location = coalesce(?, location),
       start_at = coalesce(?, start_at),
       end_at = coalesce(?, end_at),
       capacity = coalesce(?, capacity),
       member_price_cents = coalesce(?, member_price_cents),
       non_member_price_cents = coalesce(?, non_member_price_cents),
       registration_open = coalesce(?, registration_open),
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.title ?? null,
      body.description ?? null,
      body.location ?? null,
      body.start_at ?? null,
      body.end_at ?? null,
      body.capacity ?? null,
      body.member_price_cents ?? null,
      body.non_member_price_cents ?? null,
      body.registration_open !== undefined
        ? body.registration_open
          ? 1
          : 0
        : null,
      now,
      eventId,
      tenant.id
    )
    .run();

  const updated = await first<Event>(
    c.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId)
  );
  return c.json(updated);
});

// GET /api/tenants/:tenantId/events/:eventId/registrations
eventRoutes.get("/:eventId/registrations", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");

  const regs = await all<Registration>(
    c.env.DB.prepare(
      `SELECT * FROM event_registrations
       WHERE tenant_id = ? AND event_id = ?
       ORDER BY created_at ASC`
    ).bind(tenant.id, eventId)
  );
  return c.json(regs);
});

// POST /api/tenants/:tenantId/events/:eventId/check-in
eventRoutes.post("/:eventId/check-in", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    registration_id?: string;
    ticket_code?: string;
  }>();

  let reg: Registration | null = null;

  if (body.registration_id) {
    reg = await first<Registration>(
      c.env.DB.prepare(
        `SELECT * FROM event_registrations
         WHERE id = ? AND tenant_id = ? AND event_id = ?`
      ).bind(body.registration_id, tenant.id, eventId)
    );
  } else if (body.ticket_code) {
    reg = await first<Registration>(
      c.env.DB.prepare(
        `SELECT * FROM event_registrations
         WHERE ticket_code = ? AND tenant_id = ? AND event_id = ?`
      ).bind(body.ticket_code, tenant.id, eventId)
    );
  }

  if (!reg) return c.json({ error: "Registration not found" }, 404);
  if (reg.status === "checked_in") {
    return c.json({ message: "Already checked in", registration: reg });
  }
  if (reg.status === "cancelled") {
    return c.json({ error: "Registration was cancelled" }, 400);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE event_registrations SET status = 'checked_in', updated_at = ?
     WHERE id = ?`
  )
    .bind(now, reg.id)
    .run();

  reg.status = "checked_in";
  return c.json({ message: "Checked in", registration: reg });
});
