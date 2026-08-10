/**
 * Idempotency-Key handling for the public write API.
 *
 * The record is a RESERVATION taken before the handler runs, made atomic by
 * the unique index on (tenant_id, operation, idempotency_key). A caller that
 * loses the insert race gets a definite answer instead of racing into a
 * second mutation.
 *
 * The key is scoped by operation because integrators reuse one id across a
 * workflow's steps — Zapier reuses the task id — so an unscoped key would let
 * a create replay its response for an update.
 */
import type { Env } from "../types";
import { first } from "./db";
import { generateId } from "./utils/id";

/** How long a reservation is honoured before it is treated as abandoned. */
export const RESERVATION_SECONDS = 60;
/** How long a completed response stays replayable. Bounds PII retention. */
export const RETENTION_HOURS = 24;

export type IdempotencyOutcome =
  | { kind: "execute"; recordId: string; reservedUntil: string }
  | { kind: "replay"; status: number; json: unknown }
  | { kind: "in_progress" }
  | { kind: "conflict" };

export async function hashRequest(body: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(body ?? null));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Whether a handler's response is safe to CACHE under this Idempotency-Key
 * for RETENTION_HOURS, versus being a transient refusal that must instead
 * release the reservation so a retry -- after whatever moving condition
 * produced the refusal has changed -- actually re-runs the handler.
 *
 * The dividing line is not "sub-500 vs 5xx". It is whether the response is a
 * pure function of the REQUEST (same tenant + operation + body -> the same
 * answer, forever) or depends on OTHER state that can legitimately change
 * between retries of the identical request (plan tier, a count against a
 * moving limit, server health). Caching the former is what makes retries
 * safe for integrators; caching the latter would let one refusal outlive the
 * condition that caused it -- e.g. a guild that upgrades off the free plan
 * and retries with the same key would get the stale 402 replayed at them
 * for up to RETENTION_HOURS instead of the create actually going through.
 *
 * This is the single place that policy is decided; everything that follows
 * a reserve() should route its completion through this, not re-derive the
 * rule from a status-code comparison.
 */
export function isCacheableResponse(status: number, json: unknown): boolean {
  // 2xx: the mutation already happened. The response is the durable record
  // of it, so replaying it on retry is correct, not stale.
  if (status >= 200 && status < 300) return true;

  // 400 (missing_field / invalid_status / invalid_hook_url) and 422
  // (no_fields / idempotency conflict shape) are validation failures against
  // the request body itself -- the identical body fails the identical check
  // every time, so caching saves the retry a wasted round trip.
  if (status === 400 || status === 422) return true;

  // 404: the id referenced in the request does not exist for this tenant.
  // The key is fenced to the request hash, so a retry with the SAME key
  // necessarily references the SAME id -- it does not spontaneously appear.
  if (status === 404) return true;

  // 409: only "duplicate_email" is deterministic here -- the email is part
  // of the request body, so retrying it is guaranteed to find the same
  // existing row. (idempotency_in_progress is also a 409, but it is returned
  // by withIdempotency BEFORE the handler runs and never reaches complete()/
  // this predicate, so no other 409 code needs to be handled here.) Scoped
  // narrowly to the one code rather than caching all 409s.
  if (status === 409) {
    const code = (json as { code?: string } | null | undefined)?.code;
    return code === "duplicate_email";
  }

  // Everything else -- 402 plan_limit, 429 hook_limit / rate limits, and all
  // 5xx -- reflects a moving condition rather than a property of the
  // request: plan tier, a count against a limit, or transient server health.
  // Do not cache; release the reservation so the identical request can
  // legitimately get a different answer once that condition changes.
  // (429 hook_limit is listed for forward-looking completeness, not current
  // coverage: POST /v1/hooks does not go through withIdempotency today, so
  // no 429 actually reaches this predicate yet -- only the two member routes
  // do. Don't read this branch as evidence hook creation is idempotency-
  // wrapped.)
  return false;
}

/**
 * Delete expired records. Bounds retention of response bodies (member PII):
 * without this, api_idempotency becomes a second, unmanaged copy of member
 * data that never ages out.
 *
 * Deliberately cross-tenant -- this is a maintenance sweep over the whole
 * table by `expires_at`, not a per-tenant read, so it does not (and should
 * not) filter by tenant_id the way request-serving queries must.
 */
export async function sweepExpired(
  env: Env,
  limit = 500
): Promise<{ deleted: number }> {
  const res = await env.DB.prepare(
    `DELETE FROM api_idempotency
      WHERE id IN (SELECT id FROM api_idempotency WHERE expires_at <= ? LIMIT ?)`
  )
    .bind(new Date().toISOString(), limit)
    .run();
  return { deleted: res.meta?.changes ?? 0 };
}

/**
 * True for a D1 unique-constraint violation on the insert -- the expected,
 * benign outcome of losing the reservation race. Anything else (a genuine D1
 * outage, a network blip) must NOT be swallowed here: misreading an outage as
 * "someone else owns this slot" would tell a caller their request is
 * `in_progress`/`conflict` when really nothing ran at all. D1 surfaces
 * SQLite's constraint violation as an Error whose message contains
 * "UNIQUE constraint failed" (wrapped as e.g. "D1_ERROR: UNIQUE constraint
 * failed: ...: SQLITE_CONSTRAINT") -- there is no typed error class exposed,
 * so a message check is the cheapest safe signal available.
 */
function isUniqueConstraintViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /unique constraint/i.test(msg);
}

/**
 * Attempt to claim the (tenant, operation, key) slot. Returns what the caller
 * should do. The INSERT is the concurrency control: the unique index means
 * exactly one caller can win it.
 */
export async function reserve(
  env: Env,
  tenantId: string,
  operation: string,
  key: string,
  requestHash: string
): Promise<IdempotencyOutcome> {
  const now = new Date();
  const nowIso = now.toISOString();
  const recordId = generateId();
  const reservedUntil = new Date(
    now.getTime() + RESERVATION_SECONDS * 1000
  ).toISOString();
  const expiresAt = new Date(
    now.getTime() + RETENTION_HOURS * 3600 * 1000
  ).toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO api_idempotency
       (id, tenant_id, operation, idempotency_key, request_hash, status,
        reserved_until, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`
    )
      .bind(recordId, tenantId, operation, key, requestHash,
            reservedUntil, expiresAt, nowIso, nowIso)
      .run();
    return { kind: "execute", recordId, reservedUntil };
  } catch (e) {
    // Only a unique-index violation means someone else owns this slot -- read
    // it below. Any other failure (D1 outage, etc.) is a real error and must
    // propagate rather than be misreported as in_progress/conflict.
    if (!isUniqueConstraintViolation(e)) throw e;
  }

  const prior = await first<{
    id: string;
    request_hash: string;
    status: string;
    response_status: number | null;
    response_json: string | null;
    reserved_until: string | null;
  }>(
    env.DB.prepare(
      `SELECT id, request_hash, status, response_status, response_json, reserved_until
       FROM api_idempotency
       WHERE tenant_id = ? AND operation = ? AND idempotency_key = ?`
    ).bind(tenantId, operation, key)
  );
  if (!prior) {
    // Raced with the sweeper deleting an expired row. Treat as in-progress;
    // the caller retries and wins the insert next time.
    return { kind: "in_progress" };
  }
  if (prior.request_hash !== requestHash) return { kind: "conflict" };

  if (prior.status === "completed" && prior.response_json !== null) {
    return {
      kind: "replay",
      status: prior.response_status ?? 200,
      json: JSON.parse(prior.response_json),
    };
  }

  // Still reserved. If the reservation has lapsed the worker that held it is
  // gone, so take it over rather than 409-ing this caller forever.
  const takeover = await env.DB.prepare(
    `UPDATE api_idempotency
        SET reserved_until = ?, updated_at = ?
      WHERE id = ? AND status = 'reserved' AND reserved_until <= ?`
  )
    .bind(reservedUntil, nowIso, prior.id, nowIso)
    .run();
  if ((takeover.meta?.changes ?? 0) === 1) {
    return { kind: "execute", recordId: prior.id, reservedUntil };
  }
  return { kind: "in_progress" };
}

/**
 * Fence a write against the lease `reserve()` handed the caller, so a caller
 * whose reservation lapsed mid-handler (past RESERVATION_SECONDS, taken over
 * by someone else) cannot clobber the new owner's row -- or, for a DELETE,
 * cannot delete the new owner's live reservation out from under them.
 * meta.changes === 0 means this caller lost the lease; the caller of this
 * function must drop the write rather than force it through.
 */
async function fencedWrite(
  env: Env,
  recordId: string,
  reservedUntil: string,
  sql: string,
  args: unknown[]
): Promise<boolean> {
  const res = await env.DB.prepare(
    `${sql} WHERE id = ? AND status = 'reserved' AND reserved_until = ?`
  )
    .bind(...args, recordId, reservedUntil)
    .run();
  const won = (res.meta?.changes ?? 0) === 1;
  if (!won) {
    console.warn(
      "idempotency: lost reservation lease mid-flight, not caching response",
      recordId
    );
  }
  return won;
}

/**
 * Store the handler's response against a reservation this caller owns.
 * Fenced by reservedUntil: if this caller's lease was taken over while the
 * handler ran, `won` comes back false and nothing is written -- the slot now
 * belongs to someone else, so the response must not be cached under it.
 * The handler's response is still returned to this caller either way; the
 * mutation already happened and undoing it is not an option.
 */
export async function complete(
  env: Env,
  recordId: string,
  reservedUntil: string,
  status: number,
  json: unknown
): Promise<boolean> {
  return fencedWrite(
    env,
    recordId,
    reservedUntil,
    `UPDATE api_idempotency
        SET status = 'completed', response_status = ?, response_json = ?, updated_at = ?`,
    [status, JSON.stringify(json), new Date().toISOString()]
  );
}

/**
 * Drop a reservation whose handler produced an uncacheable result (5xx, or a
 * thrown exception). Fenced the same way as complete(): if this caller's
 * lease already lapsed and was taken over, the DELETE must not fire, or it
 * would delete the new owner's live reservation and let a third caller race
 * in concurrently with them.
 */
export async function release(
  env: Env,
  recordId: string,
  reservedUntil: string
): Promise<boolean> {
  return fencedWrite(
    env,
    recordId,
    reservedUntil,
    `DELETE FROM api_idempotency`,
    []
  );
}
