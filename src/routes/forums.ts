import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

export const forumAdminRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

forumAdminRoutes.get("/topics", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT t.*, m.first_name, m.last_name, m.email
         FROM forum_topics t
         LEFT JOIN members m ON m.id = t.member_id
         WHERE t.tenant_id = ?
         ORDER BY t.is_pinned DESC, t.updated_at DESC LIMIT 200`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

forumAdminRoutes.delete("/topics/:topicId", async (c) => {
  const tenant = c.get("tenant");
  const topicId = c.req.param("topicId");
  await c.env.DB.prepare(
    `DELETE FROM forum_posts WHERE topic_id = ? AND tenant_id = ?`
  )
    .bind(topicId, tenant.id)
    .run();
  const res = await c.env.DB.prepare(
    `DELETE FROM forum_topics WHERE id = ? AND tenant_id = ?`
  )
    .bind(topicId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

forumAdminRoutes.patch("/topics/:topicId", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{ is_pinned?: boolean }>();
  const res = await c.env.DB.prepare(
    `UPDATE forum_topics SET is_pinned = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.is_pinned ? 1 : 0,
      new Date().toISOString(),
      c.req.param("topicId"),
      tenant.id
    )
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
