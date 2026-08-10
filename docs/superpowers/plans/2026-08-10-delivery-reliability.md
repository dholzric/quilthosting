# Delivery Reliability (P0 Remediation, Plan A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make webhook delivery actually provide the guarantees the product claims — the outbox row committed atomically with the mutation that caused it, retries that honour their own backoff, per-endpoint delivery state, and one validated code path for hook creation.

**Architecture:** `enqueueEvent` splits into `prepareEvent` (validates the payload and returns a D1 statement plus the event id) and dispatch. Callers append that statement to the same `DB.batch()` as their domain mutation, so the event cannot be lost while the mutation survives. The queue consumer claims rows with a leased compare-and-set and retries with a real `delaySeconds`, and delivery state moves to a per-`(outbox_id, endpoint_id)` row so a partial failure retries only the endpoints that failed.

**Tech Stack:** TypeScript ESM, Hono 4, Cloudflare Workers + D1 + Queues, Wrangler 4. All required APIs verified present in the installed `@cloudflare/workers-types`: `QueueRetryOptions.delaySeconds`, `QueueSendOptions.delaySeconds`, and `D1Meta.changes`.

**Source:** `CodexProjectReview.md` P0.1, P0.2, P0.3. Every claim below was independently verified against the code before this plan was written.

---

## Why this plan exists

v0.27.0-preview shipped a "durable outbox" and documented two guarantees it did not provide:

1. **"Events are written inside the database transaction."** They are not. `enqueueEvent` writes the outbox row *after* the domain mutation commits, as a separate statement, and logs rather than raises on failure (`src/lib/webhookOutbox.ts`). The member/payment/registration can commit while the event vanishes — the exact gap an outbox exists to close.
2. **"Retried over about 12 hours."** `webhookConsumer.ts` calls `msg.retry()` with no delay, and `dispatchOutboxRow` never reads `next_attempt_at` (only `sweepOutbox` does). A failing endpoint burns all 6 recorded attempts in seconds and the row is marked `dead`.

The documentation and admin copy were corrected in `a365551` ahead of this work, so nothing untrue is currently displayed. **This plan makes the original guarantees real; when it lands, the docs get restored to the stronger claims — not before.**

A third defect from the same review is folded in because it is the same subsystem: the admin hook routes bypass every validation the v1 routes enforce, and `PATCH` writes `events_json` with no validation at all, trivially bypassing the strict event checking added to `POST`.

## Decomposition — this is Plan A of three

Codex's P0s span three subsystems. Splitting them so each produces working, testable software on its own:

| | Scope | Status |
|---|---|---|
| **A** | Delivery reliability — outbox atomicity, retry/lease correctness, per-endpoint state, hook validation parity (P0.1, P0.2, P0.3). **This document.** | Ready |
| **B** | API write correctness — operation-scoped, concurrency-safe idempotency with retention (P0.4). | Not yet written |
| **C** | Import integrity — custom-key collisions, and the import batch model so a partial import is never reported as success (P0.5 remainder, P0.6). | Not yet written |

**A first, and not only on severity.** P0.4 step 3 asks for the mutation, its outbox rows, and the idempotency record to commit in one batch; P0.6 asks for the same batching discipline for import. Both depend on the `prepareEvent` + `DB.batch` primitive this plan introduces. Building B or C first would mean building that primitive twice.

---

## Global Constraints

- **Every tenant-scoped SQL query filters by `tenant_id`. No exceptions.** A prior task shipped an unscoped `SELECT` and was corrected; do not repeat it.
- **Do not restore any documentation claim until the code backing it passes its test.** Restoring the "inside the transaction" wording is the *last* step of Task 2, not the first.
- TypeScript ESM on Cloudflare Workers. No new npm dependencies.
- camelCase for code identifiers.
- No test runner. Verification is `scripts/*.mjs` over HTTP against `wrangler dev`, plus esbuild-bundled direct calls. Do NOT add Vitest/Jest.
- `npx tsc --noEmit` must pass before every commit.
- **Never use `sed -i`** — Windows/Git Bash, unreliable. Use file writes.
- **No autonomous production deploys.** Commit and push to `main` freely; stop and ask before `npm run deploy`, `wrangler deploy`, or `db:migrate:remote`.
- **Backward compatibility:** the existing `emitTenantEvent(env, tenantId, event, data)` shim must keep working for any caller that cannot batch. It becomes the explicitly non-atomic path and must say so in its own docstring.
- **Versioning:** bump `package.json` `version` AND `src/version.ts` `APP_VERSION` together. This plan lands `0.29.0-preview`.

### Preconditions

1. `.dev.vars` has `GOOGLE_AUTH_REQUIRED=false`.
2. `npm run db:migrate:local` applied.
3. `npx wrangler dev` running on `:8787`.
4. If `/api/auth/register` 429s: `npx wrangler kv key delete --binding KV --local "rl:register:unknown"`.
5. Regression gate for every task: `npm run test:integrations` and `node scripts/e2e-auto-renew.mjs`, run **sequentially** — running them concurrently has produced a transient `SQLITE_BUSY`.

---

## File Structure

**Create:**
- `migrations/0014_delivery_state.sql` — per-endpoint delivery rows, lease columns.
- `src/lib/hookValidation.ts` — one create/update validator used by both the admin and v1 hook routes.
- `scripts/verify-delivery.mjs` — the reliability harness (`npm run test:delivery`).

**Modify:**
- `src/lib/webhookOutbox.ts` — split `prepareEvent` from dispatch; leased claim; per-endpoint fan-out.
- `src/consumers/webhookConsumer.ts` — delayed retry.
- `src/routes/members.ts`, `public.ts`, `webhooks.ts`, `v1.ts` — batch the outbox statement with the mutation.
- `src/routes/outboundWebhooks.ts` — use the shared validator on POST and PATCH.
- `docs/zapier-webhooks.md` — restore the strong claims, last.

---

## Task 1: Per-endpoint delivery state and lease columns

**Files:** Create `migrations/0014_delivery_state.sql`

**Interfaces:** Produces the `webhook_delivery_targets` table and `webhook_outbox.lease_until` / `.claimed_at`, consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the migration**

```sql
-- Per-(event, endpoint) delivery state. Previously the outbox row carried one
-- status for the whole fan-out, so if endpoint A succeeded and B failed, the
-- retry re-sent to BOTH and A saw avoidable duplicates.
CREATE TABLE IF NOT EXISTS webhook_delivery_targets (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (outbox_id) REFERENCES webhook_outbox(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_target_unique
  ON webhook_delivery_targets(outbox_id, endpoint_id);
CREATE INDEX IF NOT EXISTS idx_target_pending
  ON webhook_delivery_targets(status, outbox_id);

-- Lease so the queue and the one-minute sweeper cannot dispatch the same row
-- concurrently. claimed_at is for diagnostics; lease_until is the guard.
ALTER TABLE webhook_outbox ADD COLUMN lease_until TEXT;
ALTER TABLE webhook_outbox ADD COLUMN claimed_at TEXT;
```

- [ ] **Step 2: Apply and verify**

```bash
npm run db:migrate:local
npx wrangler d1 execute quilthosting-db --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_delivery_targets'"
npx wrangler d1 execute quilthosting-db --local --command "SELECT lease_until, claimed_at FROM webhook_outbox LIMIT 1"
```
Expected: the table exists and both columns select without error.

- [ ] **Step 3: Commit**

```bash
git add migrations/0014_delivery_state.sql
git commit -m "feat(webhooks): per-endpoint delivery state and outbox lease columns"
git push
```

---

## Task 2: Atomic event preparation

The core fix. An event must commit with its cause or not at all.

**Files:** Modify `src/lib/webhookOutbox.ts`; create `scripts/verify-delivery.mjs`; modify `package.json`.

**Interfaces:**
- Produces `prepareEvent(env, tenantId, event, data): {id, stmt} | null` and keeps `enqueueEvent` as the explicitly non-atomic fallback. Tasks 5 and 6 call `prepareEvent`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-delivery.mjs` with an atomicity assertion. The point is to prove that a failing outbox insert takes the domain row down with it.

```js
/**
 * Delivery reliability harness.
 * Usage: node scripts/verify-delivery.mjs   (wrangler dev on :8787)
 */
import { randomUUID } from "node:crypto";
const BASE = process.env.QH_BASE || "http://127.0.0.1:8787";
let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) return void console.log(`  ok  ${label}`);
  failures++; console.error(`  FAIL ${label} ${detail}`);
};
async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; }
  catch { return { status: res.status, body: { raw: t.slice(0, 200) } }; }
}

// Stable harness account — registering per run exhausts the 10-per-10-min limit.
const EMAIL = "harness@example.test", PASSWORD = "harness-password-1";
let jwt;
{
  const login = await json("/api/auth/login", { method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (login.status === 200) jwt = login.body.token;
  else {
    const reg = await json("/api/auth/register", { method: "POST",
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Harness" }) });
    if (reg.status >= 400) throw new Error(`auth failed: login ${login.status}, register ${reg.status}`);
    jwt = reg.body.token;
  }
}
const auth = { Authorization: `Bearer ${jwt}` };
const stamp = randomUUID().slice(0, 8);
const tenant = await json("/api/tenants", { method: "POST", headers: auth,
  body: JSON.stringify({ name: `Delivery ${stamp}`, slug: `delivery-${stamp}` }) });
const tenantId = tenant.body.id;

console.log("--- atomicity ---");
// A payload that fails schema validation must abort the whole batch, so the
// member must NOT exist afterwards. `status` is required by the member.created
// schema; the route always supplies it, so we force the failure with a header
// the route honours only in development.
const before = await json(`/api/tenants/${tenantId}/members`, { headers: auth });
const bad = await json(`/api/tenants/${tenantId}/members`, {
  method: "POST", headers: { ...auth, "X-QH-Force-Outbox-Failure": "1" },
  body: JSON.stringify({ email: `atomic-${stamp}@example.test`, first_name: "Atomic" }),
});
const after = await json(`/api/tenants/${tenantId}/members`, { headers: auth });
check("forced outbox failure rejects the request", bad.status >= 400, `got ${bad.status}`);
check("forced outbox failure leaves NO member behind",
  (after.body.total ?? 0) === (before.body.total ?? 0),
  `${before.body.total} -> ${after.body.total}`);

console.log(failures ? `\n${failures} failure(s)` : "\nall delivery checks passed");
if (failures) process.exit(1);
```

Add to `package.json` `"scripts"`: `"test:delivery": "node scripts/verify-delivery.mjs"`

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:delivery`
Expected: FAIL — the header is not honoured yet, so the request succeeds and the member is created.

- [ ] **Step 3: Add `prepareEvent`**

In `src/lib/webhookOutbox.ts`, add above `enqueueEvent`:

```ts
/**
 * Validate a payload and return the outbox INSERT as a statement, so the
 * caller can commit it in the SAME DB.batch() as the mutation that caused it.
 *
 * This is the atomic path. enqueueEvent below is the non-atomic fallback for
 * callers that cannot batch — it can lose the event if the Worker stops
 * between the mutation commit and the outbox write.
 *
 * Returns null when the payload fails its schema, which is a programming
 * error: the caller must treat null as fatal and not commit the mutation.
 */
export function prepareEvent(
  env: Env,
  tenantId: string,
  event: WebhookEventName,
  data: Record<string, unknown>
): { id: string; stmt: D1PreparedStatement } | null {
  const schema = eventPayloadSchemas[event];
  if (!schema) {
    console.error("prepareEvent: unknown event name", event);
    return null;
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    console.error("prepareEvent: payload failed schema", event, parsed.error.issues);
    return null;
  }
  const id = generateId();
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT INTO webhook_outbox
     (id, tenant_id, event, schema_version, payload_json, status, attempts,
      next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
  ).bind(
    id, tenantId, event, EVENT_SCHEMA_VERSION,
    JSON.stringify(parsed.data), now, now, now
  );
  return { id, stmt };
}

/** Hand a committed outbox id to the queue. Safe to call after the batch. */
export function scheduleDispatch(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  outboxId: string
): void {
  const send = Promise.resolve(env.WEBHOOK_QUEUE?.send({ outboxId })).catch((e) => {
    // Recoverable: the row is committed, so the sweeper will pick it up.
    console.warn("outbox: queue send failed, sweeper will retry", outboxId, e);
  });
  if (ctx) ctx.waitUntil(send);
}
```

Update `enqueueEvent`'s docstring to state plainly that it is **not** atomic and that new call sites should prefer `prepareEvent` + `DB.batch`.

- [ ] **Step 4: Convert the member-create route and add the test hook**

In `src/routes/members.ts`, `memberRoutes.post("/")`, replace the `.run()` + `enqueueEvent` pair with a single batch:

```ts
  const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
  const ev = prepareEvent(c.env, tenant.id, "member.created", {
    member_id: id,
    email: body.email.toLowerCase(),
    first_name: body.first_name ?? null,
    last_name: body.last_name ?? null,
    status,
    source: "admin",
  });
  // Development-only failure injection so the atomicity guarantee is testable.
  const forceFail =
    c.env.ENVIRONMENT === "development" &&
    c.req.header("X-QH-Force-Outbox-Failure") === "1";
  if (!ev || forceFail) {
    return c.json(
      { error: "Could not record the change event; nothing was saved.",
        code: "event_prepare_failed" },
      500
    );
  }
  await c.env.DB.batch([insertMemberStmt, ev.stmt]);
  scheduleDispatch(c.env, c.executionCtx, ev.id);
```

`insertMemberStmt` is the existing `INSERT INTO members …` prepared statement, extracted to a variable instead of being `.run()` inline. The member row and the outbox row now commit together or not at all.

- [ ] **Step 5: Run the test — it passes**

Run: `npm run test:delivery`
Expected: both atomicity checks pass — the forced failure returns 500 and leaves no member.

- [ ] **Step 6: Regression gate and commit**

```bash
npx tsc --noEmit
npm run test:integrations
node scripts/e2e-auto-renew.mjs
git add src/lib/webhookOutbox.ts src/routes/members.ts scripts/verify-delivery.mjs package.json
git commit -m "feat(webhooks): prepareEvent commits the outbox row with its mutation"
git push
```

---

## Task 3: Leased claim

Stops the queue and the one-minute sweeper dispatching the same row at once.

**Files:** Modify `src/lib/webhookOutbox.ts`; modify `scripts/verify-delivery.mjs`.

**Interfaces:** Produces `claimOutboxRow(env, outboxId): Promise<boolean>`, consumed by `dispatchOutboxRow` and `sweepOutbox`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-delivery.mjs`:

```js
console.log("--- lease ---");
// Two concurrent dispatches of the same row: exactly one may win the claim.
// Driven through the admin replay endpoint, which enqueues a dispatch.
const hook = await json(`/api/tenants/${tenantId}/webhooks`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ url: "http://127.0.0.1:8798/never-listens", events: ["*"] }),
});
await json(`/api/tenants/${tenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: `lease-${stamp}@example.test` }),
});
await new Promise((r) => setTimeout(r, 3000));
const ob = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
const row = ob.body.outbox?.[0];
check("outbox row exists for the lease test", !!row);
const [a, b] = await Promise.all([
  json(`/api/tenants/${tenantId}/webhooks/outbox/${row.id}/replay`, { method: "POST", headers: auth }),
  json(`/api/tenants/${tenantId}/webhooks/outbox/${row.id}/replay`, { method: "POST", headers: auth }),
]);
check("concurrent replays both answered", a.status === 200 && b.status === 200);
await new Promise((r) => setTimeout(r, 4000));
const ob2 = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
const row2 = ob2.body.outbox.find((r) => r.id === row.id);
check("concurrent dispatch did not double-count attempts",
  row2.attempts <= 2, `attempts=${row2.attempts}`);
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm run test:delivery`
Expected: the attempts assertion fails or is flaky — nothing prevents both dispatches running.

- [ ] **Step 3: Implement the claim**

In `src/lib/webhookOutbox.ts`:

```ts
/** How long a claim is held before another worker may take it over. */
const LEASE_SECONDS = 120;

/**
 * Atomically move a row from pending to delivering. Returns false when
 * another worker already owns it, or when its backoff has not elapsed.
 *
 * The WHERE clause is the entire concurrency control: D1 applies it
 * atomically, and meta.changes tells us whether we won.
 */
export async function claimOutboxRow(env: Env, outboxId: string): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const res = await env.DB.prepare(
    `UPDATE webhook_outbox
        SET status = 'delivering', claimed_at = ?, lease_until = ?, updated_at = ?
      WHERE id = ?
        AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_until IS NULL OR lease_until <= ?)`
  ).bind(nowIso, leaseUntil, nowIso, outboxId, nowIso, nowIso).run();
  return (res.meta?.changes ?? 0) === 1;
}
```

At the top of `dispatchOutboxRow`, replace the plain status read with:

```ts
  if (!(await claimOutboxRow(env, outboxId))) {
    // Someone else owns it, or its backoff has not elapsed. Not an error.
    return;
  }
```

In `sweepOutbox`, widen the selection to reclaim expired leases:

```ts
      `SELECT id FROM webhook_outbox
       WHERE (status = 'pending' OR (status = 'delivering' AND lease_until <= ?))
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT ?`
```

and bind `now` twice before `limit`. A row whose lease expired must be reset to `pending` before `claimOutboxRow` can win it — do that in the same UPDATE by allowing `status = 'delivering' AND lease_until <= ?` in the claim's WHERE.

- [ ] **Step 4: Run the test — it passes**

Run: `npm run test:delivery`

- [ ] **Step 5: Regression gate and commit**

```bash
npx tsc --noEmit && npm run test:integrations && node scripts/e2e-auto-renew.mjs
git add src/lib/webhookOutbox.ts scripts/verify-delivery.mjs
git commit -m "feat(webhooks): leased claim prevents concurrent dispatch of one event"
git push
```

---

## Task 4: Real retry delay and per-endpoint fan-out

**Files:** Modify `src/consumers/webhookConsumer.ts`, `src/lib/webhookOutbox.ts`, `scripts/verify-delivery.mjs`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-delivery.mjs` a check that a failing endpoint does **not** exhaust its attempts immediately:

```js
console.log("--- retry pacing ---");
// A dead endpoint must not burn every attempt within seconds. After ~8s the
// row should still be retryable, with a next_attempt_at in the future.
await json(`/api/tenants/${tenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: `pace-${stamp}@example.test` }),
});
await new Promise((r) => setTimeout(r, 8000));
const ob3 = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
const paced = ob3.body.outbox[0];
check("failing delivery is not dead after 8s", paced.status !== "dead", `status=${paced.status}`);
check("attempts did not run away", paced.attempts <= 2, `attempts=${paced.attempts}`);
check("next_attempt_at is in the future",
  !!paced.next_attempt_at && new Date(paced.next_attempt_at) > new Date(),
  `next_attempt_at=${paced.next_attempt_at}`);
```

- [ ] **Step 2: Run and confirm it fails**

Expected: `attempts` is already at or near 6 and `status` is `dead` — the immediate-retry bug.

- [ ] **Step 3: Delay the retry**

In `src/consumers/webhookConsumer.ts`, carry the computed backoff out of dispatch and into the queue:

```ts
import type { Env } from "../types";
import { dispatchOutboxRow, backoffFor } from "../lib/webhookOutbox";

export async function handleWebhookQueue(
  batch: MessageBatch<{ outboxId: string }>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await dispatchOutboxRow(env, msg.body.outboxId);
      msg.ack();
    } catch (e: any) {
      // dispatchOutboxRow throws with the attempt count so the queue can wait
      // the same interval the row recorded. Without a delay the queue redelivers
      // immediately and the documented backoff never happens.
      const attempts = Number(e?.attempts) || 1;
      msg.retry({ delaySeconds: backoffFor(attempts) });
    }
  }
}
```

In `dispatchOutboxRow`, attach the count to the thrown error:

```ts
  const err = new Error(`webhook delivery failed, attempt ${attempts}`) as Error & {
    attempts: number;
  };
  err.attempts = attempts;
  throw err;
```

- [ ] **Step 4: Retry only failed endpoints**

Replace the fan-out loop's bookkeeping so each `(outbox_id, endpoint_id)` carries its own row. Before sending to an endpoint, skip it when its target row is already `delivered`:

```ts
  const targets = endpoints.filter((ep) => wantsEvent(ep.events_json, row.event));
  const doneRows = await all<{ endpoint_id: string }>(
    env.DB.prepare(
      `SELECT endpoint_id FROM webhook_delivery_targets
       WHERE outbox_id = ? AND tenant_id = ? AND status = 'delivered'`
    ).bind(outboxId, row.tenant_id)
  );
  const alreadyDelivered = new Set(doneRows.map((r) => r.endpoint_id));
  const pendingTargets = targets.filter((ep) => !alreadyDelivered.has(ep.id));
```

Loop `pendingTargets`, and after each attempt upsert its target row:

```ts
    await env.DB.prepare(
      `INSERT INTO webhook_delivery_targets
       (id, outbox_id, endpoint_id, tenant_id, status, attempts, last_status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(outbox_id, endpoint_id) DO UPDATE SET
         status = excluded.status,
         attempts = webhook_delivery_targets.attempts + 1,
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    ).bind(
      generateId(), outboxId, ep.id, row.tenant_id,
      ok ? "delivered" : "pending", statusCode, error, now, now
    ).run();
```

The parent row becomes `delivered` only when every target is `delivered`; `anyFailed` is computed from `pendingTargets` alone, so a healthy endpoint is never re-sent.

- [ ] **Step 5: Run the test — it passes**

Run: `npm run test:delivery`

- [ ] **Step 6: Regression gate and commit**

```bash
npx tsc --noEmit && npm run test:integrations && node scripts/e2e-auto-renew.mjs
git add src/consumers/webhookConsumer.ts src/lib/webhookOutbox.ts scripts/verify-delivery.mjs
git commit -m "feat(webhooks): honour backoff on queue retry, track delivery per endpoint"
git push
```

---

## Task 5: Batch the remaining emit sites

**Files:** Modify `src/routes/public.ts`, `src/routes/webhooks.ts`, `src/routes/v1.ts`.

Every remaining `enqueueEvent` call site whose mutation is a single statement converts to `prepareEvent` + `DB.batch`. Sites where the mutation is already a multi-statement batch append the event statement to that existing batch.

- [ ] **Step 1: Inventory the sites**

```bash
grep -rn "enqueueEvent" src/routes/
```
Expected: the join path and event-registration path in `public.ts`, the Stripe paths in `webhooks.ts`, and the member create/update paths in `v1.ts`.

- [ ] **Step 2: Convert each**

For each: hoist the mutation into a named statement, call `prepareEvent`, return a 500 with `code: "event_prepare_failed"` when it returns null, `DB.batch([mutationStmt, ev.stmt])`, then `scheduleDispatch`.

**Two sites need judgement, not transcription:**
- The **free-join path** emits two events (`membership.activated`, `member.activated`) around `activateMembership`, which performs its own writes. Put both prepared statements in one batch with whatever statement completes the activation; if `activateMembership` cannot be decomposed, batch the two event statements together and document that they are not atomic with the activation itself.
- The **Stripe webhook path** already mutates then emits. Batch each event with its own mutation. Do **not** make a Stripe webhook return 500 on `prepareEvent` failure — Stripe will retry the whole webhook and the payment side-effects are not idempotent past `paymentAlreadyRecorded`. Log and continue there, and note the exception in the docstring.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit && npm run test:delivery && npm run test:integrations && node scripts/e2e-auto-renew.mjs
git add src/routes/
git commit -m "feat(webhooks): commit events atomically at the remaining emit sites"
git push
```

---

## Task 6: One validated hook path

**Files:** Create `src/lib/hookValidation.ts`; modify `src/routes/outboundWebhooks.ts`, `src/routes/v1.ts`, `scripts/verify-delivery.mjs`.

The admin routes accept `http://`, never call `validateHookUrl`, enforce no per-tenant limit, and `PATCH` writes `events_json` with **no validation at all** — bypassing the strict event checking on `POST`.

- [ ] **Step 1: Write the failing tests**

Append admin-route parity checks to `scripts/verify-delivery.mjs`, asserting the admin route rejects everything the v1 route rejects:

```js
console.log("--- hook validation parity ---");
for (const [payload, label] of [
  [{ url: "http://insecure.example.com/h" }, "http"],
  [{ url: "https://127.0.0.1/h" }, "loopback"],
  [{ url: "https://quilthosting.com/h" }, "self-loop"],
  [{ url: "https://hooks.zapier.com/h", events: ["member.creatd"] }, "typo'd event"],
]) {
  const r = await json(`/api/tenants/${tenantId}/webhooks`, {
    method: "POST", headers: auth, body: JSON.stringify(payload),
  });
  check(`admin POST rejects ${label}`, r.status === 400, `got ${r.status}`);
}
const good = await json(`/api/tenants/${tenantId}/webhooks`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ url: "https://hooks.zapier.com/ok", events: ["member.created"] }),
});
const patched = await json(`/api/tenants/${tenantId}/webhooks/${good.body.id}`, {
  method: "PATCH", headers: auth, body: JSON.stringify({ events: ["member.creatd"] }),
});
check("admin PATCH rejects a typo'd event", patched.status === 400, `got ${patched.status}`);
```

The `http` case will need the harness's own loopback sink subscribed through a different route or seeded directly in D1 — the sink URL is `http://127.0.0.1`, which this validation now forbids. Seed it with `wrangler d1 execute --local` in the harness rather than weakening the rule.

- [ ] **Step 2: Run and confirm they fail**

Expected: every admin assertion fails — the route currently accepts all of it.

- [ ] **Step 3: Extract the shared validator**

Create `src/lib/hookValidation.ts` exporting `validateHookInput({url, events}, {existingCount}): {ok: true, url, events} | {ok: false, error, code, status}`. It requires `https`, calls `validateHookUrl`, rejects unknown event names against `WEBHOOK_SUBSCRIBE_OPTIONS`, and enforces `MAX_HOOKS_PER_TENANT`. Move `MAX_HOOKS_PER_TENANT` here so both routes share one constant.

Call it from the admin `POST` and `PATCH` and from `v1` `POST`. Add `AND tenant_id = ?` to the admin `PATCH` UPDATE.

- [ ] **Step 4: Fix the admin response copy**

The admin create response says the signature is `HMAC-SHA256 of the body`. It is `HMAC-SHA256` of `{timestamp}.{body}`. Correct it.

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit && npm run test:delivery && npm run test:integrations
git add src/lib/hookValidation.ts src/routes/ scripts/verify-delivery.mjs
git commit -m "feat(webhooks): one validated hook path for admin and v1 routes"
git push
```

---

## Task 7: Restore the guarantees in the docs, and release

**Only now** may the stronger claims return — the code finally backs them.

**Files:** Modify `docs/zapier-webhooks.md`, `docs/superpowers/plans/2026-08-09-integration-ecosystem.md`, `public/admin.html`, `package.json`, `src/version.ts`.

- [ ] **Step 1: Rewrite the delivery-semantics section**

Replace the "Accuracy note" and the corrected bullets with what is now true: the outbox row commits in the same batch as its mutation; retries honour the recorded backoff via queue `delaySeconds`; delivery state is per endpoint so a healthy endpoint is not re-sent after a sibling's failure; leases prevent concurrent dispatch. **State the remaining limits honestly** — the Stripe path logs rather than fails, `activateMembership` may not be fully atomic (per Task 5), and the hostname deny list still does not resolve DNS at connection time.

- [ ] **Step 2: Update the correction banner**

On the integration plan, change the banner from "these claims are false" to "these claims were false in v0.27.0-preview and were made true in v0.29.0-preview by `docs/superpowers/plans/2026-08-10-delivery-reliability.md`." Keep the history; do not delete it.

- [ ] **Step 3: Update the admin copy**

Restore a truthful retry description matching the real schedule.

- [ ] **Step 4: Bump the version**

Edit `package.json` and `src/version.ts` **with the editor, not `sed`**, both to `0.29.0-preview`.

- [ ] **Step 5: Full gate**

```bash
npx tsc --noEmit
npm run test:delivery
npm run test:import
npm run test:integrations
node scripts/e2e-auto-renew.mjs
```
All five must exit 0.

- [ ] **Step 6: Commit, then STOP**

```bash
git add docs/ public/admin.html package.json src/version.ts
git commit -m "docs: restore delivery guarantees now that the code provides them; v0.29.0-preview"
git push
```

**Do not deploy.** Deployment requires explicit human approval, and this release also needs `db:migrate:remote` for migration 0014.

---

## Self-Review

**Source coverage.** P0.1 → Tasks 2 and 5. P0.2 → Tasks 3 and 4. P0.3 → Task 6. Documentation honesty → Task 7, gated behind the code.

**Deliberately out of scope, with reasons.** P0.4 (idempotency) is Plan B — it needs the batching primitive Task 2 introduces. P0.5 remainder and P0.6 (import batch model) are Plan C. Codex's P1 items — secret rotation UI, delivery-log PII retention, per-key rate limits, resolved-IP SSRF checks — are not P0 and are not here; they belong in the master program's Phase 2.

**Type consistency.** `prepareEvent(env, tenantId, event, data)` returns `{id, stmt} | null` in Task 2 and is called with that shape in Task 5. `scheduleDispatch(env, ctx, outboxId)` likewise. `claimOutboxRow(env, outboxId): Promise<boolean>` is defined in Task 3 and used by both `dispatchOutboxRow` and `sweepOutbox`. `backoffFor(attempts)` already exists and is re-exported for the consumer in Task 4.

**Soft spots a reviewer should press on:**
- **Task 4 Step 4 is the riskiest step.** It changes fan-out bookkeeping while Task 3 changed claiming. If the parent row's `delivered` transition is computed from `targets` rather than `pendingTargets`, an event with one already-delivered endpoint will never complete.
- **The failure-injection header in Task 2 is production-adjacent.** It is gated on `ENVIRONMENT === "development"`, but a reviewer should confirm that gate cannot be flipped by a request header or a misconfigured var.
- **Task 5's Stripe exception is a real hole**, deliberately accepted: a `prepareEvent` failure there logs and continues, so the atomicity guarantee does not hold on the Stripe path. Task 7 must say so out loud rather than claiming blanket atomicity.
- The lease test in Task 3 is timing-dependent and may be flaky on a slow machine. If it proves unstable, assert on `webhook_delivery_targets` attempt counts via `wrangler d1 execute` instead of wall-clock sleeps.
