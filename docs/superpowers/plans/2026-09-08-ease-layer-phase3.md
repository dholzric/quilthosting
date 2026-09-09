# Ease Layer (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the everyday product feel small. A volunteer officer sees seven grouped screens, money in dollars, a first-run flow that ends on a finished website, and a dashboard that names the next thing to do. Everything already built stays, one switch away.

**Architecture:** Two per-tenant switches in `settings`: `settings.ui.advanced` (boolean, default false — hides screens, never features) and `settings.features` (JSON booleans for capabilities that add machinery). One helper module reads both, the sidebar renders from a grouped model crossed with the existing permission matrix, and every hidden thing has an automated test proving the *off* path is unchanged. Money moves to dollars at the UI boundary only: storage stays integer cents and basis points.

**Tech Stack:** unchanged (Workers, Hono, Zod, D1, vitest; Playwright via Edge from the scratchpad for browser checks). No new runtime dependencies.

## Global Constraints

- Phase 1 and 2 Global Constraints still apply (sanitize tenant strings, keep exported signatures, batch D1 queries, `--qh-*` variables only, explicit `git add`, no `git add -A`, commit trailers).
- **Switches hide complexity, never value.** Nothing in this plan may be gated by plan tier. The only paywall stays the free ≤30 active-member cap in `src/lib/plans.ts`.
- **Defaults:** `settings.ui.advanced` false; every `settings.features` key false EXCEPT `recipes` (automation recipes) which is on, since it replaces today's hardcoded behavior. A missing key means off.
- **Money rule:** every admin input and read-out is dollars (`step="0.01"`) or a percentage; the wire format and database stay integer cents / basis points. Conversion happens in one pair of helpers, never inline.
- Other tools edit this checkout live (`src/lib/site/kits/*`, `docs/kit-gallery/`, `docs/kit-contributor-notes.md`). Never stage those.
- Every task ends green on `npx tsc --noEmit` and `npx vitest run`, and `node --check` on both inline scripts of `public/admin.html` when that file changed.

---

### Task A: The switch mechanism, grouped nav, and Settings → Advanced

**Files:**
- Create: `src/lib/features.ts` + `features.test.ts`
- Create: `src/lib/adminNav.ts` + `adminNav.test.ts` (the grouped model, shared by the admin and its tests)
- Modify: `src/routes/tenants.ts` (PATCH accepts `settings.ui` and `settings.features`, validated) + `tenants.test.ts`
- Modify: `public/admin.html` (sidebar rendering, Settings → Advanced screen) and `src/lib/adminNavGating.test.ts` (it pins the old markup — rewrite it against the new model, keeping its intent: business-only and guild-only entries must never cross)

**Interfaces:**
```ts
// src/lib/features.ts
export type FeatureKey =
  | "recipes" | "automations_v2" | "reports" | "sample_data" | "waivers"
  | "installments" | "digital_goods" | "coupons" | "library" | "bom"
  | "quilt_show" | "polls" | "gifting";
export const FEATURE_DEFAULTS: Record<FeatureKey, boolean>;          // only `recipes` true
export type FeatureMeta = { key: FeatureKey; label: string; consequence: string; group: "Power tools" | "Money" | "Community" };
export const FEATURE_CATALOG: FeatureMeta[];                          // plain-language, one sentence each
export function readUi(settingsJson: string | null | undefined): { advanced: boolean };
export function readFeatures(settingsJson: string | null | undefined): Record<FeatureKey, boolean>;
export function hasFeature(settingsJson: string | null | undefined, key: FeatureKey): boolean;
export const uiSchema: z.ZodType<{ advanced: boolean }>;              // for tenants.ts PATCH
export const featuresSchema: z.ZodType<Partial<Record<FeatureKey, boolean>>>;
// src/lib/adminNav.ts
export type NavGroup = "Home" | "People" | "Calendar" | "Site" | "Money" | "Email" | "More" | "Settings";
export type NavEntry = {
  page: string; label: string; group: NavGroup;
  simple: boolean;                       // visible when advanced === false
  tenant?: "guild" | "business";         // else both
  area?: string;                         // key into PERMISSION_MATRIX (src/lib/permissions.ts)
  feature?: FeatureKey;                  // hidden unless the feature is on
};
export const ADMIN_NAV: NavEntry[];      // every data-page in admin.html exactly once
export function visibleNav(opts: { advanced: boolean; role: string; tenantType: "guild" | "business"; features: Record<string, boolean> }): NavEntry[];
```
Simple set (`simple: true`): dashboard, members, levels (guild), events, pages/site-pages (Website), payments, comms (Email), team, settings. Everything else is Advanced. `visibleNav` also drops entries the role cannot read (reuse `canAccess(role, area, "GET", "/")`), entries for the wrong tenant type, and entries whose `feature` is off.

Admin: build the `<nav>` from `visibleNav` at runtime (keep the same `data-page` values and click handlers), grouped with a small uppercase label per group, "More" collapsed behind a disclosure when advanced. **Settings → Advanced**: a "Show advanced features" toggle plus one row per `FEATURE_CATALOG` entry (label, consequence, switch), grouped, each writing `settings.features`. Saving PATCHes and re-renders the sidebar without a reload.

- [ ] **Step 1: failing tests** — `features.test.ts`: defaults (only `recipes` on), unknown keys ignored, malformed settings → defaults, schemas reject junk. `adminNav.test.ts`: `ADMIN_NAV` covers every `data-page=` in `public/admin.html` exactly once (read the file, same idiom as the old gating test); Simple owner guild sees exactly the nine simple pages; advanced owner sees all guild pages; a viewer never sees billing/api/credentials; a business tenant never sees guild-only pages and vice versa; a feature-gated page appears only with its flag on.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run `npx vitest run src/lib/features.test.ts src/lib/adminNav.test.ts src/lib/adminNavGating.test.ts src/routes/tenants.test.ts` → PASS; `node --check`. **Step 5:** commit `feat(admin): simple/advanced switch, grouped role-aware navigation, feature catalog`.

### Task B: Money in human units

**Files:**
- Create: `src/lib/money.ts` additions — read `src/lib/utils/money.ts` first and extend it there instead if it already holds `formatMoney`: add `dollarsToCents(input: string | number): number | null`, `centsToDollars(cents: number): string`, `percentToBps(p: string | number): number | null`, `bpsToPercent(bps: number): string` + tests
- Modify: `public/admin.html` — every money input and read-out: events member/non-member price (line ~1876), store product price (~2257), store tax rate (~2247, becomes a percent), invoice lines (~7001, replace the pipe-syntax textarea with description/qty/unit-price rows), invoice tax (~6999), manual payment amount (~1030), and any "cents" label elsewhere (grep `(cents)`)
- Modify: `src/routes/events.ts`, `src/routes/products.ts`, `src/routes/invoices.ts` — zod validation that the wire values are non-negative safe integers (cents) and 0–2500 (bps); reject floats with a field error rather than truncating
- Modify: `public/docs/getting-started.html` and any doc that says levels are in cents (grep `cents` under `public/docs/`)

Rules: the input is dollars, the request body stays `*_cents`; `dollarsToCents` parses "35", "35.5", "$35.50", "1,200" and returns null for anything else; a null shows a field error and blocks submit. Invoice lines become a repeatable row editor (description, qty, unit price in dollars) that builds the same `lines[]` payload the API already takes. Tax becomes "Sales tax %" with `step="0.01"`, stored as bps.

- [ ] Steps: tests for the four converters (including the rejects) and route validation; a source-assertion test that no `(cents)` or "basis points" label remains in `public/admin.html`; implement; `npx vitest run`; `node --check`; commit `feat(admin): money in dollars and percent everywhere; invoice line editor`.

### Task C: First-run wizard

**Files:**
- Create: `src/lib/firstRun.ts` + test (server-side state: which steps are done, derived like `onboarding.ts`)
- Modify: `src/routes/tenants.ts` — `POST /api/tenants` accepts optional `logo_file_id`, `palette`, `kit` (kit already supported) and applies them atomically; new `GET /api/tenants/:id/first-run` returning `{ done, step, guild: {...} }`
- Modify: `public/admin.html` — the create-guild screen becomes a four-screen flow

Flow: **1 Your guild** (name, city, meeting info) → **2 Pick a design** (kit thumbnails from the gallery strip, six curated first, "More designs" reveals the rest) → **3 Make it yours** (upload logo — reuses the phase-2 pipeline; palette suggestions from the logo, else palette tiles) → **4 You're live** (a real preview iframe of the new site plus three next actions: "Add a membership level", "Add your first event", "Invite an officer"). Each step saves as it goes so a refresh resumes. Ends on the dashboard with the checklist already partly complete. Target: a finished site in under ten minutes without help.

- [ ] Steps: tests (create with logo+palette+kit persists all three; first-run state resumes; curated kit list is exactly six for guilds); implement; browser QA in the scratchpad harness; commit `feat(onboarding): first-run wizard — guild, design, logo and colors, live site`.

### Task D: Next-best-action dashboard and teaching empty states

**Files:**
- Create: `src/lib/nextActions.ts` + test
- Modify: `src/routes/tenants.ts` (`GET /api/tenants/:id/onboarding` gains `next_actions`) or a new `GET /:id/next-actions` — pick one and say which
- Modify: `public/admin.html` dashboard + the empty branches of the Members, Levels, Events, Store, Forms, Automations, SMS, API screens

`nextActions(db, tenant)` returns at most three ranked cards `{ id, title, body, cta: { label, href }, severity }` computed from real state, e.g.: sample copy still on N pages; no membership level; Stripe not connected while a paid level exists; members without email consent; renewal reminders start in N days (preview one); no events in the next 60 days; a blast is `partial` with failures. Empty states: one sentence explaining why the screen matters, one primary button, and "You can skip this" where true — never a bare table header.

- [ ] Steps: tests over fake state for ranking and the empty cases; implement; commit `feat(admin): next-best-action dashboard and empty states that teach`.

### Task E: Automations 2.0

**Files:**
- Create: `migrations/0029_automations_v2.sql`, `src/lib/automations/triggers.ts`, `src/lib/automations/recipes.ts` (+ tests); extend `src/lib/automations.ts`
- Modify: `src/routes/automations.ts` (+ test), `public/admin.html` automations screen (a step editor: trigger → wait N days → email, with subject/body rows — no JSON)

Schema: `automation_sequences` gains `conditions_json TEXT` and `trigger_config_json TEXT`; new `automation_runs (id, tenant_id, sequence_id, subject_type, subject_id, step, status, scheduled_at, sent_at, error, created_at)` with an index on `(status, scheduled_at)`. Triggers: `member_activated` (exists), `membership_lapsed`, `event_registered`, `event_ended`, `form_submitted`, `payment_received`. Enqueue from the places those already happen (renewals job, webhooks fulfillment, forms route, public register) by calling one exported `enqueueTrigger(env, tenantId, trigger, subject)` — additive, never inside a batch that could fail. Steps stay `steps_json` but gain `{ waitDays, subject, bodyHtml }` and are executed by extending `runAutomationJob` to lease rows in `automation_runs` the way `blastSend` leases blasts. Recipes (`features.recipes`, on by default): "Welcome series", "Renewal ladder", "Post-event thank-you", "Win-back" — installable in one click, editable afterwards. The builder itself sits behind `features.automations_v2`.

- [ ] Steps: tests (trigger enqueue is idempotent per subject+sequence; wait steps schedule correctly; a failed send retries without duplicating; recipes install as real sequences; off-switch path unchanged); implement; commit `feat(automations): triggers, wait steps, runs table and one-click recipes`.

### Task F: Reports and the monthly board report

**Files:**
- Create: `src/lib/reports.ts` + test; `src/routes/reports.ts` (+ test) mounted in `src/index.ts` under the tenant app (coordinator applies the one-line mount)
- Modify: `src/lib/renewals.ts` or the daily job to send the monthly report; `public/admin.html` Reports screen

`GET /api/tenants/:id/reports/summary?months=12` → member growth by month, renewal rate, churn, revenue by source (dues/events/store/donations), event attendance, top events — one batched query set reusing `stats.ts` SQL where it exists. Screen: sparklines and small tables (no chart library; inline SVG), a date-range select, and "Email me this monthly". The monthly job composes an HTML board report and sends it to owners/admins when `features.reports` is on.

- [ ] Steps: tests (aggregation math on fixed rows; the email renders with real numbers; the off path sends nothing); implement; commit `feat(reports): trends screen and monthly board report email`.

### Task G: Release

- [ ] Full `npx tsc --noEmit` + `npx vitest run`; local migrations; browser pass: create a guild through the wizard, confirm the sidebar shows nine grouped items, flip Advanced and see the rest, enter a level price in dollars and verify the stored cents, install a recipe, open Reports.
- [ ] Bump to `0.59.0-preview`, append implementation notes to `docs/superpowers/specs/2026-09-08-site-design-system-and-kits-design.md` (or a new phase-3 note in the plan), push, migrate remote, deploy from a clean worktree, verify production.

## Deliberately not in this phase

Household and calendar-year dues (needs its own spec: a dues-policy model, bundle payer/dependent schema, and a migration path for existing memberships), inline canvas editing, retiring `guild.html`, the accessibility audit, and the remaining `GLMUpgrades.md` modules (Block of the Month, quilt show, library, digital goods, coupons, gifting). Each is a separate plan.

## Self-review

- Coverage: Codex P0 items 1–8 → Tasks A, B, C, D; GLM A1/A2/A3/C1/C3 → Tasks C, D, E, F; GLM E (switch mechanism) → Task A. Refunds (C2) and revision restore (A5) already shipped.
- Type consistency: `FeatureKey`, `NavEntry`, `visibleNav`, the money converters, `nextActions`, and `enqueueTrigger` are each defined once and referenced by those names.
- No placeholders: every task names its files, contracts, tests, and commit message.

## Implementation note

**Shipped 2026-09-08 as v0.59.0-preview.** All six tasks landed: the Simple/Advanced switch with grouped role-aware navigation and a plain-language feature catalog; money in dollars and percent everywhere with an invoice line editor and server-side whole-cent validation; the four-screen first-run wizard (guild, design, logo and colors, live site) with derived resume; the next-best-action dashboard and teaching empty states on eight screens; automations with six triggers, wait steps, a leased runs table and four one-click recipes (migration 0029); and the reports screen with an optional monthly board report. Two corrections during integration: Reports was un-gated (a switch may hide complexity but must never remove a screen a tenant already has), and a paid event registration now fires `event_registered` from the Stripe webhook, which is the only place a paid seat is confirmed. Evidence: 2423 unit tests, typecheck clean, local end-to-end (kit + palette at creation, first-run state, dollars validation rejecting floats, recipe install and duplicate 409, reports summary, dashboard recomputation as state changes) and a browser pass showing nine grouped entries in Simple and twenty-two in Advanced with no console errors. Deferred to their own specs: household and calendar-year dues, inline canvas editing, retiring `guild.html`, the accessibility audit.