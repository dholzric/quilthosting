# QuiltHosting — Grok Project Status Review

**Date:** 2026-08-10  
**Reviewer:** Grok (xAI)  
**Branch:** `main` @ `0c9a385` (+ 3 uncommitted files)  
**App version in tree:** `0.27.1-preview`  
**Scope of review:** Recent integration foundation (Phase 1), trustworthy CSV migration (Phase 3 slice A), uncommitted WIP, verification harness results, and master-program readiness.

This document is written for the human owner **and** for Claude (or any agent) continuing the work. Sections marked **Claude: do this** are concrete fix instructions.

---

## 1. Executive summary

| Area | Status | Confidence |
|------|--------|------------|
| **Integration foundation (Phase 1 code)** | Largely **done** and green locally | High — `npm run test:integrations` passes |
| **Trustworthy CSV migration (Tasks 1–5 code)** | **~95% done**; critical WIP still **uncommitted** | High — `npm run test:import` passes *with working tree* |
| **Task 6 (docs + version bump to 0.28.0-preview)** | **Not started** | High |
| **Production deploy of either stream** | **Not done / not verified** | High — plan forbids self-deploy |
| **WA master program Phases 2–6** | **Not started** (by design) | High |
| **Gap-analysis honesty** | Re-framed; most rows still unaudited | High |

**Bottom line:** Claude has executed a large, high-quality push on integrations and member CSV import. The import feature is real, test-covered, and close to shippable as a **developer-preview feature** — but Task 6 is open, three important bugfixes live only in the working tree, and a few correctness gaps (duplicate-target enforcement under supplied mappings, `uniqueCustomKey` desync) should be closed before calling migration “trustworthy.”

Do **not** market this as full Wild Apricot parity or a complete migration product. Per the master program, this is Phase 1 (integrations) + the first slice of Phase 3 (column mapping for members only).

---

## 2. What is done

### 2.1 Platform baseline (pre-this-week, still true)

- Multi-tenant Workers + Hono + D1 + R2 + KV app at quilthosting.com (stealth site gate).
- Memberships, events, portal, Stripe Connect / platform billing, renewals cron, blasts, forms, etc.
- Real CF resource IDs in `wrangler.toml` (D1, KV, queues). Note: root `Claude.md` still claims placeholders — **docs drift** (see §5).
- Mobile Expo app under `apps/mobile/`.
- Version `0.27.1-preview` (integration developer preview lineage).

### 2.2 Integration foundation (master program Phase 1) — **code complete**

Shipped in commits through `1ff2f17` / related work:

| Deliverable | Evidence |
|-------------|----------|
| Versioned event catalog | `src/lib/webhookEvents.ts` |
| Durable outbox + queue + DLQ + sweeper | `src/lib/webhookOutbox.ts`, `src/consumers/webhookConsumer.ts`, `migrations/0013_webhook_outbox.sql`, `wrangler.toml` queue bindings, minute cron |
| Honest emitters for advertised events | `member.created`, free-join activation path, `event.registration` on free/waitlist/paid, `member.updated` with changed fields |
| v1 writes + idempotency + granular scopes + REST hooks | `src/routes/v1.ts`, api key scopes |
| Outbox visibility / replay / re-enable | `src/routes/outboundWebhooks.ts` + admin UI work in history |
| Zapier private app skeleton | `integrations/zapier/` (triggers + create member) |
| Docs for contract | `docs/zapier-webhooks.md`, API notes, commit `1ff2f17` |
| Harness | `scripts/verify-integrations.mjs` — **passes** (driven events deliver; `payment.succeeded` correctly marked UNDRIVEN → e2e-auto-renew) |

**Local verification (this review):**

```
npm run test:integrations  → exit 0
  PASS member.created, member.activated, member.updated, membership.activated,
       event.registration, form.response
  UNDRIVEN payment.succeeded (documented)
  v1 scopes + idempotency + hooks OK
```

**Phase 1 product exit criteria still open** (master program — not the same as “code merged”):

- Production delivery success rate ≥ 99% over 7 days from `webhook_deliveries` / outbox.
- Retry recovery rate ≥ 95% for transient failures.
- A real Zapier subscribe → trigger → action → unsubscribe cycle recorded (not only local harness / `zapier validate`).
- No production automation users recruited while still preview / site-gated.

### 2.3 Trustworthy CSV migration (design + plan + Tasks 1–5) — **almost complete**

**Design / plan (done):**

- `docs/superpowers/specs/2026-08-10-trustworthy-migration-design.md`
- `docs/superpowers/plans/2026-08-10-trustworthy-migration.md`

**Implemented and committed (Tasks 1–5 core):**

| Task | Commit(s) | Deliverable |
|------|-----------|-------------|
| 1 | `79b4a35` | `src/lib/importMapping.ts` — pure mapping module |
| 2 | `7556160` | `scripts/fixtures/wa-export-sample.csv` (+ ragged-row fixture row) |
| 3 | `f46abba`, `e4b6212` | Dry-run proposes mapping + warnings; `renewaldue` synonym |
| 4 | `e7db5ca`, `cd77fbe` | Apply mapping, create custom fields, merge values, tenant-scoped custom-field read, `skipped_rows`, coalesce coverage |
| 5 | `0c9a385` | Admin mapping UI, reconciliation, error CSV download |

**Harness / tooling:**

- `npm run test:import` → `scripts/verify-import.mjs` (layers 1–3)
- `npx tsc --noEmit` → **clean** (this review)

**Local verification (this review, with uncommitted fixes applied):**

```
npx tsc --noEmit           → exit 0
npm run test:import        → all layers passed
```

Including: dry run writes nothing, empty Fax no warning, custom field values + definitions, re-run convergence, hand-entered field survival under coalesce, stale-warning regression after one-column edit, skipped_rows for error CSV.

### 2.4 Honesty / process work (done)

- WA gap analysis re-framed to an evidence bar (`docs/wildapricot-gap-analysis.md`) — integrations audit documented; automations overstatement corrected.
- Master program document separates strategy from implementation plans.
- Plan explicitly: no autonomous production deploys; version bumps owned by Task 6 (import).

---

## 3. What is in flight (uncommitted right now)

`git status` shows **3 modified files, not committed**:

| File | Intent of WIP |
|------|----------------|
| `src/routes/members.ts` | When client supplies `mapping` on dry run / re-preview, **re-derive `unmapped` + `duplicates`** so editing one column does not wipe warnings for all others |
| `scripts/verify-import.mjs` | Regression tests for that stale-warning bug |
| `public/admin.html` | (1) Fix sample truncation: `esc(sample.slice(0,40))` not `esc(sample).slice(0,40)`; (2) **Do not auto-navigate away** when skipped rows need download — keep Download + “Back to members” |

These fixes are **correct and necessary**. They already make `npm run test:import` green for the stale-warning cases. They must be committed before Task 6, not left sitting in the working tree.

**Claude: do this first (WIP commit):**

1. Confirm `npx tsc --noEmit` and `npm run test:import` still exit 0.
2. Commit the three files only (do not mix Task 6 yet):

```text
git add public/admin.html scripts/verify-import.mjs src/routes/members.ts
git commit -m "fix(import): re-derive warnings on supplied mapping; keep error CSV on screen"
git push
```

3. Do **not** deploy.

---

## 4. What is not done yet

### 4.1 Import plan Task 6 — **blocking for “feature complete”**

From `docs/superpowers/plans/2026-08-10-trustworthy-migration.md`:

| Step | Status | Work |
|------|--------|------|
| Document `POST …/members/import` mapping flow in `docs/api.md` | ❌ Missing | `header` / `raw_rows` / `mapping`, exclusive-or with `rows`, warning codes, `custom_fields_created`, `skipped_rows`, legacy shape still supported |
| Document admin flow in `docs/admin-guide.md` | ❌ Missing | “Importing your members” section (map columns → warnings → import → error CSV) |
| Mirror into product docs if required by project norms | ❌ | At least note in `public/docs/` if admin-guide HTML is the customer-facing source — currently admin-guide.md has **no** Import section |
| Bump version to **`0.28.0-preview`** | ❌ | Both `package.json` **and** `src/version.ts` (currently `0.27.1-preview`) |
| Full verification gate | Partial | tsc + test:import green; re-run test:integrations + e2e-auto-renew before Task 6 commit |
| Plan checkboxes | ❌ | Plan still shows every `- [ ]` unchecked — update as you finish |

**Claude: do this (Task 6):**

1. **Only after** WIP commit in §3 is pushed.
2. Edit `docs/api.md` — members import section:

   - Request shapes: legacy `{ rows, dry_run? }` vs mapping `{ header, raw_rows, mapping?, dry_run? }`.
   - 400 codes: `ambiguous_payload`, `missing_header`, max 5000 rows.
   - Dry-run response fields: `will_create`, `will_update`, `will_skip`, `mapping`, `unmapped`, `warnings[]`, `skipped[]`, `sample`.
   - Real-import response: `created`, `updated`, `skipped`, `memberships_assigned`, `plan_limited`, `custom_fields_created`, `skipped_rows`.
   - Warning code table: `unmapped_column`, `duplicate_target`, `level_not_found`, `unparseable_date`, `invalid_status`, `column_count_mismatch`, `plan_limit_will_hold`.
   - State: dry run creates **no** members and **no** custom-field definitions; real import is **additive only** for definitions.

3. Edit `docs/admin-guide.md` — section **Importing your members**:

   - File → column table → promote to custom / ignore → read warnings → Import → download skipped CSV.
   - Nothing written until Import.
   - Re-import by email converges (updates, no duplicates).
   - Free-plan active cap may hold rows as pending (`plan_limit_will_hold`).

4. Set version in **both** files to `0.28.0-preview` with the editor (never `sed -i` on this Windows machine):

   - `package.json` → `"version": "0.28.0-preview"`
   - `src/version.ts` → `APP_VERSION = "0.28.0-preview"`

5. Run full gate:

```bash
npx tsc --noEmit
npm run test:import
npm run test:integrations
node scripts/e2e-auto-renew.mjs
```

6. Commit:

```text
git add docs/api.md docs/admin-guide.md package.json src/version.ts
git commit -m "docs: CSV column mapping flow; v0.28.0-preview"
git push
```

7. **Stop. Ask human before `npm run deploy` or remote D1 migrate.**

8. Optionally tick Task 1–6 checkboxes in the plan file so the next agent does not re-do finished work.

### 4.2 Manual UI smoke (Task 5 Step 5) — **not evidenced in git**

Harness covers API; browser flow should still be walked once:

1. `wrangler dev` → `/admin` → Members → Import → `scripts/fixtures/wa-export-sample.csv`.
2. Confirm 13 columns; Fax defaults to “Do not import”; Committee / Machine Type / Bee Group warn.
3. Promote Committee → warnings update without full page reload; Machine Type still warns.
4. Counts ≈ 5 create / 0 update / 3 skip (ragged + duplicate + missing email).
5. Import → download error CSV works **without** auto-redirect.
6. Settings / custom fields list shows promoted fields.

**Claude: do this:** Perform once after WIP commit; if anything fails, fix before Task 6 version bump.

### 4.3 Correctness gaps to fix before calling migration “trustworthy”

These are **not** covered (or only partially) by the current harness. Priority order:

#### P0 — Supplied mapping does not enforce “first known target wins”

**Where:** `src/routes/members.ts` re-derive block when `body.mapping` is set (~591–613).

**Bug:** On `proposeMapping`, a second column claiming `email` is forced to `{ kind: "ignore" }` and reported as `duplicate_target`. On **supplied** mapping (admin UI re-preview and real import), the code only **records** duplicates into the warnings list — it does **not** coerce the later entry to `ignore`.

**Effect:** Warning text says “first column wins,” but `applyMapping` walks object keys and the **later** known target can overwrite the earlier field. Admin can map two columns to `email` and get silent last-wins behavior.

**Claude: do this:**

```ts
// When re-deriving from body.mapping:
if (entry.kind === "known") {
  if (seenTargets.has(entry.target)) {
    duplicates.push({ index, header: h, target: entry.target });
    mapping![index] = { kind: "ignore" }; // ENFORCE first-wins — do not only warn
  } else {
    seenTargets.add(entry.target);
  }
}
```

Add harness coverage: dry-run + real import with two columns mapped to `email`; assert only first column’s values land, second is ignored, `duplicate_target` warning present.

#### P0 — `uniqueCustomKey` renames definition but not row values

**Where:** real-import custom-field definition creation (~741–752).

**Bug:** If `entry.key` collides, code does:

```ts
const key = uniqueCustomKey(entry.key, takenKeys);
// definition stored under `key` (possibly committee_2)
// but mapping entry and customFieldsByRow still use entry.key (committee)
```

**Effect:** Definition `committee_2` is created; member values still write under `committee` (or overwrite each other when two columns slugify to the same key). Silent data/schema mismatch.

**Claude: do this:**

1. When `key !== entry.key`, rewrite the mapping entry in place:

   ```ts
   entry.key = key; // if MappingEntry is const, rebuild entry and assign mapping[idx]
   ```

2. **Or better:** after finalizing keys, re-run `applyMapping` for all rows (or remap keys in `customFieldsByRow`).

3. Prefer also using `slugifyKey()` in the admin UI (`setImportTarget`) instead of a one-off regex, so UI and server share one key algorithm.

4. Add harness: two custom columns that slugify to the same key (e.g. `Committee` and `committee!!`) → expect one definition + values under the unique key, or second column gets `_2` **and** values follow that key.

#### P1 — `joined_at` unparseable dates not warned

**Where:** `buildWarnings` only inspects end-date synonyms for `unparseable_date`.

**Effect:** Bad “Member since” values import as raw strings into `joined_at` without a dry-run warning (end date is blanked on real import via `Date` parse; joined_at path uses `row.joined_at || now` on insert without the same validation).

**Claude: do this:**

- In dry-run warnings and real import, validate `joined_at` the same way as `end_date` (parse ISO/date; if invalid, warn and leave blank / fall back to `now` consistently).
- Extend fixture or harness with a bad joined-at row if needed.

#### P1 — Import `UPDATE members … WHERE id = ?` lacks `tenant_id`

**Where:** import update statement (~868); also status SELECTs at ~836 and ~915.

**Risk:** IDs come from tenant-scoped email lookup, so practical risk is low, but it violates the project multi-tenancy rule (“every tenant-scoped query filters by `tenant_id`”). Earlier custom-field SELECT was correctly fixed to include `tenant_id`.

**Claude: do this:** Add `AND tenant_id = ?` to import-path member SELECTs/UPDATEs, binding `tenant.id`.

#### P2 — UI / API polish

| Issue | Detail | Claude action |
|-------|--------|----------------|
| `p.warnings.length` without guard | If API ever omits `warnings`, UI throws | Use `(p.warnings \|\| []).length` |
| Mapping keys as strings after JSON | Usually fine in JS; be consistent | Prefer always string keys in client state, or normalize on receive |
| Promoting empty columns (Fax) | Creates empty custom-field definitions if admin “import all unmapped” | Optional UI: “Skip empty columns” or default empty unmapped to stay ignore and dim them |
| No email column hard-stop | Spec: only hard stop is no email column | Confirm dry-run with zero email mapping returns clear error, not `will_create: 0` with silent confusion |
| Plan checkboxes | All still `- [ ]` | Mark completed tasks `[x]` after WIP + Task 6 |

#### P2 — Fixture honesty

Fixture is an **assumed** WA export shape (called out in design). First real guild export will likely break synonym lists.

**Claude: do this when a real export arrives:** Replace/extend `scripts/fixtures/wa-export-sample.csv`, add synonyms, re-run `npm run test:import`, commit fixture + synonym updates together.

### 4.4 Intentionally deferred (do not “finish” under the import plan)

From design decomposition and master program:

| Item | Notes |
|------|--------|
| **B — Import history / batch audit log** | Deferred until A is dogfooded |
| **`members.import.completed` webhook** | Master Phase 3; code comments already acknowledge bulk import does not fire per-row `member.created` |
| Events / invoices / payments / groups import | Phase 3 broader migration |
| Stable external source IDs / delta / rollback | Explicit non-goals of current design |
| Phase 2 API breadth (OpenAPI, registrations list, Make, etc.) | Separate plan |
| Un-gate site / Zapier public directory | Human product decisions |
| Support SLAs, status page | Phase 5 |

### 4.5 Master program status (strategic)

| Phase | Status |
|-------|--------|
| 0 Truth | Partially done (integrations + automations honesty); **most gap-analysis rows still AUDIT PENDING** |
| 1 Integration foundation | **Code done**; production reliability metrics **not** met/proven |
| 2 Integration breadth | Not started |
| 3 Switching moat | **Members CSV mapping only** in flight; inventory, history, cutover service, etc. open |
| 4 Complaint-led wins | Not started |
| 5 Ops advantage | Not started |
| 6 Launch | Stealth; do not launch without explicit order |

---

## 5. Documentation / hygiene issues

| Issue | Severity | Claude action |
|-------|----------|---------------|
| Root `Claude.md` says D1/KV IDs are still placeholders | Medium | Update Architecture note: IDs are real; secrets still via wrangler/`\.dev.vars` |
| Plan Task checkboxes all unchecked | Low | Mark Tasks 1–5 `[x]` after WIP commit; Task 6 when done |
| Design status still “pending implementation plan” | Low | Spec header says “Approved, pending implementation plan” — plan exists; set status to “Implementing / nearly complete” |
| Gap analysis Member database row still oversells import | Medium | After Task 6, update row to: mapping UI + custom fields + dry-run warnings + error CSV; evidence = `npm run test:import`; still not full WA migration |
| User-level notes contain live API tokens | **Critical (ops)** | Not introduced by this feature work, but tokens in agent memory/docs must be rotated if ever leaked; never commit tokens into this repo. Do **not** paste tokens into `GrokProjectReview.md` or commits |

---

## 6. Security / secret notes (repo scan)

- `apps/mobile/credentials/` keystore password is **gitignored** and not tracked — good.
- Do not commit `.dev.vars`, keystores, or `node_modules`.
- Import path correctly avoids firing hundreds of `member.created` webhooks (by design); document that for integrators so they do not expect Zapier storms on CSV import.

---

## 7. Verification matrix (as of this review)

| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | Pass |
| `npm run test:import` | Pass **with uncommitted WIP** |
| `npm run test:integrations` | Pass |
| `node scripts/e2e-auto-renew.mjs` | **Not re-run in this review** — Claude must run before Task 6 commit |
| Browser import UI | **Not verified** here |
| Production deploy / remote migrate | **Not done** (correct) |

---

## 8. Ordered worklist for Claude (copy/paste)

Do these in order. Do not skip ahead to deploy or Phase 2.

1. **Commit WIP** (`admin.html`, `members.ts`, `verify-import.mjs`) — stale warnings + error CSV UX.  
   Message: `fix(import): re-derive warnings on supplied mapping; keep error CSV on screen`

2. **Fix P0 duplicate-target enforcement** on supplied mappings; add harness assertion.

3. **Fix P0 `uniqueCustomKey` desync** (definition key vs value key); share `slugifyKey` with admin UI; add harness assertion.

4. **Fix P1** `joined_at` validation/warnings + import-path `tenant_id` on member UPDATE/SELECT.

5. **Manual browser smoke** of import UI with fixture.

6. **Task 6:** docs (`api.md`, `admin-guide.md`) + version `0.28.0-preview` both files + full test gate including `e2e-auto-renew`.

7. **Update plan checkboxes** and lightly refresh gap-analysis import claim + design status.

8. **Stop and ask human** for deploy approval. When approved: remote migrate if needed, deploy, `curl /api/version` expects `0.28.0-preview`.

9. **Do not** start Phase 2 / full migration product unless owner prioritizes it.

---

## 9. Quality assessment of Claude’s recent work

**What went well**

- Spec-first, plan-driven implementation with pure testable core (`importMapping.ts`).
- Strong harness culture (esbuild against shipped code + HTTP layers) matching repo norms.
- Real bugs found and fixed during implementation (ragged rows, coalesce wipe, tenant-scoped custom field read, stale warnings, navigate-away killing error CSV).
- Correct restraint on version ownership (Task 6) and no autonomous deploy.
- Integration Phase 1 actually fixed previously false product claims (events that never fired, read-only v1, etc.).

**What needs discipline**

- Finish the last mile: **commit WIP**, **Task 6**, **two P0 correctness holes**.
- Keep marketing language honest: this is not “lossless WA migration,” it is “trustworthy **member CSV** mapping with custom fields.”
- Keep plan checkboxes and gap-analysis in sync so the next agent does not thrash.

**Overall grade for current stream:** **A− for engineering direction**, **B for ship-readiness** until WIP + Task 6 + P0s land.

---

## 10. Suggested owner decisions (human, not Claude)

1. Approve production deploy of integrations + import after Task 6, or keep local-only until one real guild dry-run?
2. Priority next: dogfood import with a **real** WA export, or Phase 2 API breadth, or import history (B)?
3. Stay stealth until migration path is white-glove ready (master program recommends this).

---

*End of review. File path: `GrokProjectReview.md` at repo root.*
