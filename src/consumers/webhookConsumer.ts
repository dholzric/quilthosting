import type { Env } from "../types";
import { dispatchOutboxRow, backoffFor } from "../lib/webhookOutbox";

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
      // dispatchOutboxRow already recorded attempts + backoff on the row, and
      // throws with that attempt count attached so the queue can wait the SAME
      // interval the row recorded. A bare msg.retry() redelivers immediately:
      // the redelivery is then bounced by the row's own lease/next_attempt_at
      // guard and silently ack'd, so the documented backoff never runs and the
      // queue's retry budget is burned in seconds. After max_retries the
      // message lands in the DLQ.
      const attempts = Number(e?.attempts) || 1;
      msg.retry({ delaySeconds: backoffFor(attempts) });
    }
  }
}
