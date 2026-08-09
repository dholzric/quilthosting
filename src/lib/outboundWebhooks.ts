/**
 * Compatibility shim over the durable outbox.
 *
 * The inline fetch loop that used to live here was removed in v0.27.0: it
 * awaited delivery inside the user request (slow endpoints blocked the
 * response) and lost events entirely if the Worker was cancelled between the
 * database commit and the fetch. All delivery now goes through
 * lib/webhookOutbox.ts.
 *
 * Prefer calling enqueueEvent() directly — it takes an ExecutionContext, so
 * the queue send happens in waitUntil instead of on the request path. This
 * shim exists for call sites that do not have a ctx handy.
 */
import type { Env } from "../types";
import type { WebhookEvent, WebhookEventName } from "./webhookEvents";

export type { WebhookEvent };

export async function emitTenantEvent(
  env: Env,
  tenantId: string,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  // "*" is a subscription filter, never an emitted name.
  if (event === "*") return;
  const { enqueueEvent } = await import("./webhookOutbox");
  await enqueueEvent(env, undefined, tenantId, event as WebhookEventName, data);
}
