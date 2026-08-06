import { Hono } from "hono";
import type { Env, Event, TenantVariables } from "../types";
import { generateId, generateTicketCode } from "../lib/utils/id";
import { all, first } from "../lib/db";
import { sendEmail, waitlistPromotedEmail } from "../lib/email";
import {
  normalizeQuestions,
  parseEventSettings,
} from "../lib/eventQuestions";
import { parseRecurrence, expandOccurrences } from "../lib/recurrence";

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
  custom_answers_json?: string;
  created_at: string;
};

eventRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const upcoming = c.req.query("upcoming") === "1";
  const month = c.req.query("month");
  let query = "SELECT * FROM events WHERE tenant_id = ?";
  const params: (string | number)[] = [tenant.id];
  if (month && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month)) {
    query += " AND substr(start_at, 1, 7) = ?";
    params.push(month);
  } else if (upcoming) {
    query += " AND start_at >= datetime('now')";
  }
  query += " ORDER BY start_at ASC LIMIT 400";
  const events = await all<Event>(c.env.DB.prepare(query).bind(...params));
  return c.json(events);
});

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
    questions?: unknown;
    recurrence?: unknown;
  }>();
  if (!body.title || !body.start_at) {
    return c.json({ error: "title and start_at are required" }, 400);
  }
  const rule = parseRecurrence(body.recurrence);
  const questions = normalizeQuestions(body.questions);
  const settingsJson = JSON.stringify({ questions });
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO events
     (id, tenant_id, title, description, location, start_at, end_at, capacity,
      member_price_cents, non_member_price_cents, is_public, waitlist_enabled,
      settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, tenant.id, body.title, body.description ?? null, body.location ?? null,
      body.start_at, body.end_at ?? null, body.capacity ?? null,
      body.member_price_cents ?? 0, body.non_member_price_cents ?? 0,
      body.is_public === false ? 0 : 1, body.waitlist_enabled ? 1 : 0,
      settingsJson, now, now
    )
    .run();
  // Materialize recurring occurrences as real event rows so registration,
  // capacity, calendar and ics all work unchanged.
  let created = 1;
  if (rule) {
    const occurrences = expandOccurrences(body.start_at, rule);
    const durationMs =
      body.end_at && !isNaN(new Date(body.end_at).getTime())
        ? new Date(body.end_at).getTime() - new Date(body.start_at).getTime()
        : 0;
    const stmts = [];
    for (let i = 1; i < occurrences.length; i++) {
      const startIso = occurrences[i];
      const endIso =
        durationMs > 0
          ? new Date(new Date(startIso).getTime() + durationMs).toISOString()
          : null;
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO events
           (id, tenant_id, title, description, location, start_at, end_at, capacity,
            member_price_cents, non_member_price_cents, is_public, waitlist_enabled,
            settings_json, recurrence_parent_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          generateId(), tenant.id, body.title, body.description ?? null,
          body.location ?? null, startIso, endIso, body.capacity ?? null,
          body.member_price_cents ?? 0, body.non_member_price_cents ?? 0,
          body.is_public === false ? 0 : 1, body.waitlist_enabled ? 1 : 0,
          settingsJson, id, now, now
        )
      );
    }
    for (let i = 0; i < stmts.length; i += 25) {
      await c.env.DB.batch(stmts.slice(i, i + 25));
    }
    created = occurrences.length;
    await c.env.DB.prepare("UPDATE events SET recurrence_rule = ? WHERE id = ?")
      .bind(JSON.stringify(rule), id)
      .run();
  }

  const event = await first<Event>(
    c.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id)
  );
  return c.json({ ...event, occurrences_created: created }, 201);
});

eventRoutes.get("/:eventId", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const event = await first<Event>(
    c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND tenant_id = ?").bind(eventId, tenant.id)
  );
  if (!event) return c.json({ error: "Not found" }, 404);
  return c.json(event);
});

eventRoutes.patch("/:eventId", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const body = await c.req.json();
  const existing = await first<Event>(
    c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND tenant_id = ?").bind(eventId, tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  const now = new Date().toISOString();

  let settingsJson: string | null = null;
  if (body.questions !== undefined) {
    const current = parseEventSettings(existing.settings_json);
    current.questions = normalizeQuestions(body.questions);
    settingsJson = JSON.stringify(current);
  }

  await c.env.DB.prepare(
    `UPDATE events SET
       title = coalesce(?, title), description = coalesce(?, description),
       location = coalesce(?, location), start_at = coalesce(?, start_at),
       end_at = coalesce(?, end_at), capacity = coalesce(?, capacity),
       member_price_cents = coalesce(?, member_price_cents),
       non_member_price_cents = coalesce(?, non_member_price_cents),
       registration_open = coalesce(?, registration_open),
       settings_json = coalesce(?, settings_json),
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.title ?? null, body.description ?? null, body.location ?? null,
      body.start_at ?? null, body.end_at ?? null, body.capacity ?? null,
      body.member_price_cents ?? null, body.non_member_price_cents ?? null,
      body.registration_open !== undefined ? (body.registration_open ? 1 : 0) : null,
      settingsJson,
      now, eventId, tenant.id
    )
    .run();
  const updated = await first<Event>(
    c.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId)
  );
  return c.json(updated);
});

eventRoutes.get("/:eventId/registrations", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const event = await first<Event>(
    c.env.DB.prepare(
      "SELECT * FROM events WHERE id = ? AND tenant_id = ?"
    ).bind(eventId, tenant.id)
  );
  const questions = parseEventSettings(event?.settings_json).questions || [];
  const { parsePageParams, pageMeta } = await import("../lib/pagination");
  const { limit, offset } = parsePageParams(
    {
      limit: c.req.query("limit") || undefined,
      offset: c.req.query("offset") || undefined,
      page: c.req.query("page") || undefined,
    },
    { limit: 200, max: 500 }
  );
  const countRow = await first<{ cnt: number }>(
    c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM event_registrations WHERE tenant_id = ? AND event_id = ?`
    ).bind(tenant.id, eventId)
  );
  const total = countRow?.cnt ?? 0;
  const regs = await all<Registration>(
    c.env.DB.prepare(
      `SELECT * FROM event_registrations WHERE tenant_id = ? AND event_id = ?
       ORDER BY created_at ASC LIMIT ? OFFSET ?`
    ).bind(tenant.id, eventId, limit, offset)
  );
  return c.json({
    questions,
    registrations: regs.map((r) => {
      let answers: Record<string, string> = {};
      try {
        answers = JSON.parse(r.custom_answers_json || "{}");
      } catch {}
      return { ...r, answers };
    }),
    ...pageMeta(total, limit, offset),
  });
});

eventRoutes.post("/:eventId/check-in", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{ registration_id?: string; ticket_code?: string }>();
  let reg: Registration | null = null;
  if (body.registration_id) {
    reg = await first<Registration>(
      c.env.DB.prepare(
        `SELECT * FROM event_registrations WHERE id = ? AND tenant_id = ? AND event_id = ?`
      ).bind(body.registration_id, tenant.id, eventId)
    );
  } else if (body.ticket_code) {
    reg = await first<Registration>(
      c.env.DB.prepare(
        `SELECT * FROM event_registrations WHERE ticket_code = ? AND tenant_id = ? AND event_id = ?`
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
    `UPDATE event_registrations SET status = 'checked_in', updated_at = ? WHERE id = ?`
  ).bind(now, reg.id).run();
  reg.status = "checked_in";
  return c.json({ message: "Checked in", registration: reg });
});

// GET /api/tenants/:tenantId/events/:eventId/registrations.csv
eventRoutes.get("/:eventId/registrations.csv", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const event = await first<Event>(
    c.env.DB.prepare(
      "SELECT settings_json FROM events WHERE id = ? AND tenant_id = ?"
    ).bind(eventId, tenant.id)
  );
  const questions = parseEventSettings(event?.settings_json).questions || [];
  const regs = await all<Record<string, unknown>>(
    c.env.DB.prepare(
      `SELECT name, email, status, ticket_code, amount_paid_cents, created_at, custom_answers_json
       FROM event_registrations WHERE event_id = ? AND tenant_id = ?
       ORDER BY created_at`
    ).bind(eventId, tenant.id)
  );
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const qHeaders = questions.map((q) => q.key);
  const header = [
    "name",
    "email",
    "status",
    "ticket_code",
    "amount_paid",
    "registered_at",
    ...qHeaders,
  ].join(",");
  const lines = regs.map((r) => {
    let answers: Record<string, string> = {};
    try {
      answers = JSON.parse(String(r.custom_answers_json || "{}"));
    } catch {}
    return [
      r.name,
      r.email,
      r.status,
      r.ticket_code,
      ((r.amount_paid_cents as number) / 100).toFixed(2),
      r.created_at,
      ...qHeaders.map((k) => answers[k] || ""),
    ]
      .map(cell)
      .join(",");
  });
  return new Response([header, ...lines].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="registrations.csv"',
    },
  });
});

// DELETE /api/tenants/:tenantId/events/:eventId
eventRoutes.delete("/:eventId", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const existing = await first(
    c.env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND tenant_id = ?"
    ).bind(eventId, tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM event_registrations WHERE event_id = ? AND tenant_id = ?"
    ).bind(eventId, tenant.id),
    c.env.DB.prepare(
      "DELETE FROM events WHERE id = ? AND tenant_id = ?"
    ).bind(eventId, tenant.id),
  ]);
  return c.json({ ok: true });
});

// PATCH /api/tenants/:tenantId/events/:eventId/registrations/:regId
// Promote from waitlist, cancel, or un-cancel a registration.
eventRoutes.patch("/:eventId/registrations/:regId", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const regId = c.req.param("regId");
  const body = await c.req.json<{ status: string }>();
  if (!["registered", "waitlist", "cancelled", "checked_in"].includes(body.status)) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const prev = await first<{
    status: string;
    email: string;
    name: string | null;
    ticket_code: string | null;
  }>(
    c.env.DB.prepare(
      `SELECT status, email, name, ticket_code FROM event_registrations
       WHERE id = ? AND event_id = ? AND tenant_id = ?`
    ).bind(regId, eventId, tenant.id)
  );
  if (!prev) return c.json({ error: "Registration not found" }, 404);

  const res = await c.env.DB.prepare(
    `UPDATE event_registrations SET status = ?, updated_at = ?
     WHERE id = ? AND event_id = ? AND tenant_id = ?`
  )
    .bind(body.status, new Date().toISOString(), regId, eventId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Registration not found" }, 404);

  // Notify when promoted off the waitlist
  if (prev.status === "waitlist" && body.status === "registered") {
    const event = await first<{
      title: string;
      start_at: string;
      location: string | null;
    }>(
      c.env.DB.prepare(
        "SELECT title, start_at, location FROM events WHERE id = ? AND tenant_id = ?"
      ).bind(eventId, tenant.id)
    );
    if (event) {
      const eventDate = new Date(event.start_at).toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "short",
      });
      const { subject, html } = waitlistPromotedEmail({
        guildName: tenant.name,
        firstName: prev.name?.split(" ")[0],
        eventTitle: event.title,
        eventDate,
        eventLocation: event.location ?? undefined,
        ticketCode: prev.ticket_code ?? undefined,
      });
      await sendEmail(c.env, { to: prev.email, subject, html });
    }
  }

  return c.json({ ok: true, status: body.status });
});


// ---------------------------------------------------------------------------
// Volunteer sign-up sheets (refreshments, show shifts, setup/teardown)
// ---------------------------------------------------------------------------

type SlotRow = {
  id: string;
  event_id: string;
  title: string;
  description: string | null;
  needed: number;
  starts_at: string | null;
  sort_order: number;
};

eventRoutes.get("/:eventId/volunteers.csv", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const rows = await all<Record<string, unknown>>(
    c.env.DB.prepare(
      `SELECT s.title slot, g.name, g.email, g.phone, g.note, g.created_at
       FROM volunteer_signups g JOIN volunteer_slots s ON s.id = g.slot_id
       WHERE g.tenant_id = ? AND g.event_id = ?
       ORDER BY s.sort_order, s.title, g.created_at`
    ).bind(tenant.id, eventId)
  );
  const cell = (v: unknown) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const body = ["slot,name,email,phone,note,signed_up_at"]
    .concat(
      rows.map((r) =>
        [r.slot, r.name, r.email, r.phone, r.note, r.created_at].map(cell).join(",")
      )
    )
    .join("\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="volunteers.csv"',
    },
  });
});

eventRoutes.get("/:eventId/volunteers", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const slots = await all<SlotRow>(
    c.env.DB.prepare(
      `SELECT id, event_id, title, description, needed, starts_at, sort_order
       FROM volunteer_slots WHERE tenant_id = ? AND event_id = ?
       ORDER BY sort_order, title`
    ).bind(tenant.id, eventId)
  );
  const signups = await all<{
    id: string;
    slot_id: string;
    name: string | null;
    email: string;
    phone: string | null;
    note: string | null;
    created_at: string;
  }>(
    c.env.DB.prepare(
      `SELECT id, slot_id, name, email, phone, note, created_at
       FROM volunteer_signups WHERE tenant_id = ? AND event_id = ?
       ORDER BY created_at`
    ).bind(tenant.id, eventId)
  );
  return c.json({
    slots: slots.map((s) => ({
      ...s,
      signups: signups.filter((g) => g.slot_id === s.id),
    })),
  });
});

eventRoutes.post("/:eventId/volunteers", async (c) => {
  const tenant = c.get("tenant");
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    title: string;
    description?: string;
    needed?: number;
    starts_at?: string;
    sort_order?: number;
  }>();
  if (!body.title) return c.json({ error: "title is required" }, 400);
  const event = await first(
    c.env.DB.prepare("SELECT id FROM events WHERE id = ? AND tenant_id = ?").bind(
      eventId,
      tenant.id
    )
  );
  if (!event) return c.json({ error: "Event not found" }, 404);
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO volunteer_slots
     (id, tenant_id, event_id, title, description, needed, starts_at, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, tenant.id, eventId, body.title, body.description ?? null,
      Math.max(1, Number(body.needed) || 1), body.starts_at ?? null,
      body.sort_order ?? 0, now, now
    )
    .run();
  return c.json({ ok: true, id }, 201);
});

eventRoutes.delete("/:eventId/volunteers/:slotId/signups/:signupId", async (c) => {
  const tenant = c.get("tenant");
  const res = await c.env.DB.prepare(
    "DELETE FROM volunteer_signups WHERE id = ? AND tenant_id = ? AND slot_id = ?"
  )
    .bind(c.req.param("signupId"), tenant.id, c.req.param("slotId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "Signup not found" }, 404);
  return c.json({ ok: true });
});

eventRoutes.delete("/:eventId/volunteers/:slotId", async (c) => {
  const tenant = c.get("tenant");
  const res = await c.env.DB.prepare(
    "DELETE FROM volunteer_slots WHERE id = ? AND tenant_id = ? AND event_id = ?"
  )
    .bind(c.req.param("slotId"), tenant.id, c.req.param("eventId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "Slot not found" }, 404);
  return c.json({ ok: true });
});
