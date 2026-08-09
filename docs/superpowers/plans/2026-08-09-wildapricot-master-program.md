# WildApricot Replacement — Master Program

**Status:** Program definition, 2026-08-09. Not an implementation checklist.
**Owner decision required at every phase gate.**

This document exists because the Codex review of the integration plan correctly identified that a 12-task integration slice was being framed as an "integration ecosystem," and that no single plan should carry both the implementation detail and the competitive strategy. Implementation plans live in sibling files and are referenced by phase.

**Source of the competitive claims:** the Walter/GLM-5.2 analysis (2026-08-08), corrected by a codebase audit; the Grok and Codex reviews in `2026-08-09-integration-foundation-reviews.md`; and Codex's research pass over WildApricot's public features, pricing, webhook types, API resource list, Make module catalog, public wishlist, and recent G2/Capterra reviews.

---

## The strategic thesis

The opening is real but it is **not** feature count. WildApricot has more features than QuiltHosting and will continue to. The wedge is:

1. **Pricing resentment.** Contact-count tiers punish orgs for their own history. A flat $24/mo counting only *active* members is a fundamentally different promise, not a discount.
2. **Volunteer-run reality.** The buyer is a rotating, non-technical volunteer board. Every hour of admin friction is a real cost they feel personally.
3. **Switching cost is the moat — in both directions.** Today it protects WildApricot. Lossless migration is the single highest-leverage thing we can build.
4. **Support as product.** The marketing page already promises "email support from real people" and "free migration help." Right now that is a mailto link.

**What must not happen:** shipping checkboxes to match a feature matrix, then discovering that core workflows are unreliable, migration is lossy, and support cannot answer a question about a failed payment.

### The rule this program enforces

> **"Route exists" is never an exit criterion.**

`docs/wildapricot-gap-analysis.md` currently marks features as parity on the basis that a route, migration, or lightweight UI exists. That document must be revised (Phase 0) to competitive acceptance criteria: a complete user job, done by a volunteer, with real data, including edge cases and failure modes.

---

## Phase gates

Each phase has measurable exit criteria. No phase is "done" because its code merged.

### Phase 0 — Truth (immediate, blocking everything)

Stop over-crediting the product to ourselves. Nothing here ships to customers.

| Work | Exit criterion |
|---|---|
| Revise `docs/wildapricot-gap-analysis.md` from "code exists" to end-to-end acceptance criteria | Every row states the user job, the data fidelity requirement, and how it was verified |
| Audit remaining "parity" claims the same way the integration claims were audited | A written list of claims that did not survive contact with the code |
| Define the parity matrix (below) as a living tracked artifact | Matrix exists with an owner and a review cadence |

**Precedent:** the integration audit found that 2 of 6 advertised webhook events never fired, the v1 API was read-only, and the `write` scope was enforced nowhere — all while marked as shipped. Assume comparable drift elsewhere until checked.

### Phase 1 — Integration foundation *(plan written: `2026-08-09-integration-ecosystem.md`)*

Honest event emission, durable delivery with retry/replay/DLQ, versioned payload contract, idempotent writes, granular scopes, working private Zapier app.

**Exit criteria:**
- Every advertised event has a verified emitter and a passing harness assertion (or a named script that covers it).
- Production delivery success rate ≥ 99% over 7 days, measured from `webhook_deliveries`.
- Retry recovery rate: ≥ 95% of transient failures deliver within the retry window.
- A real Zapier subscribe → trigger → action → unsubscribe cycle recorded, not just `zapier validate`.
- Released as **v0.27.0-preview / integration developer preview**. No production automation users recruited.

### Phase 2 — Integration breadth

Turn a foundation into something a guild can actually automate against.

| Work | Notes |
|---|---|
| Core resource CRUD in v1 | Members, events, registrations, invoices, payments, levels, groups |
| Lifecycle webhooks | Registration updated/canceled, payment refunded, invoice created/paid/voided, membership renewed/lapsed |
| `GET /api/v1/registrations` | Currently blocks an honest Event Registration trigger sample |
| OpenAPI 3.1 as canonical contract | Generated examples, downloadable Postman collection |
| Cursor pagination + filters on every collection | Only `/members` paginates today |
| Consistent envelopes and machine-readable error codes | Started in Phase 1, finish across all endpoints |
| API changelog, deprecation window, version policy | Required before any public listing |
| Zapier breadth + raw "API Request" action | Cover the long tail without shipping 40 actions |
| Make app | A native app, not "we have webhooks so Make works" |
| WordPress / member SSO | **Decide: build, partner, or decline with a documented alternative** |
| Per-API-key rate limiting, PII redaction/retention in delivery logs | Deferred from Phase 1 |

**Exit criteria:** a guild can run their five most common automations end to end without custom code; OpenAPI published; Zapier public submission unblocked on everything except the gate and user count.

### Phase 3 — The switching moat

The existing CSV importer has a dry run and maps common WildApricot headers. That is a start, not a migration product. WildApricot customers also carry custom fields, groups, household/bundle relationships, event and attendance history, invoices, payments, refunds, email preferences, pages/files, and store records.

| Capability | Requirement |
|---|---|
| Migration inventory | Ingest every export the customer can obtain; classify each as auto / manual / not possible |
| Mapping UI | Preserve custom fields and group/level semantics; never silently drop unknown columns |
| Dry-run reconciliation | Source count, imported, skipped, field-level warnings, totals by status/level, downloadable error report |
| Repeatable cutover | Stable source IDs, safe re-runs, delta import, rollback before go-live, auditable batch ID |
| Historical continuity | Registrations, invoices, payments, refunds, membership and communication history where exports permit |
| Identity and payment truth | Passwords and processor-held mandates **cannot** be copied. Ship member re-verification and payment-method reauthorization campaigns as first-class flows |
| Site and domain cutover | Content inventory, URL mapping/redirects, DNS checklist, forms/widgets replacement, parallel-run validation |
| White-glove service | Named migration owner, test migration, board acceptance checklist, launch window, post-cutover support |
| `members.import.completed` event | Summary event with batch ID and counts — the honest answer to "import fires nothing" |

**Exit criteria:** three real guilds migrated with a signed acceptance checklist; reconciliation report shows zero unexplained record loss; a rollback was actually exercised in rehearsal.

### Phase 4 — Complaint-led product wins

WildApricot's public wishlist is demand evidence, **not** an implementation queue. Cluster by job-to-be-done, validate against actual quilt guilds, and score on: demand × guild relevance × switching power × revenue impact ÷ (implementation cost + support load + legal/security risk).

Top public requests as of Codex's review, with status to validate:

| Request | Votes | QuiltHosting status |
|---|---:|---|
| Secondary/alternate member emails | 489 | Missing data model and delivery preferences |
| General online forms | 382 | Partial — forms exist; parity/usability unvalidated |
| Donation during membership/event checkout | 377 | Missing combined checkout upsell |
| Register for multiple events in one flow | 377 | Missing cross-event cart |
| Separate registration per recurring occurrence | 320 | Partial — occurrences are separate events; UX untested |
| Email-to-forum / listserv | 275 | Missing |
| Member-submitted events with approval | 269 | Missing |
| Searchable/foldered email templates | 265 | Missing |
| Custom administrator permissions | 261 | Missing — fixed roles only |
| Renew membership while registering for an event | 252 | Missing combined transaction |
| Member login/activity reporting | 249 | Missing |
| Sitewide hidden coupon codes | 243 | Missing |
| Membership/event installments and trials | 241 | Missing |
| Continuing-education credit tracking | 232 | Missing — low guild relevance |
| Scheduled post-event follow-up | 231 | Missing — automation engine only covers activation |
| Mobile app customization | 227 | Missing/partial |
| Per-ticket-type registration forms | 218 | Missing registration-type model |
| Event-scoped manager permissions | 212 | Missing |
| Household/family memberships, shared emails | 209 | Missing |
| Mixed family/bundle event registration | 184 | Missing |

**Likely first cluster for quilt guilds specifically:** household/family memberships + alternate emails + combined renew-and-register checkout. These three are one story — "a couple who both quilt renews and signs up for the retreat in one transaction" — and they touch the data model, so they should be sequenced before the cosmetic wins.

**Exit criteria:** each shipped item traced to a validated guild interview, not a vote count alone.

### Phase 5 — Operational advantage

The clearest place to beat WildApricot, and the one that cannot be faked.

- Support channels by plan, with published hours. Do not promise coverage that cannot be staffed.
- First-response and update targets.
- Escalation ownership for payments, data loss, email delivery, and launch cutovers.
- Public status page and incident communication template.
- In-app support context: tenant, page, version, correlation ID — so volunteers are not asked to diagnose the system.
- Searchable help content, short task videos, onboarding office hours, migration appointments.
- Visible changelog and feedback board with acknowledgement and closure loops.
- Backup/restore, export, retention, and account-offboarding procedures.

**Exit criteria:** published SLAs met for 30 consecutive days with real ticket volume.

### Phase 6 — Launch and acquisition

- Un-gate deliberately (currently a standing decision to stay stealth).
- Recruit 10+ Zapier beta users — a hard prerequisite for public directory listing.
- Publish verified comparisons and migration case studies. Verified means reproducible, not marketing claims.
- Submit public Zapier and Make integrations.

---

## The parity matrix

Tracked per resource × operation. Owner maintains; reviewed at each phase gate.

| Resource | REST read | REST write | Webhook | Zapier trigger | Zapier action | Make | Fixture | Docs | Prod-verified |
|---|---|---|---|---|---|---|---|---|---|
| Member | ✅ | Phase 1 | Phase 1 | Phase 1 | Phase 1 | ✗ | Phase 1 | Phase 1 | ✗ |
| Membership | ✗ | ✗ | Phase 1 | ✗ | ✗ | ✗ | Phase 1 | Phase 1 | ✗ |
| Event | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Registration | ✗ | ✗ | Phase 1 | Phase 1 | ✗ | ✗ | Phase 1 | Phase 1 | ✗ |
| Payment | ✅ | ✗ | Phase 1 | ✗ | ✗ | ✗ | Phase 1 | Phase 1 | ✗ |
| Invoice | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Level | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Group | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Form | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | Phase 1 | Phase 1 | ✗ |
| Store order | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Refund | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

For comparison, WildApricot's API covers contacts, events, registrations, invoices, payments, refunds, levels, groups, saved searches, audit logs, and store objects; its webhooks cover contact, membership, event, registration, invoice, payment, refund, renewal, level, and logged-email changes.

**Honest read of this table:** after Phase 1 completes, one resource is well covered and ten are not.

---

## Pricing model check

The $24/mo active-member model is a genuine wedge — WildApricot starts around $66/mo for 100 contacts on monthly billing, and its contact-count mechanic is its most-resented feature.

Preserve the simple story. But before promising unlimited usage indefinitely, model the cost of: support labor, transactional and bulk email, SMS, file storage, migration labor, and high-volume tenants. "Cheaper" must mean *predictably lower total cost with clear limits and no surprise counting* — not a price point that makes excellent support financially impossible. A guild with 800 members sending weekly newsletters and hosting a 300-person show is a materially different cost than a 40-member guild, and both pay $24.

**Action:** build a unit-economics model before Phase 6, not after.

---

## Program-level metrics

Not "features shipped."

- Successful migration rehearsals (count, and unexplained record loss)
- Production webhook delivery success rate and retry recovery rate
- Time-to-first-value for a new guild (signup → first member imported → first event published)
- Support first-response time against published target
- Task-completion usability rate for volunteer admins on core jobs
- Customer acceptance sign-offs at cutover
- Churn and stated reason

---

## Open decisions for the owner

1. **WordPress / member SSO** — build, partner, or decline? WildApricot ships a plugin with member login. Declining is legitimate but needs a documented alternative for guilds whose site is WordPress.
2. **Un-gating timing.** The Zapier public listing needs 10 live users, which needs an un-gated product. The stealth rationale ("don't alert Wild Apricot") is in direct tension with the acquisition path. This is the single highest-order sequencing decision in the program.
3. **Household/family memberships.** Two of the top 20 requests, and the data model change is invasive. Deciding early is much cheaper than retrofitting.
4. **How much history migrates.** Full financial history is expensive to import and reconcile. A defensible line ("12 months of transactions, full member and membership state") may be better than an open promise.
5. **Support staffing.** Every commitment in Phase 5 is a real recurring cost against a $24/mo price. Decide the staffing model before publishing SLAs.

---

## Related documents

- `2026-08-09-integration-ecosystem.md` — Phase 1 implementation plan (revision 2)
- `2026-08-09-integration-foundation-reviews.md` — Grok and Codex reviews, verbatim
- `docs/wildapricot-gap-analysis.md` — **requires Phase 0 revision**; currently over-credits "code exists" as parity
- `docs/competition-wild-apricot-alternatives.md` — competitive landscape
