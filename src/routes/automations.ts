import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { parseSteps } from "../lib/automations";

export const automationRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

/**
 * Triggers that actually enroll members. Add a value here ONLY when a matching
 * enroll* function in lib/automations.ts is wired to a real call site —
 * otherwise guilds can build a sequence that never runs.
 */
export const AUTOMATION_TRIGGERS = ["member_activated"] as const;

automationRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT * FROM automation_sequences WHERE tenant_id = ? ORDER BY created_at DESC`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

automationRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    name: string;
    trigger_event?: string;
    is_active?: boolean;
    steps?: unknown;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  // Only one trigger is wired: enrollMemberActivated in lib/automations.ts.
  // Reject anything else rather than silently coercing it — a sequence stored
  // with an unwired trigger would sit there enrolling nobody, which is exactly
  // the advertised-but-dead failure the webhook catalog was built to prevent.
  if (
    body.trigger_event !== undefined &&
    body.trigger_event !== "member_activated"
  ) {
    return c.json(
      {
        error: `Unsupported trigger_event "${body.trigger_event}".`,
        code: "unsupported_trigger",
        valid: AUTOMATION_TRIGGERS,
      },
      400
    );
  }
  const steps = parseSteps(JSON.stringify(body.steps || []));
  if (!steps.length) {
    return c.json({ error: "At least one step with subject and body is required" }, 400);
  }
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO automation_sequences
     (id, tenant_id, name, trigger_event, is_active, steps_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      name,
      "member_activated",
      body.is_active === false ? 0 : 1,
      JSON.stringify(steps),
      now,
      now
    )
    .run();
  const row = await first(
    c.env.DB.prepare(`SELECT * FROM automation_sequences WHERE id = ?`).bind(id)
  );
  return c.json(row, 201);
});

automationRoutes.patch("/:seqId", async (c) => {
  const tenant = c.get("tenant");
  const existing = await first<{ id: string; steps_json: string }>(
    c.env.DB.prepare(
      `SELECT * FROM automation_sequences WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("seqId"), tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    name?: string;
    is_active?: boolean;
    steps?: unknown;
  }>();
  const steps =
    body.steps !== undefined
      ? JSON.stringify(parseSteps(JSON.stringify(body.steps)))
      : existing.steps_json;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE automation_sequences SET
       name = coalesce(?, name),
       is_active = coalesce(?, is_active),
       steps_json = ?,
       updated_at = ?
     WHERE id = ?`
  )
    .bind(
      body.name?.trim() || null,
      body.is_active !== undefined ? (body.is_active ? 1 : 0) : null,
      steps,
      now,
      existing.id
    )
    .run();
  const row = await first(
    c.env.DB.prepare(`SELECT * FROM automation_sequences WHERE id = ?`).bind(existing.id)
  );
  return c.json(row);
});

automationRoutes.delete("/:seqId", async (c) => {
  const tenant = c.get("tenant");
  const res = await c.env.DB.prepare(
    `DELETE FROM automation_sequences WHERE id = ? AND tenant_id = ?`
  )
    .bind(c.req.param("seqId"), tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

automationRoutes.get("/:seqId/enrollments", async (c) => {
  const tenant = c.get("tenant");
  const seq = await first(
    c.env.DB.prepare(
      `SELECT id FROM automation_sequences WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("seqId"), tenant.id)
  );
  if (!seq) return c.json({ error: "Not found" }, 404);
  const rows = await all(
    c.env.DB.prepare(
      `SELECT e.*, m.email, m.first_name, m.last_name
       FROM automation_enrollments e
       LEFT JOIN members m ON m.id = e.member_id
       WHERE e.sequence_id = ?
       ORDER BY e.created_at DESC LIMIT 200`
    ).bind(c.req.param("seqId"))
  );
  return c.json(rows);
});
