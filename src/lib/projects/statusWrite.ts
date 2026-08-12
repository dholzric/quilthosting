// The shared guard for every UPDATE that changes (or re-affirms) a
// project's status. signQuote (src/routes/site.ts) already had this guard
// -- Task 10 hardened it against a concurrent owner action (cancel/decline)
// landing between the read of project.status and the write -- but the
// PATCH and send-estimate routes in src/routes/projects.ts had the
// identical check-then-act shape (read project.status, call
// assertTransition, THEN write with no status predicate) and no equivalent
// guard. A same-second "owner declines while the customer is on the sign
// page" or "owner re-sends the estimate while the customer is signing"
// could silently clobber a signed project or resurrect it back to
// 'estimated' (final review, F1).
//
// Binding the status actually read into the WHERE clause, and checking
// meta.changes rather than assuming a bare `.run()` succeeded, is what
// turns that race into a detectable "matched nothing" signal instead of a
// silent no-op that looks like success.
//
// Deliberately built around the CALLER supplying the extra SET fragment
// rather than this module trying to special-case each route's own set of
// non-status columns: PATCH, send-estimate, and signQuote each touch a
// different set of columns in the same statement, but all three need the
// identical status/updated_at/WHERE shape, and all three must fail the
// SAME way (meta.changes === 0) when the guard doesn't hold. What each
// caller does with that failure differs (see the two exports below) --
// PATCH and send-estimate ARE the status transition, so a failed guard
// fails the whole request; signQuote's signature INSERT is the source of
// truth for "did the customer sign," so a failed guard there just means
// the status column doesn't flip, not that the signature didn't happen.

import type { ProjectStatus } from "./types";

export interface GuardedStatusUpdateArgs {
  tenantId: string;
  projectId: string;
  /** The status this write was read under. Bound into the WHERE clause --
   * never trusted to still be true by the time the write runs. */
  fromStatus: ProjectStatus;
  /** The status this write sets. May equal fromStatus (a PATCH that
   * doesn't touch status at all, or estimated -> estimated on resend) --
   * the guard still applies: the row must not have moved out from under
   * the reader between the read and this write. */
  toStatus: ProjectStatus;
  now: string;
  /** Additional `column = ?` fragments, comma-joined into the SET clause
   * right after `status = ?, updated_at = ?`. */
  extraSet?: string;
  /** Bind values for extraSet's placeholders, in the same order they
   * appear in extraSet. */
  extraBinds?: unknown[];
}

/**
 * Builds (but does not execute) the guarded UPDATE. Run it directly with
 * `.run()` for a standalone call (PATCH, send-estimate), or hand it to
 * `db.batch([...])` alongside another statement that must commit atomically
 * with it (signQuote's signature INSERT) -- either way, check the result
 * with `guardedUpdateApplied()`.
 */
export function buildGuardedStatusUpdate(
  db: D1Database,
  args: GuardedStatusUpdateArgs
): D1PreparedStatement {
  const setParts = ["status = ?", "updated_at = ?"];
  if (args.extraSet) setParts.push(args.extraSet);
  const sql = `UPDATE projects SET ${setParts.join(", ")} WHERE id = ? AND tenant_id = ? AND status = ?`;
  return db
    .prepare(sql)
    .bind(
      args.toStatus,
      args.now,
      ...(args.extraBinds ?? []),
      args.projectId,
      args.tenantId,
      args.fromStatus
    );
}

/**
 * True iff the guarded UPDATE actually matched (and changed) a row. False
 * means the project's status moved between the read that produced
 * `fromStatus` and this write -- callers whose entire request IS the
 * status transition (PATCH, send-estimate) must treat that as a 409, never
 * as a silent no-op that still reports { ok: true }.
 */
export function guardedUpdateApplied(result: D1Result): boolean {
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Convenience wrapper for the common standalone case (PATCH,
 * send-estimate): build, run, and interpret in one call. signQuote in
 * site.ts instead calls buildGuardedStatusUpdate directly, because its
 * UPDATE must run inside the same db.batch() as the signature INSERT
 * rather than as an independent round trip.
 */
export async function runGuardedStatusUpdate(
  db: D1Database,
  args: GuardedStatusUpdateArgs
): Promise<boolean> {
  const result = await buildGuardedStatusUpdate(db, args).run();
  return guardedUpdateApplied(result);
}
