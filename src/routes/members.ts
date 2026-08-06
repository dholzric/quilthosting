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
