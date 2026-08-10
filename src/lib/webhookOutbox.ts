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
/**
 * Nominal bases for the 1st/2nd/3rd/4th+ retry: 5m, 25m, 2h, 10h. Bounded
 * exponential, indexed by (attempts - 1) below because every caller passes
 * `attempts >= 1` (see backoffFor) -- there is no "0th retry", so an index
 * for attempts=0 would be dead code. A prior revision kept a leading 60s
 * ("1m") entry here that could never be selected for exactly that reason,
 * which is how it ended up transcribed into docs as an achievable interval.
 * Don't re-add a rung unless a real caller can pass the attempts value that
 * reaches it.
 *
 * These are also only the base before full jitter (see backoffFor):  the
 * actual delay used is uniformly distributed over [base/2, base), so the
 * real first retry lands at 2.5-5m, not 5m, and so on down the list.
 */
const BACKOFF_SECONDS = [300, 1500, 7200, 36000];
/** Consecutive failures before an endpoint is parked. */
const AUTO_DISABLE_AFTER = 20;

export function backoffFor(attempts: number): number {
  // attempts is 1-based (the first failed attempt calls this with 1), so the
  // array above is indexed by attempts - 1. Math.max guards a hypothetical
  // attempts=0 caller rather than reading BACKOFF_SECONDS[-1] (undefined).
  const bounded = Math.min(Math.max(attempts - 1, 0), BACKOFF_SECONDS.length - 1);
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
  // Every IPv6 pattern below is anchored on a literal leading `[`: a DNS
  // hostname can never contain `[` or `:`, so requiring it is not a weaker
  // match, it is the fix for a real false-positive class. Bracket-optional
  // versions of these (the pre-round-2 shape) matched hostnames that merely
  // started with the same letters as an IPv6 literal -- e.g. `/^f[cd]/i`
  // rejected fcm.googleapis.com (Firebase Cloud Messaging), a thoroughly
  // plausible guild webhook target, as if it were an fc00::/7 ULA literal.
  /^\[::1\]$/, // IPv6 loopback
  /^\[::\]$/, // IPv6 unspecified address, the ::/0.0.0.0 equivalent
  /^\[::ffff:/i, // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1);
  // any address in this form can smuggle an arbitrary IPv4 target past the
  // dotted-quad patterns above, so the whole ::ffff:/96 block is denied
  // rather than re-decoding the embedded IPv4 and re-testing it.
  /^\[fe[89a-f][0-9a-f]:/i, // IPv6 fe80::/10 link-local, plus fec0::/10
  // (deprecated site-local) and the unassigned fe80-feff range above it --
  // a superset of just link-local, kept broad since none of that range is
  // ever a legitimate public webhook target.
  /^\[f[cd][0-9a-f]{2}:/i, // IPv6 unique-local, fc00::/7. Requires the
  // bracket plus the next 2 hex digits and a colon (the full first 16-bit
  // group), not just the letters "fc"/"fd", so it cannot match a hostname.
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
  // A single trailing dot is a no-op in DNS ("localhost." === "localhost",
  // "quilthosting.com." === "quilthosting.com") but WHATWG's URL parser does
  // NOT strip it from .hostname, so it silently defeats every `$`-anchored
  // pattern above. Strip it before matching.
  const host = u.hostname.replace(/\.$/, "");
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

/**
 * Hand a committed outbox id to the queue. Safe to call after the batch.
 * Mirrors enqueueEvent's ctx handling: fire-and-forget via waitUntil when a
 * ctx is available, otherwise awaited directly so the send isn't abandoned.
 */
export async function scheduleDispatch(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  outboxId: string
): Promise<void> {
  const send = Promise.resolve(env.WEBHOOK_QUEUE?.send({ outboxId })).catch((e) => {
    // Recoverable: the row is committed, so the sweeper will pick it up.
    console.warn("outbox: queue send failed, sweeper will retry", outboxId, e);
  });
  if (ctx) ctx.waitUntil(send);
  else await send;
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

/** How long a claim is held before another worker may take it over. */
const LEASE_SECONDS = 120;

/**
 * Atomically move a row from pending (or a 'delivering' row whose lease has
 * expired) to delivering. Returns the lease_until value it just set on
 * success, or null when another worker already owns it, or its backoff has
 * not elapsed.
 *
 * The WHERE clause is the entire concurrency control: D1 applies it
 * atomically, and meta.changes tells us whether we won.
 *
 * lease_until IS NULL OR lease_until <= ? is checked for BOTH statuses, not
 * just 'delivering'. The admin replay endpoint (outboundWebhooks.ts) resets
 * a row to 'pending' by id without touching lease_until, so a row currently
 * being delivered can be replayed mid-flight; without this guard a pending
 * row with a still-live lease would be claimable immediately, handing a
 * second worker the same in-flight event.
 */
export async function claimOutboxRow(env: Env, outboxId: string): Promise<string | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const res = await env.DB.prepare(
    `UPDATE webhook_outbox
        SET status = 'delivering', claimed_at = ?, lease_until = ?, updated_at = ?
      WHERE id = ?
        AND status IN ('pending', 'delivering')
        AND (lease_until IS NULL OR lease_until <= ?)
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
  ).bind(nowIso, leaseUntil, nowIso, outboxId, nowIso, nowIso).run();
  return (res.meta?.changes ?? 0) === 1 ? leaseUntil : null;
}

/**
 * Fence a completion write with the lease claimOutboxRow handed us, so a
 * worker whose lease expired mid-delivery (a hanging endpoint past
 * LEASE_SECONDS) cannot clobber a newer claim's state after the sweeper has
 * already reclaimed the row. meta.changes === 0 means we lost the lease;
 * the caller must drop the write rather than force it through.
 */
async function fencedComplete(
  env: Env,
  outboxId: string,
  lease: string,
  sql: string,
  args: unknown[]
): Promise<boolean> {
  const res = await env.DB.prepare(
    `${sql} WHERE id = ? AND status = 'delivering' AND lease_until = ?`
  ).bind(...args, outboxId, lease).run();
  const won = (res.meta?.changes ?? 0) === 1;
  if (!won) {
    console.warn(
      "outbox: lost lease mid-delivery, dropping stale completion write",
      outboxId
    );
  }
  return won;
}

/** Deliver one outbox row to every subscribed endpoint. Throws to signal retry. */
export async function dispatchOutboxRow(
  env: Env,
  outboxId: string
): Promise<void> {
  const lease = await claimOutboxRow(env, outboxId);
  if (!lease) {
    // Someone else owns it, or its backoff has not elapsed. Not an error.
    return;
  }
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

  // Per-(event, endpoint) state. Without it the outbox row carries ONE status
  // for the whole fan-out, so a retry driven by a single failing endpoint
  // re-sends to the healthy ones too and they see avoidable duplicates.
  const doneRows = await all<{ endpoint_id: string }>(
    env.DB.prepare(
      `SELECT endpoint_id FROM webhook_delivery_targets
       WHERE outbox_id = ? AND tenant_id = ? AND status = 'delivered'`
    ).bind(outboxId, row.tenant_id)
  );
  const alreadyDelivered = new Set(doneRows.map((r) => r.endpoint_id));
  const pendingTargets = targets.filter((ep) => !alreadyDelivered.has(ep.id));

  if (!targets.length) {
    await fencedComplete(
      env,
      outboxId,
      lease,
      `UPDATE webhook_outbox SET status = 'delivered', updated_at = ?`,
      [now]
    );
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

  // Only the endpoints that have NOT already taken this event. anyFailed is
  // therefore computed from this round's attempts alone -- computing it from
  // every target would let an event with one already-delivered endpoint fail
  // forever, since that endpoint is never re-sent and so never re-succeeds.
  for (const ep of pendingTargets) {
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

      // The durable per-endpoint marker. Once this says 'delivered' the loop
      // above skips this endpoint on every later attempt of the same event.
      await env.DB.prepare(
        `INSERT INTO webhook_delivery_targets
         (id, outbox_id, endpoint_id, tenant_id, status, attempts, last_status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(outbox_id, endpoint_id) DO UPDATE SET
           status = excluded.status,
           attempts = webhook_delivery_targets.attempts + 1,
           last_status = excluded.last_status,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
        .bind(
          generateId(),
          outboxId,
          ep.id,
          row.tenant_id,
          ok ? "delivered" : "pending",
          statusCode,
          error,
          now,
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
  // The parent row is 'delivered' only when EVERY subscribed target is
  // delivered. anyFailed covers this round's pendingTargets; the targets
  // excluded from that list were excluded precisely because their marker
  // already said 'delivered'. So !anyFailed => all targets delivered.
  if (!anyFailed) {
    await fencedComplete(
      env,
      outboxId,
      lease,
      `UPDATE webhook_outbox SET status = 'delivered', attempts = ?, updated_at = ?`,
      [attempts, now]
    );
    return;
  }

  if (attempts >= MAX_ATTEMPTS) {
    const wonDead = await fencedComplete(
      env,
      outboxId,
      lease,
      `UPDATE webhook_outbox SET status = 'dead', attempts = ?, last_status = ?,
       last_error = ?, updated_at = ?`,
      [attempts, lastStatus, lastError, now]
    );
    // Only after we know the parent write landed: a lost lease means another
    // worker owns this row's fate, and burying its targets would misreport
    // endpoints that worker may still be delivering to.
    if (wonDead) {
      await env.DB.prepare(
        `UPDATE webhook_delivery_targets SET status = 'dead', updated_at = ?
         WHERE outbox_id = ? AND tenant_id = ? AND status = 'pending'`
      ).bind(now, outboxId, row.tenant_id).run();
    }
    return;
  }

  // Drawn ONCE. backoffFor applies full jitter over [base/2, base), so calling
  // it again in the consumer to build delaySeconds would be an independent
  // draw from the same range: roughly half the time the queue's delay lands
  // SHORTER than this next_attempt_at, claimOutboxRow refuses the early
  // redelivery, and the consumer acks it as a pre-backoff drop. Those retries
  // would silently never accrue toward the DLQ. One draw, shared by both.
  const delaySeconds = backoffFor(attempts);
  const nextAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const won = await fencedComplete(
    env,
    outboxId,
    lease,
    `UPDATE webhook_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?,
     last_status = ?, last_error = ?, updated_at = ?`,
    [attempts, nextAt, lastStatus, lastError, now]
  );
  if (!won) {
    // Lease lost mid-delivery: the sweeper (or another worker) already owns
    // this row's next attempt. Do not throw -- that would tell the queue to
    // redeliver a message whose outcome we can no longer safely record.
    return;
  }
  // Signals the queue to redeliver; after max_retries the message lands in the
  // DLQ. The exact delay just written into next_attempt_at rides on the error
  // so the consumer can hold the redelivery until the same instant this row
  // says it is next due, instead of having the queue bounce it back instantly.
  const err = new Error(`webhook delivery failed, attempt ${attempts}`) as Error & {
    attempts: number;
    delaySeconds: number;
  };
  err.attempts = attempts;
  err.delaySeconds = delaySeconds;
  throw err;
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
       WHERE (status = 'pending' OR (status = 'delivering' AND lease_until <= ?))
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT ?`
    ).bind(now, now, limit)
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
