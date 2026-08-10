import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import {
  WEBHOOK_SUBSCRIBE_OPTIONS,
  EVENT_SCHEMA_VERSION,
} from "../lib/webhookEvents";
import { validateHookInput } from "../lib/hookValidation";

export const outboundWebhookRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

const EVENT_OPTIONS = WEBHOOK_SUBSCRIBE_OPTIONS;

outboundWebhookRoutes.get("/events", (c) => c.json({ events: EVENT_OPTIONS }));

/**
 * Outbox visibility. fail_count used to be incremented and never consumed;
 * these three routes make delivery state actionable for a volunteer admin.
 */
outboundWebhookRoutes.get("/outbox", async (c) => {
  const tenant = c.get("tenant");
  const status = c.req.query("status") || "";
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT id, event, status, attempts, last_status, last_error,
                created_at, next_attempt_at
         FROM webhook_outbox
         WHERE tenant_id = ? AND (? = '' OR status = ?)
         ORDER BY created_at DESC LIMIT 100`
      ).bind(tenant.id, status, status)
    );
    return c.json({ outbox: rows });
  } catch {
    return c.json({ outbox: [] });
  }
});

/**
 * Re-drive a failed or dead event. Resets attempts so backoff starts over.
 *
 * KNOWN NARROW RACE (accepted, not fixed): this reset is not fenced against a
 * dispatch that is already in flight. If a delivery is mid-fetch when an admin
 * hits replay, that dispatch's own writes land after this reset -- its target
 * upsert can re-mark an endpoint 'delivered' for the replay we just cleared,
 * and its fenced outbox write still holds the live lease, so the replay's
 * queue message is refused by claimOutboxRow and dropped. Consequence is a
 * replay that quietly does nothing until the sweeper re-drives the row; no
 * duplicate send and no lost event. Closing it properly means fencing the
 * replay on lease_until too, which is a larger change than this window earns.
 */
outboundWebhookRoutes.post("/outbox/:outboxId/replay", async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("outboxId");
  const row = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM webhook_outbox WHERE id = ? AND tenant_id = ?"
    ).bind(id, tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  const nowIso = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE webhook_outbox SET status = 'pending', attempts = 0,
       next_attempt_at = null, updated_at = ? WHERE id = ?`
    ).bind(nowIso, id),
    // Clear the per-endpoint markers too. Dispatch skips any target already
    // marked 'delivered', so without this a replay of a partially- (or fully-)
    // delivered event would silently send to nobody and just flip the row back
    // to 'delivered' -- the opposite of what the admin pressed the button for.
    c.env.DB.prepare(
      `DELETE FROM webhook_delivery_targets WHERE outbox_id = ? AND tenant_id = ?`
    ).bind(id, tenant.id),
  ]);
  if (c.env.WEBHOOK_QUEUE) {
    c.executionCtx.waitUntil(c.env.WEBHOOK_QUEUE.send({ outboxId: id }));
  }
  return c.json({ replayed: true });
});

/** Clear an auto-disable so the endpoint starts receiving again. */
outboundWebhookRoutes.post("/:endpointId/enable", async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("endpointId");
  await c.env.DB.prepare(
    `UPDATE webhook_endpoints SET is_active = 1, fail_count = 0,
     disabled_reason = null, updated_at = ? WHERE id = ? AND tenant_id = ?`
  )
    .bind(new Date().toISOString(), id, tenant.id)
    .run();
  return c.json({ enabled: true });
});

outboundWebhookRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT id, url, events_json, is_active, fail_count, last_status, last_error,
                last_success_at, disabled_reason, created_at, updated_at,
                CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END as has_secret
         FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at DESC`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

outboundWebhookRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    url: string;
    secret?: string;
    events?: string[];
  }>();
  // Default missing/empty events to ["*"] BEFORE validating, same as the v1
  // route -- validateHookInput only validates events it is given, it does
  // not decide the default.
  const requested =
    Array.isArray(body.events) && body.events.length ? body.events : ["*"];
  const countRow = await first<{ cnt: number }>(
    c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM webhook_endpoints WHERE tenant_id = ?`
    ).bind(tenant.id)
  );
  const result = validateHookInput(
    { url: body.url || "", events: requested },
    { existingCount: countRow?.cnt ?? 0 }
  );
  if (!result.ok) {
    return c.json(
      {
        error: result.error,
        code: result.code,
        ...(result.valid ? { valid: result.valid } : {}),
      },
      result.status
    );
  }
  const url = result.url!;
  const events = result.events!;
  const id = generateId();
  const now = new Date().toISOString();
  const secret = body.secret?.trim() || generateId().replace(/-/g, "");
  await c.env.DB.prepare(
    `INSERT INTO webhook_endpoints
     (id, tenant_id, url, secret, events_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(id, tenant.id, url, secret, JSON.stringify(events), now, now)
    .run();
  return c.json(
    {
      id,
      url,
      events,
      secret,
      message:
        "Copy the secret now — used as X-QH-Signature, HMAC-SHA256 of `{timestamp}.{body}`.",
    },
    201
  );
});

outboundWebhookRoutes.patch("/:id", async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("id");
  const existing = await first(
    c.env.DB.prepare(
      `SELECT id FROM webhook_endpoints WHERE id = ? AND tenant_id = ?`
    ).bind(id, tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    url?: string;
    is_active?: boolean;
    events?: string[];
  }>();
  // No existingCount here: editing an existing hook never trips the
  // per-tenant hook limit, only creating a new one does.
  const result = validateHookInput({ url: body.url, events: body.events });
  if (!result.ok) {
    return c.json(
      {
        error: result.error,
        code: result.code,
        ...(result.valid ? { valid: result.valid } : {}),
      },
      result.status
    );
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE webhook_endpoints SET
       url = coalesce(?, url),
       is_active = coalesce(?, is_active),
       events_json = coalesce(?, events_json),
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      result.url || null,
      body.is_active === undefined ? null : body.is_active ? 1 : 0,
      result.events ? JSON.stringify(result.events) : null,
      now,
      id,
      tenant.id
    )
    .run();
  return c.json({ ok: true });
});

outboundWebhookRoutes.delete("/:id", async (c) => {
  const tenant = c.get("tenant");
  const res = await c.env.DB.prepare(
    `DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?`
  )
    .bind(c.req.param("id"), tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

outboundWebhookRoutes.get("/:id/deliveries", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, event, status_code, success, error, created_at
       FROM webhook_deliveries
       WHERE endpoint_id = ? AND tenant_id = ?
       ORDER BY created_at DESC LIMIT 50`
    ).bind(c.req.param("id"), tenant.id)
  );
  return c.json(rows);
});

/** POST test ping */
outboundWebhookRoutes.post("/:id/test", async (c) => {
  const tenant = c.get("tenant");
  const ep = await first<{ id: string; url: string; secret: string | null }>(
    c.env.DB.prepare(
      `SELECT id, url, secret FROM webhook_endpoints WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("id"), tenant.id)
  );
  if (!ep) return c.json({ error: "Not found" }, 404);
  // Direct fetch to this one endpoint — a test ping is not a domain event and
  // must not enter the outbox (it would retry and pollute delivery history).
  const body = JSON.stringify({
    id: generateId(),
    schema_version: EVENT_SCHEMA_VERSION,
    event: "test.ping",
    created_at: new Date().toISOString(),
    tenant_id: tenant.id,
    data: { message: "QuiltHosting Zapier/Make test webhook" },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-QH-Event": "test.ping",
    "X-QH-Timestamp": timestamp,
    "X-QH-Schema-Version": String(EVENT_SCHEMA_VERSION),
  };
  if (ep.secret) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(ep.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    // Must match dispatchOutboxRow: HMAC over `{timestamp}.{body}`, not body alone.
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`)
    );
    headers["X-QH-Signature"] = [...new Uint8Array(mac)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  try {
    const res = await fetch(ep.url, { method: "POST", headers, body });
    return c.json({ ok: res.ok, status: res.status });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});
