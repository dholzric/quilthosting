import { Hono } from "hono";
import type { Env, Member, TenantVariables } from "../types";
import { generateId } from "../lib/utils/id";
import { all, first } from "../lib/db";

export const memberRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

memberRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const status = c.req.query("status");
  const search = c.req.query("q");
  let query = "SELECT * FROM members WHERE tenant_id = ?";
  const params: any[] = [tenant.id];
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }
  if (search) {
    query += " AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)";
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  query += " ORDER BY last_name, first_name, email LIMIT 200";
  const members = await all<Member>(
    c.env.DB.prepare(query).bind(...params)
  );
  return c.json(members);
});

memberRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    email: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    status?: string;
  }>();
  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }
  const existing = await first(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, body.email.toLowerCase())
  );
  if (existing) {
    return c.json({ error: "Member with this email already exists" }, 409);
  }
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO members
     (id, tenant_id, email, first_name, last_name, phone, status, joined_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      body.email.toLowerCase(),
      body.first_name ?? null,
      body.last_name ?? null,
      body.phone ?? null,
      body.status ?? "pending",
      now,
      now,
      now
    )
    .run();
  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id)
  );
  return c.json(member, 201);
});

// GET /api/tenants/:tenantId/members/export.csv
memberRoutes.get("/export.csv", async (c) => {
  const tenant = c.get("tenant");
  const members = await all<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? ORDER BY last_name, first_name"
    ).bind(tenant.id)
  );
  const csvCell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = "email,first_name,last_name,phone,status,joined_at,notes";
  const lines = members.map((m) =>
    [m.email, m.first_name, m.last_name, m.phone, m.status, m.joined_at, m.notes]
      .map(csvCell)
      .join(",")
  );
  return new Response([header, ...lines].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="members.csv"',
    },
  });
});

memberRoutes.get("/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!member) return c.json({ error: "Not found" }, 404);
  return c.json(member);
});

const MEMBER_STATUSES = ["pending", "active", "lapsed", "cancelled"];

memberRoutes.patch("/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const body = await c.req.json<{
    email?: string;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    status?: string;
    notes?: string | null;
  }>();

  const existing = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!existing) return c.json({ error: "Member not found" }, 404);

  if (body.status && !MEMBER_STATUSES.includes(body.status)) {
    return c.json({ error: "Invalid status" }, 400);
  }
  if (body.email !== undefined) {
    const email = body.email.toLowerCase().trim();
    if (!email) return c.json({ error: "email cannot be empty" }, 400);
    const dupe = await first(
      c.env.DB.prepare(
        "SELECT id FROM members WHERE tenant_id = ? AND email = ? AND id != ?"
      ).bind(tenant.id, email, memberId)
    );
    if (dupe) return c.json({ error: "Another member already uses that email" }, 409);
    body.email = email;
  }

  const fields: string[] = [];
  const params: any[] = [];
  for (const key of ["email", "first_name", "last_name", "phone", "status", "notes"] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(body[key]);
    }
  }
  if (!fields.length) return c.json({ error: "No fields to update" }, 400);

  fields.push("updated_at = ?");
  params.push(new Date().toISOString(), memberId, tenant.id);
  await c.env.DB.prepare(
    `UPDATE members SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`
  )
    .bind(...params)
    .run();

  const updated = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
  );
  return c.json(updated);
});

// "Delete" = cancel; history (payments, registrations) is preserved
memberRoutes.delete("/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const existing = await first<Member>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!existing) return c.json({ error: "Member not found" }, 404);
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE members SET status = 'cancelled', updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(now, memberId, tenant.id),
    c.env.DB.prepare(
      "UPDATE memberships SET status = 'cancelled', updated_at = ? WHERE member_id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(now, memberId, tenant.id),
  ]);
  return c.json({ ok: true, status: "cancelled" });
});

/**
 * POST /api/tenants/:tenantId/members/import
 * Bulk upsert by email — the Wild Apricot migration path.
 * Body: { rows: [{email, first_name?, last_name?, phone?, status?, notes?}] }
 */
memberRoutes.post("/import", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{ rows: Array<Record<string, string>> }>();
  if (!Array.isArray(body.rows) || !body.rows.length) {
    return c.json({ error: "rows array is required" }, 400);
  }
  if (body.rows.length > 2000) {
    return c.json({ error: "Max 2000 rows per import" }, 400);
  }

  const existing = await all<{ id: string; email: string }>(
    c.env.DB.prepare("SELECT id, email FROM members WHERE tenant_id = ?").bind(tenant.id)
  );
  const byEmail = new Map(existing.map((m) => [m.email, m.id]));
  const now = new Date().toISOString();
  let created = 0,
    updated = 0,
    skipped = 0;
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();

  for (const row of body.rows) {
    const email = (row.email || "").toLowerCase().trim();
    if (!email || !email.includes("@") || seen.has(email)) {
      skipped++;
      continue;
    }
    seen.add(email);
    const status = MEMBER_STATUSES.includes(row.status || "")
      ? row.status
      : "active";
    if (byEmail.has(email)) {
      stmts.push(
        c.env.DB.prepare(
          `UPDATE members SET
             first_name = coalesce(?, first_name), last_name = coalesce(?, last_name),
             phone = coalesce(?, phone), notes = coalesce(?, notes), updated_at = ?
           WHERE id = ?`
        ).bind(
          row.first_name || null,
          row.last_name || null,
          row.phone || null,
          row.notes || null,
          now,
          byEmail.get(email)
        )
      );
      updated++;
    } else {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO members (id, tenant_id, email, first_name, last_name, phone, notes, status, joined_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          generateId(),
          tenant.id,
          email,
          row.first_name || null,
          row.last_name || null,
          row.phone || null,
          row.notes || null,
          status,
          row.joined_at || now,
          now,
          now
        )
      );
      created++;
    }
  }

  for (let i = 0; i < stmts.length; i += 50) {
    await c.env.DB.batch(stmts.slice(i, i + 50));
  }
  return c.json({ ok: true, created, updated, skipped });
});
