# Dues Policy, Households, and Cleanup (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell what a quilt guild actually sells — a calendar-year membership and a household membership — and finish the site work by retiring the classic renderer and fixing the accessibility gaps.

**Architecture:** Spec: `docs/superpowers/specs/2026-09-08-dues-policy-and-households-design.md`. One new module `src/lib/dues.ts` owns every term and price calculation; `membership_levels` carries the policy; households are their own tables with the membership still owned by the payer, and "is this person an active member" becomes one shared SQL fragment used by the roster, directory, portal, member pricing, and the plan cap. Everything is additive: a level that is never edited behaves exactly as today.

**Tech Stack:** unchanged (Workers, Hono, Zod, D1, vitest; Playwright via Edge from the scratchpad).

## Global Constraints

- Constraints from phases 1–3 still apply (sanitize tenant strings, keep exported signatures, batch D1 queries, dollars in the UI and cents on the wire, explicit `git add`, no `git add -A`, commit trailers, `node --check` on both inline scripts when `public/admin.html` changes).
- **Nothing may change an existing member's term, price, or renewal date.** Migration adds columns whose defaults reproduce today's behavior; a level changes behavior only when an officer edits it, and the editor says so before saving.
- **Never infer family structure.** A household exists because someone said so in the UI or an import column — never because two rows share a surname or address.
- The plan cap counts people: a household of three is three active members (`src/lib/plans.ts`).
- Other tools edit this checkout live (`src/lib/site/kits/*`, `docs/kit-gallery/`). Never stage those.
- Every task ends green on `npx tsc --noEmit` and `npx vitest run`.

---

### Task A: Dues policy engine and the level editor

**Files:**
- Create: `migrations/0030_dues_policy.sql`, `src/lib/dues.ts` + `dues.test.ts`
- Modify: `src/lib/memberships.ts` (+ test) — `activateMembership`/`extendMembership` take an optional `policy`; `computeMembershipEnd` stays exported and unchanged
- Modify: `src/routes/levels.ts` (+ test) — accept and validate the policy fields
- Modify: `src/lib/renewals.ts` (+ test) — lapse on `lapseDate(policy, end_date)`, and reminder copy names the renewal date
- Modify: `public/admin.html` — the Levels editor only
- Modify: `src/routes/public.ts` — the join price shown and charged for a fixed-year level uses `prorateCents`

**Migration 0030 (policy half only; households are Task B):**
```sql
ALTER TABLE membership_levels ADD COLUMN term_mode TEXT NOT NULL DEFAULT 'anniversary';
ALTER TABLE membership_levels ADD COLUMN term_anchor TEXT;
ALTER TABLE membership_levels ADD COLUMN proration TEXT NOT NULL DEFAULT 'none';
ALTER TABLE membership_levels ADD COLUMN grace_days INTEGER NOT NULL DEFAULT 0;
```

**Interfaces:** exactly as the spec's §4.1 (`TermMode`, `Proration`, `DuesPolicy`, `readDuesPolicy`, `computeTermEnd`, `prorateCents`, `describePolicy`, `lapseDate`). Rules to pin in tests: `calendar` ends on December 31 of the year the term runs into, so a January 3 and a December 20 start both end the same December 31; `fixed_date` uses `MM-DD` and rolls to next year when the start is on or after the anchor; a start exactly on the anchor gets a full term, not a zero-length one; leap day anchors clamp to February 28 in non-leap years; proration applies only when no prior membership exists for that member and level; `half_year` charges `ceil(price/2)` after the midpoint; `monthly` charges `ceil(price × monthsRemaining / durationMonths)`, clamped to `[0, price]`.

Admin: "Membership year" as three radio choices ("Runs from when they join" / "Runs January to December" / "Runs from a date I pick" with a month-day picker), a proration choice visible only for the fixed modes, a grace-days field, and `describePolicy` rendered underneath in words. Changing the mode on a level with active memberships shows an inline warning that existing terms keep their dates.

- [ ] Steps: failing tests for every rule above → implement `dues.ts` → wire memberships/levels/renewals/public → admin editor → `npx vitest run src/lib/dues.test.ts src/lib/memberships.test.ts src/lib/renewals.test.ts src/routes/levels.test.ts src/routes/public.test.ts` → `npx tsc --noEmit` → local migration → commit `feat(dues): calendar-year and fixed-date terms, proration, grace periods`.

### Task B: Households

**Files:**
- Create: `migrations/0031_households.sql`, `src/lib/households.ts` + test
- Modify: `src/routes/members.ts` (+ test) — household column, move in/out actions, and the roster query
- Modify: `src/routes/public.ts` (+ test) — the join flow for a household level
- Modify: `src/routes/portal.ts` (+ test) — household view, payer-only management
- Modify: `src/lib/plans.ts` (+ test) — the cap counts household people
- Modify: `public/admin.html` (Members screen only), `public/portal.html`
- Modify: `src/routes/levels.ts` — `household_max`, `household_add_cents`

**Migration 0031:** the two tables and two level columns from the spec's §4.2, with `UNIQUE (member_id)` on `household_members`.

**Interfaces:**
```ts
export type HouseholdRole = "payer" | "member";
export function activeMembershipFilter(memberAlias: string): string;   // SQL fragment: own active membership OR payer's, used everywhere
export async function isActiveMember(db, tenantId, memberId): Promise<boolean>;
export async function createHousehold(db, tenantId, payerMemberId, name, memberIds, now): Promise<string>;
export async function addToHousehold(db, tenantId, householdId, memberId, now): Promise<void>;
export async function removeFromHousehold(db, tenantId, memberId, now): Promise<void>;
export async function householdFor(db, tenantId, memberId): Promise<{ id: string; name: string; payer_member_id: string; members: { id; email; first_name; last_name; role }[] } | null>;
export function householdPriceCents(level: { price_cents: number; household_add_cents: number }, people: number): number;
```
Every place that asks "is this person an active member" must use `activeMembershipFilter` — grep for `status = 'active'` against `memberships` and convert: roster, directory, portal, member pricing in `public.ts`, and the plan cap. A test asserts no other SQL in `src/` decides membership on its own.

Join flow: a level with `household_max > 1` accepts `people: [{ email, first_name, last_name }]` (≤ `household_max − 1` beyond the payer, emails unique and not already members of another household), charges `householdPriceCents`, and on fulfillment creates the members, the household, and the single membership in one batch. Each person gets a magic-link welcome; only the payer's email carries the payment receipt.

- [ ] Steps: failing tests (membership derivation, price, join batch contents, cap counting, remove-from-household ends derived membership but keeps the person, a person cannot be in two households) → implement → admin and portal → full suite → commit `feat(dues): household memberships — one payment, many members`.

### Task C: Retire the classic renderer

**Files:**
- Modify: `src/routes/tenants.ts` (a platform-admin endpoint to upgrade a tenant), `src/index.ts`, `src/routes/site.ts`, `src/middleware/siteGate.ts`, `src/lib/site/serve.test.ts`, `src/lib/guildSite.test.ts`
- Delete: `public/guild.html` (last step only)

Order matters. First confirm every remaining `settings.site.renderer === "legacy"` tenant renders correctly through `serveSite` by upgrading each one in a preview (`GET /:id/site/upgrade?preview=1`) and comparing against its classic page by eye. Then upgrade them. Then remove the legacy branch from `src/index.ts` and `useLegacyRenderer`, keep `/g/:slug/__preview` serving a minimal preview shell (the editor's guild preview depends on it — replace it with a `serveSite`-rendered preview rather than deleting the route), and delete `guild.html` with its source-assertion test. If any tenant cannot be upgraded cleanly, stop and report rather than deleting.

- [ ] Steps: preview and upgrade every legacy tenant on production (report the list first) → remove the branch → replace `__preview` → delete the file and its test → full suite → commit `chore(site): retire the classic guild renderer`.

### Task D: Accessibility pass

**Files:** `public/admin.html`, `public/portal.html`, `public/qh-site.css`, `public/qh-site.js`, `public/qh.css`, plus a new `src/lib/a11y.test.ts` for source assertions.

Scope: keyboard reachability and visible focus on every control in the admin, the portal, and a rendered kit site; correct labels and `aria-*` on the editor's canvas, dialogs, drawers, and the section picker; heading order; form errors announced (`aria-live`) and tied to their inputs (`aria-describedby`); the mobile drawer trapping and restoring focus (already true — assert it); `prefers-reduced-motion` honored; color contrast already enforced at the token level (assert the admin's own palette too). Fix what fails; record what cannot be fixed without a rewrite. Add source assertions for the invariants that can be checked statically (every `<button>` has a name, every input has a label or `aria-label`, no positive `tabindex`, no `outline: none` without a replacement).

- [ ] Steps: audit with a scratchpad Playwright script that walks the tab order and dumps names/roles → fix → assert → commit `fix(a11y): keyboard, labels, focus and announcements across admin, portal and sites`.

### Task E: Release

- [ ] Full typecheck and suite; local migrations 0030 and 0031; browser pass: create a calendar-year level and confirm two joins on different dates share an end date; join a household level with two people and confirm both can sign in, both appear in the directory, and the cap counts two; upgrade a legacy guild and confirm the classic renderer is gone.
- [ ] Bump to `0.60.0-preview`, append implementation notes to the spec, push, migrate remote, deploy from a clean worktree, verify production.

## Deliberately not in this phase

Inline canvas editing, per-person pricing inside a household, more than one payer, corporate bundles, and the remaining `GLMUpgrades.md` modules (Block of the Month, quilt show, library, digital goods, coupons, gifting). Each is its own plan.

## Self-review

- Coverage: spec §4.1 → Task A; §4.2, §4.3 admin/portal/join → Task B; §4.5 import is deferred to a follow-up task in the next phase and is called out here so it is not forgotten; Codex items 16–17 → Tasks A and B; phase-2 residual "retire guild.html" → Task C; GLM B7 accessibility → Task D.
- Type consistency: `DuesPolicy`, `computeTermEnd`, `prorateCents`, `lapseDate`, `activeMembershipFilter`, `householdPriceCents` are each defined once and referenced by those names.
- Ordering: Task B depends on Task A's migration being applied first (both touch `membership_levels`); Tasks C and D are independent and can run in parallel with either.
