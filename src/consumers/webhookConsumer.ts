import type { Env } from "../types";
import { dispatchOutboxRow } from "../lib/webhookOutbox";

/**
 * Used only when dispatchOutboxRow threw without a delaySeconds -- an
 * unexpected failure outside its own error path. Deliberately a constant and
 * NOT a backoffFor() call: backoffFor applies full jitter, so re-drawing it
 * here would produce a delay independent of the one already written into the
 * row's next_attempt_at, which is exactly the divergence this file's fix
 * removed. One minute matches the sweeper's period, so the worst case is that
 * the sweeper gets there first.
 */
const FALLBACK_RETRY_SECONDS = 60;

export async function handleWebhookQueue(
  batch: MessageBatch<{ outboxId: string }>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await dispatchOutboxRow(env, msg.body.outboxId);
      // Also reached when dispatchOutboxRow returned early because
      // claimOutboxRow lost the race (row already owned, or its backoff has
      // not elapsed yet). That is a pre-backoff redelivery, not a failure --
      // acking it here is a deliberate drop, not a bug: the row's own
      // next_attempt_at/lease already reflects who owns it next, and the
      // one-minute sweeper is the backstop that redelivers it.
      msg.ack();
    } catch (e: any) {
      // dispatchOutboxRow already recorded the failure and wrote
      // next_attempt_at; it throws carrying the EXACT delay it used, so the
      // queue redelivers at the same instant the row says it is next due.
      // A bare msg.retry() redelivers immediately: the redelivery is then
      // bounced by the row's lease/next_attempt_at guard and silently ack'd,
      // so the documented backoff never runs and the queue's retry budget is
      // burned in seconds. Re-deriving the delay here would be almost as bad,
      // since backoffFor is jittered and a second draw undershoots the row's
      // own deadline about half the time. After max_retries the message lands
      // in the DLQ.
      const delaySeconds = Number(e?.delaySeconds) || FALLBACK_RETRY_SECONDS;
      msg.retry({ delaySeconds });
    }
  }
}
