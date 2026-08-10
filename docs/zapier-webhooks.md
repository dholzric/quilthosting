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

As of v0.29.0-preview, the guarantees below are backed by the code — see
`docs/superpowers/plans/2026-08-10-delivery-reliability.md` for the remediation
that made them true. An earlier version of this page (v0.27.0-preview) claimed
some of this before the code supported it; that history is preserved, not
deleted, in the correction banner on
`docs/superpowers/plans/2026-08-09-integration-ecosystem.md`.

- **At-least-once.** A retry can redeliver an event you already processed.
  **Dedupe on the envelope `id`.**
- **The outbox row commits atomically with the mutation that caused it, at
  every converted call site.** `member.created` (admin, public join form, API
  v1), `member.updated` (API v1 PATCH), `event.registration`, and
  `form.response` write their outbox row in the same `DB.batch()` as the row
  that caused them — either both commit or neither does.
- **Retries honour a real, recorded backoff.** Each failed attempt draws one
  jittered delay and writes it to the row's `next_attempt_at`; that same delay
  is handed to the queue as `delaySeconds`, so the queue and the row agree on
  when the next attempt is due instead of the queue redelivering immediately.
  The actual gaps: roughly 2.5–5 min before the 1st retry, 12–25 min before
  the 2nd, 1–2 h before the 3rd, and 5–10 h before the 4th and 5th — each
  figure is a range, not a fixed number, because every delay is jittered so a
  fleet of failed deliveries does not retry in lockstep. Up to 6 attempts
  total, then the event is marked `dead`.
- **A leased claim prevents double delivery.** Dispatch (whether triggered by
  the queue or by the one-minute cron sweeper) first takes a time-boxed lease
  on the row with a compare-and-set update; a lease that a worker never
  releases (a hung fetch, a killed Worker) is reclaimable by another worker
  once it expires, and every completion write is fenced on the lease so a
  worker that has lost its lease cannot clobber a newer claim's result.
- **A 2xx response means delivered.** Anything else, or a connection failure,
  counts as a failed attempt.
- **Fan-out is per endpoint, not all-or-nothing.** Delivery state is tracked
  per `(event, endpoint)`. If you have two endpoints subscribed and one fails,
  only that endpoint is retried — a healthy endpoint is not re-sent after a
  sibling's failure and will not see duplicates from this cause. (At-least-once
  redelivery can still duplicate a delivery for other reasons — dedupe on the
  envelope `id` regardless.)
- **Admin and API-key webhook management share one validator.** `https`
  required, hostname deny list, event names checked against the fixed catalog,
  and a per-tenant endpoint limit — applied on both surfaces. `/api/v1/hooks`
  only exposes create/list/delete (no PATCH); on the admin route, edit
  (`PATCH`) is validated identically to create.
- **Auto-disable:** an endpoint with 20 consecutive failures is switched off so
  one dead Zap does not consume your delivery budget. Admin → Zapier shows an
  "auto-disabled" badge with a **Re-enable** button.
- **Replay:** Admin → Zapier → Recent deliveries lists every event with its
  status, attempt count, and last error. Failed and dead events have a
  **Replay** button.

### Limitations — read before relying on atomicity

- **One write path is not yet atomic: admin `PATCH /members/:memberId`
  (`member.updated`).** It still uses the older `enqueueEvent` helper, which
  writes the outbox row *after* the member update commits, as a separate
  statement. If the Worker stops in that window, the update stands and its
  event is lost. Every other path listed above (`member.created`,
  `member.updated` via API v1, `event.registration`, `form.response`) is
  atomic; this one admin route is the exception.
- **The Stripe webhook path logs instead of failing when event-preparation
  fails.** Stripe retries the *entire* webhook body on any non-2xx response,
  and the payment side effects on that path are not safely re-runnable past
  `paymentAlreadyRecorded`. So if writing an outbox row fails there, the
  mutation is committed alone, a loud error is logged, and the request still
  returns 200 rather than asking Stripe to redeliver a payment already
  recorded. The event can be lost; the payment is not.
- **`membership.activated` and `member.activated` are atomic with each other,
  not with the activation.** On both the free-join path and the Stripe dues
  path, `activateMembership()` runs and commits its own statements (expiring
  prior actives, inserting the membership, flipping member status) first, and
  only afterward are the two outbox rows written — batched together so a
  subscriber never sees one event without the other, but neither event is in
  the same transaction as the activation itself.
- **The Stripe commit helper requires its mutation to be idempotent, and
  nothing enforces that.** `commitStripeMutationWithEvent` falls back to
  re-running the mutation alone if the batched write fails, and that fallback
  can itself be interrupted. Every current caller passes a statement that is
  safe to run twice (an INSERT on a pre-generated id, or a status-flag UPDATE
  whose WHERE clause is a no-op once applied) — but a future caller passing a
  non-idempotent statement (e.g. a bare decrement) could double-apply.
- **The hostname deny list does not resolve DNS.** `https` is required and
  loopback, private ranges, link-local/metadata addresses, and our own domains
  are refused by pattern match against the hostname — but a hostname that
  resolves to a private address at request time still passes. DNS rebinding is
  out of scope.
- **Delivery remains at-least-once.** Leasing and per-endpoint state prevent
  the *known* double-send causes, but a retry can still redeliver an event you
  already processed (queue redelivery races, a completion write that lands
  after a client already saw a timeout, etc.). Consumers must always dedupe on
  the envelope `id` — this is not going away.

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
