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

- **At-least-once.** A retry can redeliver an event you already processed.
  **Dedupe on the envelope `id`.**
- Events are written to a durable outbox inside the database transaction, then
  dispatched off the request path via Cloudflare Queues. An event is not lost
  if the Worker is cancelled mid-request.
- **Retries:** up to 6 attempts with exponential backoff plus jitter —
  roughly 1 min, 5 min, 25 min, 2 h, 10 h. After that the event is marked
  `dead` and stops retrying.
- **A 2xx response means delivered.** Anything else, or a connection failure,
  counts as a failed attempt.
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
