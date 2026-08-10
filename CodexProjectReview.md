# QuiltHosting Current Project Review

**Review date:** 2026-08-10
**Reviewer:** Codex (OpenAI)
**Point-in-time branch:** `main` at `574925d7c9124df38517da271eda19eb6ea03d7f`
**Version in tree:** `0.28.0-preview`
**Production deployment:** not performed or verified in this review

## Executive verdict

Claude has made a substantial, useful advance. The integration work is now a
real foundation instead of a collection of advertised-but-dead endpoints, and
the member CSV importer is dramatically safer than it was. The current commit
passes every local verification command I ran.

It is **not production-ready integration infrastructure**, **not yet a
trustworthy migration product**, and **nowhere near full WildApricot parity**.
Passing the current harnesses proves the happy paths that they drive; it does
not prove the failure and concurrency behavior on which the strongest product
claims depend.

The biggest release blockers are:

1. An application mutation and its webhook outbox insert are separate writes.
   A Worker interruption between them permanently loses the event even though
   the docs claim the outbox is in the database transaction.
2. Queue retries ignore the recorded `next_attempt_at`, concurrent dispatches
   are not claimed/locked, and one failed endpoint causes successful endpoints
   to be redelivered.
3. The JWT/admin webhook routes bypass the URL, event, and tenant limits used by
   the safer v1 routes. They can store insecure/private/self-loop targets and
   then server-side `fetch` them.
4. API idempotency keys are tenant-wide rather than operation-scoped and are
   not concurrency-safe.
5. A supplied CSV mapping can map multiple columns to the same native/custom
   target and silently use the last value, despite warning text saying the
   first wins.
6. A real import can partially write members/custom-field definitions, swallow
   membership-assignment failures, and still return `ok: true`.

My recommendation is to keep the product gated and call the current work a
**local developer preview**. Fix the P0 items below, run one real WildApricot
export through a browser rehearsal, then cut `0.28.0-preview`. Do not let the
green tests or the number of recent commits turn into a parity claim.

## Current status by workstream

| Workstream | What is genuinely done | What remains before its exit gate |
|---|---|---|
| Phase 0 — product truth | The gap analysis now admits that most old checkmarks meant “code exists,” and integrations/automations were re-audited. | Most claimed parity rows still have no complete user-journey evidence. The phase was not completed before later phases started. |
| Phase 1 — integration foundation | Seven catalogued events; schema/version envelope; outbox/queue/DLQ/sweeper; emitters on the named paths; v1 member writes; REST hooks; granular scopes; replay UI; private Zapier scaffold; local harness. | Correct durability/retry semantics, safe admin hook parity, concurrency-safe idempotency, failure-path tests, production metrics, and a real Zapier subscribe/trigger/action/unsubscribe run. |
| Phase 2 — integration breadth | Not materially started beyond the Phase 1 member slice and existing read endpoints. | CRUD for events/registrations/invoices/payments/levels/groups, lifecycle events, OpenAPI, pagination/error consistency, Make, API-request action, rate limits, retention, and more. |
| Phase 3 — switching moat | Member CSV mapping slice: positional parsing, synonyms, dry-run warnings, custom-field import, reconciliation counts, re-run-by-email, and skipped-row CSV. | P0 correctness below; real WA export; batch audit/history; stable source IDs; rollback/delta; groups/households/history/financials/content; payment reauthorization; site/domain cutover; white-glove runbook. |
| Phase 4 — complaint-led wins | Research seed and prioritization framework exist. | The actual complaint-led feature clusters are not implemented or user-validated. |
| Phase 5 — support/operations | Marketing promises exist. | Support is still primarily mailto links. No staffed hours/SLA, ticket context, incident process, status page, backup/restore procedure, or 30-day proof. |
| Phase 6 — launch | Deliberately not started; site remains gated. | Unit economics, pilot migrations, production reliability, support capacity, beta users, ungating decision, case studies, Zapier/Make submission. |

## What Claude completed well

### Integration foundation

- `src/lib/webhookEvents.ts` is now the single event vocabulary with payload
  schemas, schema version, descriptions, and fixtures.
- The previously dead `member.created`, free-path activation, registration,
  and member-update emissions now have real call sites.
- Stripe activation/payment coverage passes the dedicated auto-renew E2E.
- v1 member create/update enforce granular write scope and support an
  idempotency key on the normal sequential retry path.
- The v1 hook API rejects HTTP, loopback, self-loop, and unknown event names;
  signing secrets are returned once and omitted from list responses.
- The private Zapier project is structurally valid and contains two hook
  triggers plus one create-member action.
- The integration documentation is much more honest about preview scope,
  DNS-rebinding limitations, missing rate limits, and CSV import behavior.

### Member CSV migration slice

- Mapping is keyed by column index, so duplicate header text does not collapse
  the source data.
- Unknown non-empty columns are reported instead of silently discarded.
- Ragged rows are skipped rather than shifted into the wrong fields.
- Dry run does not create members or custom-field definitions.
- Imported custom values merge over existing member values; an omitted custom
  column no longer erases hand-entered data.
- Re-running the fixture converges by email rather than duplicating members.
- Full skipped-row details are returned and can be downloaded as a CSV.
- Commit `a688c4d` correctly preserved warnings after a mapping edit, escaped
  sample text before injecting it, and kept the error-download controls on
  screen. Grok's statement that these fixes were still uncommitted is now
  stale; they are committed in the current branch history.
- Commit `574925d` added the bulk-import API/admin documentation and bumped
  `package.json` and `src/version.ts` together to `0.28.0-preview`. It changed
  no runtime implementation. Some new documentation statements describe the
  intended behavior rather than the actual behavior; those are called out
  below and must be fixed before deploy.

## Verification performed for this review

| Command | Result | What it proves / does not prove |
|---|---|---|
| `npx tsc --noEmit` | Pass | Current TypeScript compiles. |
| `npm run test:scale` | Pass | Pagination/audience scale helpers and expected migration indexes pass their scripted checks. |
| `npm run test:import` | Pass, all layers | Mapping vocabulary, HTTP dry run, fixture import, skipped rows, re-run convergence, and value-preservation cases pass. It does not test malformed mappings, collisions, partial failure, concurrency, or the browser. |
| `npm run test:integrations` | Pass | Six directly driven events delivered; v1 scope/idempotency happy path and safe v1 hook CRUD pass. `payment.succeeded` is deliberately driven elsewhere. It does not test delayed retry, DLQ, concurrent dispatch, admin hook CRUD, or cryptographically verify the signature. |
| `node scripts/e2e-auto-renew.mjs` | Pass | Local signed Stripe checkout, renewal, sequential replay dedupe, and the three Stripe event rows pass. |
| `npm test` in `integrations/zapier` | 25 checks passed, 0 failed, 6 general warnings | Structurally valid app only. No live Zapier account lifecycle was tested. Warnings include input-cleaning flags, missing auth help links, and user-entered base-URL validation. |

No production delivery metrics, remote deployment, remote migration, or human
browser walkthrough was performed by Codex. The untracked
`GrokProjectReview.md` was read and preserved.

## P0 — fix before preview deployment or pilot data

### P0.1 — The “durable outbox” can lose events

**Evidence:** `enqueueEvent()` inserts the outbox row in
`src/lib/webhookOutbox.ts:98`, but its callers perform the business mutation
first and then separately call `enqueueEvent` (for example member create in
`src/routes/members.ts:94`). `docs/zapier-webhooks.md:90` says the event is
written “inside the database transaction.” That is not what the code does.
`enqueueEvent` also catches its own insert errors and lets the main request
succeed.

**Failure:** the member/payment/registration can commit, the Worker can stop or
the outbox insert can fail, and the event never exists for the queue or sweeper
to recover. This is the exact gap an outbox is supposed to remove.

**Claude: do this**

1. Split event preparation from dispatch. Create a helper that validates the
   payload, creates the event ID/envelope data, and returns a prepared D1 outbox
   insert statement plus the ID.
2. Append that statement to the **same `DB.batch`** as the domain mutation. For
   paths with several events, append all outbox statements to that batch.
3. Only after the batch succeeds, schedule queue sends with `waitUntil`. Queue
   send failure is recoverable because the committed outbox rows exist.
4. Do not swallow an outbox database failure when the event is contractually
   part of the mutation. Fail/roll back the entire batch.
5. Add a deterministic test that forces the outbox insert to fail and proves
   the domain row also does not commit, plus the inverse queue-send-failure case
   proving the outbox remains sweepable.
6. Correct the documentation only after the atomic test passes.

### P0.2 — Retry timing, claiming, and fan-out state are incorrect

**Evidence:** `dispatchOutboxRow` records `next_attempt_at` at
`src/lib/webhookOutbox.ts:322-328`, then throws. The consumer calls
`msg.retry()` without a delay. The dispatcher does not check `next_attempt_at`.
The row is never atomically moved from `pending` to a claimed/leased state.
It loops every subscribed endpoint on every attempt and stores only one status
on the parent outbox row.

**Failures:**

- Queue redelivery can happen immediately instead of at the documented
  1m/5m/25m/etc. schedule and can exhaust the queue budget early.
- The minute sweeper and queue, or duplicate queue messages, can dispatch the
  same pending row concurrently.
- If endpoint A succeeds and endpoint B fails, A is sent the same event on
  every retry. At-least-once allows duplicates, but this design creates
  avoidable duplicates and resets endpoint state misleadingly.
- A process crash has no explicit delivery lease/recovery state.

**Claude: do this**

1. Add an atomic claim (`pending` -> `delivering`) with a lease timestamp and a
   compare-and-set condition. If zero rows change, another worker owns it.
2. Make the sweeper reclaim expired leases, not live deliveries.
3. Honor the computed delay using the Queue delay option supported by the
   installed Cloudflare types, or schedule a delayed replacement message and
   acknowledge the current one. Do not both immediately retry and rely on the
   database timestamp.
4. Persist delivery state per `(outbox_id, endpoint_id)` and retry only failed
   targets. Keep `X-QH-Delivery` stable for that target.
5. Decide explicitly how 408/429/5xx, other 4xx, timeout, disabled endpoint,
   and no-subscriber cases behave.
6. Add tests for timeout, 429, 500-then-200, permanent 400, duplicate queue
   messages, concurrent claim, mixed-success fan-out, replay, auto-disable,
   lease recovery, and DLQ exhaustion.

### P0.3 — Admin webhook CRUD bypasses the safe v1 rules (SSRF/config risk)

**Evidence:** `src/routes/outboundWebhooks.ts:94-170` accepts HTTP or HTTPS with
a string-prefix check, has no `validateHookUrl`, allows arbitrary event names
on PATCH, and applies no 25-hook limit. `POST /:id/test` then server-fetches the
stored URL. The v1 hook route has substantially better validation.

**Failure:** an authenticated tenant admin can store a loopback/private/
self-domain URL (or a DNS-rebinding hostname) and make the Worker request it.
Typos create subscriptions that can never fire. Admin and API behavior diverge.

**Claude: do this**

1. Extract one hook create/update service used by both admin and v1 routes.
2. Require HTTPS, call `validateHookUrl`, strictly validate every event against
   the catalog, and enforce the same per-tenant limit on both routes.
3. Apply validation to PATCH as well as POST, and include `tenant_id` in the
   final UPDATE condition.
4. Put an outbound timeout/response-size ceiling on the test and delivery
   fetches. The hostname deny list remains incomplete until resolved IPs are
   checked at connection time; keep that limitation explicit.
5. Add a one-time secret-rotation endpoint/UI that updates
   `secret_rotated_at`; the column exists but no workflow uses it.
6. Correct the admin response: signatures cover
   `{timestamp}.{raw body}`, not only the body.
7. Add admin-route parity tests for every rejection the v1 harness checks.

### P0.4 — API idempotency is not operation-scoped or concurrency-safe

**Evidence:** migration `0013` makes `(tenant_id, idempotency_key)` unique.
`withIdempotency` hashes only `JSON.stringify(body)`, performs the mutation,
and inserts the cached response afterward. It catches the unique-index race
without reading/reconciling the winning response.

**Failures:**

- Reusing `abc` on member create and member patch can replay an unrelated
  response or report a false body conflict.
- Two simultaneous first requests can both run the mutation before either
  stores the idempotency record.
- Records have no expiration/cleanup and all sub-500 responses, including
  transient throttling or plan failures, can be retained indefinitely.

**Claude: do this**

1. Add an operation identifier (HTTP method + canonical route/action) to the
   schema, lookup, request hash, and unique key.
2. Reserve the operation/key atomically before executing. Define a `pending`
   response for concurrent callers and a recovery policy for abandoned
   reservations.
3. Where possible, commit the mutation, its outbox rows, and the completed
   idempotency response in one D1 batch. Use deterministic resource IDs so an
   abandoned pending operation can be reconciled safely.
4. Set and document retention/expiry; add a cleanup job. Decide which response
   classes are cacheable rather than caching every non-5xx by default.
5. Test same key across routes, simultaneous identical requests, simultaneous
   different bodies, crash after reservation, and retry after transient error.

### P0.5 — Supplied import mappings can silently overwrite columns

**Evidence:** in `src/routes/members.ts:599-613`, duplicate known targets are
reported but the later entry remains in `mapping`. `applyMapping` then assigns
the later value over the first. Custom targets have no collision detection.
In the definition loop, `if (takenKeys.has(entry.key)) continue` means
`uniqueCustomKey()` is never allowed to suffix an actual collision. Two new
headers that slugify to the same key write one definition and the last cell
wins. The new `docs/api.md` now says duplicate targets are ignored and the
first wins, which makes this implementation bug an externally documented false
guarantee.

Grok correctly identified this area as a blocker, but its exact
“definition renamed to `_2` while values use the old key” explanation does not
match the current branch: the early `continue` prevents the rename entirely.
The real current failure is silent target collapse/last-wins data loss.

**Claude: do this**

1. Add a server-side Zod schema for `header`, `raw_rows`, and `mapping`.
   Whitelist entry kinds and native targets; constrain indices, string lengths,
   row/cell sizes, custom key syntax, and mapping count.
2. Canonicalize the complete mapping **before applying any row**. Track claimed
   native targets and claimed custom keys. Either reject conflicts with a
   machine-readable `mapping_conflict` or force later entries to ignore and
   return the canonical mapping. Do not warn “first wins” while executing
   last-wins.
3. Require exactly one email target for a real import. The design says absence
   of email is the hard stop; current code merely skips every row.
4. Resolve custom-key suffixes in the canonical mapping first, then run
   `applyMapping` with those final keys. Existing custom-field matches should
   remain deliberate; two source columns targeting one existing field must
   still be treated as a conflict.
5. Have the server provide the suggested key. The browser currently has a
   second, weaker slugifier that can produce an empty key for punctuation-only
   headers.
6. Disable already-claimed targets in the UI and show the conflict next to the
   affected columns.
7. Add dry-run and real-import tests for two email targets, two identical
   custom targets, two headers with the same slug, punctuation-only headers,
   out-of-range mapping indices, unknown kinds/targets, no email target, and an
   oversized mapping.

### P0.6 — Import success is not atomic or truthfully reconciled

**Evidence:** custom-field definitions are written before member batches;
member statements are committed in groups of 50; membership activation occurs
afterward one member at a time. Activation exceptions are only logged at
`src/routes/members.ts:952-954`, and the route still returns `ok: true`.

**Failure:** a mid-import error can leave definitions and some members written.
A membership failure leaves a member pending or in the wrong state without an
entry in `skipped_rows`. The admin sees a success summary that is not a full
reconciliation. There is no batch ID, persisted report, resume, or rollback.

**Claude: do this**

1. Pull the minimal import-history/batch model forward rather than treating it
   as optional polish. Persist `import_batch` status, source hash, canonical
   mapping, counts, row errors, and timestamps before applying data.
2. Stage/validate all rows, then process resumable chunks under the batch ID.
   Mark a batch `completed`, `partial`, or `failed`; never return plain `ok`
   after swallowed row failures.
3. Include membership assignment failures in the row-level reconciliation and
   downloadable error file. Retry only safe failed rows.
4. Make custom-field definition changes concurrency-safe. The current
   read/modify/write of all `settings_json` can overwrite a simultaneous
   settings edit; use normalized definitions or optimistic version checking.
5. Define rollback for a rehearsal: restore changed records from captured
   before-state or delete only rows created by the batch. Exercise it in a
   test before promising rollback.
6. Until this exists, limit the claim to “member CSV preview/import,” not
   “lossless” or “trustworthy migration.”

## P1 — important correctness/security work

### P1.1 — Finish import data fidelity and UI safety

- `buildWarnings` validates the expiry/end date but not `joined_at`; real
  inserts can store an unparseable raw joined date. Parse and normalize both,
  warn consistently, and define the fallback.
- The free-plan dry-run estimate counts invalid, duplicate, and already-active
  cases differently from the real loop. Use one pure reconciliation simulator
  for preview and execution decisions so `plan_limit_will_hold` is exact.
- Rapid select changes launch overlapping previews. A late older response can
  replace the newest mapping. Add an `AbortController` or monotonically
  increasing revision, ignore stale responses, and disable Import until the
  latest preview finishes.
- Error-CSV row numbers are data-array indices starting at 1, not actual source
  file line numbers (the header is line 1). Return both `data_row` and
  `source_line`, or use source line `index + 2` consistently.
- Neutralize spreadsheet-formula cells beginning with `=`, `+`, `-`, or `@`
  in the downloadable error CSV while preserving the original value for a
  safe re-import workflow.
- Add `tenant_id` to import-path member UPDATE and the status SELECTs at the
  current `src/routes/members.ts:835`, `:868`, and `:915`. IDs originate from a
  tenant query, but every tenant-owned query should enforce the boundary.
- Test a 5,000-row realistic file for Worker CPU, memory, D1 calls, response
  size, and browser responsiveness. The row ceiling alone is not a scale test.

### P1.2 — Harden Stripe/event consistency

- Stripe dedupe is a read-before-write check while the payment intent index is
  non-unique. Concurrent webhook deliveries can both pass. Add an atomic
  processed-Stripe-event record keyed by Stripe event ID and appropriate unique
  constraints for payment/invoice references.
- Paid registration currently emits even if its event lookup failed, using an
  empty `event_title`. Do not emit an invalidly incomplete business event;
  require the registration/event/tenant records and record a recoverable error.
- The Stripe comment saying a retry can re-emit and consumers can dedupe by
  envelope ID is misleading: a new enqueue would create a new envelope ID.
  Deduplicate at the Stripe source event, then document that behavior.
- The store-order lookup in `src/routes/webhooks.ts:333` omits `tenant_id`.
  Add it even though order IDs are intended to be globally unique.

### P1.3 — Close API-key, hook, and retention gaps

- The API-key route only adds `read` when the submitted list is empty. A caller
  can mint `hooks:write` without `read`, contrary to the docs. Either always
  union `read` server-side or make read permissions explicit and enforce them
  on every GET, including `GET /api/v1/hooks`.
- Add per-key rate limits and expose quota headers. Public/auth rate limiting
  does not protect the v1 API.
- Add retention/redaction rules for `webhook_deliveries.payload_json`; it can
  contain member PII.
- Add expiration/cleanup for idempotency records and delivery logs.
- API collection coverage remains uneven: members paginate; several v1 lists
  use a fixed `LIMIT 200`. Phase 2 should apply cursor pagination and filters
  consistently.

### P1.4 — Prove the Zapier app instead of only validating it

1. Normalize the configurable base URL (trim trailing slashes) and validate its
   scheme/host; Zapier's own validation warning calls this out.
2. Decide and document required scopes at authentication. A connection can
   currently test successfully but later fail when a trigger/action needs a
   scope it lacks.
3. Fix the README count (“These four” while listing five) and the registration
   wording. A waitlisted registration does not “take a seat.”
4. Address the six Zapier general warnings or record why each is accepted.
5. Run and record a real private-app lifecycle: authenticate, subscribe, cause
   an event, receive it, create a member, replay safely, turn the Zap off, and
   prove unsubscribe. Local `zapier-platform validate` is not this test.

### P1.5 — Repair documentation and tracking drift

- Every checkbox in both implementation plans remains unchecked although the
  associated commits exist. Add a status ledger with commit IDs and
  verification evidence; leave genuinely open steps unchecked.
- `docs/superpowers/specs/2026-08-10-trustworthy-migration-design.md` still says
  “pending implementation plan,” although the plan and most code exist.
- `CLAUDE.md:32` says D1/KV IDs are placeholders; `wrangler.toml` has real IDs.
- `docs/zapier-webhooks.md` overclaims an atomic outbox transaction. Correct it
  immediately as a known limitation or after implementing P0.1.
- The gap analysis still has many old checkmarks under a warning that they are
  unaudited. Replace them with `AUDIT PENDING` rows and concrete acceptance
  tests rather than leaving contradictory symbols.
- The master parity matrix still says “Phase 1” instead of current evidence and
  has no named owner/review cadence. Update it as a living artifact.
- Task 6 added `docs/api.md` and `docs/admin-guide.md` and bumped both version
  files in `574925d`. However, `docs/api.md` says duplicate supplied targets
  are ignored/first-wins when they are currently last-wins, and says warnings
  are computed identically for dry and real imports although the real response
  does not return `warnings`. Correct the contract to match fixed behavior.
  Public getting-started copy still describes only the older simple import.

`0.28.0-preview` now exists in the tree, but it has not been deployed. Treat it
as an unreleased version marker, close the P0 correctness issues, and update the
docs again before asking to deploy it.

## P2 — program work required to beat WildApricot

The recent work is a narrow foundation, not the “do everything WA does, but
better and cheaper” outcome. The master plan is directionally good and should
remain the program of record, with these execution priorities:

1. **Finish truth before feature count.** Audit events, email/bounces,
   membership lifecycle, financials/refunds, website builder, store, directory,
   mobile, permissions, forms, and reports as complete volunteer tasks with
   failure cases. Code existence earns no parity checkmark.
2. **Make switching the moat.** After the member-import blockers, use a real WA
   export and build inventory, source IDs, groups/households, history,
   reconciliation, rollback, payment reauthorization, content/URL/DNS cutover,
   and board acceptance. Three real rehearsed migrations are the gate.
3. **Build integration breadth.** Cover the resource/operation matrix with API,
   lifecycle events, Zapier, Make, OpenAPI, examples, and production evidence.
   Today only the Member row is close even locally.
4. **Turn support into a product.** A mailto link does not beat WA support.
   Choose staffing and published hours; add ticket ownership, escalation,
   tenant/page/version/correlation context, status/incident communication,
   migration appointments, help content, and measurable response targets.
5. **Validate complaint clusters with quilt guilds.** The highest-leverage
   likely cluster remains households/alternate emails/combined
   renew-and-register, but do not treat public vote counts as an automatic
   backlog. Record interviews and acceptance criteria.
6. **Prove “cheaper” is sustainable.** Model support labor, migration labor,
   Resend, SMS, storage, queue/Worker/D1 usage, Stripe/platform fees, and large
   guild behavior before promising unlimited usage at $24. Better support and
   white-glove migration cannot be funded by wishful unit economics.

## Ordered handoff for Claude

Claude should work in this order and stop at the deployment gate:

1. Preserve `GrokProjectReview.md` and this review; update the project status
   ledger to HEAD `574925d`.
2. Fix P0.5 first (canonical validated import mapping and collision tests).
3. Fix P0.6 plus P1.1 (truthful batch result, failures, date/tenant/UI cases).
4. Perform a browser walkthrough with the fixture, including fast mapping
   changes and the skipped-row download. Save dated evidence.
5. Run a sanitized real WildApricot member export in dry-run mode; update the
   fixture/synonyms and document every unsupported source field. Do not import
   customer data into a shared development tenant.
6. Fix P0.1/P0.2 and add the outbox failure/concurrency suite.
7. Fix P0.3/P0.4 and the Stripe/API P1 items.
8. Run the real Zapier lifecycle and retain the result.
9. Correct the Task 6 docs, repair stale plans/gap analysis/`CLAUDE.md`, and
   keep `0.28.0-preview` unreleased until the preceding gates pass.
10. Rerun `tsc`, scale, import, integrations, auto-renew, Zapier validation,
    and the new failure suites from a clean worktree.
11. Stop and ask the owner before remote migrations, deploy, ungating, or
    recruiting production automation users.
12. After owner approval, deploy, verify `/api/version`, queue/cron bindings,
    outbox dashboards, and remote migrations; then begin the seven-day Phase 1
    production reliability window.

## Release call

**Current call: NO-GO for production/pilot claims.**
**Safe label:** local, unreleased `0.28.0-preview` foundation, gated.
**Next credible gate:** P0 import fixes + real export rehearsal + P0 integration
reliability/security fixes + real Zapier cycle + clean full verification.

The opportunity is still attractive. The product can win on predictable
active-member pricing, volunteer usability, refunds, switching help, and
support. The money is in making those claims demonstrably true under failure,
not in getting the most checkmarks into the repo first.
