/**
 * Durable webhook delivery.
 *
 * enqueueEvent() writes an outbox row (durable) and hands the id to the queue
 * via waitUntil (fast path). If the queue send fails or the Worker dies, the
 * cron sweeper picks the row up by next_attempt_at. Delivery is therefore
 * at-least-once: consumers must dedupe on the envelope `id`.
 */
import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import {
  EVENT_SCHEMA_VERSION,
  eventPayloadSchemas,
  type WebhookEventName,
} from "./webhookEvents";

const MAX_ATTEMPTS = 6;
/** 1m, 5m, 25m, 2h, 10h — bounded exponential, jitter applied at use. */
const BACKOFF_SECONDS = [60, 300, 1500, 7200, 36000];
/** Consecutive failures before an endpoint is parked. */
const AUTO_DISABLE_AFTER = 20;

export function backoffFor(attempts: number): number {
  const bounded = Math.min(attempts, BACKOFF_SECONDS.length - 1);
  const base = BACKOFF_SECONDS[bounded];
  // Full jitter, so a fleet of failed deliveries does not retry in lockstep.
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local + cloud metadata
  /^\[?::1\]?$/,
  /^\[?f[cd]/i, // IPv6 loopback + unique-local
  /(^|\.)quilthosting\.com$/i, // no self-loop
  /(^|\.)workers\.dev$/i,
];

/**
 * Returns an error string, or null when the URL is an acceptable hook target.
 *
 * NOTE: this is a hostname deny list, not full SSRF protection — a DNS name
 * that resolves to a private address still passes. Documented as such rather
 * than overclaimed.
 */
export function validateHookUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "url is not a valid URL";
  }
  if (u.protocol !== "https:") return "url must be https";
  const host = u.hostname;
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    return `url host "${host}" is not an allowed webhook target`;
  }
  return null;
}

/**
 * Structural type rather than ExecutionContext: Hono's `c.executionCtx` and the
 * workers-types `ExecutionContext<unknown>` are not assignable to each other,
 * and waitUntil is all this needs.
 */
type WaitUntilCtx = { waitUntil(promise: Promise<unknown>): void };

/**
 * Validate a payload and return the outbox INSERT as a statement, so the
 * caller can commit it in the SAME DB.batch() as the mutation that caused it.
 *
 * This is the atomic path. enqueueEvent below is the non-atomic fallback for
 * callers that cannot batch — it can lose the event if the Worker stops
 * between the mutation commit and the outbox write.
 *
 * Returns null when the payload fails its schema, which is a programming
 * error: the caller must treat null as fatal and not commit the mutation.
 */
export function prepareEvent(
  env: Env,
  tenantId: string,
  event: WebhookEventName,
  data: Record<string, unknown>
): { id: string; stmt: D1PreparedStatement } | null {
  const schema = eventPayloadSchemas[event];
  if (!schema) {
    console.error("prepareEvent: unknown event name", event);
    return null;
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    console.error("prepareEvent: payload failed schema", event, parsed.error.issues);
    return null;
  }
  const id = generateId();
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT INTO webhook_outbox
     (id, tenant_id, event, schema_version, payload_json, status, attempts,
      next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
  ).bind(
    id, tenantId, event, EVENT_SCHEMA_VERSION,
    JSON.stringify(parsed.data), now, now, now
  );
  return { id, stmt };
}

/** Hand a committed outbox id to the queue. Safe to call after the batch. */
export function scheduleDispatch(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  outboxId: string
): void {
  const send = Promise.resolve(env.WEBHOOK_QUEUE?.send({ outboxId })).catch((e) => {
    // Recoverable: the row is committed, so the sweeper will pick it up.
    console.warn("outbox: queue send failed, sweeper will retry", outboxId, e);
  });
  if (ctx) ctx.waitUntil(send);
}

/**
 * Non-atomic fallback: writes the outbox row AFTER the caller's mutation has
 * already committed, as a separate statement. There is a real window between
 * the mutation commit and this insert — if the Worker dies there, or this
 * insert itself fails, the mutation stands but its event is silently lost.
 *
 * Prefer `prepareEvent` + `env.DB.batch([mutationStmt, ev.stmt])` for any new
 * call site, which commits the domain row and its event atomically. This
 * function exists only for call sites not yet converted to that pattern.
 */
export async function enqueueEvent(
  env: Env,
  ctx: WaitUntilCtx | undefined,
  tenantId: string,
  event: WebhookEventName,
  data: Record<string, unknown>
): Promise<void> {
  try {
    // Validate against the frozen contract. A payload that fails here is a
    // programming error: log loudly rather than silently shipping a malformed
    // event that consumers will parse into undefined fields.
    const schema = eventPayloadSchemas[event];
    if (!schema) {
      console.error("outbox: unknown event name", event);
      return;
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      console.error("outbox: payload failed schema", event, parsed.error.issues);
      return;
    }

    const id = generateId();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO webhook_outbox
       (id, tenant_id, event, schema_version, payload_json, status, attempts,
        next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        event,
        EVENT_SCHEMA_VERSION,
        JSON.stringify(parsed.data),
        now,
        now,
        now
      )
      .run();

    // Fast path. Never awaited by the request when a ctx is available.
    const send = Promise.resolve(
      env.WEBHOOK_QUEUE?.send({ outboxId: id })
    ).catch((e) => {
      console.warn("outbox: queue send failed, sweeper will retry", id, e);
    });
    if (ctx) ctx.waitUntil(send);
    else await send;
  } catch (e) {
    console.warn("enqueueEvent", e);
  }
}

async function signBody(
  secret: string,
  timestamp: string,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  // Timestamp is inside the signed material so a captured body cannot be
  // replayed later under a fresh header.
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`)
  );
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function wantsEvent(eventsJson: string, event: string): boolean {
  try {
    const arr = JSON.parse(eventsJson || "[]");
    if (!Array.isArray(arr) || !arr.length) return true;
    return arr.includes("*") || arr.includes(event);
  } catch {
    return true;
  }
}

type OutboxRow = {
  id: string;
  tenant_id: string;
  event: string;
  schema_version: number;
  payload_json: string;
  status: string;
  attempts: number;
  created_at: string;
};

/** Deliver one outbox row to every subscribed endpoint. Throws to signal retry. */
export async function dispatchOutboxRow(
  env: Env,
  outboxId: string
): Promise<void> {
  const row = await first<OutboxRow>(
    env.DB.prepare(`SELECT * FROM webhook_outbox WHERE id = ?`).bind(outboxId)
  );
  if (!row || row.status === "delivered" || row.status === "dead") return;

  const endpoints = await all<{
    id: string;
    url: string;
    secret: string | null;
    events_json: string;
  }>(
    env.DB.prepare(
      `SELECT id, url, secret, events_json FROM webhook_endpoints
       WHERE tenant_id = ? AND is_active = 1`
    ).bind(row.tenant_id)
  );

  const targets = endpoints.filter((ep) => wantsEvent(ep.events_json, row.event));
  const now = new Date().toISOString();

  if (!targets.length) {
    await env.DB.prepare(
      `UPDATE webhook_outbox SET status = 'delivered', updated_at = ? WHERE id = ?`
    )
      .bind(now, outboxId)
      .run();
    return;
  }

  const envelope = {
    id: row.id,
    schema_version: row.schema_version,
    event: row.event,
    created_at: row.created_at,
    tenant_id: row.tenant_id,
    data: JSON.parse(row.payload_json),
  };
  const body = JSON.stringify(envelope);

  let anyFailed = false;
  let lastStatus: number | null = null;
  let lastError: string | null = null;

  for (const ep of targets) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "QuiltHosting-Webhooks/2.0",
      "X-QH-Event": row.event,
      "X-QH-Delivery": `${row.id}:${ep.id}`,
      "X-QH-Timestamp": timestamp,
      "X-QH-Schema-Version": String(row.schema_version),
    };
    if (ep.secret) {
      headers["X-QH-Signature"] = await signBody(ep.secret, timestamp, body);
    }

    let statusCode: number | null = null;
    let error: string | null = null;
    let ok = false;
    try {
      const res = await fetch(ep.url, { method: "POST", headers, body });
      statusCode = res.status;
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (e: any) {
      error = e?.message || "fetch failed";
    }
    if (!ok) {
      anyFailed = true;
      lastStatus = statusCode;
      lastError = error;
    }

    try {
      await env.DB.prepare(
        `INSERT INTO webhook_deliveries
         (id, tenant_id, endpoint_id, event, payload_json, status_code, success, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          generateId(),
          row.tenant_id,
          ep.id,
          row.event,
          body.slice(0, 8000),
          statusCode,
          ok ? 1 : 0,
          error,
          now
        )
        .run();

      if (ok) {
        await env.DB.prepare(
          `UPDATE webhook_endpoints SET fail_count = 0, last_status = ?, last_error = null,
           last_success_at = ?, updated_at = ? WHERE id = ?`
        )
          .bind(statusCode, now, now, ep.id)
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE webhook_endpoints SET fail_count = coalesce(fail_count,0) + 1,
           last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`
        )
          .bind(statusCode, error, now, ep.id)
          .run();
        // Park a poison endpoint so one dead Zap does not burn the tenant's
        // delivery budget forever. Admin can re-enable.
        await env.DB.prepare(
          `UPDATE webhook_endpoints SET is_active = 0,
           disabled_reason = 'consecutive delivery failures'
           WHERE id = ? AND fail_count >= ?`
        )
          .bind(ep.id, AUTO_DISABLE_AFTER)
          .run();
      }
    } catch (e) {
      console.warn("webhook delivery log failed", e);
    }
  }

  const attempts = row.attempts + 1;
  if (!anyFailed) {
    await env.DB.prepare(
      `UPDATE webhook_outbox SET status = 'delivered', attempts = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(attempts, now, outboxId)
      .run();
    return;
  }

  if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE webhook_outbox SET status = 'dead', attempts = ?, last_status = ?,
       last_error = ?, updated_at = ? WHERE id = ?`
    )
      .bind(attempts, lastStatus, lastError, now, outboxId)
      .run();
    return;
  }

  const nextAt = new Date(Date.now() + backoffFor(attempts) * 1000).toISOString();
  await env.DB.prepare(
    `UPDATE webhook_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?,
     last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`
  )
    .bind(attempts, nextAt, lastStatus, lastError, now, outboxId)
    .run();
  // Signals the queue to redeliver; after max_retries the message lands in the DLQ.
  throw new Error(`webhook delivery failed, attempt ${attempts}`);
}

/** Cron safety net for rows the queue never acknowledged. */
export async function sweepOutbox(
  env: Env,
  limit = 100
): Promise<{ swept: number }> {
  const now = new Date().toISOString();
  const rows = await all<{ id: string }>(
    env.DB.prepare(
      `SELECT id FROM webhook_outbox
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT ?`
    ).bind(now, limit)
  );
  for (const r of rows) {
    try {
      await dispatchOutboxRow(env, r.id);
    } catch {
      /* attempts + backoff already recorded */
    }
  }
  return { swept: rows.length };
}
