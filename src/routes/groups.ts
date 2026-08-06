import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

export const groupRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type GroupRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
};

// GET /api/tenants/:tenantId/groups
groupRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all<GroupRow>(
    c.env.DB.prepare(
      `SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
              (SELECT COUNT(*) FROM member_group_members m
               WHERE m.group_id = g.id) as member_count
       FROM member_groups g
       WHERE g.tenant_id = ?
       ORDER BY g.name`
    ).bind(tenant.id)
  );
  return c.json(rows);
});

// POST /api/tenants/:tenantId/groups
groupRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{ name: string; description?: string }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > 80) return c.json({ error: "name too long" }, 400);

  const dupe = await first(
    c.env.DB.prepare(
      "SELECT id FROM member_groups WHERE tenant_id = ? AND lower(name) = lower(?)"
    ).bind(tenant.id, name)
  );
  if (dupe) return c.json({ error: "A group with that name already exists" }, 409);

  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO member_groups (id, tenant_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, tenant.id, name, body.description?.trim() || null, now, now)
    .run();

  return c.json(
    {
      id,
      name,
      description: body.description?.trim() || null,
      member_count: 0,
      created_at: now,
    },
    201
  );
});

// Static paths before /:groupId
// GET /api/tenants/:tenantId/groups/for-member/:memberId
groupRoutes.get("/for-member/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const member = await first(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!member) return c.json({ error: "Member not found" }, 404);

  const rows = await all<{ id: string; name: string }>(
    c.env.DB.prepare(
      `SELECT g.id, g.name FROM member_groups g
       JOIN member_group_members mgm ON mgm.group_id = g.id
       WHERE mgm.member_id = ? AND g.tenant_id = ?
       ORDER BY g.name`
    ).bind(memberId, tenant.id)
  );
  return c.json(rows);
});

// PUT /api/tenants/:tenantId/groups/for-member/:memberId — replace membership
groupRoutes.put("/for-member/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const member = await first(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!member) return c.json({ error: "Member not found" }, 404);

  const body = await c.req.json<{ group_ids?: string[] }>();
  const groupIds = Array.isArray(body.group_ids)
    ? [...new Set(body.group_ids.filter(Boolean))]
    : [];

  for (const gid of groupIds) {
    const g = await first(
      c.env.DB.prepare(
        "SELECT id FROM member_groups WHERE id = ? AND tenant_id = ?"
      ).bind(gid, tenant.id)
    );
    if (!g) return c.json({ error: `Unknown group ${gid}` }, 400);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "DELETE FROM member_group_members WHERE member_id = ? AND tenant_id = ?"
  )
    .bind(memberId, tenant.id)
    .run();

  if (groupIds.length) {
    await c.env.DB.batch(
      groupIds.map((gid) =>
        c.env.DB.prepare(
          `INSERT INTO member_group_members (group_id, member_id, tenant_id, created_at)
           VALUES (?, ?, ?, ?)`
        ).bind(gid, memberId, tenant.id, now)
      )
    );
  }

  return c.json({ ok: true, group_ids: groupIds });
});

// PATCH /api/tenants/:tenantId/groups/:groupId
groupRoutes.patch("/:groupId", async (c) => {
  const tenant = c.get("tenant");
  const groupId = c.req.param("groupId");
  const existing = await first<GroupRow>(
    c.env.DB.prepare(
      "SELECT * FROM member_groups WHERE id = ? AND tenant_id = ?"
    ).bind(groupId, tenant.id)
  );
  if (!existing) return c.json({ error: "Group not found" }, 404);

  const body = await c.req.json<{ name?: string; description?: string | null }>();
  let name = existing.name;
  if (body.name !== undefined) {
    name = body.name.trim();
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    const dupe = await first(
      c.env.DB.prepare(
        "SELECT id FROM member_groups WHERE tenant_id = ? AND lower(name) = lower(?) AND id != ?"
      ).bind(tenant.id, name, groupId)
    );
    if (dupe) return c.json({ error: "A group with that name already exists" }, 409);
  }
  const description =
    body.description !== undefined
      ? body.description?.trim() || null
      : existing.description;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE member_groups SET name = ?, description = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(name, description, now, groupId, tenant.id)
    .run();
  return c.json({ id: groupId, name, description, updated_at: now });
});

// DELETE /api/tenants/:tenantId/groups/:groupId
groupRoutes.delete("/:groupId", async (c) => {
  const tenant = c.get("tenant");
  const groupId = c.req.param("groupId");
  const res = await c.env.DB.prepare(
    "DELETE FROM member_groups WHERE id = ? AND tenant_id = ?"
  )
    .bind(groupId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Group not found" }, 404);
  return c.json({ ok: true });
});

// GET /api/tenants/:tenantId/groups/:groupId/members
groupRoutes.get("/:groupId/members", async (c) => {
  const tenant = c.get("tenant");
  const groupId = c.req.param("groupId");
  const group = await first(
    c.env.DB.prepare(
      "SELECT id, name FROM member_groups WHERE id = ? AND tenant_id = ?"
    ).bind(groupId, tenant.id)
  );
  if (!group) return c.json({ error: "Group not found" }, 404);

  const members = await all(
    c.env.DB.prepare(
      `SELECT m.id, m.email, m.first_name, m.last_name, m.status, mgm.created_at as added_at
       FROM member_group_members mgm
       JOIN members m ON m.id = mgm.member_id
       WHERE mgm.group_id = ? AND mgm.tenant_id = ?
       ORDER BY m.last_name, m.first_name, m.email`
    ).bind(groupId, tenant.id)
  );
  return c.json({ group, members });
});

// POST /api/tenants/:tenantId/groups/:groupId/members
// Body: { member_ids: string[] } or { emails: string[] }
groupRoutes.post("/:groupId/members", async (c) => {
  const tenant = c.get("tenant");
  const groupId = c.req.param("groupId");
  const group = await first(
    c.env.DB.prepare(
      "SELECT id FROM member_groups WHERE id = ? AND tenant_id = ?"
    ).bind(groupId, tenant.id)
  );
  if (!group) return c.json({ error: "Group not found" }, 404);

  const body = await c.req.json<{
    member_ids?: string[];
    emails?: string[];
  }>();

  let memberIds = Array.isArray(body.member_ids)
    ? body.member_ids.filter(Boolean)
    : [];

  if (Array.isArray(body.emails) && body.emails.length) {
    for (const raw of body.emails) {
      const email = String(raw || "")
        .toLowerCase()
        .trim();
      if (!email) continue;
      const m = await first<{ id: string }>(
        c.env.DB.prepare(
          "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
        ).bind(tenant.id, email)
      );
      if (m) memberIds.push(m.id);
    }
  }

  memberIds = [...new Set(memberIds)];
  if (!memberIds.length) {
    return c.json({ error: "member_ids or emails required" }, 400);
  }
  if (memberIds.length > 500) {
    return c.json({ error: "Max 500 members per request" }, 400);
  }

  const now = new Date().toISOString();
  let added = 0;
  let skipped = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const mid of memberIds) {
    const m = await first(
      c.env.DB.prepare(
        "SELECT id FROM members WHERE id = ? AND tenant_id = ?"
      ).bind(mid, tenant.id)
    );
    if (!m) {
      skipped++;
      continue;
    }
    stmts.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO member_group_members (group_id, member_id, tenant_id, created_at)
         VALUES (?, ?, ?, ?)`
      ).bind(groupId, mid, tenant.id, now)
    );
  }

  for (let i = 0; i < stmts.length; i += 50) {
    const batch = stmts.slice(i, i + 50);
    const results = await c.env.DB.batch(batch);
    for (const r of results) {
      if (r.meta.changes) added++;
      else skipped++;
    }
  }

  await c.env.DB.prepare(
    "UPDATE member_groups SET updated_at = ? WHERE id = ?"
  )
    .bind(now, groupId)
    .run();

  return c.json({ ok: true, added, skipped });
});

// DELETE /api/tenants/:tenantId/groups/:groupId/members/:memberId
groupRoutes.delete("/:groupId/members/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const groupId = c.req.param("groupId");
  const memberId = c.req.param("memberId");
  const res = await c.env.DB.prepare(
    `DELETE FROM member_group_members
     WHERE group_id = ? AND member_id = ? AND tenant_id = ?`
  )
    .bind(groupId, memberId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not in group" }, 404);
  return c.json({ ok: true });
});
