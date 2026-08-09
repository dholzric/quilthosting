/**
 * Single source of truth for outbound webhook events: names, payload schemas,
 * and human descriptions.
 *
 * RULE: every name here MUST have a live enqueue call site, and
 * scripts/verify-integrations.mjs asserts a real delivery for each one it can
 * drive locally. Names the harness cannot drive are listed in
 * HARNESS_UNDRIVEN below with the script that does cover them — an event is
 * never simply skipped, because advertising an event with no emitter is the
 * exact defect this module exists to prevent.
 */
import { z } from "zod";

export const EVENT_SCHEMA_VERSION = 1;

export const WEBHOOK_EVENTS = [
  "member.created",
  "member.activated",
  "member.updated",
  "membership.activated",
  "payment.succeeded",
  "event.registration",
  "form.response",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** Wildcard is valid for subscribing but is never an emitted event name. */
export type WebhookEvent = WebhookEventName | "*";

export const WEBHOOK_SUBSCRIBE_OPTIONS: readonly string[] = [
  "*",
  ...WEBHOOK_EVENTS,
];

export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventName, string> = {
  "member.created": "A member record is created (admin, public join form, or API)",
  "member.activated": "A member becomes active, on the free or paid path",
  "member.updated": "A member's details or status change",
  "membership.activated": "A membership becomes active, with level metadata",
  "payment.succeeded": "A checkout completes",
  "event.registration": "Someone takes an event seat (free, waitlist, or paid)",
  "form.response": "A public form is submitted",
};

/** Events the local harness cannot drive, and what covers them instead. */
export const HARNESS_UNDRIVEN: Partial<Record<WebhookEventName, string>> = {
  "payment.succeeded": "scripts/e2e-auto-renew.mjs (signed Stripe webhooks)",
};

/** Which mutation path produced the event. Present on every payload. */
const sourceField = z.enum(["admin", "join_form", "api", "stripe", "public"]);

export const eventPayloadSchemas: Record<WebhookEventName, z.ZodTypeAny> = {
  "member.created": z.object({
    source: sourceField,
    member_id: z.string(),
    email: z.string(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    status: z.string(),
  }),
  "member.activated": z.object({
    source: sourceField,
    member_id: z.string(),
    email: z.string(),
    level_id: z.string().nullable(),
  }),
  "member.updated": z.object({
    source: sourceField,
    member_id: z.string(),
    email: z.string(),
    status: z.string(),
    previous_status: z.string(),
    changed: z.array(z.string()),
  }),
  "membership.activated": z.object({
    source: sourceField,
    member_id: z.string(),
    email: z.string(),
    level_id: z.string(),
    level_name: z.string(),
    membership_id: z.string().nullable(),
  }),
  "payment.succeeded": z.object({
    source: sourceField,
    type: z.string(),
    amount_cents: z.number(),
    email: z.string().nullable(),
    related_id: z.string().nullable(),
  }),
  "event.registration": z.object({
    source: sourceField,
    registration_id: z.string(),
    event_id: z.string(),
    event_title: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    status: z.string(),
    amount_paid_cents: z.number(),
    ticket_code: z.string().nullable(),
  }),
  "form.response": z.object({
    source: sourceField,
    form_id: z.string(),
    response_id: z.string(),
    email: z.string().nullable(),
    answers: z.record(z.unknown()),
  }),
};

/**
 * Compatibility policy for EVENT_SCHEMA_VERSION:
 *   - Adding an OPTIONAL field           -> no version bump
 *   - Adding a REQUIRED field            -> bump
 *   - Renaming or removing a field       -> bump, and keep the old field
 *                                           populated for one minor release
 *   - Changing a field's meaning/type    -> bump
 * Consumers must ignore unknown fields. The envelope always carries
 * schema_version so a consumer can branch.
 */
