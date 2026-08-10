# Zapier / Make outbound webhooks

Admin → **Zapier** (or API: `/api/tenants/:id/webhooks`, or `/api/v1/hooks` with an API key).

There is also a native Zapier app — see `integrations/zapier/README.md`. It is
private (not directory-listed) and covers two of the seven events.

## Setup in Zapier

1. Create a Zap → **Webhooks by Zapier** → **Catch Hook**.
2. Copy the URL into QuiltHosting → Zapier → Add endpoint.
3. Subscribe to events (or `*`).
4. Save the **signing secret** shown once.
5. Send **Test** from QuiltHosting; continue the Zap.

## Payload

```json
{
  "id": "delivery-uuid",
  "schema_version": 1,
  "event": "member.activated",
  "created_at": "2026-08-06T12:00:00.000Z",
  "tenant_id": "…",
  "data": { "source": "join_form", "member_id": "…", "email": "…", "level_id": "…" }
}
```

Every `data` object carries a `source` field naming the mutation path that
produced it: `admin`, `join_form`, `api`, `stripe`, or `public`.

Headers:

| Header | Meaning |
|---|---|
| `X-QH-Event` | Event name |
| `X-QH-Delivery` | `{outbox-id}:{endpoint-id}` — unique per endpoint per attempt |
| `X-QH-Timestamp` | Unix seconds, part of the signed material |
| `X-QH-Schema-Version` | Matches `schema_version` in the body |
| `X-QH-Signature` | HMAC-SHA256 hex of `{X-QH-Timestamp}.{raw body}` |

## Events

| Event | When |
|-------|------|
| `member.created` | A member record is created (admin, public join form, or API) |
| `member.activated` | A member becomes active, on the free or paid path |
| `member.updated` | A member's details or status change |
| `membership.activated` | A membership becomes active, with level metadata |
| `payment.succeeded` | A checkout completes |
| `event.registration` | Someone takes an event seat (free, waitlist, or paid) |
| `form.response` | A public form is submitted |
| `*` | All |

Subscribing to a name that is not on this list returns `400 unknown_event`. It
is **not** silently ignored — a dropped typo would produce a Zap that never
fires and looks identical to a broken integration.

## Verifying the signature

The timestamp is inside the signed material, so a captured body cannot be
replayed later under a fresh header. Compare digests in constant time.

```js
import crypto from "node:crypto";

function verify(rawBody, headers, secret) {
  const ts = headers["x-qh-timestamp"];
  const sig = headers["x-qh-signature"];
  if (!ts || !sig) return false;

  // Reject anything older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");

  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

## Delivery semantics

> **Accuracy note (2026-08-10).** An earlier version of this page claimed the
> outbox row is written "inside the database transaction" and that retries are
> spread over roughly 12 hours. Neither was true of the code. Both claims are
> corrected below, and the underlying work is tracked as P0 remediation. This
> section now describes what the code actually does today.

- **At-least-once.** A retry can redeliver an event you already processed.
  **Dedupe on the envelope `id`.**
- **Delivery is best-effort, not transactional.** The outbox row is written
  *after* the domain mutation commits, as a separate statement, and a failure
  to write it is logged rather than raised. If the Worker stops between the two
  writes, the member/payment/registration exists and the event does not. Making
  the outbox insert part of the same batch as the mutation is outstanding work.
- **Retries are fast, not spread out.** The queue redelivers immediately on
  failure — up to 5 queue attempts, after which the message goes to the
  dead-letter queue. The row also carries a `next_attempt_at` computed with
  exponential backoff, but only the one-minute cron sweeper honours it; the
  queue path does not. In practice a persistently failing endpoint exhausts its
  6 recorded attempts within seconds and the event is marked `dead`.
- **A 2xx response means delivered.** Anything else, or a connection failure,
  counts as a failed attempt.
- **Fan-out is all-or-nothing per attempt.** Delivery state is stored on the
  event, not per endpoint. If you have two endpoints subscribed and one fails,
  the retry re-sends to *both* — the healthy one will see duplicates. Dedupe on
  the envelope `id`.
- **Auto-disable:** an endpoint with 20 consecutive failures is switched off so
  one dead Zap does not consume your delivery budget. Admin → Zapier shows an
  "auto-disabled" badge with a **Re-enable** button.
- **Replay:** Admin → Zapier → Recent deliveries lists every event with its
  status, attempt count, and last error. Failed and dead events have a
  **Replay** button.

## Compatibility policy

`schema_version` is currently `1`.

- Adding an **optional** field → no version bump.
- Adding a **required** field → bump.
- Renaming or removing a field → bump, and the old field stays populated for
  one minor release.
- Changing a field's meaning or type → bump.

Consumers must ignore unknown fields.

## Known limits

Stated plainly so nobody relies on something that is not there:

- **CSV import does not fire `member.created`.** A bulk import would write one
  outbox row and one queue send per row and exceed the Worker subrequest
  ceiling. Poll `GET /api/v1/members` after an import instead. A
  `members.import.completed` summary event is planned.
- **Admin status edits fire `member.updated`, not `member.activated`.** Setting
  a member to `active` by hand is a data correction, not a membership
  lifecycle event. `member.updated` carries `previous_status` and `status`, so
  a Zap can filter on the transition.
- **Hook URL validation is a hostname deny list, not full SSRF protection.**
  `https` is required and loopback, private ranges, link-local/metadata
  addresses, and our own domains are refused — but a DNS name that resolves to
  a private address still passes.
- **The multi-SKU store cart has no dedicated event.** `payment.succeeded`
  fires, but there is no `order.paid`.
- **No per-API-key rate limiting yet**, and delivery logs retain payloads
  (including member PII) with no redaction or retention policy.

REST pull API remains at `/api/v1/*` with API keys — see [api.md](./api.md).
