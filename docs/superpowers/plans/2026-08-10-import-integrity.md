# Import Integrity (P0 Remediation, Plan C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the CSV importer silently losing data and silently overstating success — so a guild migrating from Wild Apricot can trust what the screen tells them.

**Architecture:** Colliding custom-field keys become a detected, named condition instead of a silent overwrite. Every import runs under a persisted batch record that tracks row-level outcomes including membership-assignment failures, so the result is `completed` or `partial` — never a bare success that hides losses.

**Tech Stack:** TypeScript ESM, Hono 4, Cloudflare Workers + D1, Wrangler 4.

**Source:** `CodexProjectReview.md` P0.5 (remainder) and P0.6. Both re-verified against current code on 2026-08-10 before this plan was written.

---

## Verified findings

**P0.5 — two headers can silently collapse into one custom field.**

Key derivation is `header.toLowerCase().replace(/[^a-z0-9]+/g, "_")`, so distinct headers collide:

```
Bee Group     -> bee_group   |  Bee-Group     -> bee_group    COLLIDE
T Shirt       -> t_shirt     |  T-Shirt       -> t_shirt      COLLIDE
Machine Type  -> machine_type|  Machine  Type -> machine_type COLLIDE
```

`uniqueCustomKey` exists to de-duplicate, but `if (takenKeys.has(entry.key)) continue;` runs first, so it is only ever called with an un-taken key and **always returns its input unchanged** — dead code. Worse, even if it did rename the definition, `applyMapping` writes values under the *original* key, so the definition and the values would diverge. Today the second column simply overwrites the first, with no warning.

**P0.6 — a partial import is reported as complete success.**

Membership assignment runs after the member batch, one at a time, and its failure path is:

```ts
} catch (e) {
  console.warn("import membership assign failed", pm.memberId, e);
}
```

The member exists, their membership does not, nothing enters `skipped_rows`, and the response still reports `created: N`. The admin sees "Imported: 240 new" and believes their migration worked. There is no batch id, no persisted report, no resume, and no rollback.

---

## Global Constraints

- **Every tenant-scoped SQL query filters by `tenant_id`. No exceptions.**
- **Never report success for work that did not happen.** Any outcome that loses or skips data must be visible in the response and in the persisted batch record.
- **Backward compatibility:** the legacy `rows`-without-`header` payload must keep working. The public v1 API and existing scripts depend on it.
- TypeScript ESM on Cloudflare Workers; no new npm dependencies.
- camelCase for code identifiers.
- No test runner. Verification is `scripts/*.mjs`. Do NOT add Vitest/Jest.
- `npx tsc --noEmit` must pass before every commit.
- **Never use `sed -i`** — Windows/Git Bash, unreliable.
- **Run every command synchronously.** Three implementers across the previous plans stalled polling a background test; two had already finished their work.
- **Deployment is authorised** for this project (no production users), but deploy only at a coherent point — a completed plan, never mid-task. Migrations must be applied remotely **before** the code that depends on them.
- **Versioning:** bump `package.json` `version` AND `src/version.ts` `APP_VERSION` together. This plan lands `0.31.0-preview`.

### Preconditions

1. `.dev.vars` has `GOOGLE_AUTH_REQUIRED=false` and `ENVIRONMENT=development`.
2. `npm run db:migrate:local` applied.
3. `npx wrangler dev` running on `:8787`.
4. If `/api/auth/register` 429s: `npx wrangler kv key delete --binding KV --local "rl:register:unknown"`.
5. Regression gate every task, run **sequentially**: `npm run test:import`, `npm run test:integrations`, then `node scripts/e2e-auto-renew.mjs`.

---

## Task 1: Detect colliding custom keys

**Files:** Modify `src/lib/importMapping.ts`, `src/routes/members.ts`, `scripts/verify-import.mjs`

**Interfaces:** Produces a `duplicate_custom_key` warning code and a matching 400 rejection, consumed by the admin UI's existing warning renderer.

- [ ] **Step 1: Write the failing test**

In `scripts/verify-import.mjs`, add a case using a header row containing two columns that slugify identically — `Bee Group` and `Bee-Group` — both mapped to `kind: "custom"`:

```js
// Two headers that collapse to the same key must be REPORTED, not silently
// merged. Today the second overwrites the first with no warning at all.
const collideHeader = ["E-Mail", "Bee Group", "Bee-Group"];
const collideRows = [["a@example.test", "Tuesday", "Thursday"]];
const collideMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "custom", key: "bee_group", label: "Bee Group" },
  2: { kind: "custom", key: "bee_group", label: "Bee-Group" },
};
const dryCollide = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: collideHeader, raw_rows: collideRows,
                         mapping: collideMapping, dry_run: true }),
});
check("collision is warned in the dry run",
  (dryCollide.body.warnings || []).some((w) => w.code === "duplicate_custom_key"),
  JSON.stringify(dryCollide.body.warnings));

const realCollide = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: collideHeader, raw_rows: collideRows, mapping: collideMapping }),
});
check("collision is rejected on the real import",
  realCollide.status === 400 && realCollide.body.code === "duplicate_custom_key",
  `got ${realCollide.status} ${JSON.stringify(realCollide.body)}`);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:import`
Expected: both assertions FAIL — no warning is produced and the import returns 200 with one column silently overwriting the other. Paste the output.

- [ ] **Step 3: Detect the collision**

In `src/lib/importMapping.ts`, add a pure helper beside `proposeMapping`:

```ts
/**
 * Two different headers can slugify to the same custom key — "Bee Group" and
 * "Bee-Group" both give bee_group. Before this check the second silently
 * overwrote the first, so a guild lost a whole column with no signal.
 *
 * We report rather than auto-rename: a generated `bee_group_2` is meaningless
 * to the admin, and renaming the definition without also remapping the values
 * (which is what the dead uniqueCustomKey path would have done) puts the
 * definition and the data out of step.
 */
export function findDuplicateCustomKeys(
  mapping: ImportMapping,
  header: string[]
): Array<{ key: string; headers: string[]; indices: number[] }> {
  const byKey = new Map<string, { headers: string[]; indices: number[] }>();
  for (const [idxRaw, entry] of Object.entries(mapping)) {
    if (entry.kind !== "custom") continue;
    const idx = Number(idxRaw);
    const slot = byKey.get(entry.key) ?? { headers: [], indices: [] };
    slot.headers.push(header[idx] ?? `column ${idx}`);
    slot.indices.push(idx);
    byKey.set(entry.key, slot);
  }
  return [...byKey.entries()]
    .filter(([, v]) => v.indices.length > 1)
    .map(([key, v]) => ({ key, headers: v.headers, indices: v.indices }));
}
```

- [ ] **Step 4: Warn on dry run, reject on import**

In `src/routes/members.ts`, call it once the mapping is resolved. On the **dry run**, push a warning per collision:

```ts
    for (const d of duplicateKeys) {
      warnings.push({
        code: "duplicate_custom_key",
        message: `"${d.headers.join('" and "')}" would both import into the same custom field. Rename one column, or set one to "Do not import".`,
        count: d.indices.length,
        sample_rows: [],
      });
    }
```

On the **real import**, refuse before writing anything:

```ts
  if (duplicateKeys.length) {
    return c.json(
      {
        error: "Two or more columns map to the same custom field.",
        code: "duplicate_custom_key",
        duplicates: duplicateKeys,
      },
      400
    );
  }
```

Rejecting rather than guessing is deliberate: the admin can see both column names in the message and resolve it in one click in the mapping table.

- [ ] **Step 5: Delete the dead code**

`uniqueCustomKey` in `src/lib/importMapping.ts` is unreachable — the `if (takenKeys.has(entry.key)) continue;` guard in `src/routes/members.ts` means it is only ever called with an un-taken key. It also misleads: it looks like collision handling that works. Delete it and its call, or keep it and add a comment stating it is currently unreachable. **Prefer deleting** — with Task 1's check in place, nothing needs it. Confirm no other caller with `grep -rn "uniqueCustomKey" src/`.

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit
npm run test:import
npm run test:integrations
git add src/lib/importMapping.ts src/routes/members.ts scripts/verify-import.mjs
git commit -m "fix(import): detect colliding custom-field keys instead of silently merging"
git push
```

---

## Task 2: Import batch records

**Files:** Create `migrations/0016_import_batches.sql`

**Interfaces:** Produces `import_batches` and `import_batch_errors`, consumed by Task 3.

- [ ] **Step 1: Write the migration**

```sql
-- Every import runs under a batch record so a partial result can be reported
-- as partial. Previously a membership-assignment failure was console.warn'd
-- and the response still said "created: N" — the admin saw a clean success
-- for a migration that had silently lost memberships.
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- running | completed | partial | failed
  status TEXT NOT NULL DEFAULT 'running',
  -- The mapping actually applied, so a later reader can tell what was imported.
  mapping_json TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  memberships_assigned INTEGER NOT NULL DEFAULT 0,
  membership_failures INTEGER NOT NULL DEFAULT 0,
  plan_limited INTEGER NOT NULL DEFAULT 0,
  custom_fields_created INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_batch_tenant
  ON import_batches(tenant_id, started_at);

-- Row-level outcomes, so the admin can download exactly what failed and why.
CREATE TABLE IF NOT EXISTS import_batch_errors (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  -- skipped | membership_failed
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_error_batch
  ON import_batch_errors(batch_id);
```

- [ ] **Step 2: Apply and verify**

```bash
npm run db:migrate:local
npx wrangler d1 execute quilthosting-db --local --command "SELECT status, membership_failures FROM import_batches LIMIT 1"
npx wrangler d1 execute quilthosting-db --local --command "SELECT kind, reason FROM import_batch_errors LIMIT 1"
```
Expected: both select without error.

- [ ] **Step 3: Commit**

```bash
git add migrations/0016_import_batches.sql
git commit -m "feat(import): batch and row-error tables for truthful reconciliation"
git push
```

---

## Task 3: Truthful reconciliation

The core fix: membership failures are counted and surfaced, and the response says `partial` when anything was lost.

**Files:** Modify `src/routes/members.ts`, `scripts/verify-import.mjs`

- [ ] **Step 1: Write the failing test**

Force a membership assignment to fail and assert the import does **not** claim clean success. The cheapest reliable trigger: import a row whose level matches an active level, then make activation fail by deleting the level between the member batch and the membership loop — awkward. Prefer instead to assert the reporting contract directly:

```js
// A row naming a level that exists must assign a membership. If assignment
// fails for any reason, the response must say so — not report a clean create.
// Drive the observable contract: memberships_assigned + membership_failures
// must equal the number of rows that named a real level.
const withLevel = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, mapping }),
});
const namedRealLevel = /* count rows whose level column matches "Annual Membership" */;
check("every row naming a real level is accounted for",
  (withLevel.body.memberships_assigned + withLevel.body.membership_failures) === namedRealLevel,
  `assigned=${withLevel.body.memberships_assigned} failed=${withLevel.body.membership_failures} expected=${namedRealLevel}`);
check("import reports a batch id", !!withLevel.body.batch_id);
check("clean import reports completed", withLevel.body.status === "completed",
  `got ${withLevel.body.status}`);
```

Then a genuine failure case: seed a member row whose `member_id` will violate a constraint during activation — or simpler and deterministic, temporarily point `pendingMemberships` at a non-existent level id via a dev-only header, exactly as `src/routes/members.ts` already does for `X-QH-Force-Outbox-Failure` (gated on `ENVIRONMENT === "development"`, env var read first, nothing client-controlled reaching the gate). Assert:

```js
check("forced membership failure reports partial", forced.body.status === "partial");
check("forced membership failure is counted", forced.body.membership_failures > 0);
check("forced membership failure appears in errors",
  (forced.body.errors || []).some((e) => e.kind === "membership_failed"));
```

- [ ] **Step 2: Run and confirm failure**

Expected: no `batch_id`, no `status`, no `membership_failures` in the response at all. Paste the output.

- [ ] **Step 3: Open a batch before writing**

At the start of the real import (after validation, before the member statements execute), insert an `import_batches` row with `status='running'` and the resolved `mapping_json`, and hold its id. Every subsequent count updates that record.

- [ ] **Step 4: Count and record membership failures**

Replace the swallow-and-warn:

```ts
    } catch (e) {
      // Previously this was console.warn only, so a member could be created
      // without their membership and the import still reported clean success.
      membershipFailures++;
      batchErrors.push({
        row_number: pm.rowNumber,
        kind: "membership_failed",
        reason: (e as Error)?.message?.slice(0, 300) || "membership assignment failed",
        email: pm.email,
      });
    }
```

`pendingMemberships` must carry `rowNumber` and `email` for this — add them where it is populated.

- [ ] **Step 5: Close the batch honestly**

After the loop, write the counts, insert the `import_batch_errors` rows, and set the status:

```ts
  // completed only when nothing was lost. Anything skipped, plan-limited, or
  // failed to activate makes this a partial import, and the admin must be told.
  const status =
    skippedRows.length === 0 && membershipFailures === 0 && planLimited === 0
      ? "completed"
      : "partial";
```

Return `batch_id`, `status`, `membership_failures`, and `errors` alongside the existing counters. Keep every existing field so the admin UI and any caller keep working.

- [ ] **Step 6: Surface it in the UI**

In `public/admin.html`'s `runImport()`, when `status === "partial"` render the result as a warning rather than a success, and name what was lost: skipped rows, plan-limited rows, and membership failures each with a count. The existing "Download skipped rows" button should include membership failures in its CSV, since those rows also need the guild's attention.

- [ ] **Step 7: Verify and commit**

```bash
npx tsc --noEmit
npm run test:import
npm run test:integrations
node scripts/e2e-auto-renew.mjs
git add src/routes/members.ts public/admin.html scripts/verify-import.mjs
git commit -m "fix(import): report partial imports as partial, count membership failures"
git push
```

---

## Task 4: Import history

**Files:** Modify `src/routes/members.ts`, `public/admin.html`, `scripts/verify-import.mjs`

- [ ] **Step 1: Add the endpoints**

```ts
// GET /api/tenants/:tenantId/members/import/batches — last 50, newest first
// GET /api/tenants/:tenantId/members/import/batches/:batchId/errors — row detail
```

Both tenant-scoped. The errors endpoint returns the full list, not a cap, because its purpose is a downloadable report.

**Route-ordering caution:** `memberRoutes` already has `GET /:memberId`. Register these literal paths **before** it or `import` will be captured as a member id. Verify with a request to `/members/import/batches` returning a batch list rather than a 404 member lookup.

- [ ] **Step 2: Add the admin view**

A "Recent imports" card on the Members page: when, who, counts, status badge (`completed` green / `partial` amber / `failed` red), and a link to download that batch's errors as CSV. This is where a guild goes after a migration to check what happened — the one-shot alert is gone the moment they navigate away.

- [ ] **Step 3: Verify and commit**

Assert a batch appears in the list with the right status after an import, and that its errors endpoint returns the rows recorded in Task 3.

```bash
npx tsc --noEmit && npm run test:import && npm run test:integrations
git add src/routes/members.ts public/admin.html scripts/verify-import.mjs
git commit -m "feat(import): persisted import history with per-batch error reports"
git push
```

---

## Task 5: Documentation, version, and deploy

**Files:** Modify `docs/api.md`, `docs/admin-guide.md`, `package.json`, `src/version.ts`

- [ ] **Step 1: Document the new contract**

In `docs/api.md`: `batch_id`, `status` (`completed` | `partial`), `membership_failures`, `errors`, the `duplicate_custom_key` 400, and the two history endpoints. State plainly that `partial` means data was not fully imported and the batch's errors should be reviewed.

In `docs/admin-guide.md`: what a partial import means and what to do about it.

**State the limits honestly.** There is still no rollback, no resume, and no delta re-import — a failed batch is re-run by fixing the CSV and importing again, which converges because import matches on email. Say so rather than implying transactional import.

- [ ] **Step 2: Bump the version**

Edit `package.json` and `src/version.ts` **with the editor, not `sed`**, both to `0.31.0-preview`.

- [ ] **Step 3: Full gate**

```bash
npx tsc --noEmit
npm run test:import
npm run test:idempotency
npm run test:delivery
npm run test:integrations
node scripts/e2e-auto-renew.mjs
```
All six must exit 0.

- [ ] **Step 4: Commit and deploy**

Deployment is authorised for this project. Deploy only from a green gate, and **apply migrations before the code**:

```bash
git add docs/ package.json src/version.ts
git commit -m "docs: import batch reporting; v0.31.0-preview"
git push
npm run db:migrate:remote   # 0016
npm run deploy
curl -s https://quilthosting.com/api/version
```
Expected: `{"version":"0.31.0-preview"}`.

---

## Out of scope

Codex's P0.6 also asks for staged/resumable chunked processing, rollback from captured before-state, and concurrency-safe custom-field definition writes. This plan delivers **truthful reporting** — the property that stops a guild trusting a migration that silently lost data — but not transactional import. Rollback in particular needs a before-state capture that does not exist. Task 5 must document the gap rather than implying it is solved.

The read/modify/write of `tenants.settings_json` during custom-field creation remains racy against a simultaneous settings edit. Carried forward; it is a narrow window and the admin UI does not encourage concurrent edits.

---

## Self-Review

**Source coverage.** P0.5 remainder → Task 1. P0.6 batch model and truthful reconciliation → Tasks 2 and 3. Persisted report → Tasks 2 and 4. Row-level membership failures in the downloadable report → Task 3 Steps 4-6.

**Deliberately not done, and why:** resumable chunking and rollback (see Out of scope). Naming them here so the final review can hold Task 5's documentation to it.

**Type consistency.** `findDuplicateCustomKeys(mapping, header)` returns `Array<{key, headers, indices}>` in Task 1 and is consumed under that shape in Task 1 Step 4. `import_batches` / `import_batch_errors` column names in Task 2 are used verbatim in Tasks 3 and 4.

**Soft spots a reviewer should press on:**
- **Task 3 Step 1's failure trigger is the weakest part of this plan.** Forcing a membership-assignment failure deterministically is awkward; a dev-only header is proposed, and it ships in production code, so it needs the same gating scrutiny the earlier plans' dev hooks received. If the implementer finds a cleaner deterministic trigger, prefer it.
- **Task 4's route ordering** is a real trap: `GET /:memberId` already exists and will swallow `/import/batches` if registered first.
- The `status` predicate treats `plan_limited > 0` as partial. That is deliberate — members held at `pending` by the free-plan cap are a real, actionable shortfall — but it means a free-plan guild importing 40 members always sees `partial`. Consider whether the UI should phrase that case differently from a genuine failure.
