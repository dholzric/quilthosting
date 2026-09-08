/**
 * Move due scheduled blasts onto the queued pipeline.
 *
 * Safe to call every minute from overlapping cron ticks: each due row is
 * claimed with a conditional UPDATE (status='scheduled' AND send_at <= now)
 * and only counted when that UPDATE changed exactly one row, so two ticks
 * that both see the same due blast cannot both queue it. Delivery itself
 * happens in processQueuedBlasts / processBlastChunk (lib/blastSend.ts),
 * which take a separate sending lease.
 */
import type { Env } from "../types";
import { all } from "./db";
import { bodyToHtml } from "./email/merge";

type ScheduledRow = { id: string; send_at: string };

export type ScheduledBlastsResult = {
  /** Blasts claimed and moved to 'queued' by this call. */
  sent_blasts: number;
  /** Always 0 here — delivery is asynchronous. Kept for the cron summary shape. */
  emails: number;
  errors: string[];
};

export async function runScheduledBlasts(
  env: Env,
  nowIso: string = new Date().toISOString()
): Promise<ScheduledBlastsResult> {
  const result: ScheduledBlastsResult = { sent_blasts: 0, emails: 0, errors: [] };

  let rows: ScheduledRow[] = [];
  try {
    rows = await all<ScheduledRow>(
      env.DB.prepare(
        `SELECT id, send_at FROM blasts
         WHERE status = 'scheduled' AND send_at IS NOT NULL AND send_at <= ?
         ORDER BY send_at ASC
         LIMIT 20`
      ).bind(nowIso)
    );
  } catch (e) {
    // migration not applied yet
    result.errors.push(`scheduled query: ${String(e)}`);
    return result;
  }

  for (const blast of rows) {
    try {
      const claim = await env.DB.prepare(
        `UPDATE blasts
           SET status = 'queued', cursor_email = NULL, sent_count = 0, error_count = 0
         WHERE id = ? AND status = 'scheduled' AND send_at IS NOT NULL AND send_at <= ?`
      )
        .bind(blast.id, nowIso)
        .run();
      if ((claim.meta?.changes ?? 0) !== 1) continue; // another tick got it
      result.sent_blasts++;
    } catch (e) {
      result.errors.push(`blast ${blast.id}: ${String(e)}`);
    }
  }

  return result;
}

export { bodyToHtml };
