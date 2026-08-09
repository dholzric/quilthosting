import type { Env } from "../types";
import { dispatchOutboxRow } from "../lib/webhookOutbox";

export async function handleWebhookQueue(
  batch: MessageBatch<{ outboxId: string }>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await dispatchOutboxRow(env, msg.body.outboxId);
      msg.ack();
    } catch {
      // dispatchOutboxRow already recorded attempts + backoff; let the queue
      // redeliver. After max_retries the message lands in the DLQ.
      msg.retry();
    }
  }
}
