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
