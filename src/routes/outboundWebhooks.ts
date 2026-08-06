import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

export const outboundWebhookRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

const EVENT_OPTIONS = [
  "*",
  "member.created",
  "member.activated",
  "member.updated",
  "membership.activated",
  "payment.succeeded",
  "event.registration",
  "form.response",
];

outboundWebhookRoutes.get("/events", (c) => c.json({ events: EVENT_OPTIONS }));

outboundWebhookRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT id, url, events_json, is_active, fail_count, last_status, last_error,
                last_success_at, created_at, updated_at,
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
  const url = (body.url || "").trim();
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    return c.json({ error: "url must be http(s)" }, 400);
  }
  const events = Array.isArray(body.events) && body.events.length
    ? body.events.filter((e) => EVENT_OPTIONS.includes(e))
    : ["*"];
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
      message: "Copy the secret now — used as X-QH-Signature HMAC-SHA256 of the body.",
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
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE webhook_endpoints SET
       url = coalesce(?, url),
       is_active = coalesce(?, is_active),
       events_json = coalesce(?, events_json),
       updated_at = ?
     WHERE id = ?`
  )
    .bind(
      body.url?.trim() || null,
      body.is_active === undefined ? null : body.is_active ? 1 : 0,
      body.events ? JSON.stringify(body.events) : null,
      now,
      id
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
  const { emitTenantEvent } = await import("../lib/outboundWebhooks");
  // Temporarily emit only to this URL via direct fetch
  const body = JSON.stringify({
    id: generateId(),
    event: "test.ping",
    created_at: new Date().toISOString(),
    tenant_id: tenant.id,
    data: { message: "QuiltHosting Zapier/Make test webhook" },
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-QH-Event": "test.ping",
  };
  if (ep.secret) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(ep.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body)
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
