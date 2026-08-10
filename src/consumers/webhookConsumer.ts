import type { Env } from "../types";
import { dispatchOutboxRow } from "../lib/webhookOutbox";

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
    } catch {
      // dispatchOutboxRow already recorded attempts + backoff; let the queue
      // redeliver. After max_retries the message lands in the DLQ.
      msg.retry();
    }
  }
}
