# API Write Correctness (P0 Remediation, Plan B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Idempotency-Key` mean what integrators assume it means — scoped to the operation, safe under concurrency, and bounded in retention — so a Zapier or Make retry can never replay an unrelated response, double-execute a mutation, or accumulate member PII forever.

**Architecture:** The idempotency record becomes a *reservation* taken **before** the handler runs, made atomic by a unique index that now includes the operation. A concurrent caller that loses the race gets a definite answer (replay, 409 in-progress, or 422 reuse) rather than racing into a second mutation. Abandoned reservations expire on a lease, reusing the pattern Plan A established for the outbox.

**Tech Stack:** TypeScript ESM, Hono 4, Cloudflare Workers + D1, Wrangler 4.

**Source:** `CodexProjectReview.md` P0.4. Every claim below was re-verified against current code on 2026-08-10, after Plan A's changes, before this plan was written.

---

## Verified findings

| Claim | Verification |
|---|---|
| The key is not operation-scoped | **Confirmed.** `migrations/0013_webhook_outbox.sql:34` — `UNIQUE INDEX idx_idem_key ON api_idempotency(tenant_id, idempotency_key)`. The lookup at `src/routes/v1.ts:213-215` matches on the same two columns. So `Idempotency-Key: abc` on `POST /members` and on `PATCH /members/:id` collide. |
| The record is written after the mutation | **Confirmed.** `src/routes/v1.ts:229` runs the handler; the INSERT is at `:234`. Two simultaneous first requests both pass the "no prior record" check and both mutate. |
| No retention or cleanup | **Confirmed.** No reference to `api_idempotency` outside that one insert and select. Rows — including full response bodies containing member PII — persist indefinitely. |

### Why this matters concretely

Zapier and Make retry on timeout, and a Zap's task id is reused as the key across steps. Today:

- A Zap whose "create member" step and "update member" step reuse a key gets one step's response replayed for the other, or a spurious `422`.
- Two retries firing simultaneously — routine when a Worker is slow — both create the member; the second gets `409 duplicate_email` and the Zap reports failure for a member that exists twice over.
- Every cached response body is retained forever, so `api_idempotency` becomes a second, unmanaged copy of the member database.

---

## Global Constraints

- **Every tenant-scoped SQL query filters by `tenant_id`. No exceptions.**
- **A reservation must be taken before the handler runs.** Any design that mutates first and records second reintroduces the defect.
- **Backward compatibility:** a request with no `Idempotency-Key` must behave exactly as it does today — straight through to the handler, nothing recorded.
- TypeScript ESM on Cloudflare Workers; no new npm dependencies.
- camelCase for code identifiers.
- No test runner. Verification is `scripts/*.mjs` over HTTP against `wrangler dev`. Do NOT add Vitest/Jest.
- `npx tsc --noEmit` must pass before every commit.
- **Never use `sed -i`** — Windows/Git Bash, unreliable.
- **No autonomous production deploys.** Commit and push to `main` freely; stop and ask before `npm run deploy`, `wrangler deploy`, or `db:migrate:remote`.
- **Run every command synchronously.** Two implementers on the previous plan stalled polling a background test; one had already finished its work. Each suite takes 1-3 minutes — run it and wait.
- **Versioning:** bump `package.json` `version` AND `src/version.ts` `APP_VERSION` together. This plan lands `0.30.0-preview`.

### Preconditions

1. `.dev.vars` has `GOOGLE_AUTH_REQUIRED=false` and `ENVIRONMENT=development`.
2. `npm run db:migrate:local` applied.
3. `npx wrangler dev` running on `:8787`.
4. If `/api/auth/register` 429s: `npx wrangler kv key delete --binding KV --local "rl:register:unknown"`.
5. Regression gate every task, run **sequentially**: `npm run test:integrations`, then `node scripts/e2e-auto-renew.mjs`.

---

## File Structure

**Create:**
- `migrations/0015_idempotency_scope.sql` — operation column, reservation status, expiry, new unique index.
- `src/lib/idempotency.ts` — the whole mechanism, extracted out of `v1.ts`.
- `scripts/verify-idempotency.mjs` — harness (`npm run test:idempotency`).

**Modify:**
- `src/routes/v1.ts` — `withIdempotency` becomes a thin wrapper over the new module; call sites pass an operation id.
- `src/index.ts` — daily cron sweeps expired reservations.
- `docs/api.md` — document scoping, the 409, and retention.

---

## Task 1: Schema for scoped, expiring reservations

**Files:** Create `migrations/0015_idempotency_scope.sql`

**Interfaces:** Produces the `operation`, `status`, `expires_at` columns and the `(tenant_id, operation, idempotency_key)` unique index that Task 2's atomic reservation depends on.

- [ ] **Step 1: Write the migration**

```sql
-- Idempotency records become operation-scoped reservations with an expiry.
--
-- Previously the unique key was (tenant_id, idempotency_key), so the same key
-- used on POST /members and PATCH /members/:id collided: one operation could
-- replay the other's response or report a spurious 422. Zapier reuses a task
-- id across a Zap's steps, so this is the normal case, not an edge case.
--
-- SQLite cannot add a column to a UNIQUE index in place, so the table is
-- rebuilt. Existing rows are discarded rather than migrated: they carry no
-- operation, so they cannot be scoped correctly, and a stale replay of an
-- unscoped record is exactly the bug being fixed. The window is small (the
-- feature shipped in 0.27.0-preview and is not yet in production use), and
-- losing a cached response only means a retry re-executes — which the new
-- reservation path then makes safe.
DROP TABLE IF EXISTS api_idempotency;

CREATE TABLE api_idempotency (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Method + canonical route, e.g. "POST /v1/members". Part of the key.
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  -- reserved: handler is running or the worker died mid-flight.
  -- completed: response_status/response_json are authoritative.
  status TEXT NOT NULL DEFAULT 'reserved',
  response_status INTEGER,
  response_json TEXT,
  -- A reserved row older than this is treated as abandoned and may be taken
  -- over, so a crashed worker cannot 409 a caller forever.
  reserved_until TEXT,
  -- After this, the row is deleted by the daily sweep. Bounds retention of
  -- response bodies, which contain member PII.
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_idem_scoped
  ON api_idempotency(tenant_id, operation, idempotency_key);
CREATE INDEX idx_idem_expiry ON api_idempotency(expires_at);
```

- [ ] **Step 2: Apply and verify**

```bash
npm run db:migrate:local
npx wrangler d1 execute quilthosting-db --local --command "SELECT operation, status, reserved_until, expires_at FROM api_idempotency LIMIT 1"
npx wrangler d1 execute quilthosting-db --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_idem_scoped'"
```
Expected: the columns select without error and the index exists.

- [ ] **Step 3: Commit**

```bash
git add migrations/0015_idempotency_scope.sql
git commit -m "feat(api): operation-scoped, expiring idempotency reservations"
git push
```

---

## Task 2: Reserve before executing

The core fix. A reservation is taken atomically **before** the handler runs, so two concurrent callers cannot both mutate.

**Files:** Create `src/lib/idempotency.ts`, `scripts/verify-idempotency.mjs`; modify `src/routes/v1.ts`, `package.json`.

**Interfaces:**
- Produces `withIdempotency(c, {tenantId, operation, body}, handler): Promise<Response>` where `handler` returns `{status, json}`. Task 3 extends its concurrency behaviour; Task 4 adds retention.

- [ ] **Step 1: Write the failing tests**

Create `scripts/verify-idempotency.mjs`. Model the auth/tenant/API-key setup on the existing `scripts/verify-integrations.mjs` — reuse the stable `harness@example.test` account rather than registering per run, or you will exhaust the 10-per-10-minute register limit.

The assertions that must exist, each able to fail against the current implementation:

```js
// 1. OPERATION SCOPING — the headline fix.
//    Same key on two different operations must NOT collide.
const key = `scope-${stamp}`;
const create = await json("/api/v1/members", {
  method: "POST", headers: { ...writeAuth, "Idempotency-Key": key },
  body: JSON.stringify({ email: `a-${stamp}@example.test` }),
});
check("create with key succeeds", create.status === 201, `got ${create.status}`);
const patch = await json(`/api/v1/members/${create.body.member.id}`, {
  method: "PATCH", headers: { ...writeAuth, "Idempotency-Key": key },
  body: JSON.stringify({ first_name: "Scoped" }),
});
// Against the CURRENT code this returns 422 (hash differs) or replays the
// create's 201 — both wrong. It must run as its own operation.
check("same key on a different operation is independent",
  patch.status === 200, `got ${patch.status} ${JSON.stringify(patch.body)}`);

// 2. CONCURRENCY — two simultaneous identical firsts must produce ONE member.
const cKey = `conc-${stamp}`;
const cBody = JSON.stringify({ email: `conc-${stamp}@example.test` });
const [r1, r2] = await Promise.all([
  json("/api/v1/members", { method: "POST", headers: { ...writeAuth, "Idempotency-Key": cKey }, body: cBody }),
  json("/api/v1/members", { method: "POST", headers: { ...writeAuth, "Idempotency-Key": cKey }, body: cBody }),
]);
const statuses = [r1.status, r2.status].sort();
// Exactly one may execute. The loser is either replayed (201) or told the
// operation is in flight (409) — never a second create, never a 409
// duplicate_email surfaced from the database.
check("concurrent identical requests never both execute",
  statuses.every((s) => s === 201 || s === 409),
  `got ${JSON.stringify(statuses)}`);
const listed = await json(`/api/v1/members?limit=100`, { headers: writeAuth });
const dupes = listed.body.members.filter((m) => m.email === `conc-${stamp}@example.test`);
check("concurrent requests created exactly one member",
  dupes.length === 1, `found ${dupes.length}`);

// 3. Unchanged behaviour: same key + same body replays; different body 422s.
// 4. No key at all still works and records nothing.
```

- [ ] **Step 2: Run and confirm failure**

Add `"test:idempotency": "node scripts/verify-idempotency.mjs"` to `package.json` scripts.

Run: `npm run test:idempotency`
Expected: assertion 1 FAILS (the PATCH collides with the create's record) and assertion 2 is unreliable — often both requests create, so the duplicate check fails. Paste the real output.

- [ ] **Step 3: Write the module**

Create `src/lib/idempotency.ts`:

```ts
/**
 * Idempotency-Key handling for the public write API.
 *
 * The record is a RESERVATION taken before the handler runs, made atomic by
 * the unique index on (tenant_id, operation, idempotency_key). A caller that
 * loses the insert race gets a definite answer instead of racing into a
 * second mutation.
 *
 * The key is scoped by operation because integrators reuse one id across a
 * workflow's steps — Zapier reuses the task id — so an unscoped key would let
 * a create replay its response for an update.
 */
import type { Env } from "../types";
import { first } from "./db";
import { generateId } from "./utils/id";

/** How long a reservation is honoured before it is treated as abandoned. */
export const RESERVATION_SECONDS = 60;
/** How long a completed response stays replayable. Bounds PII retention. */
export const RETENTION_HOURS = 24;

export type IdempotencyOutcome =
  | { kind: "execute"; recordId: string }
  | { kind: "replay"; status: number; json: unknown }
  | { kind: "in_progress" }
  | { kind: "conflict" };

export async function hashRequest(body: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(body ?? null));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Attempt to claim the (tenant, operation, key) slot. Returns what the caller
 * should do. The INSERT is the concurrency control: the unique index means
 * exactly one caller can win it.
 */
export async function reserve(
  env: Env,
  tenantId: string,
  operation: string,
  key: string,
  requestHash: string
): Promise<IdempotencyOutcome> {
  const now = new Date();
  const nowIso = now.toISOString();
  const recordId = generateId();
  const reservedUntil = new Date(
    now.getTime() + RESERVATION_SECONDS * 1000
  ).toISOString();
  const expiresAt = new Date(
    now.getTime() + RETENTION_HOURS * 3600 * 1000
  ).toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO api_idempotency
       (id, tenant_id, operation, idempotency_key, request_hash, status,
        reserved_until, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`
    )
      .bind(recordId, tenantId, operation, key, requestHash,
            reservedUntil, expiresAt, nowIso, nowIso)
      .run();
    return { kind: "execute", recordId };
  } catch {
    // Unique-index violation: someone else owns this slot. Read it.
  }

  const prior = await first<{
    id: string;
    request_hash: string;
    status: string;
    response_status: number | null;
    response_json: string | null;
    reserved_until: string | null;
  }>(
    env.DB.prepare(
      `SELECT id, request_hash, status, response_status, response_json, reserved_until
       FROM api_idempotency
       WHERE tenant_id = ? AND operation = ? AND idempotency_key = ?`
    ).bind(tenantId, operation, key)
  );
  if (!prior) {
    // Raced with the sweeper deleting an expired row. Treat as in-progress;
    // the caller retries and wins the insert next time.
    return { kind: "in_progress" };
  }
  if (prior.request_hash !== requestHash) return { kind: "conflict" };

  if (prior.status === "completed" && prior.response_json !== null) {
    return {
      kind: "replay",
      status: prior.response_status ?? 200,
      json: JSON.parse(prior.response_json),
    };
  }

  // Still reserved. If the reservation has lapsed the worker that held it is
  // gone, so take it over rather than 409-ing this caller forever.
  const takeover = await env.DB.prepare(
    `UPDATE api_idempotency
        SET reserved_until = ?, updated_at = ?
      WHERE id = ? AND status = 'reserved' AND reserved_until <= ?`
  )
    .bind(reservedUntil, nowIso, prior.id, nowIso)
    .run();
  if ((takeover.meta?.changes ?? 0) === 1) {
    return { kind: "execute", recordId: prior.id };
  }
  return { kind: "in_progress" };
}

/** Store the handler's response against a reservation this caller owns. */
export async function complete(
  env: Env,
  recordId: string,
  status: number,
  json: unknown
): Promise<void> {
  await env.DB.prepare(
    `UPDATE api_idempotency
        SET status = 'completed', response_status = ?, response_json = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(status, JSON.stringify(json), new Date().toISOString(), recordId)
    .run();
}

/** Drop a reservation whose handler produced an uncacheable result. */
export async function release(env: Env, recordId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM api_idempotency WHERE id = ?`)
    .bind(recordId)
    .run();
}
```

- [ ] **Step 4: Rewire `v1.ts`**

Replace the body of `withIdempotency` so it takes an operation and delegates. Its call sites pass a stable operation id — `"POST /v1/members"` and `"PATCH /v1/members/:memberId"` — **not** the concrete path, so two different member ids share one operation namespace as intended.

```ts
async function withIdempotency(
  c: any,
  tenantId: string,
  operation: string,
  body: unknown,
  handler: () => Promise<{ status: number; json: unknown }>
): Promise<Response> {
  const key = c.req.header("Idempotency-Key");
  if (!key) {
    const r = await handler();
    return c.json(r.json, r.status);
  }

  const idem = await import("../lib/idempotency");
  const hash = await idem.hashRequest(body);
  const outcome = await idem.reserve(c.env, tenantId, operation, key, hash);

  if (outcome.kind === "replay") return c.json(outcome.json, outcome.status);
  if (outcome.kind === "conflict") {
    return c.json(
      {
        error: "Idempotency-Key reused with a different request body",
        code: "idempotency_key_reuse",
      },
      422
    );
  }
  if (outcome.kind === "in_progress") {
    c.header("Retry-After", "2");
    return c.json(
      {
        error: "A request with this Idempotency-Key is still in progress.",
        code: "idempotency_in_progress",
      },
      409
    );
  }

  const r = await handler();
  // 5xx is never cached: the caller must be able to retry a transient failure,
  // and a released reservation lets them win the slot again.
  if (r.status >= 500) await idem.release(c.env, outcome.recordId);
  else await idem.complete(c.env, outcome.recordId, r.status, r.json);
  return c.json(r.json, r.status);
}
```

- [ ] **Step 5: Run the tests — they pass**

Run: `npm run test:idempotency`
Expected: operation scoping passes, and the concurrency assertion holds — exactly one member created, the loser answered 201 or 409.

- [ ] **Step 6: Regression gate and commit**

```bash
npx tsc --noEmit
npm run test:integrations
node scripts/e2e-auto-renew.mjs
git add src/lib/idempotency.ts src/routes/v1.ts scripts/verify-idempotency.mjs package.json
git commit -m "feat(api): reserve idempotency slots before executing, scoped by operation"
git push
```

---

## Task 3: Prove the concurrency properties

Task 2's concurrency assertion is timing-dependent and may pass by luck. This task makes the guarantees provable.

**Files:** Modify `scripts/verify-idempotency.mjs`

- [ ] **Step 1: Make the race deterministic**

Two concurrent HTTP requests may not overlap on a fast local Worker, so the assertion can pass without exercising the race. Drive the reservation directly instead, the way Plan A's Task 3 drove `claimOutboxRow`:

Add a **dev-only** route — gated on `c.env.ENVIRONMENT === "development"`, exactly like the failure-injection header in `src/routes/members.ts`, reading the env var only and nothing client-controlled — that calls `reserve()` and returns the outcome kind. Then assert:

- Two `reserve()` calls with the same `(tenant, operation, key)` return exactly one `execute` and one `in_progress`.
- After `complete()`, a third `reserve()` returns `replay` with the stored status and body.
- With a different `requestHash`, `reserve()` returns `conflict`.
- A reservation whose `reserved_until` is in the past is taken over: seed one via `wrangler d1 execute`, then assert `reserve()` returns `execute` with the **existing** record id, not a new one.
- The takeover is exclusive: two concurrent takeover attempts on the same lapsed reservation yield exactly one `execute`.

- [ ] **Step 2: Prove the tests discriminate**

For each assertion, show it failing against a broken variant. At minimum: temporarily remove the `reserved_until <= ?` predicate from the takeover UPDATE and show the exclusivity assertion fails. Paste the output; do not assert it.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit && npm run test:idempotency && npm run test:integrations
git add scripts/verify-idempotency.mjs src/routes/v1.ts
git commit -m "test(api): deterministic proof of idempotency reservation exclusivity"
git push
```

---

## Task 4: Retention and a deliberate cache policy

**Files:** Modify `src/lib/idempotency.ts`, `src/index.ts`, `scripts/verify-idempotency.mjs`

- [ ] **Step 1: Sweep expired records**

Add to `src/lib/idempotency.ts`:

```ts
/** Delete expired records. Bounds retention of response bodies (member PII). */
export async function sweepExpired(env: Env, limit = 500): Promise<{ deleted: number }> {
  const res = await env.DB.prepare(
    `DELETE FROM api_idempotency
      WHERE id IN (SELECT id FROM api_idempotency WHERE expires_at <= ? LIMIT ?)`
  )
    .bind(new Date().toISOString(), limit)
    .run();
  return { deleted: res.meta?.changes ?? 0 };
}
```

Call it from `runDailyJobs` in `src/index.ts` — the daily branch, **not** the one-minute sweep branch, which exists only for the outbox. Include the count in the job's logged result.

- [ ] **Step 2: Decide what is cacheable**

Today every sub-500 response is cached. That is wrong for two classes:

- **`402 plan_limit`** — a guild that upgrades and retries would get the old refusal replayed for 24 hours.
- **`429 hook_limit`** — same reasoning; the limit is a moving condition, not a property of the request.

Cache `2xx`, `4xx` that are genuinely deterministic for the same body (`400`, `404`, `409 duplicate_email`, `422`), and release the reservation for `402`, `429`, and all `5xx`. Put the decision in one predicate in `src/lib/idempotency.ts` with a comment explaining each case, so the policy is reviewable in one place rather than implied by a comparison operator.

- [ ] **Step 3: Test both**

Assert a `402 plan_limit` is NOT replayed: drive a free-plan tenant to its active-member limit, get the 402 with a key, raise the limit (set `plan='starter'` via `wrangler d1 execute`), retry with the same key and body, and assert it now succeeds rather than replaying the 402.

Assert `sweepExpired` deletes only expired rows: seed one expired and one live record, run the sweep, assert exactly one remains.

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit && npm run test:idempotency && npm run test:integrations && node scripts/e2e-auto-renew.mjs
git add src/lib/idempotency.ts src/index.ts scripts/verify-idempotency.mjs
git commit -m "feat(api): bound idempotency retention and stop caching transient refusals"
git push
```

---

## Task 5: Documentation and version

**Files:** Modify `docs/api.md`, `package.json`, `src/version.ts`

- [ ] **Step 1: Rewrite the `Idempotency-Key` section**

Read the shipped code first; document what it does, not what this plan intended. Cover:

- The key is scoped to the operation. The same key on `POST /members` and `PATCH /members/:id` are independent, and reusing one across a workflow's steps is safe.
- Same key + same body → the original response replays, for 24 hours.
- Same key + different body → `422 idempotency_key_reuse`.
- A request still in flight → `409 idempotency_in_progress` with `Retry-After`. Document that this is the correct answer to a too-fast retry, and that the client should wait and retry rather than treating it as failure.
- Transient refusals (`402 plan_limit`, `429 hook_limit`) and all `5xx` are **not** cached, so a retry after the condition clears will succeed.
- Records expire after 24 hours and are swept daily.

**State the limitation honestly:** an abandoned reservation is only taken over after `RESERVATION_SECONDS`, so a client retrying inside that window gets `409` even though no other request is really running.

- [ ] **Step 2: Bump the version**

Edit `package.json` and `src/version.ts` **with the editor, not `sed`**, both to `0.30.0-preview`.

- [ ] **Step 3: Full gate**

```bash
npx tsc --noEmit
npm run test:idempotency
npm run test:delivery
npm run test:import
npm run test:integrations
node scripts/e2e-auto-renew.mjs
```
All six must exit 0.

- [ ] **Step 4: Commit, then STOP**

```bash
git add docs/api.md package.json src/version.ts
git commit -m "docs: operation-scoped idempotency semantics; v0.30.0-preview"
git push
```

**Do not deploy.** Production still needs migrations 0014 and 0015 applied remotely, and deployment requires explicit human approval.

---

## Out of scope

- **Plan C** — import key collisions and the import batch model (Codex P0.5 remainder and P0.6).
- **`members.ts:446`**, the admin `PATCH` still on the non-atomic emit path. Carried from Plan A; it is a delivery concern, not an idempotency one.
- Idempotency for the admin JWT routes. Only the public v1 write API accepts `Idempotency-Key`, and only integrators retry automatically.

---

## Self-Review

**Source coverage.** Codex P0.4 step 1 (operation in schema, lookup, hash, unique key) → Tasks 1 and 2. Step 2 (reserve atomically before executing, defined response for concurrent callers, recovery for abandoned reservations) → Tasks 2 and 3. Step 4 (retention, cleanup, deliberate cacheable classes) → Task 4. Step 5 (test same key across routes, simultaneous identical, simultaneous different bodies, crash after reservation, retry after transient error) → Tasks 2, 3 and 4.

**Deliberately not done:** Codex step 3 asks for the mutation, its outbox rows, and the completed idempotency response to commit in one D1 batch. That would need the handler to return statements rather than execute them — a rewrite of both v1 write endpoints. The reservation makes double-execution impossible, which is the property that matters; the residual is that a crash between mutation and `complete()` leaves a reservation that lapses and permits a retry to re-execute. **That retry is not protected**, and Task 5 must document it rather than implying full crash safety.

**Type consistency.** `IdempotencyOutcome`, `reserve`, `complete`, `release`, `hashRequest`, `sweepExpired`, `RESERVATION_SECONDS`, `RETENTION_HOURS` are defined in Task 2 and used under those names in Tasks 3, 4 and 5. `withIdempotency(c, tenantId, operation, body, handler)` gains the `operation` parameter in Task 2; both call sites must be updated in the same commit or the build breaks.

**Soft spots a reviewer should press on:**
- **Task 1 drops the table.** Justified while the feature is unused in production, but if anything has started relying on it, this discards cached responses. Verify `api_idempotency` is genuinely empty in production before this migration is applied remotely.
- **Task 3 adds a dev-only route to production code.** It must be gated on the env var only. Plan A's equivalent was reviewed carefully; this one deserves the same scrutiny.
- **The `catch {}` around the reserving INSERT swallows every error, not only unique violations.** A genuine D1 outage would be read as "someone else owns the slot," and the follow-up SELECT would then return no row and yield `in_progress` — a 409 for what is really an outage. Acceptable, but a reviewer should decide whether it warrants distinguishing the error.
- The 60-second reservation window is a guess. If Zapier retries faster than that, integrators will see 409s that resolve themselves. Worth revisiting with real traffic.
