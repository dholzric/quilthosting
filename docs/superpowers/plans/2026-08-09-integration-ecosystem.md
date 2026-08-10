# Integration Foundation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **POST-EXECUTION CORRECTION (2026-08-10).** This plan was executed and shipped
> as v0.27.0-preview, and two of its delivery claims turned out to be false of
> the code it produced. Do not re-implement or quote them:
>
> 1. **"Events are written inside the database transaction"** — they are not.
>    `enqueueEvent` writes the outbox row *after* the domain mutation commits,
>    as a separate statement, and swallows its own insert errors. The event can
>    be lost while the mutation survives. This is the exact gap an outbox exists
>    to close.
> 2. **"Up to 6 attempts over ~12 hours"** — the queue consumer calls
>    `msg.retry()` with no delay and `dispatchOutboxRow` never checks
>    `next_attempt_at`, so retries fire immediately and a failing endpoint burns
>    all attempts in seconds. Only the cron sweeper honours the backoff.
>
> Found by an external Codex review on 2026-08-10 and confirmed against the
> code. `docs/zapier-webhooks.md` and the admin UI copy have been corrected;
> the code fix is tracked as P0 remediation.

**Revision 2 (2026-08-09).** Revision 1 was reviewed by Grok and Codex and found **not executable as written**. Both reviews are preserved verbatim in `2026-08-09-integration-foundation-reviews.md`. Every blocking claim was independently re-verified against the codebase before this revision — see "Verified review findings" below. This revision incorporates all of Grok's P0/P1/P2 corrections and all of Codex's P0 reliability gates, including the durable outbox.

**Goal:** Build the reliable, contract-stable integration foundation QuiltHosting needs before any integration can be marketed — honest event emission, durable delivery with retry and replay, a versioned payload contract, idempotent write actions, scoped API access, and a working Zapier app.

**Scope boundary — read this before reporting on it.** This plan is **Phase 1 of the program in `2026-08-09-wildapricot-master-program.md`**. Completing it does **not** constitute WildApricot integration parity. Shipping it produces seven reliably-delivered events, two Zapier triggers, one Zapier action, a private Zapier app, and seven v1 endpoints. Do not describe the result as an "integration ecosystem" internally or externally.

**Architecture:** A single catalog module owns event names *and* their versioned payload schemas. Domain mutations write an immutable `webhook_outbox` row inside the mutation boundary and never call `fetch` inline; a Cloudflare Queue consumer dispatches with bounded exponential backoff and a dead-letter queue, and a cron sweeper recovers anything the queue never acknowledged. The public v1 API gains idempotent writes and REST-hook management under dedicated scopes so a Zapier app authenticates with an API key alone.

**Tech Stack:** TypeScript ESM, Hono 4, Zod 3, Cloudflare Workers + D1 + **Queues** (verified available on account `fc9a445b7af4421e2d0c2fd202885f97`; 8 queues already exist including a DLQ pair, so the account is on Workers Paid), Wrangler 4. Zapier app uses the Zapier Platform CLI.

---

## Verified review findings

Both reviewers' blocking claims were re-checked against the live code. All confirmed:

| Finding | Source | Verification |
|---|---|---|
| Free join never emits `member.activated` / `membership.activated` | Grok P0-1 | **Confirmed.** `src/routes/public.ts:266` calls `activateMembership` then returns. The only emits of those names are `src/routes/webhooks.ts:275,281` — the Stripe path. Revision 1's Task 2 baseline and Task 5 "everything passes" claim were both false. |
| Harness cannot reach `/public/*` under the site gate | Grok P0-2 | **Confirmed.** `src/middleware/siteGate.ts` exempts `/api/webhooks/`, `/api/auth/`, `/api/v1/`, `/t/o/`, `/t/c/`, `/.well-known/`, OPTIONS, and any valid Bearer JWT. `/public/*` is not exempt. |
| `POST /api-keys` returns `api_key`, not `key` | Grok P0-3 | **Confirmed.** `src/routes/apiKeys.ts:50` returns `api_key: raw`. |
| v1 hooks inserting `secret: null` breaks parity | Grok P1-7 | **Confirmed.** The admin route auto-generates one at `src/routes/outboundWebhooks.ts:57`. |
| `registration_open` is ignored on event POST | Grok P1-11 | **Confirmed.** Only read in the PATCH coalesce at `src/routes/events.ts:168,177`. |
| Inline `fetch` after commit is not reliable delivery | Codex P0-1 | **Confirmed by inspection.** `src/lib/outboundWebhooks.ts:74-140` awaits `fetch` inside the request, after the mutation committed; `fail_count` is incremented at `:130` and consumed nowhere. |

Revision 1's own self-review flagged Task 4 Step 2 as its weakest step. Grok independently reached the same conclusion. That step is rewritten here to show the final block.

---

## Global Constraints

- **Multi-tenancy:** every tenant-scoped query filters by `tenant_id`. No exceptions.
- **Data conventions:** money is integer cents; timestamps are ISO strings; booleans are INTEGER 0/1; JSON columns are TEXT with a `_json` suffix.
- **Identifiers:** camelCase for code identifiers.
- **No test runner exists in this repo.** Verification is `scripts/*.mjs` over HTTP against `wrangler dev`, following `scripts/e2e-auto-renew.mjs`. Do not introduce Vitest/Jest.
- **Typecheck is the only static gate:** `npx tsc --noEmit` must pass before every commit.
- **Never edit files with `sed -i` on this machine.** It is Windows/PowerShell and `sed -i` is unreliable here (Grok P1-10). Use the editor or a Node one-liner.
- **No autonomous production deploys.** `npm run deploy` touches live secrets and the stealth gate. A subagent must stop and request explicit human approval before deploying (Codex required-edit 10). Committing and pushing to `main` is fine.
- **Emission must never break the main flow, and must never block the response.** After Task 2 the only correct way to emit is `enqueueEvent(...)` inside the mutation, dispatched via `c.executionCtx.waitUntil` — never a bare inline `await fetch`.
- **Versioning:** bump `package.json` `version` AND `src/version.ts` `APP_VERSION` together. This plan spans 0.26.1 → **0.27.0-preview**, labeled *integration developer preview*.

### Preconditions for the verification harness

1. `wrangler.toml` sets `GOOGLE_AUTH_REQUIRED = "true"` and `.dev.vars` does not override it, so password register/login 403s locally. Add to `.dev.vars`: `GOOGLE_AUTH_REQUIRED=false`
2. `.dev.vars` sets `SITE_ACCESS_PASSWORD`, so `/public/*` is gated. The harness **must** authenticate — see Task 3 Step 1, which sends the admin JWT on public routes because `siteGate.ts:100-101` accepts any valid Bearer JWT.
3. `npm run db:migrate:local` applied.
4. `npx wrangler dev` running on `:8787` in a separate terminal.
5. **The harness is local-only.** Local workerd can reach a host loopback sink; a deployed Worker cannot. If the sink receives nothing, debug Worker→host networking before suspecting emitters (Grok P1-12).

---

## File Structure

**Create:**
- `src/lib/webhookEvents.ts` — event names, versioned payload schemas, descriptions. Single source of truth.
- `src/lib/webhookOutbox.ts` — `enqueueEvent`, `dispatchOutboxRow`, `sweepOutbox`. All delivery logic.
- `src/consumers/webhookConsumer.ts` — Queue consumer entry point.
- `migrations/0013_webhook_outbox.sql` — outbox table, idempotency table, endpoint limits.
- `scripts/verify-integrations.mjs` — E2E harness.
- `scripts/fixtures/events/*.json` — payload snapshots shared by Worker, Zapier app, and docs.
- `integrations/zapier/` — Zapier Platform CLI app.

**Modify:**
- `src/lib/outboundWebhooks.ts` — becomes a thin compatibility shim over the outbox; the inline `fetch` loop moves to `webhookOutbox.ts`.
- `src/routes/members.ts`, `public.ts`, `webhooks.ts` — emit sites.
- `src/routes/v1.ts` — writes, idempotency, hooks.
- `src/routes/apiKeys.ts` — new scope vocabulary.
- `src/routes/events.ts` — accept `registration_open` on POST (Grok P1-11).
- `src/index.ts` — export `queue`, add outbox sweep to `scheduled`.
- `wrangler.toml` — queue producer/consumer bindings, 1-minute sweep cron.
- `public/admin.html` — event catalog from API, scope checkboxes, delivery/replay UI.
- `docs/zapier-webhooks.md`, `docs/api.md`, `public/docs/api.html`.

---

## Task 1: Event catalog with versioned payload contract

Collapses three disagreeing event lists into one module, and — per Codex P0-2 — attaches a versioned schema to each name so two mutation paths cannot emit the same event with different shapes.

**Files:**
- Create: `src/lib/webhookEvents.ts`, `scripts/fixtures/events/*.json`
- Modify: `src/lib/outboundWebhooks.ts:9-17`, `src/routes/outboundWebhooks.ts:11-20`, `public/admin.html:3752`

**Interfaces:**
- Produces: `WEBHOOK_EVENTS`, `WebhookEventName`, `WebhookEvent`, `WEBHOOK_EVENT_DESCRIPTIONS`, `WEBHOOK_SUBSCRIBE_OPTIONS`, `EVENT_SCHEMA_VERSION`, `eventPayloadSchemas` (Zod). Every later task imports from here.

- [ ] **Step 1: Create the catalog with schemas**

Create `src/lib/webhookEvents.ts`:

```ts
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

export const WEBHOOK_SUBSCRIBE_OPTIONS: readonly string[] = ["*", ...WEBHOOK_EVENTS];

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

const base = {
  /** Which mutation path produced this event. */
  source: z.enum(["admin", "join_form", "api", "stripe", "public"]),
};

export const eventPayloadSchemas: Record<WebhookEventName, z.ZodTypeAny> = {
  "member.created": z.object({
    ...base,
    member_id: z.string(),
    email: z.string(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    status: z.string(),
  }),
  "member.activated": z.object({
    ...base,
    member_id: z.string(),
    email: z.string(),
    level_id: z.string().nullable(),
  }),
  "member.updated": z.object({
    ...base,
    member_id: z.string(),
    email: z.string(),
    status: z.string(),
    previous_status: z.string(),
    changed: z.array(z.string()),
  }),
  "membership.activated": z.object({
    ...base,
    member_id: z.string(),
    email: z.string(),
    level_id: z.string(),
    level_name: z.string(),
    membership_id: z.string().nullable(),
  }),
  "payment.succeeded": z.object({
    ...base,
    type: z.string(),
    amount_cents: z.number(),
    email: z.string().nullable(),
    related_id: z.string().nullable(),
  }),
  "event.registration": z.object({
    ...base,
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
    ...base,
    form_id: z.string(),
    response_id: z.string(),
    email: z.string().nullable(),
    answers: z.record(z.unknown()),
  }),
};
```

**Compatibility policy** — add this as a comment block at the bottom of the file, because Codex P0-2 requires it be written down, not assumed:

```ts
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
```

- [ ] **Step 2: Point the emitter and validator at the catalog**

In `src/lib/outboundWebhooks.ts`, delete the inline union (lines 9-17) and replace with:

```ts
import type { WebhookEvent } from "./webhookEvents";
export type { WebhookEvent };
```

In `src/routes/outboundWebhooks.ts`, replace the `EVENT_OPTIONS` array (lines 11-20) with:

```ts
import { WEBHOOK_SUBSCRIBE_OPTIONS } from "../lib/webhookEvents";

const EVENT_OPTIONS = WEBHOOK_SUBSCRIBE_OPTIONS;
```

**Strict rejection (Codex P0-4):** both the admin route (`outboundWebhooks.ts:52-54`) and the future v1 route currently *silently filter* unknown event names. Change the admin route to reject instead:

```ts
  const requested = Array.isArray(body.events) && body.events.length ? body.events : ["*"];
  const unknown = requested.filter((e) => !WEBHOOK_SUBSCRIBE_OPTIONS.includes(e));
  if (unknown.length) {
    return c.json(
      { error: `Unknown event(s): ${unknown.join(", ")}`, code: "unknown_event",
        valid: WEBHOOK_SUBSCRIBE_OPTIONS },
      400
    );
  }
  const events = requested;
```

A silently-dropped typo produces a Zap that never fires and is indistinguishable from the bug this whole plan is fixing.

- [ ] **Step 3: Write payload fixtures**

Create one file per event under `scripts/fixtures/events/`, e.g. `member.created.json`:

```json
{
  "schema_version": 1,
  "event": "member.created",
  "data": {
    "member_id": "mem_sample",
    "email": "member@example.com",
    "first_name": "Ada",
    "last_name": "Lovelace",
    "status": "pending",
    "source": "join_form"
  }
}
```

Write the remaining six to match `eventPayloadSchemas` exactly. These are the shared fixtures Codex P0-2 requires: the Worker validates against them, the Zapier app uses them as `sample`, and the docs embed them.

- [ ] **Step 4: Typecheck and verify catalog serving**

```bash
npx tsc --noEmit
curl -s -H "Authorization: Bearer $JWT" \
  http://127.0.0.1:8787/api/tenants/$TENANT_ID/webhooks/events
```
Expected: all seven names plus `*`.

- [ ] **Step 5: Make the admin UI read the catalog**

Replace the hardcoded `<code>` at `public/admin.html:3752` with `<code style="font-size:0.8rem" id="webhookEventCatalog">loading…</code>` and populate it:

```js
async function loadWebhookEventCatalog() {
  const el = document.getElementById("webhookEventCatalog");
  if (!el) return;
  try {
    const res = await api(`/api/tenants/${tenantId}/webhooks/events`);
    el.textContent = (res.events || []).join(" · ");
  } catch {
    el.textContent = "unavailable";
  }
}
```

Call it where the webhook list loads, using the page's existing `api()` helper and `tenantId`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/webhookEvents.ts src/lib/outboundWebhooks.ts src/routes/outboundWebhooks.ts scripts/fixtures public/admin.html
git commit -m "feat(webhooks): versioned event catalog as single source of truth"
git push
```

---

## Task 2: Durable outbox and queue dispatcher

Replaces best-effort inline `fetch` with a durable outbox. This is Codex P0-1 and the single largest change in the plan.

**Files:**
- Create: `migrations/0013_webhook_outbox.sql`, `src/lib/webhookOutbox.ts`, `src/consumers/webhookConsumer.ts`
- Modify: `src/lib/outboundWebhooks.ts`, `src/index.ts`, `wrangler.toml`

**Interfaces:**
- Produces: `enqueueEvent(env, ctx, tenantId, event, data, source)`, `dispatchOutboxRow(env, rowId)`, `sweepOutbox(env, limit)`. Tasks 4-9 call **only** `enqueueEvent`.

- [ ] **Step 1: Migration**

Create `migrations/0013_webhook_outbox.sql`:

```sql
-- Durable outbox: a row is written inside the mutation, dispatched out-of-band.
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | delivering | delivered | failed | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_outbox_sweep ON webhook_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON webhook_outbox(tenant_id, created_at);

-- Idempotency for v1 writes (Codex P0-3).
CREATE TABLE IF NOT EXISTS api_idempotency (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_key ON api_idempotency(tenant_id, idempotency_key);

-- Signing timestamp + rotation support on endpoints (Codex P0-4).
ALTER TABLE webhook_endpoints ADD COLUMN secret_rotated_at TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN disabled_reason TEXT;
```

Apply: `npm run db:migrate:local`

- [ ] **Step 2: The outbox module**

Create `src/lib/webhookOutbox.ts`:

```ts
/**
 * Durable webhook delivery.
 *
 * enqueueEvent() writes an outbox row (durable) and hands the id to the queue
 * via waitUntil (fast path). If the queue send fails or the Worker dies, the
 * cron sweeper picks the row up by next_attempt_at. Delivery is therefore
 * at-least-once: consumers must be idempotent on the envelope `id`.
 */
import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import {
  EVENT_SCHEMA_VERSION,
  eventPayloadSchemas,
  type WebhookEventName,
} from "./webhookEvents";

const MAX_ATTEMPTS = 6;
/** 1m, 5m, 25m, 2h, 10h — bounded exponential with jitter applied at use. */
const BACKOFF_SECONDS = [60, 300, 1500, 7200, 36000];

export function backoffFor(attempts: number): number {
  const bounded = Math.min(attempts, BACKOFF_SECONDS.length - 1);
  const base = BACKOFF_SECONDS[bounded];
  // Full jitter, so a fleet of failed deliveries does not retry in lockstep.
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

export async function enqueueEvent(
  env: Env,
  ctx: ExecutionContext | undefined,
  tenantId: string,
  event: WebhookEventName,
  data: Record<string, unknown>
): Promise<void> {
  try {
    // Validate against the frozen contract. A payload that fails here is a
    // programming error: log loudly, do not silently ship a malformed event.
    const schema = eventPayloadSchemas[event];
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      console.error("outbox: payload failed schema", event, parsed.error.issues);
      return;
    }

    const id = generateId();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO webhook_outbox
       (id, tenant_id, event, schema_version, payload_json, status, attempts,
        next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
    )
      .bind(id, tenantId, event, EVENT_SCHEMA_VERSION,
            JSON.stringify(parsed.data), now, now, now)
      .run();

    // Fast path. Never awaited by the request.
    const send = env.WEBHOOK_QUEUE.send({ outboxId: id }).catch((e) => {
      console.warn("outbox: queue send failed, sweeper will retry", id, e);
    });
    if (ctx) ctx.waitUntil(send);
    else await send;
  } catch (e) {
    console.warn("enqueueEvent", e);
  }
}

async function signBody(
  secret: string,
  timestamp: string,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  // Timestamp is inside the signed material so a captured body cannot be
  // replayed later with a fresh header (Codex P0-4).
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`)
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function wantsEvent(eventsJson: string, event: string): boolean {
  try {
    const arr = JSON.parse(eventsJson || "[]");
    if (!Array.isArray(arr) || !arr.length) return true;
    return arr.includes("*") || arr.includes(event);
  } catch {
    return true;
  }
}

/** Deliver one outbox row to every subscribed endpoint. Idempotent by row id. */
export async function dispatchOutboxRow(env: Env, outboxId: string): Promise<void> {
  const row = await first<{
    id: string; tenant_id: string; event: string; schema_version: number;
    payload_json: string; status: string; attempts: number; created_at: string;
  }>(env.DB.prepare(`SELECT * FROM webhook_outbox WHERE id = ?`).bind(outboxId));
  if (!row || row.status === "delivered" || row.status === "dead") return;

  const endpoints = await all<{
    id: string; url: string; secret: string | null; events_json: string;
  }>(
    env.DB.prepare(
      `SELECT id, url, secret, events_json FROM webhook_endpoints
       WHERE tenant_id = ? AND is_active = 1`
    ).bind(row.tenant_id)
  );

  const targets = endpoints.filter((ep) => wantsEvent(ep.events_json, row.event));
  const now = new Date().toISOString();

  if (!targets.length) {
    await env.DB.prepare(
      `UPDATE webhook_outbox SET status = 'delivered', updated_at = ? WHERE id = ?`
    ).bind(now, outboxId).run();
    return;
  }

  const envelope = {
    id: row.id,
    schema_version: row.schema_version,
    event: row.event,
    created_at: row.created_at,
    tenant_id: row.tenant_id,
    data: JSON.parse(row.payload_json),
  };
  const body = JSON.stringify(envelope);

  let anyFailed = false;
  for (const ep of targets) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "QuiltHosting-Webhooks/2.0",
      "X-QH-Event": row.event,
      "X-QH-Delivery": `${row.id}:${ep.id}`,
      "X-QH-Timestamp": timestamp,
      "X-QH-Schema-Version": String(row.schema_version),
    };
    if (ep.secret) headers["X-QH-Signature"] = await signBody(ep.secret, timestamp, body);

    let statusCode: number | null = null;
    let error: string | null = null;
    let ok = false;
    try {
      const res = await fetch(ep.url, { method: "POST", headers, body });
      statusCode = res.status;
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (e: any) {
      error = e?.message || "fetch failed";
    }
    if (!ok) anyFailed = true;

    await env.DB.prepare(
      `INSERT INTO webhook_deliveries
       (id, tenant_id, endpoint_id, event, payload_json, status_code, success, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(generateId(), row.tenant_id, ep.id, row.event, body.slice(0, 8000),
            statusCode, ok ? 1 : 0, error, now)
      .run();

    if (ok) {
      await env.DB.prepare(
        `UPDATE webhook_endpoints SET fail_count = 0, last_status = ?, last_error = null,
         last_success_at = ?, updated_at = ? WHERE id = ?`
      ).bind(statusCode, now, now, ep.id).run();
    } else {
      await env.DB.prepare(
        `UPDATE webhook_endpoints SET fail_count = coalesce(fail_count,0) + 1,
         last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`
      ).bind(statusCode, error, now, ep.id).run();
      // Auto-disable a poison endpoint so one dead Zap does not burn the
      // tenant's delivery budget forever (Codex P0-1 item 5).
      await env.DB.prepare(
        `UPDATE webhook_endpoints SET is_active = 0, disabled_reason = 'consecutive failures'
         WHERE id = ? AND fail_count >= 20`
      ).bind(ep.id).run();
    }
  }

  const attempts = row.attempts + 1;
  if (!anyFailed) {
    await env.DB.prepare(
      `UPDATE webhook_outbox SET status = 'delivered', attempts = ?, updated_at = ? WHERE id = ?`
    ).bind(attempts, now, outboxId).run();
  } else if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE webhook_outbox SET status = 'dead', attempts = ?, updated_at = ? WHERE id = ?`
    ).bind(attempts, now, outboxId).run();
  } else {
    const nextAt = new Date(Date.now() + backoffFor(attempts) * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE webhook_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?,
       updated_at = ? WHERE id = ?`
    ).bind(attempts, nextAt, now, outboxId).run();
    throw new Error(`delivery failed, attempt ${attempts}`); // signals queue retry
  }
}

/** Cron safety net for rows the queue never acknowledged. */
export async function sweepOutbox(env: Env, limit = 100): Promise<{ swept: number }> {
  const now = new Date().toISOString();
  const rows = await all<{ id: string }>(
    env.DB.prepare(
      `SELECT id FROM webhook_outbox
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT ?`
    ).bind(now, limit)
  );
  for (const r of rows) {
    try {
      await dispatchOutboxRow(env, r.id);
    } catch { /* backoff already recorded */ }
  }
  return { swept: rows.length };
}
```

- [ ] **Step 3: Queue consumer**

Create `src/consumers/webhookConsumer.ts`:

```ts
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
```

- [ ] **Step 4: Wire bindings**

In `wrangler.toml`, add:

```toml
[[queues.producers]]
binding = "WEBHOOK_QUEUE"
queue = "quilthosting-webhooks"

[[queues.consumers]]
queue = "quilthosting-webhooks"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 5
dead_letter_queue = "quilthosting-webhooks-dlq"
```

Change the cron to add a one-minute sweep:

```toml
[triggers]
crons = ["0 8 * * *", "* * * * *"]
```

Create the queues (human-approved step — this provisions real infrastructure):

```bash
npx wrangler queues create quilthosting-webhooks
npx wrangler queues create quilthosting-webhooks-dlq
```

Add `WEBHOOK_QUEUE: Queue<{ outboxId: string }>` to the `Env` interface in `src/types.ts`, then run `npm run cf-typegen`.

- [ ] **Step 5: Wire the Worker entry points**

In `src/index.ts`, export the queue handler and branch the cron by schedule so the one-minute sweep does not run the daily job:

```ts
import { handleWebhookQueue } from "./consumers/webhookConsumer";
import { sweepOutbox } from "./lib/webhookOutbox";

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ outboxId: string }>, env: Env) {
    await handleWebhookQueue(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "* * * * *") {
      ctx.waitUntil(sweepOutbox(env).then((r) => {
        if (r.swept) console.log("outbox sweep", r);
      }));
      return;
    }
    ctx.waitUntil(
      runDailyJobs(env).then((r) => { console.log("Cron daily jobs", r); })
    );
  },
};
```

Note the signature change: `_event` becomes `event` because the cron expression now selects the branch.

- [ ] **Step 6: Make the old emitter a shim**

Rewrite `emitTenantEvent` in `src/lib/outboundWebhooks.ts` to delegate, so the four existing call sites keep working unchanged during migration:

```ts
export async function emitTenantEvent(
  env: Env,
  tenantId: string,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  if (event === "*") return;
  const { enqueueEvent } = await import("./webhookOutbox");
  await enqueueEvent(env, undefined, tenantId, event, data);
}
```

Delete the old inline `fetch` loop entirely — it is now dead code and leaving it invites a future caller to reintroduce blocking delivery.

- [ ] **Step 7: Typecheck and smoke-test the outbox**

```bash
npx tsc --noEmit
npm run db:migrate:local
```

With `wrangler dev` running, submit a public form (the one currently-live emit path), then:

```bash
npx wrangler d1 execute quilthosting-db --local \
  --command "SELECT id, event, status, attempts FROM webhook_outbox ORDER BY created_at DESC LIMIT 5"
```
Expected: a `form.response` row reaching `status = 'delivered'`.

- [ ] **Step 8: Commit**

```bash
git add migrations/0013_webhook_outbox.sql src/lib/webhookOutbox.ts src/consumers src/lib/outboundWebhooks.ts src/index.ts src/types.ts wrangler.toml
git commit -m "feat(webhooks): durable outbox with queue dispatch, backoff, and DLQ"
git push
```

---

## Task 3: Verification harness (writes the failing tests)

Rewritten from Revision 1 to fix Grok P0-2 (site gate), P0-3 (`api_key`), P0-4 (truthful baseline), and P1-11 (`registration_open`).

**Files:**
- Create: `scripts/verify-integrations.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the harness**

Create `scripts/verify-integrations.mjs`:

```js
/**
 * Integration surface E2E — outbox delivery + v1 API.
 * Usage: node scripts/verify-integrations.mjs
 * Requires: wrangler dev on :8787, GOOGLE_AUTH_REQUIRED=false in .dev.vars,
 *           npm run db:migrate:local applied.
 *
 * LOCAL ONLY: the Worker must reach a host loopback sink. A deployed Worker
 * cannot. Empty sink => debug Worker->host networking before emitters.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BASE = process.env.QH_BASE || "http://127.0.0.1:8787";
const SINK_PORT = Number(process.env.QH_SINK_PORT || 8799);

function loadDevVars() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* optional */ }
  return out;
}

const received = [];
let sink;

function startSink() {
  return new Promise((r) => {
    sink = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try { received.push(JSON.parse(body)); }
        catch { received.push({ event: "<unparseable>", raw: body }); }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    sink.listen(SINK_PORT, "127.0.0.1", r);
  });
}

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

/** Outbox dispatch is async; poll rather than race it. */
async function waitForEvent(name, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.some((p) => p.event === name)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  loadDevVars(); // presence check; the JWT below is what actually opens the gate
  await startSink();
  console.log(`sink on :${SINK_PORT}`);

  const stamp = randomUUID().slice(0, 8);

  const reg = await json("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: `harness-${stamp}@example.test`,
      password: "harness-password-1",
      name: "Harness Admin",
    }),
  });
  if (reg.status >= 400) {
    throw new Error(
      `register failed (${reg.status}). Set GOOGLE_AUTH_REQUIRED=false in .dev.vars. ` +
      JSON.stringify(reg.body)
    );
  }
  const jwt = reg.body.token;
  const auth = { Authorization: `Bearer ${jwt}` };

  // siteGate accepts ANY valid Bearer JWT, so the same header opens /public/*.
  // Without this every public drive returns the private-preview HTML. (Grok P0-2)
  const pub = { Authorization: `Bearer ${jwt}` };

  const tenant = await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `Harness Guild ${stamp}`, slug: `harness-${stamp}` }),
  });
  if (tenant.status >= 400) throw new Error(`tenant: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.id;
  const slug = tenant.body.slug;

  const hook = await json(`/api/tenants/${tenantId}/webhooks`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ url: `http://127.0.0.1:${SINK_PORT}/hook`, events: ["*"] }),
  });
  if (hook.status >= 400) throw new Error(`hook: ${JSON.stringify(hook.body)}`);

  const catalog = await json(`/api/tenants/${tenantId}/webhooks/events`, { headers: auth });
  const advertised = (catalog.body.events || []).filter((e) => e !== "*");

  // ---- drive the real routes ----
  await json(`/api/tenants/${tenantId}/members`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ email: `m-${stamp}@example.test`, first_name: "Ada" }),
  });

  const members = await json(`/api/tenants/${tenantId}/members`, { headers: auth });
  const memberId = members.body.members[0].id;
  await json(`/api/tenants/${tenantId}/members/${memberId}`, {
    method: "PATCH", headers: auth, body: JSON.stringify({ first_name: "Augusta" }),
  });

  const level = await json(`/api/tenants/${tenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "Free Level", price_cents: 0, duration_months: 12, renewal_type: "manual",
    }),
  });
  // Free join -> member.created + member.activated + membership.activated
  await json(`/public/${slug}/join`, {
    method: "POST", headers: pub,
    body: JSON.stringify({
      email: `join-${stamp}@example.test`, first_name: "Grace", last_name: "Hopper",
      level_id: level.body.id,
    }),
  });

  // registration_open is NOT read by events POST (schema default is 1) — do not
  // send it, or an implementer will waste an hour debugging a no-op. (Grok P1-11)
  const ev = await json(`/api/tenants/${tenantId}/events`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      title: "Harness Event", start_at: "2027-01-01T18:00:00.000Z",
      member_price_cents: 0, non_member_price_cents: 0,
    }),
  });
  await json(`/public/${slug}/events/${ev.body.id}/register`, {
    method: "POST", headers: pub,
    body: JSON.stringify({ email: `ev-${stamp}@example.test`, name: "Katherine Johnson" }),
  });

  // form.response — create a form and submit it, so it is genuinely covered
  const form = await json(`/api/tenants/${tenantId}/forms`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      title: "Harness Form",
      fields: [{ key: "why", label: "Why join?", type: "text", required: false }],
    }),
  });
  if (form.status < 400) {
    await json(`/public/${slug}/forms/${form.body.id}/submit`, {
      method: "POST", headers: pub,
      body: JSON.stringify({ email: `form-${stamp}@example.test`, answers: { why: "quilts" } }),
    });
  } else {
    console.log(`NOTE: form create returned ${form.status}; form.response will be reported UNDRIVEN`);
  }

  // ---- assert ----
  // payment.succeeded needs signed Stripe webhooks: covered by e2e-auto-renew.mjs.
  const undriven = new Set(["payment.succeeded"]);
  if (form.status >= 400) undriven.add("form.response");

  const results = [];
  for (const name of advertised) {
    if (undriven.has(name)) { results.push({ name, undriven: true }); continue; }
    results.push({ name, ok: await waitForEvent(name) });
  }

  console.log("\n--- webhook event delivery ---");
  let failed = 0;
  for (const r of results) {
    if (r.undriven) { console.log(`UNDRIVEN  ${r.name}  (see scripts/e2e-auto-renew.mjs)`); continue; }
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  }
  console.log(`\nreceived: ${received.map((p) => p.event).join(", ") || "(none)"}`);

  // Envelope contract
  const sample = received[0];
  if (sample) {
    for (const k of ["id", "schema_version", "event", "created_at", "tenant_id", "data"]) {
      if (!(k in sample)) throw new Error(`envelope missing "${k}"`);
    }
    console.log(`envelope OK (schema_version=${sample.schema_version})`);
  }

  sink.close();
  if (failed) {
    console.error(`\n${failed} advertised event(s) never fired.`);
    process.exit(1);
  }
  console.log("\nAll driven events delivered.");
}

main().catch((e) => { console.error(e); sink?.close(); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

Add to `package.json` `"scripts"`: `"test:integrations": "node scripts/verify-integrations.mjs"`

- [ ] **Step 3: Run it and confirm the TRUTHFUL baseline**

Run: `npm run test:integrations`

Expected **today** — note this differs from Revision 1, which wrongly predicted the activated events would pass (Grok P0-1/P0-4):

```
FAIL  member.created
FAIL  member.activated        <- free path has no emit
FAIL  member.updated
FAIL  membership.activated    <- free path has no emit
PASS  form.response
FAIL  event.registration
UNDRIVEN  payment.succeeded
```

Five failures. If `member.activated` or `membership.activated` unexpectedly PASSes, stop — it means an emit exists somewhere this plan did not account for; find it before proceeding.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-integrations.mjs package.json
git commit -m "test: harness asserting every advertised event fires, with truthful baseline"
git push
```

---

## Task 4: Emit `member.created`

**Files:** Modify `src/routes/members.ts:91-94`, `src/routes/public.ts:239-241`

- [ ] **Step 1: Admin create path**

In `src/routes/members.ts`, replace the tail of `memberRoutes.post("/")`:

```ts
  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id)
  );
  const { enqueueEvent } = await import("../lib/webhookOutbox");
  await enqueueEvent(c.env, c.executionCtx, tenant.id, "member.created", {
    member_id: id,
    email: body.email.toLowerCase(),
    first_name: body.first_name ?? null,
    last_name: body.last_name ?? null,
    status,
    source: "admin",
  });
  return c.json(member, 201);
});
```

`enqueueEvent` swallows its own errors, so no `try`/`catch` wrapper is needed — that was only required for the old inline-fetch emitter.

- [ ] **Step 2: Public join path**

In `src/routes/public.ts`, inside the `if (!member) { … }` block, after the member re-fetch:

```ts
    member = await first<Member>(
      c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
    );
    const { enqueueEvent } = await import("../lib/webhookOutbox");
    await enqueueEvent(c.env, c.executionCtx, tenant.id, "member.created", {
      member_id: memberId,
      email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      status: "pending",
      source: "join_form",
    });
  } else if (customJson !== "{}") {
```

- [ ] **Step 3: Deliberately do NOT emit on CSV import**

Do not add an emit at `src/routes/members.ts:604`. Add this comment above that loop's `INSERT INTO members`:

```ts
  // No per-row member.created here: a 500-row import would write 500 outbox
  // rows and 500 queue sends inside one invocation. A members.import.completed
  // summary event is planned (see wildapricot-master-program.md Phase 3).
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npm run test:integrations
```
Expected: `PASS member.created`. Four failures remain.

- [ ] **Step 5: Commit**

```bash
git add src/routes/members.ts src/routes/public.ts
git commit -m "fix(webhooks): emit member.created — advertised but never fired"
git push
```

---

## Task 5: Emit `member.activated` + `membership.activated` on the free path

**This task did not exist in Revision 1.** It is Grok P0-1 — without it the harness stays red no matter what else lands.

**Files:** Modify `src/routes/public.ts:266-292`

- [ ] **Step 1: Emit after free activation**

In `src/routes/public.ts`, inside `if (level.price_cents === 0) { … }`, after the `enrollMemberActivated` block and before the `return c.json({ status: "active", … })`:

```ts
    const { enqueueEvent } = await import("../lib/webhookOutbox");
    await enqueueEvent(c.env, c.executionCtx, tenant.id, "membership.activated", {
      member_id: member.id,
      email,
      level_id: level.id,
      level_name: level.name,
      membership_id: membershipId,
      source: "join_form",
    });
    await enqueueEvent(c.env, c.executionCtx, tenant.id, "member.activated", {
      member_id: member.id,
      email,
      level_id: level.id,
      source: "join_form",
    });
```

Order matters for consumer sanity: `membership.activated` carries the level metadata, `member.activated` is the coarser signal. This mirrors the Stripe path at `src/routes/webhooks.ts:275,281`, which emits them in the same order.

- [ ] **Step 2: Align the Stripe path with the schema**

The existing Stripe emits predate the catalog and lack `source` and `membership_id`, so they will now fail `eventPayloadSchemas` validation and be dropped with a console error. Update `src/routes/webhooks.ts:275-285` to add `source: "stripe"` to both payloads, `membership_id: null` to `membership.activated`, and `level_id: level.id` to `member.activated`.

**This is a real regression risk**: if skipped, Task 2's schema validation silently kills the *currently working* paid-path events. Verify with `node scripts/e2e-auto-renew.mjs` in Step 4.

- [ ] **Step 3: Decide the admin/API create-with-active case**

Grok P1-9 and Codex both flag it: creating a member with `status: "active"` via admin or API fires only `member.created`, not `member.activated`, even though the catalog says "a member becomes active."

**Decision for this plan: do not emit `member.activated` there.** Admin-set status is a data correction, not a membership lifecycle event, and `member.updated` already carries `previous_status` → `status` so a Zap can detect it. Record that reasoning in `docs/zapier-webhooks.md` (Task 12) so the catalog description is honest — the description in Task 1 already says "on the free or paid path", which is the precise scope.

- [ ] **Step 4: Verify both paths**

```bash
npx tsc --noEmit
npm run test:integrations          # member.activated + membership.activated now PASS
node scripts/e2e-auto-renew.mjs    # paid path did NOT regress from Step 2
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/public.ts src/routes/webhooks.ts
git commit -m "fix(webhooks): emit activation events on the free join path"
git push
```

---

## Task 6: Emit `event.registration`

Revision 1 asked the implementer to paste a null-filled block and "move it later." Both reviewers rejected that. The final block is shown here.

**Files:** Modify `src/routes/public.ts:461-477`, `src/routes/webhooks.ts:170-225`

- [ ] **Step 1: Free / waitlist path**

In `src/routes/public.ts`, immediately after the registration `INSERT … .run()` and before the `if (status === "registered")` email block:

```ts
    const { enqueueEvent } = await import("../lib/webhookOutbox");
    await enqueueEvent(c.env, c.executionCtx, tenant.id, "event.registration", {
      registration_id: regId,
      event_id: eventId,
      event_title: event.title,
      email,
      name: body.name ?? null,
      status,
      amount_paid_cents: 0,
      ticket_code: ticketCode,
      source: "public",
    });
```

- [ ] **Step 2: Paid path — final placement, complete payload**

In `src/routes/webhooks.ts`, the paid branch already fetches `reg` and `eventRow` to build the confirmation email. Place the emit **after** the `if (eventRow && tenant) { … }` block closes, still inside `if (reg) { … }`, so every field is populated:

```ts
      if (reg) {
        const eventRow = await first<{ title: string; start_at: string; location: string | null }>(
          c.env.DB.prepare(
            "SELECT title, start_at, location FROM events WHERE id = ? AND tenant_id = ?"
          ).bind(reg.event_id, tenantId)
        );
        const tenant = await first<{ name: string }>(
          c.env.DB.prepare("SELECT name FROM tenants WHERE id = ?").bind(tenantId)
        );
        if (eventRow && tenant) {
          /* …existing confirmation-email block, unchanged… */
        }

        // Seat is only real once Stripe confirms — emit here, never at
        // pending_payment. At-least-once delivery means a Stripe retry can
        // re-emit; consumers dedupe on the envelope id.
        const { enqueueEvent } = await import("../lib/webhookOutbox");
        await enqueueEvent(c.env, c.executionCtx, tenantId, "event.registration", {
          registration_id: relatedId,
          event_id: reg.event_id,
          event_title: eventRow?.title ?? "",
          email: reg.email,
          name: reg.name ?? null,
          status: "registered",
          amount_paid_cents: session.amount_total || 0,
          ticket_code: reg.ticket_code ?? null,
          source: "stripe",
        });
      }
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run test:integrations        # event.registration PASSes
node scripts/e2e-auto-renew.mjs  # paid path intact
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/public.ts src/routes/webhooks.ts
git commit -m "fix(webhooks): emit event.registration on free, waitlist, and paid paths"
git push
```

---

## Task 7: Emit `member.updated`

**Files:** Modify `src/routes/members.ts:390-393`

- [ ] **Step 1: Emit on PATCH**

```ts
  const updated = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
  );
  const { enqueueEvent } = await import("../lib/webhookOutbox");
  await enqueueEvent(c.env, c.executionCtx, tenant.id, "member.updated", {
    member_id: memberId,
    email: updated?.email ?? existing.email,
    status: updated?.status ?? existing.status,
    previous_status: existing.status,
    // Column names the caller actually changed, so a Zap can filter without diffing
    changed: fields.map((f) => f.split(" = ")[0]).filter((f) => f !== "updated_at"),
    source: "admin",
  });
  return c.json(updated);
});
```

`fields` (built at line 362) and `existing` (fetched at line 326) are both in scope.

- [ ] **Step 2: Verify — harness fully green**

```bash
npx tsc --noEmit
npm run test:integrations
```
Expected: exit 0. `PASS` on all six driven events, `UNDRIVEN payment.succeeded`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/members.ts
git commit -m "fix(webhooks): emit member.updated with changed-field list"
git push
```

---

## Task 8: Scope vocabulary and idempotent v1 writes

Adds Codex P0-3 (idempotency) and Codex's strengthened scope requirement: a trigger-only Zap must not be able to mutate members, so `hooks:write` is separate from `members:write`.

**Files:** Modify `src/routes/v1.ts`, `src/routes/apiKeys.ts`, `src/routes/members.ts` (export `MEMBER_STATUSES`), `public/admin.html:3824`, `scripts/verify-integrations.mjs`

**Interfaces:**
- Produces: `requireScope(c, auth, scope)`, `withIdempotency(c, auth, handler)`, `POST /api/v1/members`, `PATCH /api/v1/members/:memberId`.

- [ ] **Step 1: Widen the scope vocabulary**

In `src/routes/apiKeys.ts:31`, replace the filter with:

```ts
export const API_SCOPES = ["read", "members:write", "hooks:write"] as const;
// "write" is retained as a deprecated alias that grants both, so any key
// minted before v0.27.0 keeps working.
const scopes = Array.isArray(body.scopes)
  ? body.scopes.filter((s) => [...API_SCOPES, "write"].includes(s))
  : ["read"];
```

- [ ] **Step 2: Scope guard and idempotency helper**

Append to `src/routes/v1.ts`:

```ts
import { createHash } from "node:crypto"; // nodejs_compat is enabled in wrangler.toml

/** 403 unless the key carries the scope. Legacy "write" grants everything. */
function requireScope(c: any, auth: { scopes: string[] }, scope: string): Response | null {
  if (auth.scopes.includes(scope) || auth.scopes.includes("write")) return null;
  return c.json(
    { error: `This API key lacks the "${scope}" scope.`, code: "insufficient_scope",
      required: scope },
    403
  );
}

async function hashRequest(body: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(body ?? null));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Idempotency-Key handling (Codex P0-3). Zapier retries; without this a retried
 * create returns 409 and the Zap reports failure for a member that exists.
 * Replays the original response for a matching retry; 422 for key reuse with a
 * different body.
 */
async function withIdempotency(
  c: any,
  tenantId: string,
  body: unknown,
  handler: () => Promise<{ status: number; json: unknown }>
): Promise<Response> {
  const key = c.req.header("Idempotency-Key");
  if (!key) {
    const r = await handler();
    return c.json(r.json, r.status);
  }
  const hash = await hashRequest(body);
  const prior = await first<{ request_hash: string; response_status: number; response_json: string }>(
    c.env.DB.prepare(
      `SELECT request_hash, response_status, response_json FROM api_idempotency
       WHERE tenant_id = ? AND idempotency_key = ?`
    ).bind(tenantId, key)
  );
  if (prior) {
    if (prior.request_hash !== hash) {
      return c.json(
        { error: "Idempotency-Key reused with a different request body",
          code: "idempotency_key_reuse" },
        422
      );
    }
    return c.json(JSON.parse(prior.response_json), prior.response_status);
  }
  const r = await handler();
  if (r.status < 500) {
    const { generateId } = await import("../lib/utils/id");
    try {
      await c.env.DB.prepare(
        `INSERT INTO api_idempotency
         (id, tenant_id, idempotency_key, request_hash, response_status, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(generateId(), tenantId, key, hash, r.status,
             JSON.stringify(r.json), new Date().toISOString()).run();
    } catch { /* unique-index race: another attempt already stored it */ }
  }
  return c.json(r.json, r.status);
}
```

- [ ] **Step 3: The write endpoints**

Export `MEMBER_STATUSES` from `src/routes/members.ts` (Grok P1-8 — do not copy the array), then append to `src/routes/v1.ts`:

```ts
v1Routes.post("/members", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "members:write");
  if (denied) return denied;

  const body = await c.req.json<{
    email?: string; first_name?: string | null; last_name?: string | null;
    phone?: string | null; status?: string;
  }>();

  return withIdempotency(c, auth.tenant.id, body, async () => {
    if (!body.email) return { status: 400, json: { error: "email is required", code: "missing_field" } };
    const email = body.email.toLowerCase().trim();

    const { MEMBER_STATUSES } = await import("./members");
    const status = body.status ?? "pending";
    if (!MEMBER_STATUSES.includes(status)) {
      return { status: 400, json: { error: "Invalid status", code: "invalid_status" } };
    }

    const existing = await first<{ id: string }>(
      c.env.DB.prepare("SELECT id FROM members WHERE tenant_id = ? AND email = ?")
        .bind(auth.tenant.id, email)
    );
    if (existing) {
      return { status: 409, json: { error: "Member with this email already exists",
                                    code: "duplicate_email", member_id: existing.id } };
    }

    if (status === "active") {
      const { assertCanActivateMember } = await import("../lib/plans");
      try {
        await assertCanActivateMember(c.env.DB, auth.tenant, null);
      } catch (e: any) {
        return { status: e.status || 402,
                 json: { error: e.message, code: e.code || "plan_limit" } };
      }
    }

    const { generateId } = await import("../lib/utils/id");
    const id = generateId();
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO members
       (id, tenant_id, email, first_name, last_name, phone, status, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, auth.tenant.id, email, body.first_name ?? null, body.last_name ?? null,
           body.phone ?? null, status, now, now, now).run();

    const { enqueueEvent } = await import("../lib/webhookOutbox");
    await enqueueEvent(c.env, c.executionCtx, auth.tenant.id, "member.created", {
      member_id: id, email, first_name: body.first_name ?? null,
      last_name: body.last_name ?? null, status, source: "api",
    });

    const member = await first(
      c.env.DB.prepare(
        `SELECT id, email, first_name, last_name, phone, status, joined_at, created_at
         FROM members WHERE id = ?`
      ).bind(id)
    );
    return { status: 201, json: { member } };
  });
});
```

Add `PATCH /members/:memberId` following the same shape: `requireScope(…, "members:write")`, `withIdempotency`, 404 if not found, plan-limit check when activating, field assembly over `["first_name","last_name","phone","status"]`, then `enqueueEvent(… "member.updated" …, source: "api")`.

**`email` is deliberately immutable on v1 PATCH** (Grok P1-8) — admin PATCH allows it, but changing the identity key from an integration is a footgun and there is no merge story. Document it in Task 12.

- [ ] **Step 4: Admin UI scope checkboxes**

Replace the hardcoded `"read"` at `public/admin.html:3824` with three checkboxes: `read` (always on, disabled), `members:write`, `hooks:write`. Label `hooks:write` **"Allow Zapier/Make to subscribe to events (required even for trigger-only Zaps)"** — Grok P2-16 correctly notes a trigger-only user must still be told why they need it.

- [ ] **Step 5: Extend the harness**

```js
  const readKey = await json(`/api/tenants/${tenantId}/api-keys`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "harness-read", scopes: ["read"] }),
  });
  const writeKey = await json(`/api/tenants/${tenantId}/api-keys`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "harness-write", scopes: ["read", "members:write", "hooks:write"] }),
  });
  // POST /api-keys returns `api_key`, NOT `key`. (Grok P0-3)
  const readAuth  = { Authorization: `Bearer ${readKey.body.api_key}` };
  const writeAuth = { Authorization: `Bearer ${writeKey.body.api_key}` };

  const denied = await json("/api/v1/members", {
    method: "POST", headers: readAuth,
    body: JSON.stringify({ email: `scope-${stamp}@example.test` }),
  });
  if (denied.status !== 403) throw new Error(`members:write not enforced (${denied.status})`);

  const idemKey = `harness-${stamp}`;
  const createBody = JSON.stringify({ email: `api-${stamp}@example.test`, first_name: "Api" });
  const first1 = await json("/api/v1/members", {
    method: "POST", headers: { ...writeAuth, "Idempotency-Key": idemKey }, body: createBody,
  });
  if (first1.status !== 201) throw new Error(`v1 create failed: ${JSON.stringify(first1.body)}`);
  const retry = await json("/api/v1/members", {
    method: "POST", headers: { ...writeAuth, "Idempotency-Key": idemKey }, body: createBody,
  });
  if (retry.status !== 201) throw new Error(`idempotent retry returned ${retry.status}, expected 201`);
  if (retry.body.member.id !== first1.body.member.id) throw new Error("idempotent retry created a second member");
  const reuse = await json("/api/v1/members", {
    method: "POST", headers: { ...writeAuth, "Idempotency-Key": idemKey },
    body: JSON.stringify({ email: `different-${stamp}@example.test` }),
  });
  if (reuse.status !== 422) throw new Error(`key reuse should 422, got ${reuse.status}`);
  console.log("v1 writes: scope enforced, idempotent retry replayed, key reuse rejected");
```

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit && npm run test:integrations
git add src/routes/v1.ts src/routes/apiKeys.ts src/routes/members.ts public/admin.html scripts/verify-integrations.mjs
git commit -m "feat(api): idempotent v1 member writes under granular scopes"
git push
```

---

## Task 9: REST hooks with signing, SSRF blocking, and limits

Fixes Grok P1-6 (the SSRF comment that promised what the code did not do) and P1-7 (`secret: null`), and adds Codex P0-4's limits.

**Files:** Modify `src/routes/v1.ts`, `scripts/verify-integrations.mjs`

- [ ] **Step 1: URL safety helper**

Add to `src/lib/webhookOutbox.ts`:

```ts
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./,      // link-local + AWS metadata
  /^\[?::1\]?$/, /^\[?f[cd]/i,                       // IPv6 loopback + ULA
  /(^|\.)quilthosting\.com$/i,                       // no self-loop
  /(^|\.)workers\.dev$/i,
];

/** Returns an error string, or null when the URL is an acceptable hook target. */
export function validateHookUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "url is not a valid URL"; }
  if (u.protocol !== "https:") return "url must be https";
  const host = u.hostname;
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    return `url host "${host}" is not an allowed webhook target`;
  }
  return null;
}
```

This is a hostname deny list, not full SSRF protection — a DNS name resolving to a private address still passes. Say exactly that in the docs (Task 12) rather than overclaiming, which is what Grok objected to.

- [ ] **Step 2: The hook routes**

Append to `src/routes/v1.ts`:

```ts
import { WEBHOOK_SUBSCRIBE_OPTIONS } from "../lib/webhookEvents";
import { validateHookUrl } from "../lib/webhookOutbox";

const MAX_HOOKS_PER_TENANT = 25;

v1Routes.get("/hooks", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, url, events_json, is_active, disabled_reason, created_at
       FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`
    ).bind(auth.tenant.id)
  );
  // Secrets are never returned after creation.
  return c.json({
    hooks: rows.map((r: any) => ({
      id: r.id, url: r.url, events: JSON.parse(r.events_json || '["*"]'),
      is_active: !!r.is_active, disabled_reason: r.disabled_reason,
      created_at: r.created_at,
    })),
  });
});

v1Routes.post("/hooks", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "hooks:write");
  if (denied) return denied;

  const body = await c.req.json<{ url?: string; events?: string[] }>();
  if (!body.url) return c.json({ error: "url is required", code: "missing_field" }, 400);

  const urlError = validateHookUrl(body.url);
  if (urlError) return c.json({ error: urlError, code: "invalid_hook_url" }, 400);

  // Reject unknown names outright; never silently filter. (Codex P0-4)
  const requested = Array.isArray(body.events) && body.events.length ? body.events : ["*"];
  const unknown = requested.filter((e) => !WEBHOOK_SUBSCRIBE_OPTIONS.includes(e));
  if (unknown.length) {
    return c.json({ error: `Unknown event(s): ${unknown.join(", ")}`,
                    code: "unknown_event", valid: WEBHOOK_SUBSCRIBE_OPTIONS }, 400);
  }

  const countRow = await first<{ cnt: number }>(
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM webhook_endpoints WHERE tenant_id = ?`)
      .bind(auth.tenant.id)
  );
  if ((countRow?.cnt ?? 0) >= MAX_HOOKS_PER_TENANT) {
    return c.json({ error: `Limit of ${MAX_HOOKS_PER_TENANT} hooks reached`,
                    code: "hook_limit" }, 429);
  }

  const { generateId } = await import("../lib/utils/id");
  const id = generateId();
  const now = new Date().toISOString();
  // Parity with the admin route, which generates a secret at outboundWebhooks.ts:57.
  const secret = generateId().replace(/-/g, "");
  await c.env.DB.prepare(
    `INSERT INTO webhook_endpoints
     (id, tenant_id, url, secret, events_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, auth.tenant.id, body.url, secret, JSON.stringify(requested), now, now).run();

  // Shown once. Zapier ignores it; Make and custom consumers should verify.
  return c.json({ hook: { id, url: body.url, events: requested, secret } }, 201);
});

v1Routes.delete("/hooks/:hookId", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "hooks:write");
  if (denied) return denied;

  const hookId = c.req.param("hookId");
  const existing = await first<{ id: string }>(
    c.env.DB.prepare("SELECT id FROM webhook_endpoints WHERE id = ? AND tenant_id = ?")
      .bind(hookId, auth.tenant.id)
  );
  if (!existing) return c.json({ error: "Hook not found", code: "not_found" }, 404);

  await c.env.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?")
    .bind(hookId, auth.tenant.id).run();
  return c.json({ deleted: true });
});
```

**Harness note:** the https-only rule means the harness cannot subscribe its loopback sink through `/api/v1/hooks`. It subscribes through the admin JWT route instead (which still allows `http://`), and tests the v1 route's *rejections* separately. Keep the v1 rule strict.

- [ ] **Step 3: Extend the harness**

```js
  const sub = await json("/api/v1/hooks", {
    method: "POST", headers: writeAuth,
    body: JSON.stringify({ url: "https://hooks.zapier.com/harness/test", events: ["member.created"] }),
  });
  if (sub.status !== 201) throw new Error(`hook subscribe failed: ${JSON.stringify(sub.body)}`);
  if (!sub.body.hook.secret) throw new Error("hook created without a signing secret");

  for (const [url, label] of [
    ["http://insecure.example.com/hook", "http"],
    ["https://127.0.0.1/hook", "loopback"],
    ["https://quilthosting.com/hook", "self-loop"],
  ]) {
    const r = await json("/api/v1/hooks", {
      method: "POST", headers: writeAuth, body: JSON.stringify({ url }),
    });
    if (r.status !== 400) throw new Error(`${label} hook should be rejected, got ${r.status}`);
  }

  const bad = await json("/api/v1/hooks", {
    method: "POST", headers: writeAuth,
    body: JSON.stringify({ url: "https://hooks.zapier.com/x", events: ["member.creatd"] }),
  });
  if (bad.status !== 400) throw new Error("typo'd event name must be rejected, not filtered");

  const listed = await json("/api/v1/hooks", { headers: writeAuth });
  if (listed.body.hooks.some((h) => "secret" in h)) throw new Error("GET must not return secrets");

  const unsub = await json(`/api/v1/hooks/${sub.body.hook.id}`, { method: "DELETE", headers: writeAuth });
  if (unsub.status !== 200) throw new Error("unsubscribe failed");
  console.log("hooks: subscribe/sign/reject-unsafe/reject-typo/no-secret-leak/unsubscribe OK");
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit && npm run test:integrations
git add src/routes/v1.ts src/lib/webhookOutbox.ts scripts/verify-integrations.mjs
git commit -m "feat(api): v1 REST hooks with signing secret, URL blocking, and limits"
git push
```

---

## Task 10: Delivery observability and replay

Codex P0-1 items 5-6: `fail_count` must become actionable, and a volunteer admin needs to see and re-drive failures.

**Files:** Modify `src/routes/outboundWebhooks.ts`, `public/admin.html`

- [ ] **Step 1: Outbox status and replay endpoints**

Add to `src/routes/outboundWebhooks.ts` (admin, JWT-scoped):

```ts
// GET /api/tenants/:tenantId/webhooks/outbox?status=
outboundWebhookRoutes.get("/outbox", async (c) => {
  const tenant = c.get("tenant");
  const status = c.req.query("status");
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, event, status, attempts, last_status, last_error, created_at, next_attempt_at
       FROM webhook_outbox
       WHERE tenant_id = ? AND (? = '' OR status = ?)
       ORDER BY created_at DESC LIMIT 100`
    ).bind(tenant.id, status || "", status || "")
  );
  return c.json({ outbox: rows });
});

// POST /api/tenants/:tenantId/webhooks/outbox/:outboxId/replay
outboundWebhookRoutes.post("/outbox/:outboxId/replay", async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("outboxId");
  const row = await first<{ id: string }>(
    c.env.DB.prepare("SELECT id FROM webhook_outbox WHERE id = ? AND tenant_id = ?")
      .bind(id, tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  await c.env.DB.prepare(
    `UPDATE webhook_outbox SET status = 'pending', attempts = 0, next_attempt_at = null,
     updated_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), id).run();
  c.executionCtx.waitUntil(c.env.WEBHOOK_QUEUE.send({ outboxId: id }));
  return c.json({ replayed: true });
});

// POST /api/tenants/:tenantId/webhooks/:endpointId/enable — clears auto-disable
outboundWebhookRoutes.post("/:endpointId/enable", async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("endpointId");
  await c.env.DB.prepare(
    `UPDATE webhook_endpoints SET is_active = 1, fail_count = 0, disabled_reason = null,
     updated_at = ? WHERE id = ? AND tenant_id = ?`
  ).bind(new Date().toISOString(), id, tenant.id).run();
  return c.json({ enabled: true });
});
```

- [ ] **Step 2: Admin UI**

In the Zapier/webhooks admin panel add a "Recent deliveries" table (event, status, attempts, last error, time) with a **Replay** button per failed/dead row, and a visible banner on any endpoint where `disabled_reason` is set, with a **Re-enable** button. Use the page's existing `api()` helper and table styling.

Add a plain-language notice: *"Delivery is retried for about 12 hours. Failed events stay here for replay."*

- [ ] **Step 3: Verify and commit**

Drive a failure by subscribing a hook to a URL that 500s, then confirm the row reaches `status = 'pending'` with `attempts > 0`, and that Replay resets it.

```bash
npx tsc --noEmit
git add src/routes/outboundWebhooks.ts public/admin.html
git commit -m "feat(webhooks): outbox visibility, replay, and endpoint re-enable"
git push
```

---

## Task 11: Zapier Platform CLI app

Incorporates every Grok P2 correction: real connection label, configurable base URL, honest registration sample, pinned platform version, documented trigger gaps.

**Files:** Create `integrations/zapier/**`

- [ ] **Step 1: Scaffold with proper package fields**

```bash
mkdir -p integrations/zapier/triggers integrations/zapier/creates
cd integrations/zapier
npm init -y
npm install zapier-platform-core@17.0.0
```

Edit `integrations/zapier/package.json` to set `"main": "index.js"`, `"version": "1.0.0"`, and pin `zapier-platform-core` to an exact version — never float `latest` in a committed app (Grok P2-17). Ensure `node_modules/` under this directory is gitignored.

- [ ] **Step 2: Authentication with a real connection label**

Create `integrations/zapier/authentication.js`:

```js
// bundle.authData only ever holds what the user typed plus what `test` returns,
// so the tenant name must come back from the test call. (Grok P2-13)
module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey', label: 'API Key', required: true, type: 'password',
      helpText:
        'QuiltHosting → Admin → Settings → API Keys → New Key. Tick **hooks:write** ' +
        '(required even for trigger-only Zaps) and **members:write** if you want ' +
        'the Create Member action.',
    },
    {
      key: 'baseUrl', label: 'Site URL', required: false, type: 'string',
      default: 'https://quilthosting.com',
      helpText: 'Leave as-is unless you were given a different URL.',
    },
  ],
  test: async (z, bundle) => {
    const base = bundle.authData.baseUrl || 'https://quilthosting.com';
    const res = await z.request({ url: `${base}/api/v1/me` });
    if (res.status !== 200) throw new Error('That API key was not accepted.');
    return {
      tenantName: res.data.tenant.name,
      tenantId: res.data.tenant.id,
      scopes: res.data.scopes,
    };
  },
  connectionLabel: '{{tenantName}}',
};

module.exports.befores = [
  (request, z, bundle) => {
    if (bundle.authData.apiKey) {
      request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
    }
    return request;
  },
];
```

- [ ] **Step 3: Shared base-URL helper**

Create `integrations/zapier/baseUrl.js`:

```js
module.exports = (bundle) => bundle.authData.baseUrl || 'https://quilthosting.com';
```

Use it everywhere instead of hardcoding the host (Grok P2-14).

- [ ] **Step 4: New Member trigger**

Create `integrations/zapier/triggers/newMember.js`:

```js
const baseUrl = require('../baseUrl');

module.exports = {
  key: 'newMember',
  noun: 'Member',
  display: { label: 'New Member', description: 'Triggers when a member is created.' },
  operation: {
    type: 'hook',
    performSubscribe: (z, bundle) =>
      z.request({
        url: `${baseUrl(bundle)}/api/v1/hooks`, method: 'POST',
        body: { url: bundle.targetUrl, events: ['member.created'] },
      }).then((res) => res.data.hook),
    performUnsubscribe: (z, bundle) =>
      z.request({
        url: `${baseUrl(bundle)}/api/v1/hooks/${bundle.subscribeData.id}`, method: 'DELETE',
      }).then((res) => res.data),
    perform: (z, bundle) => [
      { id: bundle.cleanedRequest.data.member_id, ...bundle.cleanedRequest.data },
    ],
    performList: (z, bundle) =>
      z.request({ url: `${baseUrl(bundle)}/api/v1/members?limit=3` })
        .then((res) => res.data.members.map((m) => ({ ...m, member_id: m.id }))),
    sample: require('../../../scripts/fixtures/events/member.created.json').data,
  },
};
```

- [ ] **Step 5: Event Registration trigger — honest sample**

Create `integrations/zapier/triggers/eventRegistration.js` in the same shape, with `events: ['event.registration']`.

**`performList` must not list events as if they were registrations** (Grok P2-15). There is no `GET /api/v1/registrations` in this phase, so return the fixture:

```js
    // No registrations list endpoint yet (master program Phase 2). Returning the
    // fixture keeps Zapier's field discovery correct rather than showing event
    // fields where registration fields belong.
    performList: () => [require('../../../scripts/fixtures/events/event.registration.json').data],
```

- [ ] **Step 6: Create Member action**

Create `integrations/zapier/creates/createMember.js` with inputs `email` (required), `first_name`, `last_name`, `phone`, `status` (choices `pending`/`active`, default `pending`, helpText warning that `active` consumes a free-plan slot). `perform` POSTs to `${baseUrl(bundle)}/api/v1/members` and returns `res.data.member`.

Send an idempotency key so Zapier's retries do not duplicate members:

```js
      headers: { 'Idempotency-Key': `zap-${bundle.meta.id || z.hash('sha256', JSON.stringify(bundle.inputData))}` },
```

- [ ] **Step 7: Wire and document**

Create `index.js` exporting `version`, `platformVersion`, `authentication`, `beforeRequest`, `triggers`, `creates`.

Create `integrations/zapier/README.md` covering `zapier push`, private-invite distribution, and — required by Grok P2-18 — an explicit **"Not yet available as Zapier triggers"** list: `member.updated`, `member.activated`, `membership.activated`, `payment.succeeded`, `form.response`. They exist as webhooks but have no Zapier trigger in this phase.

- [ ] **Step 8: Validate**

```bash
cd integrations/zapier && npx zapier validate
```
Expected: no errors. `zapier validate` runs offline.

Then run a **real** subscribe → trigger → action → unsubscribe cycle against local `wrangler dev` (Codex required-edit 9) using `zapier invoke`, or with the harness acting as Zapier if a Zapier account is unavailable. Record the outcome in the README. Do not claim the app works on `zapier validate` alone.

- [ ] **Step 9: Commit**

```bash
cd ../.. && git add integrations/zapier .gitignore
git commit -m "feat(zapier): platform app with hook triggers, idempotent create action"
git push
```

---

## Task 12: Documentation, contract publication, and release

**Files:** Modify `docs/zapier-webhooks.md`, `docs/api.md`, `public/docs/api.html`, `package.json`, `src/version.ts`

- [ ] **Step 1: Correct and expand the webhook docs**

Replace the four-row event table in `docs/zapier-webhooks.md:31-35` with all seven, copied verbatim from `WEBHOOK_EVENT_DESCRIPTIONS`. Then add sections for:

- **Envelope format**, with a real fixture, documenting `id`, `schema_version`, `event`, `created_at`, `tenant_id`, `data`.
- **Signature verification** — `X-QH-Signature` is `HMAC-SHA256(secret, "{X-QH-Timestamp}.{body}")`. Include a constant-time verification example and state the accepted replay window.
- **Delivery semantics** — at-least-once; dedupe on envelope `id`; up to 6 attempts over ~12 hours; endpoints auto-disable after 20 consecutive failures; failed events are replayable from Admin.
- **Compatibility policy**, copied from the `webhookEvents.ts` comment block.
- **Known limits** — hostname deny list is not full SSRF protection; CSV import fires no per-row event; admin status edits fire `member.updated`, not `member.activated`; v1 PATCH cannot change `email`.

- [ ] **Step 2: Document the v1 API**

Add to `docs/api.md` and mirror into `public/docs/api.html`: `POST|PATCH /api/v1/members`, `GET|POST /api/v1/hooks`, `DELETE /api/v1/hooks/:hookId`. For each give the request body, a `curl` example, the scope required, and every error code (`insufficient_scope`, `idempotency_key_reuse`, `unknown_event`, `invalid_hook_url`, `hook_limit`, `plan_limit`, `duplicate_email`, `invalid_status`). Document `Idempotency-Key` semantics explicitly.

- [ ] **Step 3: Version bump — no `sed`**

Edit `package.json` and `src/version.ts` with the editor (Grok P1-10 — `sed -i` is unreliable on this Windows setup). Set both to `0.27.0-preview`.

The `-preview` suffix is deliberate: per Codex, this release is an **integration developer preview**. Do not recruit production automation users on it.

- [ ] **Step 4: Full verification**

```bash
npx tsc --noEmit
npm run test:integrations
node scripts/e2e-auto-renew.mjs
cd integrations/zapier && npx zapier validate && cd ../..
```
All four must pass.

- [ ] **Step 5: Request human approval to deploy — do not self-deploy**

Deployment touches live secrets, the stealth gate, and now provisions queues. **Stop here and ask.** When approved:

```bash
npx wrangler queues create quilthosting-webhooks
npx wrangler queues create quilthosting-webhooks-dlq
npm run db:migrate:remote
npm run deploy
curl -s https://quilthosting.com/api/version
```
Expected: `{"version":"0.27.0-preview"}`.

- [ ] **Step 6: Commit**

```bash
git add docs/ public/docs/ package.json src/version.ts
git commit -m "docs: event contract, delivery semantics, v1 API; v0.27.0-preview"
git push
```

---

## Out of scope — tracked in the master program

Deferred with reasons. All are carried in `2026-08-09-wildapricot-master-program.md`:

1. **Zapier public directory submission** — needs a Zapier account, review, and 10 live users. Blocked while the site is gated.
2. **Un-gating the site** — a standing product decision, not a code change.
3. **Broader Zapier/Make coverage** — only 2 of 7 events have triggers; no Make app.
4. **OpenAPI 3.1 contract, cursor pagination, API changelog** — Codex P1.
5. **WildApricot migration product** — Codex P1; the single biggest switching lever.
6. **Support operations** — SLAs, status page, in-app context.
7. **`members.import.completed` summary event** — the honest answer to "CSV import fires nothing."
8. **Store multi-SKU `order.paid`** — `webhooks.ts:304` updates `store_orders` and emits no dedicated event.
9. **Rate limiting per API key, PII redaction/retention in delivery logs** — Codex P0-4 items not covered here.

---

## Self-Review

**Review coverage.** Grok P0-1 → Task 5 (new). P0-2 → Task 3 Step 1 (JWT on `/public/*`). P0-3 → Task 8 Step 5 (`api_key`). P0-4 → Task 3 Step 3 (truthful baseline). P1-5 → Task 6 Step 2 (final block). P1-6 → Task 9 Step 1 (`validateHookUrl` + honest limitation). P1-7 → Task 9 Step 2 (secret generated, returned once). P1-8 → Task 8 Step 3 (`MEMBER_STATUSES` exported, email immutability documented). P1-9 → Task 5 Step 3 (explicit decision). P1-10 → Task 12 Step 3 and Global Constraints (no `sed`). P1-11 → Task 3 Step 1 (field dropped, comment added). P1-12 → Preconditions (local-only). P2-13→Task 11 Step 2. P2-14→Step 3. P2-15→Step 5. P2-16→Task 8 Step 4. P2-17→Task 11 Step 1. P2-18→Task 11 Step 7. P3 nits → catalog comment rewritten with `HARNESS_UNDRIVEN`; idempotent re-emit noted in Task 6 Step 2; deploy gated in Global Constraints.

Codex P0-1 → Task 2 + Task 10. P0-2 → Task 1 (schemas, `schema_version`, fixtures, compatibility policy). P0-3 → Task 8 (`withIdempotency`, error codes). P0-4 → Tasks 8/9 (scopes, limits, timestamp signing, deny list, no secret leak on GET) — *partially*: rate limiting and PII retention are deferred and listed. P0-5 → Tasks 3/9/11 test additions — *partially*: duplicate-delivery and DLQ-behavior tests are thin. Required-edits 1-11 all applied; 12 → master program.

**Type consistency.** `WebhookEventName`, `WEBHOOK_EVENTS`, `WEBHOOK_SUBSCRIBE_OPTIONS`, `EVENT_SCHEMA_VERSION`, `eventPayloadSchemas`, `HARNESS_UNDRIVEN` defined once in Task 1. `enqueueEvent`/`dispatchOutboxRow`/`sweepOutbox`/`validateHookUrl` defined in Task 2/9 and used with those exact signatures throughout. `requireScope(c, auth, scope)` and `withIdempotency(c, tenantId, body, handler)` defined in Task 8, reused in Task 9.

**Remaining soft spots a reviewer should press on:**
- **Task 5 Step 2 is the highest-risk step in the plan.** Adding schema validation in Task 2 will silently drop the *currently working* Stripe emits unless their payloads are updated to match. The verification is `node scripts/e2e-auto-renew.mjs`, which must be run.
- **Task 2 Step 5 changes the `scheduled` signature** and adds a one-minute cron. If the branch is wrong the daily renewal job runs every minute — check the `event.cron` comparison carefully.
- The harness asserts delivery but not retry/DLQ behavior. Codex P0-5 asked for timeout/429/500/malformed coverage; only the failure-to-`pending` path is exercised, in Task 10 Step 3. A reviewer wanting real reliability confidence should expand this.
- `scripts/fixtures/events/*.json` is imported by the Zapier app via a deep relative path (`../../../scripts/...`). If `integrations/zapier` is ever published standalone, that breaks — copy the fixtures at package time instead.
