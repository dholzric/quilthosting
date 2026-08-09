# Integration Foundation — Review Appendix

Verbatim reviews of the 2026-08-09 integration plan by Grok and Codex.
The plan itself lives in `2026-08-09-integration-ecosystem.md`; every
blocking item below was independently verified against the codebase
before the plan was revised.

---

## Review: Grok (2026-08-09)

Reviewed against the live codebase (`src/lib/outboundWebhooks.ts`, emit call sites, `src/routes/{v1,members,public,webhooks,outboundWebhooks,apiKeys,events}.ts`, site gate, harness patterns in `scripts/e2e-auto-renew.mjs`, `docs/zapier-webhooks.md`, `package.json` 0.26.1). Overall: **good diagnosis and right product direction**, but the plan is **not implementable as written** — Task 2's expected baseline is wrong, Tasks 3–5 leave two advertised events still dead on the free path the harness drives, and the harness itself will not reach `/public/*` under the stealth gate.

### Verdict

| Area | Rating | Note |
|---|---|---|
| Prior analysis / premises | Strong | Read-only v1, dead `member.created` / `event.registration`, JWT-only hook management, dead `write` scope, docs-vs-UI mismatch — all verified. |
| Architecture (catalog + emit sites + v1 write + hooks + Zapier) | Strong | Right decomposition. Catalog-as-SSoT is the correct fix for the advertisement/emitter drift. |
| Task ordering / TDD intent | Good idea | Failing harness before emitters is the right discipline. |
| Emit-site completeness | **Fail** | Free membership activation never emits `member.activated` / `membership.activated`; plan never adds those emits yet claims Task 5 makes the harness green. |
| Harness realism | **Fail** | Site gate + API key field name + free-path assumptions will make the script fail for reasons unrelated to the product gaps. |
| Task 4 paid-path instruction | Weak | Self-identified soft spot is real; show the final block, not a move-later puzzle. |
| Task 6/7 API design | Good with nits | Scope gate + https hooks are right; code has drift and incomplete SSRF note. |
| Task 8 Zapier app | Usable scaffold | Several Platform-CLI correctness issues; private-app scope is correctly deferred. |
| Task 9 docs / version | Fine | Prefer non-`sed` edits on Windows. |

**Recommendation:** fix the issues below in the plan before executing. Do not start Task 1→commit→push as written.

---

### P0 — Must fix before implementation

#### 1. Free-path `member.activated` / `membership.activated` are also dead (plan misses them)

Verified emit call sites today:

| Event | Call site |
|---|---|
| `form.response` | `src/routes/public.ts` (forms) |
| `membership.activated`, `member.activated`, `payment.succeeded` | `src/routes/webhooks.ts` **Stripe paid path only** |
| `member.created`, `member.updated`, `event.registration` | **nowhere** |

Free join in `public.ts` calls `activateMembership(...)` and enrolls automations, then returns — **no `emitTenantEvent`**. So Task 2's expected output is wrong:

```
PASS  member.activated      ← will FAIL today
PASS  membership.activated  ← will FAIL today
```

And Task 5's claim *"everything passes"* is false: after Tasks 3–5 only, free join still will not deliver those two events. The harness drives free join specifically to obtain them.

**Required plan change:** add a task (or extend Task 3/5) to emit `member.activated` + `membership.activated` on the free activation path (and preferably any other non-Stripe activation path). Best design: emit once near `activateMembership` callers (or inside a thin wrapper that has `env`), not only in `webhooks.ts`. Payload should match the existing Stripe emits (`member_id`, `email`, plus `level_id` / `level_name` for membership).

Also consider: admin/API create with `status: "active"` should probably fire `member.activated` (or at least document that it does not). Today Task 6 only emits `member.created`.

#### 2. Harness will die on the site gate for `/public/*`

`siteGate` exempts `/api/auth/*`, `/api/v1/*`, webhooks, and any request with a **valid JWT Bearer**. It does **not** exempt `/public/*`.

The harness posts to:

- `/public/${slug}/join`
- `/public/${slug}/events/.../register`

with **no** `Authorization` and **no** site-access cookie. With `SITE_ACCESS_PASSWORD` set (this repo's `.dev.vars` has it; `e2e-auto-renew.mjs` requires it), those calls get the private-preview HTML, not JSON.

`GOOGLE_AUTH_REQUIRED=false` alone is necessary but not sufficient.

**Required plan change (pick one and write it into Task 2):**

1. Prefer: send the harness admin JWT on public routes too (gate accepts any valid Bearer JWT), **or**
2. Obtain a `qh_site` cookie via `POST /site-access` using `SITE_ACCESS_PASSWORD` from `.dev.vars` (mirror how a browser would), **or**
3. Document that harness runs require `SITE_ACCESS_PASSWORD` unset **and** `ENVIRONMENT=development` — risky if someone runs against a misconfigured local that still acts closed.

Also load `.dev.vars` the way `e2e-auto-renew.mjs` does for any gate/password needs.

#### 3. Harness API key field is wrong as written

Task 6 Step 4 code uses `readKey.body.key` / `writeKey.body.key`.  
`POST /api/tenants/:id/api-keys` returns **`api_key`** (`src/routes/apiKeys.ts` ~50). The plan's "check the field name" note is correct but the pasted code will copy-paste fail. Hard-code `api_key` in the plan snippet.

#### 4. Task 2 baseline and skip list must be rewritten

After fixing (1) and (2), restate expected FAIL set **before** emitter work:

| Event | Baseline (today) | After this plan (if free-path activated emits are added) |
|---|---|---|
| `member.created` | FAIL | PASS (Tasks 3 + 6) |
| `member.updated` | FAIL | PASS (Task 5) |
| `event.registration` | FAIL | PASS (Task 4 free path) |
| `member.activated` | FAIL on free join | PASS only if free-path emit is added |
| `membership.activated` | FAIL on free join | PASS only if free-path emit is added |
| `payment.succeeded` | not driven | SKIP (or drive via signed Stripe like e2e) |
| `form.response` | not driven | SKIP (or drive a real form create+submit) |

The catalog rule ("every advertised name has a live emitter") is only honest if free activation is included. Skipping two events in the harness while advertising them is how the original bug shipped.

---

### P1 — Fix in the same plan revision

#### 5. Task 4 Step 2: show the final emit block

Agree with the self-review soft spot. Do not paste a null-filled emit and then say "move it later." Paste the final placement after the `reg` / `eventRow` lookups, guarded with `if (reg && eventRow)`, with full fields. Implementers under subagent-driven execution will otherwise leave the null payload.

#### 6. Task 7: comment promises SSRF protection the code does not implement

Comment: *"never point a hook back at ourselves (SSRF / self-loop)."*  
Code: only rejects non-`https:`. No blocklist for `quilthosting.com`, metadata IPs, or link-local.

Either:

- implement a small deny list (`localhost`, `127.0.0.1`, `*.quilthosting.com`, private ranges if you care — note Workers `fetch` already has some restrictions), **or**
- drop the claim and document "https only; SSRF hardening deferred."

https-only is fine for Zapier; the misleading comment is not.

#### 7. V1 hooks create `secret: null` — parity break with admin webhooks

Admin `POST /api/tenants/:id/webhooks` auto-generates a signing secret and returns it once. Task 7 inserts `secret` as `null`, so `X-QH-Signature` is never sent for API-created hooks.

Zapier REST hooks ignore signatures; Make / custom consumers often want them. Prefer: generate secret the same way as the admin route, return it once on `201` (`hook.secret`), never again on GET. Document that Zapier can ignore it.

#### 8. Task 6 duplicates member write logic instead of sharing

The v1 POST/PATCH reimplements insert, plan-limit checks, and update field assembly already in `members.ts`. Drift risk is real (statuses, email normalization, `directory_visible`, etc.).

Acceptable for a thin plan if you **export and reuse** `MEMBER_STATUSES` (plan already says this) **and** extract a small `createMember` / `updateMember` helper used by both route modules. At minimum, do not leave "deliberately not duplicated" as a hand-wave without the export.

Also: v1 PATCH does not allow `email` change; admin PATCH does. Document that as intentional or align.

#### 9. Admin create of `status: "active"` vs `member.activated`

If the catalog describes `member.activated` as "A member becomes active", emitting only `member.created` from admin/API create-with-active is incomplete. Either emit both, or tighten the description to "paid/free membership activation path" and list sources.

#### 10. Windows / this machine: `sed -i` in Task 9

User environment is Windows PowerShell. `sed -i` is unreliable here. Bump `package.json` + `src/version.ts` with the editor / a tiny node one-liner, not sed.

#### 11. Harness event create body: `registration_open` is ignored on POST

`events.ts` POST does not read `registration_open` (only PATCH does). Default in schema is `1`, so free registration still works today — the harness field is a no-op. Either drop it from the harness body or teach POST to accept it. Minor, but don't let an implementer "debug registration_open" for an hour.

#### 12. Worker → host sink (`http://127.0.0.1:8799`)

Local wrangler/workerd can usually reach host loopback; remote Workers cannot. State explicitly: harness is **local-only**. If sink receives nothing, first debug Worker→host networking, not emitters. Optional improvement: assert `webhook_deliveries` via `wrangler d1 execute --local` (as e2e does) as a second oracle when the sink is empty.

---

### P2 — Zapier app (Task 8) correctness

#### 13. `connectionLabel: '{{bundle.authData.tenantName}}'` will be empty

Custom auth `authData` only has `apiKey`. `/api/v1/me` returns `tenant.name` but that is not automatically copied into `authData`.

Use a perform-style test that returns label fields, e.g.:

```js
test: async (z, bundle) => {
  const res = await z.request({ url: `${BASE}/api/v1/me` });
  if (res.status !== 200) throw new Error('Invalid API key');
  return {
    tenantName: res.data.tenant.name,
    tenantId: res.data.tenant.id,
    scopes: res.data.scopes,
  };
},
connectionLabel: '{{tenantName}}',
```

#### 14. Hardcoded `https://quilthosting.com` everywhere

Fine for production private app; painful while stealth-gated and for local `zapier test`. Prefer a second auth field `baseUrl` (default production) so private testing against `*.workers.dev` or a tunnel works without forking the app.

#### 15. `eventRegistration.performList` shape mismatch

Plan hits `GET /api/v1/events` and maps events as if they were registrations. Zapier's sample/field discovery will show event fields (`title`, `start_at`), not registration fields (`registration_id`, `ticket_code`). Either:

- add `GET /api/v1/registrations` (or events/:id/registrations) and list those, **or**
- keep static `sample` only and make `performList` return `[sample]` until a list endpoint exists.

Do not pretend events are registrations.

#### 16. Write scope required for pure triggers

`POST /api/v1/hooks` requires `write`. A guild that only wants "New Member → Slack" must mint a write key. That is OK if documented in Admin UI + Zapier helpText ("write scope required for Zapier, including triggers"). Consider a future `hooks` scope; not blocking.

#### 17. `zapier validate` may need more package scaffolding

`npm init -y` + one dependency often fails validate without `main`, platform version pinning, and the expected export shape. Pin `zapier-platform-core` to a known major (don't float `latest` in a committed app), set `"main": "index.js"`, and add a one-line README for `zapier push` / private invite. Out-of-scope public directory is correctly called out.

#### 18. Missing triggers that the catalog advertises

MVP with New Member + Event Registration + Create Member is fine. Note explicitly that `member.updated`, `payment.succeeded`, `form.response`, `membership.activated` are **not** in the Zapier app yet — otherwise Task 8 over-promises relative to Task 1's full catalog.

---

### P3 — Smaller nits

- **Task 1 catalog comment vs Task 2 skips:** "Every name here MUST have a live emit + harness asserts one delivery per name" conflicts with skipping `form.response` / `payment.succeeded`. Soften the catalog comment to "every name has a known emit site; harness covers free-path events; paid/form covered by e2e X" — or actually drive them.
- **Bulk import omission:** correct call (subrequest ceiling). Good comment. Optional later: `members.imported` summary event with `{ count }` — out of scope, but better than silent bulk for automation users.
- **Idempotent Stripe event.registration:** if webhook is retried and status was already `registered`, you may re-emit. Usually acceptable; mention once.
- **`requireScope(c: any, ...)`:** matches existing `requireApiKey(c: any)` style; fine. Prefer typing with Hono context when touching the file.
- **Deploy step in Task 9:** `npm run deploy` + production curl is a human/prod action. Keep it, but do not let subagents deploy without explicit user approval (secrets, stealth gate, live traffic).
- **Per-task `git push`:** matches user standing rules; OK. Still scan for secrets before each push.
- **Out of scope list:** solid, especially store multi-SKU / retry-backoff deferrals and stealth-gate stance.

---

### Suggested plan patch (minimal)

1. **New Task 3b (or fold into Task 3):** emit `member.activated` + `membership.activated` on free join after `activateMembership` (and document Stripe path already does). Update catalog descriptions if needed.
2. **Rewrite Task 2 harness:**
   - JWT (or site cookie) on `/public/*` drives
   - use `api_key` field name
   - expected FAIL list includes activated events until 3b
   - skip only true paid/form events, with comments pointing at `e2e-auto-renew.mjs` / form route
3. **Task 4:** final paid-path emit block only (no move puzzle).
4. **Task 7:** generate+return secret; fix or drop SSRF claim.
5. **Task 6:** use `api_key` in harness snippet; export `MEMBER_STATUSES`; note email immutability.
6. **Task 8:** fix auth test/label; baseUrl field; fix registration performList; pin platform core; list which catalog events are not Zapier triggers yet.
7. **Task 9:** no sed; dual version bump via edit.

---

### What I would keep unchanged

- Single catalog module as SSoT — yes.
- No new test framework; script harness over HTTP — yes for this repo.
- Not emitting on CSV import — yes.
- Emit after Stripe confirms paid seats, not at `pending_payment` — yes.
- `write` scope enforcement + admin checkbox — yes.
- REST-hook subscribe/unsubscribe under v1 with API key — yes; this is the real Zapier blocker.
- Out-of-scope: public Zapier directory, un-gating, website builder, delivery retries — yes.
- Version jump 0.26.1 → 0.27.0 for the feature set — appropriate once free-path activated emits and v1 writes land.

---

### Bottom line (Grok)

The audit that motivated this plan is high quality and the product goal is right: **make the integration surface honest, then make Zapier possible**. Do not execute the task checklist as written until free-path activation emits and the harness gate/auth details are fixed — otherwise you will "finish" Task 5 with a still-red harness and re-learn the same lesson about advertised events that do not fire.

---

## Review: Codex (2026-08-09)

### Executive verdict

**Grok's implementation review is correct and should be treated as a blocking review, not optional commentary.** I independently checked the plan, the live route/schema structure, the current WildApricot integration surface, WildApricot's public wishlist, and recent customer-review themes.

My additional verdict is more strategic: **this is a useful integration-repair plan, but it is not an “integration ecosystem” plan and it does not, by itself, advance the product to WildApricot parity.** After Grok's fixes, the deliverable is still:

- seven outbound event names, several with incomplete lifecycle semantics;
- two Zapier triggers;
- one Zapier action;
- a private, undiscoverable Zapier app;
- five read endpoints and two member-write endpoints;
- synchronous, best-effort webhook delivery with no retry or replay;
- no Make app, WordPress/SSO path, SDK, OpenAPI contract, full-fidelity migration tooling, or integration support runbook.

That is a legitimate **Phase 1 foundation**. It is not yet a competitive ecosystem. Rename the plan goal or make the phase boundary explicit so shipping v0.27.0 cannot be reported internally or marketed as “WildApricot integration parity.”

**Recommendation:** revise this file before execution. Incorporate Grok's P0/P1 corrections, add the integration-contract and reliability gates below, and append a sequenced follow-on backlog. Keep the broader WildApricot replacement program in a separate master plan; otherwise this already-long implementation checklist becomes unexecutable.

### What Grok got right

I agree with all of Grok's P0 findings and most of the P1/P2 findings. In particular:

1. Free activation events, site-gate handling, and the `api_key` response name are hard blockers.
2. The paid registration emit must be shown in its final location with a complete payload.
3. API-created hooks must be signed; `secret: null` creates an avoidable security and parity defect.
4. The event-registration trigger cannot use events as registration samples.
5. The Zapier app needs a configurable base URL for prelaunch testing and a real connection label.
6. `sed -i`, autonomous production deploys, and per-task pushes should not be embedded as copy-paste assumptions for this Windows/private-preview environment.

I would strengthen two of Grok's “future” observations into release gates:

- A generic `write` scope is too broad for REST-hook subscriptions. Add a dedicated `hooks:write` (or `webhooks:write`) scope. A trigger-only Zap must not be able to create or mutate members.
- Delivery retry/replay is not an optional polish item if this release is called an integration ecosystem. Either implement durable delivery now or label v0.27.0 “integration developer preview” and do not recruit production automation users yet.

### P0 — Contract and reliability gaps the existing reviews did not fully cover

#### 1. Direct `fetch` after a mutation is not reliable event delivery

`emitTenantEvent` queries endpoints and awaits outbound `fetch` calls after the database mutation has already committed. If the Worker is canceled between commit and emit, the event is lost. If an endpoint is slow, the user-facing request waits. A failed call increments `fail_count`, but nothing consumes that state, retries it, disables a poison endpoint, or alerts anyone.

For production integrations, use a durable outbox/queue design:

1. Record an immutable event/outbox row as part of the domain mutation boundary.
2. Dispatch outside the user request through Cloudflare Queues or a scheduled outbox worker.
3. Retry with bounded exponential backoff and jitter.
4. Move exhausted deliveries to a dead-letter state.
5. Expose “redeliver” and “disable endpoint” controls in Admin.
6. Publish retry behavior and retention in the API docs.

If that cannot fit v0.27.0, do not overstate the result: call the current mode **best effort**, show that warning in Admin, and make durable delivery the next blocking integration release.

#### 2. Freeze a versioned event contract before adding more emit sites

The current envelope has a useful event ID and timestamp, but no explicit schema version. Payloads are hand-built at each route, so two mutation paths can emit the same event name with different fields or meanings.

Before implementation, define and test:

- `schema_version` on the envelope;
- stable event ID semantics and a distinct per-endpoint delivery/attempt ID;
- resource ID, resource type, action, tenant ID, occurrence time, and source/actor;
- required versus nullable fields for every event;
- create/update/delete/cancel semantics;
- a compatibility policy for adding, renaming, and removing fields;
- fixture snapshots shared by the Worker, Zapier app, and public docs.

The event catalog should not only list names and descriptions. It should map each event to its versioned payload schema and verified emit sources.

#### 3. Add idempotency before exposing write actions

Zapier, Make, and ordinary API clients retry requests. `POST /api/v1/members` currently uses email uniqueness as an accidental duplicate guard and returns `409` on retry. That is not a clean idempotency contract and will make successful Zaps appear failed.

Require or accept an `Idempotency-Key`, persist the key + request hash + response per tenant, replay the original response for a matching retry, and reject a reused key with a different body. Apply the same pattern to every future create/payment/registration action. Also give write responses stable machine-readable error codes, not only English strings.

#### 4. Security needs more than HTTPS and an HMAC

The plan should add:

- a dedicated hook-management scope;
- endpoint count limits per tenant and request rate limits per API key;
- strict rejection of any unknown event name (do not silently filter typos);
- URL normalization plus self-host, localhost, literal private/link-local/metadata address blocking;
- a signing timestamp and documented replay window, not only `HMAC(body)`;
- secret rotation and one-time reveal behavior;
- constant-time signature verification examples in the docs;
- maximum request body sizes and audit entries for key/hook creation, rotation, and deletion;
- redaction rules so delivery logs do not become a second long-lived database of member PII.

#### 5. The test strategy proves happy paths, not the contract

One local script and `zapier validate` are not enough for a public integration. Add tests for:

- duplicate deliveries and idempotent consumers;
- timeout, 429, 500, malformed response, DNS/connection failure, and retry exhaustion;
- signature verification, timestamp replay rejection, and secret rotation;
- tenant isolation and scope escalation attempts;
- hook limit/rate-limit enforcement;
- unknown event rejection;
- Zapier subscribe, sample, live trigger, action retry, unsubscribe, and auth rotation;
- production-like queue/dispatcher behavior, not only `127.0.0.1` delivery.

Keep the HTTP E2E harness, but add focused tests around the event schemas and dispatcher. The repo's current lack of a test runner is not a reason for the new Zapier package or delivery subsystem to remain untested.

### P1 — The competitive integration scope is much broader

WildApricot's current public material says its integration surface includes website widgets, a WordPress plugin with member login/SSO, Zapier and Make, wide webhook notifications, Admin and Member APIs, and external SSO. Its API supports much more than member writes: contacts, events, event registrations, invoices, payments, refunds, membership levels/groups, saved searches, audit logs, store objects, and more. Its webhook types cover contact, membership, event, event registration, invoice, payment, refund, renewal, membership level, and logged email changes.

By contrast, this plan's Zapier app has **New Member**, **Event Registration**, and **Create Member** only. To compete honestly, add a follow-on matrix with parity status for each resource and operation. A practical minimum sequence is:

| Priority | Triggers | Actions/searches |
|---|---|---|
| Integration GA | Member created/updated/activated; registration created/updated/canceled; payment succeeded/refunded; invoice created/paid/voided | Find member; create/update member; find event; create/update/cancel registration; find invoice/payment |
| Next | Event created/updated/canceled; membership renewed/lapsed; form response; store order paid/refunded | Create/update event; record offline payment; create invoice; add/remove group; send member email |
| Ecosystem parity | Membership-level changes, email delivery/bounce, donation, store/order, audit events | Raw authenticated API request; bulk/export jobs; integration-specific searches |

For every row, track: REST read/write support, webhook support, Zapier trigger/action/search, Make module, test fixture, documentation, and production verification.

Also add these competitive requirements:

- OpenAPI 3.1 as the canonical API contract, generated examples, and a downloadable Postman collection;
- cursor pagination and filters on every collection, including events/payments/levels;
- consistent resource envelopes and errors;
- API changelog, deprecation window, and version support policy;
- webhook replay UI and delivery diagnostics that a volunteer guild admin can understand;
- a raw “API Request” Zapier action for long-tail workflows;
- a Make app plan, not an assumption that generic webhooks equal a native Make integration;
- WordPress/member SSO decision: build, partner, or explicitly decline with a migration alternative.

### P1 — “Easy to switch” is not addressed by this plan

The existing member CSV importer is a useful start: it has a dry run, maps common WildApricot headers, and carries basic identity, status, notes, level, and dates. It is not yet a migration product. WildApricot customers also have custom fields, groups, household/bundle relationships, event and attendance history, invoices, payments, refunds, email preferences, pages/files, store records, and historical activity.

Add a dedicated WildApricot migration program with:

1. **Migration inventory:** ingest and classify every export the customer can obtain; show what can migrate automatically, manually, or not at all.
2. **Mapping UI:** preserve custom fields and group/level semantics instead of dropping unknown columns.
3. **Dry-run reconciliation:** source count, imported count, skipped count, field-level warnings, totals by status/level, and downloadable error report.
4. **Repeatable cutover:** stable source IDs, safe re-runs, delta import, rollback before go-live, and an auditable migration batch ID.
5. **Historical continuity:** event/registration, invoice/payment/refund, membership, and communication history where exports/API permissions permit it.
6. **Identity/payment truth:** explain that passwords and processor-held cards/recurring mandates generally cannot simply be copied; provide member re-verification and payment-method reauthorization campaigns.
7. **Site/domain cutover:** content inventory, URL mapping/redirects, DNS/custom-domain checklist, forms/widgets replacement, and parallel-run validation.
8. **White-glove service:** a named migration owner, test migration, board acceptance checklist, launch window, and post-cutover support.

The current plan's instruction that CSV import emits no event is sensible for row-level hooks, but add a single `members.import.completed` summary event with migration/import ID and counts. “Poll all members after import” is expensive and a poor automation contract.

### P1 — The plan does not address “better support” or operating trust

The marketing page promises “email support from real people,” “free migration help,” and “priority support,” while the current product surface is primarily a mailto link. Better support is an operational product and needs measurable commitments.

Before launch, define:

- support channels by plan and published hours;
- first-response and update targets, without promising 24/7 coverage that cannot be staffed;
- escalation ownership for payments, data loss, email delivery, and launch cutovers;
- a public status page and incident communication template;
- in-app support context (tenant, page, version, correlation ID) so volunteers do not have to diagnose the system for us;
- searchable help content, short task videos, onboarding office hours, and migration appointments;
- a visible changelog and feedback board with acknowledgement and closure loops;
- backup/restore, export, retention, and account-offboarding procedures.

This is one of the clearest places to beat WildApricot, but it cannot remain a slogan.

### P1 — Current parity documents over-credit “feature exists” as “feature is competitive”

`docs/wildapricot-gap-analysis.md` frequently marks a route, migration, or lightweight UI as parity. Competitive parity must be proven by complete user jobs, data fidelity, edge cases, accessibility/mobile UX, operational reliability, and migration coverage—not file existence.

The current WildApricot public wishlist exposes obvious low-hanging-fruit candidates that are absent or materially incomplete here. As of this review, top requests include:

| Public demand signal | Votes shown | QuiltHosting status to validate |
|---|---:|---|
| Secondary/alternate member emails | 489 | Missing data model and delivery preferences |
| General online forms | 382 | Partial; forms exist, but parity/usability requires validation |
| Donation during membership/event checkout | 377 | Missing combined checkout upsell |
| Register for multiple events in one flow | 377 | Missing cross-event cart/checkout |
| Separate registration per recurring occurrence | 320 | Partial; occurrences become separate events, UX must be tested |
| Email-to-forum/listserv | 275 | Missing |
| Member-submitted events with approval | 269 | Missing |
| Searchable/foldered email templates | 265 | Missing |
| Custom administrator permissions | 261 | Missing; fixed roles only |
| Renew membership while registering for an event | 252 | Missing combined transaction |
| Member login/activity reporting | 249 | Missing |
| Sitewide hidden coupon codes | 243 | Missing |
| Membership/event installments and trials | 241 | Missing |
| Continuing-education credit tracking | 232 | Missing; lower relevance to quilt guilds, but required for broad WA replacement claims |
| Scheduled post-event follow-up | 231 | Missing; automation engine only supports member activation |
| Mobile app customization | 227 | Missing/partial |
| Per-ticket-type registration forms | 218 | Missing registration-type model |
| Event-scoped manager permissions | 212 | Missing |
| Household/family memberships and shared emails | 209 | Missing |
| Mixed family/bundle event registration | 184 | Missing |

Do not blindly build all 3,400 wishlist ideas. Treat votes as demand evidence, cluster them by the job to be done, validate relevance with quilt guilds, and maintain a scored backlog: demand, guild relevance, switching power, revenue impact, implementation cost, support load, and legal/security risk. The table above is a strong research seed, not an automatic implementation order.

### Product-program structure required to beat WildApricot

Keep this implementation plan focused, but connect it to a master program with explicit gates:

1. **Truth and reliability:** fix dead events, freeze contracts, durable delivery, idempotency, security, replay, observability.
2. **Integration breadth:** core resource CRUD, lifecycle webhooks, OpenAPI, Zapier/Make breadth, WordPress/SSO decision.
3. **Switching moat:** migration inventory, history/custom-field import, parallel run, cutover, white-glove migration.
4. **Complaint-led product wins:** alternate emails/households, combined checkout, event registration flexibility, template/search UX, custom permissions, activity reporting, post-event automation.
5. **Operational advantage:** support targets, status/incident handling, backups/export, in-product feedback, visible shipping cadence.
6. **Launch and acquisition:** ungate intentionally, recruit 10+ Zapier beta users, publish verified comparisons and migration case studies, then submit public integrations.

Each phase needs measurable exit criteria. “Route exists” is not one. Use successful migration rehearsals, production delivery success rate, retry recovery rate, time-to-first-value, support response time, task-completion usability, and customer acceptance.

### Pricing comment

The $24/month active-member model is a real wedge against WildApricot's current contact-tier pricing (starting at $66/month for 100 contacts on monthly billing). Preserve the simple pricing story, but model support, email, SMS, storage, migration labor, and high-volume tenants before promising unlimited usage forever. “Cheaper” should mean a predictably lower total cost with clear limits and no surprise contact counting—not a price that makes excellent support financially impossible.

### Required edits before anyone executes this checklist

1. Apply every Grok P0 and P1 correction.
2. Change the title/goal to **Integration Foundation** or explicitly label this Phase 1.
3. Add free-path activation emits and make the harness baseline truthful.
4. Add versioned payload schemas and snapshot fixtures.
5. Add API idempotency and stable error codes before the first Zapier action.
6. Replace generic trigger access to `write` with a dedicated hook scope.
7. Decide: durable queue/outbox now, or developer-preview labeling with no production automation promise.
8. Add signing timestamp/rotation, endpoint limits, strict event validation, PII retention, and API-key rate limits.
9. Expand Task 8 tests beyond `zapier validate`; run real subscribe/trigger/action/unsubscribe flows.
10. Remove automatic production deploy/push assumptions from worker instructions; make deployment a human-approved release step.
11. Add the parity matrix and follow-on phases above so this slice cannot be mistaken for the whole competitive strategy.
12. Create a separate, evidence-backed WildApricot parity and complaints backlog; revise the existing gap analysis from “code exists” to end-to-end competitive acceptance criteria.

### Sources checked for this Codex review

- [WildApricot features](https://www.wildapricot.com/features)
- [WildApricot integrations](https://www.wildapricot.com/features/integrations)
- [WildApricot pricing](https://www.wildapricot.com/pricing)
- [WildApricot webhook types](https://gethelp.wildapricot.com/en/articles/1670-webhooks)
- [WildApricot API pagination/resource list](https://gethelp.wildapricot.com/en/articles/2911-updating-your-api-integrations-for-pagination)
- [WildApricot public wishlist, sorted by votes](https://forums.wildapricot.com/forums/308932/filters/top)
- [WildApricot Make module catalog](https://apps.make.com/wild-apricot)
- [Recent G2 reviews](https://www.g2.com/products/wildapricot/reviews)
- [Recent Capterra reviews](https://www.capterra.com/p/76116/WildApricot/reviews/)

### Bottom line (Codex)

The opportunity is real: pricing resentment, dated UX, uneven support, and a long public request backlog create a credible opening. But the winning strategy is not “ship more checkboxes.” It is **reliable core workflows, lossless switching, visibly better support, and complaint-led features that remove recurring volunteer pain**.

Execute this plan only after the blocking corrections. Then treat it as the integration foundation—not the finish line and not evidence that QuiltHosting already matches WildApricot's ecosystem.
