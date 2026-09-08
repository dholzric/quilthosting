# QuiltHosting readiness review and implementation handoff

**Author: Codex / Astra — September 8, 2026**  
**Audience: Claude implementing the next release**  
**Baseline:** `48511170ef9660c02c4bd8d05a2964b3d335a52c`, package `0.54.0-preview`.

## Decision

**NO-GO for an unrestricted commercial launch.** There is a substantial product here, but important customer actions fail and the authorization, content isolation, authentication, and payment recovery boundaries need work before accepting production customers. The strongest competitive opportunity is an easy website builder combined with dependable guild administration and assisted migration. More feature labels will not compensate for broken registration or lost payment fulfillment.

The website-building experience is currently split: guilds have a basic visual block editor; business tenants have a JSON textarea. Neither provides a complete, safe draft-to-publish workflow. The customer should be able to produce a good website without knowing JSON, HTML, font keys, image URLs, or DNS terminology.

This is a review and implementation brief, not a completed implementation. Only this file was added. Existing reviews and application code were preserved. Keep stealth protections in place until launch is explicitly authorized.

## Evidence and limits

| Check performed in this review | Result | What this establishes |
|---|---|---|
| `npx tsc --noEmit` | PASS | Current TypeScript compiles. |
| `npm test -- --reporter=dot` | 28 files / 399 tests PASS | Existing unit coverage passes. Several tests deliberately log failure scenarios; some project tests also log missing execution context and unset email configuration. This is not proof of actual email/outbox delivery. |
| `npm run test:scale` | PASS | Pagination/audience helpers and source assertions pass. This is not a production load test. |
| `npm audit --omit=dev --json` | Zero reported production dependency vulnerabilities | Package advisory check only; it does not cover application vulnerabilities or development dependencies. |
| Requests to production `/`, `/admin`, and Workers preview `/` | HTTP 401 | Anonymous access remains gated. `/robots.txt` returns 200. No authenticated production workflow was tested. |
| Real Worker dispatch with a synthetic signed Viewer JWT and mocked D1 | Page creation 201; write-key creation 201 | The actual route/middleware chain permits these operations for a Viewer. No production records or keys were created. |
| Real authentication code with synthetic credentials | Session accepted at `/api/auth/verify-magic` with 200; emoji-containing name throws `InvalidCharacterError` | Token purpose confusion and Unicode failure reproduced. |
| Chromium: real block renderer output inserted into a fixture DOM | Harmless inline image error handler executed | Raw HTML remains executable. No token extraction or external payload was used. |
| Chromium: business builder module with fixture API | New page exposes `Blocks (JSON)` | Confirms the customer-facing editor is a JSON form. This isolated module check did not include the full admin stylesheet. |
| Chromium: actual `guild.html` + CSS, synthetic API responses, 390px viewport | Homepage Join opens dialog; Membership Join and Events Register open no dialog | Conversion failure reproduced with no page errors. These fixture pages had no horizontal overflow. |

Temporary probe sources and JSON evidence are in `%TEMP%\qh-astra-review-20260908\`: `probe.mjs`, `evidence.json`, `guild-browser.mjs`, `guild-browser-evidence.json`. These are review evidence, not a committed test suite; convert the important probes to maintainable regression tests. The first browser fixture attempt omitted `info.tenant` and was corrected before the results above were recorded.

**Not verified here:** production Stripe/Resend configuration, a complete paid join/renew/refund, live custom-domain provisioning, actual D1 load at scale, backups/restores, mobile app distribution, accessibility compliance, or every route's tenant isolation. Existing HTTP integration/import/delivery/business-site scripts were inspected but not rerun; several mutate shared local D1 fixtures or require a running local Worker. Use isolated test state when running them. Do not carry forward August audit PASS results as current evidence.

## Priority map

P0 means fix before production customer use; P1 means required for a credible self-service paid pilot; P2 means prioritize against target-customer demand after the core is dependable. Static findings below identify code paths, not claims of observed production exploitation or data loss.

| ID | Priority | Work | Evidence |
|---|---|---|---|
| SEC-1 | P0 | Enforce roles at every tenant API boundary | Local route reproduction |
| SEC-2 | P0 | Stop executable tenant content on application origins | Browser reproduction + source |
| AUTH-1 | P0 | Separate magic-link tokens, sessions, and OAuth state | Local reproduction + source |
| PAY-1 | P0 | Make Stripe processing recoverable and idempotent | Static failure-path trace |
| WEB-1 | P0 | Restore Join/Register on dedicated public pages | Browser reproduction |
| PAY-2 | P0 | Make seats/inventory reservations atomic and expiring | Static failure-path trace |
| MAIL-1 | P0 for bulk email | Add consent, unsubscribe, suppression, delivery feedback | Missing in inspected implementation |
| BUILD-1 | P1 | One accessible visual editor for guild and business sites | Source + browser fixture |
| BUILD-2 | P1 | Drafts, preview, revisions, autosave, and concurrency protection | Missing in inspected editor/schema |
| BUILD-3 | P1 | Fix content representation drift and silent fallback writes | Static data-flow trace |
| ONB-1 | P1 | Outcome-driven, resumable onboarding and assisted migration | Static workflow trace |
| ONB-2 | P1 | Reliable login, email delivery, and domain provisioning | Source + Unicode reproduction |
| OPS-1 | P1 | Reliable mail scheduling and resumable background work | Static scheduling trace |
| PERF-1 | P1 | Measure and improve real page/API performance | Source; load not measured |
| SEC-3 | P1, before public writes | Input limits, abuse controls, audit and privacy boundaries | Source |
| OPS-2 | P1 | Deployment checks, observability, restore, and customer support | Missing/unverified operational evidence |
| COMP-1 | P1/P2 | Close customer-specific competitive gaps | Inventory + current primary sources |

## P0 findings

### SEC-1 — Viewer can change the site and create a persistent write credential

**Evidence:** `src/index.ts:344` mounts tenant routes behind `requireAuth`, `tenantMiddleware`, and `requireTenantAccess`. `src/middleware/auth.ts` accepts any `tenant_users` role and attaches `tenantRole`; it does not restrict operations. `src/routes/pages.ts` and `src/routes/apiKeys.ts` do not check that role. The synthetic Viewer received 201 from both POST endpoints, including an API key with `members:write` scope.

**Impact:** UI navigation restrictions do not protect the API. A read-only staff member can publish content and mint credentials whose lifetime is independent of their browser session. Membership and events chairs also need bounded permissions. Some routes already enforce owner/admin checks, such as team, billing, domain, and projects; preserve those protections rather than assuming the entire application lacks authorization.

**Implementation:** Define one explicit permission matrix and reusable `requirePermission` middleware. Cover reads involving sensitive information as well as POST/PATCH/DELETE, exports, emails/SMS, refunds, webhooks, files, site settings, and key issuance. Owner/admin manage credentials; a user cannot mint scopes exceeding their own permissions. Specify whether staff removal revokes keys they issued. Audit credential creation and privileged changes with actor, tenant, target, time, and result.

**Acceptance:** Table-driven route tests for owner/admin/membership/events/viewer/platform/anonymous and a second tenant. Viewer page/key writes return 403 without DB writes. Events chair cannot alter memberships or refund unrelated payments. Changing request tenant IDs, object IDs, headers, and hostnames never crosses tenants. UI and API derive access from the same matrix.

### SEC-2 — Tenant content can execute JavaScript where admin sessions are stored

**Evidence:** `src/lib/blocks.ts` passes `text.html` and `html.html` directly into output; `contentFromPage` also returns legacy `content_json.html` unchanged. `public/guild.html:270`, the homepage, and blog rendering use `innerHTML`. `public/admin.html` previews raw HTML too. Admin and portal sessions are stored in browser localStorage, and `/g/:slug` shares the platform origin. The harmless `<img ... onerror>` probe executed in Chromium.

There is an additional active-content surface: `src/routes/files.ts` allows any `image/*` logo, including SVG, and `src/routes/public.ts` serves the stored type inline at `/:slug/logo`. The safer business `/img/:fileId` work does not automatically protect this guild endpoint.

**Implementation:** Introduce a reviewed HTML allowlist sanitizer for rich text and legacy content. Validate URL protocols; remove script, handlers, dangerous embeds, and active SVG. Use context-correct attribute escaping—`admin.html`'s text-to-`innerHTML` `esc()` helper does not encode quotes for use inside HTML attributes. Keep unrestricted custom code out of the application origin; if offered, isolate it on a separate origin/sandbox with a documented trust model. Apply a workable CSP and security headers across the actual rendered surfaces, with explicit embed exceptions. Harden file MIME validation and serve active/unknown downloads as attachments on an isolated asset origin.

**Acceptance:** Stored payloads in rich text, legacy HTML, URLs, titles, nav labels, blog entries, logos, and editor previews cannot execute or read synthetic admin storage. Verify both guild and business renderers, portal, and admin. Legitimate formatting survives sanitation. An owner's ability to customize their own site must not confer access to other organizations when a platform operator previews it.

### AUTH-1 — Session renewal accepts the wrong token type; magic links are replayable

**Evidence:** `src/routes/auth.ts` signs magic links and sessions with the same payload/key. `/verify-magic` accepts any valid token and issues a fresh seven-day session; the local session-token probe returned 200. `src/index.ts` `/auth/verify` has the same general exchange. Neither path consumes a one-use identifier. `verifyJwt` lacks a strict payload/purpose/issuer/audience schema and revocation lookup. Google OAuth state is a signed timestamp/destination/slug, without a browser-bound nonce or consumption record.

**Impact:** Possession of a valid session can permit renewal beyond its original lifetime; a magic link can be reused during validity. The signed OAuth state alone is not bound to the browser that began login. These are authentication design defects, not evidence that an attacker can forge signatures.

**Implementation:** Prefer a maintained JWT/session implementation; otherwise strictly validate claims. Use a dedicated short-lived purpose and one-use hashed magic-link record, consumed atomically. Reject session tokens at both magic exchanges and magic tokens at protected APIs. Implement revocable sessions, logout-all, and sensible absolute/idle lifetime policy. Bind OAuth state to a short-lived secure browser cookie/nonce and consume it once; test login CSRF. Avoid long-lived bearer tokens in receipt URLs (`src/routes/portal.ts` currently supports `?token=`) and redact token-bearing request URLs from logs. If migrating to HttpOnly cookies, design CSRF protection and CORS together; do not just switch storage.

**Acceptance:** Replay, concurrent exchange, wrong purpose, expired token, invalid claims, revoked/deleted account, and cross-browser OAuth callback are rejected. A token cannot extend itself via the magic endpoint. Successful logout-all invalidates active sessions. Original valid login flows still work.

### PAY-1 — Recording payment is treated as equivalent to completing fulfillment

**Evidence:** In `src/routes/webhooks.ts:145–215`, a recorded Stripe reference causes an early successful return. The payment insert precedes event registration, dues activation, and order fulfillment. A crash after recording payment can leave fulfillment incomplete; retry then exits early. `commitStripeMutationWithEvent` can swallow both batch and fallback failure while processing continues. Initial migration indexes on Stripe references are not unique; a pre-read is not a concurrency claim. This is a static failure-path finding, not a live charge experiment.

**Implementation:** Persist a Stripe event inbox keyed by provider event ID, with processing status/lease and retryable failure. Separately enforce business-operation uniqueness so different provider events cannot fulfill the same checkout/invoice twice. Make local payment + entitlement/order updates transactional where possible; track resumable steps where not. Commit the outbound outbox in the same transaction. A failed durable write must not be silently acknowledged as complete. Add a reconciliation job/UI for paid-but-unfulfilled, missing payments, stale processing, refunds, and subscription mismatches. Do not solve this by merely changing all failures to 500 while keeping non-idempotent side effects.

**Acceptance:** Inject failure before/after every durable step; replay and concurrently deliver the same event and related event types. Exactly one payment, one entitlement/order effect, and the expected durable outbox rows result. A post-payment failure recovers on retry. Test Stripe test-mode paid join, recurring renewal, cancellation, failed payment, event booking, donation, cart, partial/full refund, and expired checkout. Inspect amounts and state, not just HTTP status.

### WEB-1 — Membership Join and Events Register buttons are dead

**Evidence:** `public/guild.html:230–259` uses `cloneNode(true)` to copy homepage membership/event cards into dedicated routes. The cards attach click handlers with `addEventListener` in `levelCard` and `eventCard` (`:662–709`); cloning does not copy them. On actual HTML with fixture data, homepage Join opened one dialog; `/g/audit/membership` Join and `/g/audit/events` Register opened none. No JavaScript error is raised, so console-only smoke tests miss it.

**Implementation:** Render cards from the source data in each view or use delegated handlers on a stable container. Ensure direct deep links and client navigation use the same working actions.

**Acceptance:** Browser tests click Join/Register on homepage, `/membership`, `/join`, `/join-renew`, `/events`, and event detail, on platform paths and tenant hosts. Verify dialog submission reaches the intended API with the correct level/event. Include touch and keyboard activation. Run against real local Worker fixtures after the isolated browser regression passes.

### PAY-2 — Capacity and stock checks do not reserve resources atomically

**Evidence:** `src/routes/public.ts:914–1007` counts event registrations and later inserts; two requests can pass the same count. Pending-payment registrations consume seats but are omitted from the duplicate-registration lookup. No `checkout.session.expired` handling was found in `webhooks.ts`. Cart handling checks stock before checkout; free orders are marked paid before separate conditional decrements whose affected-row counts are ignored. Paid fulfillment also needs a reservation/reconciliation contract.

**Implementation:** Use atomic seat/stock reservation with DB-enforced invariants, an expiry, and a unique booking/order identity. Reuse an existing pending checkout for retries. Release reservations on failure, cancellation, timeout, or expiration; consume them once on confirmed payment. Normalize repeated SKUs in carts. Define compensation for partial multi-item failure. Verify membership pricing against an authenticated member identity: event pricing currently trusts the submitted email's active-member status, without proving the submitter controls that identity.

**Acceptance:** With one remaining seat/item, 20 concurrent attempts cannot oversell. Refresh/retry cannot create extra holds. Abandoned checkout releases capacity and allows rebooking. Free and paid multi-SKU orders cannot report fulfillment after a failed decrement. A nonmember cannot obtain a member discount just by supplying someone else's email. No real charges are needed for these regressions.

### MAIL-1 — Bulk email has no complete permission and delivery lifecycle

**Evidence:** The inspected email sender, blast/audience code, routes, and migrations have no marketing unsubscribe/preference/suppression implementation or Resend bounce/complaint webhook handler. Sending success is provider acceptance, not delivery. Open/click tracking exists, so engagement metrics must not be mistaken for delivery or permission evidence.

**Implementation:** Add tenant-specific communication preferences and signed one-click unsubscribe links, preserve opt-outs during import, and check suppression at send time. Distinguish necessary transactional messages from newsletters. Ingest authenticated delivery/bounce/complaint events idempotently; surface failed/delayed messages and suppress inappropriate retries. Configure a verified sender and reply-to identity, sending quotas, and provider pacing. Resend exposes the necessary event types: [Resend event types](https://resend.com/docs/webhooks/event-types).

**Acceptance:** An opted-out recipient receives no later marketing send, including a previously queued campaign or re-import. Replayed provider events do not duplicate effects. Bounce/complaint status appears in admin. Provider outage or unset credentials does not produce a misleading sent/delivered result. Review the actual customer communications policy before making legal compliance claims.

## Make website creation easy and powerful

### BUILD-1 — Converge on one visual authoring system

**Evidence:** `public/admin.html:2618` offers guild drag/drop with a ten-type palette, HTML-oriented text editing, URL-based images, and JSON navigation. `public/qh-site-builder.js:86–163` exposes business `blocks_json` directly. The backend supports additional blocks such as hero, FAQ, testimonials, service cards, galleries, contact form, and intake that the guild palette cannot author. Business appearance exposes internal names such as `primaryBright`, `textBase`, and font keys. Business navigation expects `Label | /path` lines.

**Required experience:** Start with a template and edit the rendered site. Use one versioned block registry/schema, rendering contract, and editor component system with tenant-type-specific palettes. Preserve existing content during convergence; do not silently convert or discard unfamiliar blocks.

| Customer job | Required capability |
|---|---|
| Start a professional site | Previewable starter sites for a guild, quilt show, retreat/workshop, and service business; seed Home, About, Join/Services, Events, Contact as appropriate. Clearly marked sample content. |
| Change text | Inline rich text with headings, links, lists, accessible formatting, and safe paste from Word. No HTML required. |
| Add images | Upload/select from a tenant media library, drag/drop, crop/focal point, alt-text prompt, responsive optimization, and broken-link feedback. |
| Arrange content | Add, move up/down, drag, duplicate, hide, and delete sections; keyboard/touch alternatives; undo/redo. Add a controlled columns/section layout model. |
| Use membership features | Actual join, event list/calendar, directory, document, form, donation, gallery, and store blocks with representative data and empty/error states. |
| Make navigation | Page picker, external link input, ordering, optional nested menus, visibility, explicit homepage selection; no JSON. Warn on broken internal links. |
| Apply branding | Small curated color/font combinations, logo, header/footer, readable contrast checks, and live preview. Advanced controls can be progressive. |
| Check the result | Desktop/tablet/mobile preview using the production renderer, not editor-only HTML approximations. Preview as public visitor and member where appropriate. |

**Acceptance:** Five representative volunteer admins, without developer help, create a branded five-page site, add an event, upload an image, edit navigation, and preview mobile. Target at least 4/5 completion, median under 20 minutes, zero JSON/HTML interaction. Record where they stall and adjust. These are proposed gates, not measured results.

### BUILD-2 — Separate editing from publishing

**Evidence:** Pages have one content representation and a `published` boolean. Saving an existing published page overwrites its live content; guild new pages default to published. “Preview site” opens the live guild homepage. No persisted revision history, autosave recovery, edit conflict protection, or safe draft preview was found in the inspected builder paths. Delete permanently removes the row.

**Implementation:** Introduce draft and published revisions, a published revision pointer, explicit Publish, and a tokenized short-lived preview that cannot be indexed or cached publicly. Autosave drafts with a visible Saved/Saving/Failed status; keep recoverable state after network failure. Add revision history/restore, soft-delete/trash, and optimistic concurrency via revision ID/ETag. Provide a launch check for contact details, working Join/Contact actions, mobile view, broken images, page visibility, and payment readiness. Never turn off the platform stealth gate as a side effect of saving a page.

**Acceptance:** Edits to a published page remain private until publish. Two admins cannot silently overwrite each other. Browser refresh/offline/reconnect preserves or clearly recovers drafts. Restoring a revision reproduces its content. A preview shows unpublished blocks and has correct access restrictions. Members-only content is absent from public HTML, API payloads, search, and shared caches.

### BUILD-3 — Fix content drift, metadata clearing, and success-with-data-loss behavior

**Evidence:** `admin.html` `editPage` retains old `content_json.html` in `pg-content`; `savePage` prefers that old value over its newly rendered snapshot. Public rendering prefers `blocks_json`, but `src/routes/portal.ts:903` selects only `content_json` for pages. Consequently a block edit can appear publicly while the member portal keeps old content. Deleting all blocks can resurrect old HTML because `contentFromPage` falls back whenever the parsed block array is empty.

`src/routes/pages.ts` catches arbitrary insert/update failures and retries an older schema statement that omits blocks, SEO, and navigation fields. This can report success while dropping a customer's intended changes. `parseBlocks` silently discards unsupported inputs. Metadata PATCH uses `coalesce`; submitting an empty SEO title/description becomes null and can leave the old value rather than clearing it.

**Implementation:** Make one versioned canonical document authoritative; explicitly distinguish legacy-only documents from a deliberate empty document. Derive all public, portal, preview, and export output from it. Validate requests and return field-level errors, including unsupported blocks. Replace broad compatibility fallbacks with explicit migration/version checks and fail clearly if required schema is absent. Model omitted versus cleared fields separately. Add redirects or explicit warnings for changed page slugs and reject reserved route collisions.

**Acceptance:** Edit an imported legacy page, change blocks twice, and verify the exact latest content in public site, portal, and preview. Remove every block: no old content reappears. Unsupported JSON returns 400 without changing the saved page. Inject a DB error: no partial fallback success. Clearing SEO metadata works. Published URL changes preserve old links through redirects where supported.

## Make onboarding quick and dependable

### ONB-1 — Replace the checklist with a resumable first-success flow

**Evidence:** `public/admin.html:551–586` marks “Share your public guild page” done unconditionally. It removes onboarding after a level and any member exist, regardless of Stripe/site readiness. The Dismiss control cannot reliably hide an incomplete checklist because `!coreDone` forces it visible. Progress depends on localStorage. Tenant creation accepts only name/slug and seeds no starter website or membership level. Business creation/selection is a separate operator-managed path.

**Recommended sequence:** Account → organization details and goal → choose starting site → set logo/colors → configure one membership level or service → preview a real working site. Let the customer defer import, Stripe identity verification, and custom DNS. Persist progress server-side and resume across browsers. Then offer distinct next tasks: accept payments, import members, invite another officer, and publish. Compute readiness from actual state; don't equate “visited a screen” with completion.

**Migration:** The importer has substantial mapping, warning, history, and date/status preservation work; retain it. Wrap it in a WildApricot-specific guided migration: upload sample export, map/preview, reconcile counts and statuses, review warnings, import resumably, download per-row results, compare before/after, then invite members. Inventory payment history, consent, files, website pages, event registrations, custom fields, and recurring payment credentials separately. Do not imply a contacts CSV transfers an entire organization or existing card subscriptions. Use the existing manual website-rebuild scripts as internal assistance, not as evidence of self-service migration.

**Acceptance:** From a fresh account, first usable website preview in 10 minutes without a card. Stripe/DNS wait does not block editing. On another device, the correct unfinished task resumes. Import interruption/retry converges without changed historical dates/statuses or duplicate welcome mail; partial results are visible. Pilot migration counts reconcile before the old system is retired. Add privacy-conscious activation events for account, organization, preview, import, payment readiness, publish, and first member join.

### ONB-2 — Remove avoidable login and domain dead ends

**Evidence:** `wrangler.toml` sets Google-required admin auth. This is configured behavior; production secret presence was not checked. The JWT encoder calls `btoa(JSON.stringify(payload))`, which throws for an emoji/non-Latin display name; locally reproduced. `/magic-link` ignores `sendEmail(...).success` and can return a sent-like message after provider failure. `tenants.ts` starts domain provisioning with `void ensurePlatformSubdomain(...).catch(...)` rather than awaiting or using a durable task; success can be returned with no completed subdomain and no visible error.

**Implementation:** Use UTF-8-safe token encoding. Offer a clearly supported non-Google admin login/recovery option built on AUTH-1, since volunteer officers may not have or want Google accounts. Preserve enumeration resistance while distinguishing service-wide mail failure from successful request acceptance. Show resend/cooldown and delivery help. Provision domains through durable work or `waitUntil` plus persisted retry/status, with a working platform URL throughout. Use friendly DNS instructions and statuses for pending ownership, DNS, certificate, active, and failed.

**Acceptance:** Names with accents, Chinese characters, and emoji can log in. An unset/unavailable mail service gives actionable recovery without exposing whether a particular account exists. New guilds always receive a working fallback URL. DNS/API failure is visible and retryable. Verify public site, portal login, member invitation, payment return URLs, and HTTPS on a real test custom domain before advertising that journey.

**Launch scope:** `src/lib/tenantType.ts` only considers flagged businesses launched; guilds intentionally stay gated. Implement a deliberate guild publication policy when launch is authorized. Do not flip guilds to business to bypass it: that changes membership limits and product behavior. Keep platform admin and unpublished tenants protected.

## Performance, reliability, security hardening

### OPS-1 — Scheduled communication must run at the requested time and survive retries

**Evidence:** `wrangler.toml` runs daily jobs at `0 8 * * *`; the every-minute branch in `src/index.ts` only sweeps webhooks. Scheduled blasts are moved onto the queue by the daily job, so a campaign scheduled just after that run may wait almost a day. `blastSend.ts` sends 40 emails concurrently, advances the cursor after failures, and marks the campaign sent even with an error count. A crash after provider acceptance but before cursor persistence can repeat recipients. Multiple processors can read a `sending` blast without an exclusive lease.

**Implementation:** Separate due-time scheduling from daily membership housekeeping. Use durable, tenant-fair recipient jobs with claims/leases, bounded concurrency, provider-aware rate limits, retries/backoff and idempotency keys where supported. Represent accepted, delivered, retrying, failed, and cancelled accurately. Do not advance failed recipients out of recovery. Paginate renewal/reminder scans, checkpoint work, and catch up missed windows after outages.

**Acceptance:** A campaign scheduled five minutes ahead begins within an agreed one-minute tolerance in the tenant's timezone, including DST cases. Overlapping cron/manual triggers do not duplicate sends. Inject 429/5xx/timeouts, crash after provider acceptance, and restart; recipients recover with accurate status. A large guild does not starve smaller guilds.

### PERF-1 — Measure customer-visible performance, then remove the expensive paths

**Evidence:** `public/admin.html` is about 231 KB uncompressed with most screens in one inline script. Guild boot fetches seven datasets before completing its initial view, including all page content and blog content; the public guild route serves a client-rendered shell even for missing pages. Business sites already have SSR, SEO helpers, and versioned edge caching—preserve and extend that work. Host resolution and DB page/nav lookups happen before the rendered cache lookup, so an HTML cache hit is not a zero-DB request.

**Implementation:** Load screen modules on demand without requiring a framework rewrite. Fetch only route-relevant data and paginate blog/pages/media. Share server rendering where practical so guild pages have useful initial HTML, correct status, canonical metadata and social previews. Optimize responsive images and fonts. Profile D1 queries/rows scanned and use `EXPLAIN QUERY PLAN`; normalize/index host lookups and reuse request-scoped tenant resolution. Keep auth/public visibility checks ahead of shared cache access. Make cache invalidation cover page, navigation, theme, deletion, and publication state.

**Acceptance:** Publish reproducible measurements for small, 1,000-member, and 10,000-member tenants with realistic events/pages/files. Proposed budgets: mobile public LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 at p75; representative list API p95 ≤500ms under a documented 50-concurrent-user staging scenario. Record cold/warm behavior, errors, D1 work, CPU, payload sizes, and email backlog separately. These are targets, not existing benchmarks. Run logged-out cache-isolation tests after unpublishing or restricting a previously public page.

### SEC-3 — Harden the less visible boundaries before public traffic

| Area | Current evidence / concern | Implementation and acceptance |
|---|---|---|
| Runtime validation | Many routes cast `req.json<T>()`; that does not validate at runtime. `levels.ts` accepts prices/durations without a strict schema. Uploads buffer the full body before applying size limits. | Apply shared schemas for strings, IDs, email, finite integer money/quantity, enums, object depth, array length, and total body size. Enforce limits while reading. Invalid/oversized input returns a controlled 4xx and writes nothing. |
| Abuse controls | KV read/increment/write rate limits are non-atomic and fail open. Some public write paths, including cart/form/volunteer paths, have no equivalent route limiter. Tenant creation can provision resources repeatedly. | Use an appropriate atomic/platform limiter, tenant/IP/account quotas, and escalating bot checks. Cover site-access attempts and resource creation too. Concurrent load cannot bypass the intended budget or deny all guild members sharing a meeting Wi-Fi. |
| CORS/session boundary | `src/index.ts` reflects any Origin with credentials enabled. Current APIs primarily use explicit bearer tokens. | Use an explicit origin policy for platform and verified tenant domains. Test allowed/denied origins. Do not describe reflection alone as proof of bearer-token theft; prevent it becoming exploitable during a cookie-session migration. |
| Documents and media | Portal document library treats every staff-uploaded file as a member document (`uploaded_by IS NOT NULL`). There is no explicit private-staff/document-library classification in that selection. | Add purpose/visibility and references for staff-private files, site assets, member documents, galleries, and intake photos. Authenticated membership does not automatically authorize every uploaded asset. Test each audience and guessed file IDs. |
| Sensitive data/logging | Portal receipt tokens can appear in URLs; offline check-in data persists in localStorage and logout only removes selected session keys. | Redact request credentials, avoid bearer URL credentials, add offline retention/explicit cache clearing on shared devices, and disclose offline data handling. Verify sign-out/tenant-switch behavior. |
| Administrative audit | No complete immutable admin action log was found; webhook/import logs are not a replacement. | Log privileged changes and exports with tenant/actor/action/target, redact secrets, and expose useful history to owners. |

### OPS-2 — Add a release and support system that matches the product promise

**Evidence:** No `.github` workflow directory is present. `CLAUDE.md` says there is no test runner and resource IDs are placeholders, but current package/config contradict both. Existing operational notes and test scripts are useful, yet no restore rehearsal or current production readiness evidence was established.

**Implementation:** Add CI for typecheck, unit tests, migration of a fresh and an upgraded isolated DB, browser customer journeys, and integration contracts. Make scripts accept isolated state/config consistently. Produce a release manifest with commit, migration version, deployed version and gate state. Monitor errors, failed login delivery, webhook age, paid-but-unfulfilled records, renewal/automation failures, and tenant-visible outages. Define tested backup/restore for D1 plus R2 and a selective tenant recovery procedure. Protect admin surfaces even when customer websites are public. Update stale developer and customer documentation only after behavior is verified.

**Customer operations:** Provide contextual help, searchable documentation, a real setup-call booking path, migration assistance, support issue tracking, an honest response-time target, status communication, and an officer handover checklist. Add complete export/offboarding with a retention policy and resumable job status. Existing member CSV export is not a complete account export.

**Acceptance:** Restore a synthetic tenant into an isolated environment and reconcile memberships, money references, pages, and media. Proposed initial operational gates: agreed RPO ≤24h and rehearsed RTO ≤4h; choose stricter money-recovery requirements as appropriate. A deliberately failed recurring job alerts the operator and has a documented recovery path. A failed deploy has a rehearsed rollback that accounts for schema compatibility. Record who owns support and incident response before charging customers.

## COMP-1 — Competitive scope and missing features

Current WildApricot primary pages describe an integrated website builder, membership, payments, events, email and integrations, with mobile-friendly templates and drag/drop authoring. Its membership page describes page access by membership level/group. These are meaningful customer expectations, not optional polish. Sources checked for this review: [Website builder](https://www.wildapricot.com/features/membership-website-builder-software), [Membership management](https://www.wildapricot.com/features/membership-management-software), [Features](https://www.wildapricot.com/features), [Pricing](https://www.wildapricot.com/pricing). Pricing pages change; this review does not adopt the old comparison document's dollar figures.

| Customer capability | QuiltHosting evidence | Recommendation |
|---|---|---|
| Roster, levels, renewal, imports | Substantial implementation, including import diagnostics and historical-date handling | P1: prove a complete migrated guild lifecycle; fix money/auth gaps before expanding it. |
| Family/household or organization bundles | No first-class bundle/payer/dependent model found in inspected membership schema/routes | P1 if pilot guilds require it: one payer, linked individuals, shared renewal, dependent permissions and migration. Otherwise P2 with an explicit sales limitation. |
| Calendar-year dues, prorating, approval workflows, level changes | Current level model is primarily duration/months and manual/auto renewal; complete policy-driven journeys not established | Validate with pilot guilds, then implement policy settings and lifecycle tests. Do not mark unsupported semantics as covered by custom fields. |
| Restricted website sections | Boolean `is_members_only`; portal checks exist | P1: correct current rendering/visibility. P2 or pilot blocker: level/group-specific access, with centralized entitlement rules. |
| Event operations | Capacity, waitlist, check-in, questions, recurrence, volunteers have code | P1: prove paid and free lifecycle and recovery. Validate group/guest booking, price windows, coupons, cancellation/self-service, multi-session retreats, and attendance reporting before claiming coverage. |
| Email and automations | Segments, templates, scheduled blasts, tracking; configurable trigger remains `member_activated` | P1: deliverability and scheduling. P2: event-attendee follow-up, renewal sequences, suppression/exit conditions, and visible enrollment/run history. |
| Financial administration | Payments, invoices, refunds, exports and QBO routes exist | P1: reconcile money to memberships/events/orders, test offline dues and refunds, distinguish platform subscription from guild payouts. Validate QBO with a sandbox account before advertising readiness. |
| Complete switching/offboarding | Member CSV tooling is strong; complete site/payment/file/history transfer not proven | P1: scoped migration plan, reconciliation report and assisted cutover. P2: broader import formats and portable whole-account export. |
| Website discoverability | Business SSR/SEO/sitemap exists; guild shell and authoring are less capable | P1: guild page metadata, proper missing-page status, mobile preview, redirects, accessible authoring, and explicit launch indexing policy. |
| Support and officer turnover | Help docs and email/setup links exist | P1: guided handover, role-safe invitations, ownership transfer, setup assistance, and a measurable support process. |
| Mobile apps, SMS, chapters, forums, galleries, Zapier | Code/scaffolds are present | Preserve them; individually validate customer jobs and distribution/provider setup. They are not a substitute for fixing the primary website/dues experience. |

**Commercial recommendation:** Start with quilt/craft guilds and their actual workflows. Business service websites can remain a distinct product path sharing the editor; do not force guild onboarding through quoting/business settings. The current $24 Guild price and unlimited active-member allowance (`src/lib/plans.ts`) need a cost model for mail, storage, payment support, migrations, and staff time. Define fair usage and paid assistance clearly; do not promise unlimited operational cost. Compare total cost and administrative time saved using measured pilot evidence.

## Claude execution order and release gates

Work can proceed in independent workstreams, with shared contracts agreed before integration. This is suggested task organization, not permission to launch.

1. **Trust and money:** SEC-1, SEC-2, AUTH-1, PAY-1, PAY-2. Define the permission matrix, session model, canonical content trust boundary, and fulfillment state machine first. Add reproductions before fixing. WEB-1 is a small independent conversion repair that should land early.
2. **Customer website:** BUILD-1/2/3, ONB-1/2. Agree the document/revision schema with the security work. Deliver one complete template → edit → preview → publish path before broadening the palette. Preserve current tenant content and test migrations.
3. **Mail and operations:** MAIL-1, OPS-1/2, PERF-1, SEC-3. Establish isolated integration fixtures, reliable delivery, monitoring and restore evidence. Measure performance after representative site content exists.
4. **Pilot-specific parity:** Select COMP-1 gaps from actual pilot requirements; implement the smallest complete customer job, with limits stated honestly. Avoid a sprawling parity checklist without usage evidence.

For each item Claude completes, append an implementation note with changed files, migration/backfill, regression evidence, residual limitations and deployed verification status. Do not mark an item done solely because a screen, route, or unit test exists.

### Gate A — Safe to invite a supervised pilot

- P0 regressions closed, with route-role and cross-tenant tests plus browser stored-content tests.
- Paid join/renew/event/refund demonstrated in Stripe test mode with duplicate and failure injection; reconciliation clean.
- Join/Register work on all relevant public routes, including real Worker/browser tests.
- No bulk newsletter access until consent, suppression and reliable delivery are working.
- Publication scope is deliberate; platform/admin and unpublished tenants remain protected.

### Gate B — Viable self-service paid pilot

- At least five target admins complete the website/onboarding tasks; ≥4/5 without developer help, first preview ≤10 minutes, branded five-page site median ≤20 minutes.
- At least three guild migrations reconcile counts/statuses/dates and complete a real admin/member workflow with explicit approval for any real payments or invitations.
- Correct website output at mobile/desktop, keyboard-accessible authoring and customer forms, and no known critical accessibility failures.
- Production mail/domain configuration and custom-domain return/login paths verified for a test tenant.
- Performance measurements, restore rehearsal, alerts, support ownership, and unit-cost assumptions recorded.

### Gate C — Public launch

- Stable paid pilot evidence across billing/renewal and officer tasks; unresolved pilot defects explicitly triaged.
- Comparison, pricing, limits, migration promises, privacy/terms, support and status pages reflect verified behavior.
- Explicit launch authorization, a staged tenant rollout, production smoke checks and a rollback owner.

**Final assessment:** The existing foundation is worth building on. The immediate path to a WildApricot competitor is to make trust, payments, website creation, migration, and everyday volunteer tasks dependable—not to add another loosely integrated feature before those jobs work.

---

## Implementation notes — Claude, September 8, 2026

Deployed as `0.56.0-preview` (Worker version `18a7c4ea`, commits `f11b09c`, `354e664`, `c226bbc` on `main`). Migrations 0021–0025 applied to production D1 after confirming zero duplicate Stripe refs. Evidence: `npx tsc --noEmit` clean; `npx vitest run` 51 files / 879 tests; fresh local D1 migration apply; Playwright (Edge) run of the editor against a local Worker; live production probes after deploy (magic link exchange + replay 401, session token rejected at the magic exchange, headers, CORS, onboarding, drafts, bootstrap). Stealth gate unchanged.

| ID | Status | Changed files (main) | Migration | Regression evidence | Residual |
|---|---|---|---|---|---|
| SEC-1 | Done | `src/lib/permissions.ts`, `src/middleware/permissions.ts`, `src/index.ts`; admin nav/read-only mirror in `public/admin.html` | — | 61 table-driven tests incl. viewer POST /pages and /api-keys → 403 | Verb-level only within an area; events role cannot download registration CSVs |
| SEC-2 | Done | `src/lib/sanitize.ts`, `src/lib/blocks.ts`, `src/lib/site/render.ts`, `src/routes/files.ts`, `src/routes/public.ts` (logo/photo allowlist + nosniff), `src/middleware/securityHeaders.ts` | — | 103 sanitizer payload tests; blocks/render/files tests; live check: `<img onerror>` stored → rendered as `<img>` | `style`/`id` attributes dropped; no script-restricting CSP yet (inline scripts in single-file pages); admin canvas renders server preview HTML |
| AUTH-1 | Done | `src/lib/auth/jwt.ts`, `src/lib/auth/magic.ts`, `src/routes/auth.ts`, `src/routes/portal.ts`, `public/portal.html`, `apps/mobile/app/member.tsx` | 0021 `auth_tokens` | 43 tests; production: link consumed once, replay 401, session at verify-magic 401, magic as bearer 401 | No server-side session revocation (proposed `users.auth_epoch`); 7-day sessions unchanged; deploy signed everyone out once |
| PAY-1 | Done | `src/routes/webhooks.ts`, `src/lib/fulfillment.ts`, `src/lib/stripe/index.ts` | 0022 `stripe_events`, `payments.fulfilled_at`, partial unique indexes | 11 webhook tests: duplicate delivery, concurrent claim, crash-after-record retry, expired session | Not re-tested with a live Stripe charge after deploy; late `completed` after a swept hold may oversell by one (logged) |
| PAY-2 | Done | `src/routes/public.ts`, `src/lib/fulfillment.ts`, `src/index.ts` (minute sweep) | 0022 `hold_expires_at`, order reservation columns | 21 public tests: conditional seat claim, hold reuse, SKU normalization, stock compensation | Member price still granted by email match; `member_price_verified` flag added for admin review |
| WEB-1 | Done | `public/guild.html` | — | Source-assertion test (no `cloneNode`); browser: Join/Register wired from data | — |
| MAIL-1 | Done | `src/lib/suppression.ts`, `src/lib/email/*`, `src/lib/blastSend.ts`, `src/lib/audience.ts`, `src/routes/unsubscribe.ts`, `src/routes/emailWebhooks.ts`, `src/routes/comms.ts`, `src/routes/members.ts` (import keeps opt-out) | 0023 | 44 tests; production `/u/<bad>` → 400, `/api/webhooks/resend` → 503 until secret set | **Operator action:** create the Resend webhook → `wrangler secret put RESEND_WEBHOOK_SECRET`; `mailto:` unsubscribe target has no inbox; Resend rate limit may need `CONCURRENCY` lowered |
| BUILD-1 | Done | `public/admin.html` (shared editor), `public/qh-site-builder.js`, `public/qh.css` | — | Playwright: add section, rich text, image upload → guild image route, undo, publish; tests pin editor↔matrix and guild.html hooks | Rich text uses `execCommand`; `events_list`/`store_list` placeholders on canvas (exact in Preview); first real-user usability test still to run |
| BUILD-2 | Done | `src/routes/pages.ts`, `src/lib/pageDrafts.ts`, `src/routes/site.ts`, `src/routes/portal.ts` | 0025 drafts, `page_revisions`, `page_redirects`, `deleted_at` | Draft/publish/CAS 409/restore/trash tests; browser: Saved pill, Preview desktop/tablet/mobile via production renderer, History restore | Trashed page keeps its slug until permanently deleted; single-hop redirects |
| BUILD-3 | Done | `src/routes/pages.ts` | — | 42 tests: unsupported block 400, cleared vs omitted metadata, empty blocks clear legacy HTML, reserved slugs, no fallback statements | Slug rename now redirects (BUILD-2); `PATCH /site/settings` theme still loosely validated |
| ONB-1 | Done | `src/lib/starterSite.ts`, `src/lib/onboarding.ts`, `src/routes/tenants.ts`, `public/admin.html` | 0024 | 28 tests; production `/onboarding` reflects real Test Guild state | Readiness is recomputed, only dismissal is stored; pre-existing tenants show no subdomain badge until "Check again" |
| ONB-2 | Done | `src/lib/auth/jwt.ts` (UTF-8), `src/routes/auth.ts` (503 on send failure), `src/lib/tenantHost.ts` + `src/routes/domain.ts` (persisted status + retry), `src/middleware/siteGate.ts` (`/auth/verify` exempt, hand-off fragment preserved) | 0024 | Emoji/CJK sign-in test; live: `/auth/verify` reachable without the gate cookie | Google-only admin login policy unchanged (config, not code) |
| OPS-1 | Done | `src/index.ts`, `src/lib/scheduledBlasts.ts`, `src/lib/blastSend.ts` | 0023 lease columns | Lease contention + conditional claim tests | No give-up after repeated stalls; Resend pacing |
| SEC-3 | Partial | `src/lib/corsPolicy.ts`, `src/middleware/rateLimit.ts` + `[[ratelimits]]` binding, `src/middleware/securityHeaders.ts`, pages body limits | — | CORS/header/limiter tests; live: foreign origin gets no CORS grant | Body limits only on pages routes; no admin audit log; file visibility classification not added |
| OPS-2 | Partial | `.github/workflows/ci.yml` | — | CI runs typecheck, tests, fresh-DB migrations, secret scan | No restore rehearsal, alerting, or release manifest yet |
| PERF-1 | Partial | `/public/:slug/site-bootstrap` (7 boot requests → 1), lazy images, nav-aware SSR cache key | — | Byte-equality tests vs the seven endpoints | No measured budgets; admin.html still one bundle; guild pages still client-rendered |
| COMP-1 | Not started | — | — | — | Household bundles, level-specific page access, calendar-year dues remain open |
