# Design: dues policy and household memberships

**Date:** 2026-09-08 · **Status:** proposed · **Author:** Claude, from `CodexRecommendations.md` items 16–17 and `GLMUpgrades.md` (household/calendar-year listed as the WA-killer for quilt guilds)

## 1. The problem

A quilt guild sells two things QuiltHosting cannot currently express.

**Calendar-year dues.** Most guilds run a fixed membership year — "dues are $40, the year runs January through December, join after July and pay $20." Today a level is `duration_months` counted from the join date (`computeMembershipEnd` in `src/lib/memberships.ts`: start date plus N months). A member who joins in October gets a term ending next October, so the guild's roster never lines up with its treasurer's year, its renewal letter, or its show cycle. Every guild that works this way has to fake it by hand.

**Household memberships.** "One payment, two quilters at the same address." Today `memberships` is one row per `member_id`, so a household is either two paid memberships or one membership and an off-books spouse who cannot sign in, appear in the directory, or register at member prices. `public/docs/features.html` already lists this under what is not included, and it is the single most common January SKU in this market.

Both are dues-model problems, not interface problems, which is why they were held out of phase 3.

## 2. Goals and non-goals

Goals:

1. A guild can choose how its membership year works — anniversary (today's behavior, unchanged and still the default), fixed calendar year, or a fixed date — per level, with a plain-language explanation and no date arithmetic on screen.
2. A guild can offer a household level: one payer, one payment, two or more named people who each get a login, a directory entry, member pricing, and renewal notices.
3. Existing memberships keep working exactly as they do now. No backfill changes a term, a price, or a renewal date.
4. A treasurer can see who is in a household and move someone out of it without deleting anyone.
5. The importer can bring households and fixed-year terms across from Wild Apricot without inventing data.

Non-goals: per-person pricing inside a household beyond a flat add-on price, more than one payer per household, corporate or chapter bundles (a chapter is already a tenant relationship), and prorating anything other than a fixed-year level's first term.

## 3. Approaches considered

- **A. Policy on the level, bundle as its own table (recommended).** `membership_levels` grows a dues policy (`term_mode`, `term_anchor`, `proration`); a household is a `households` row plus `household_members`, with the membership still owned by the payer. Additive schema, existing rows keep the default policy, and every read path that asks "is this person an active member" gains one join rather than a new concept.
- **B. Household as a member with dependents.** Model the household as a `members` row and hang people off it. Smaller schema, but it breaks every existing query that assumes a member is a person, and it makes the directory, email consent, and check-in wrong by default.
- **C. Levels with a quantity.** Sell "membership × 2" and let the guild write the second name in a custom field. Cheapest, and what guilds do today by hand. It does not give the second person a login, a directory entry, or member pricing, which is the entire point.

A is the design below.

## 4. Architecture

### 4.1 Dues policy on the level

```
membership_levels
  term_mode      TEXT NOT NULL DEFAULT 'anniversary'   -- anniversary | calendar | fixed_date
  term_anchor    TEXT                                  -- calendar: NULL (Jan 1). fixed_date: 'MM-DD', e.g. '07-01'
  proration      TEXT NOT NULL DEFAULT 'none'          -- none | half_year | monthly
  grace_days     INTEGER NOT NULL DEFAULT 0            -- days after end_date before lapse
```

`term_mode = 'anniversary'` is exactly today's behavior. `calendar` and `fixed_date` compute the term end as the next anchor date strictly after the start, so a January 3 join and a December 20 join both end on the same December 31. Proration applies only to the **first** term of a fixed-year level: `half_year` charges half after the midpoint; `monthly` charges `ceil(months remaining / term months) × price`, rounded to the cent, never above the full price and never below zero. Renewals always charge the full price.

One new module `src/lib/dues.ts` owns every calculation:

```ts
export type TermMode = "anniversary" | "calendar" | "fixed_date";
export type Proration = "none" | "half_year" | "monthly";
export type DuesPolicy = { termMode: TermMode; termAnchor?: string | null; durationMonths: number; proration: Proration; graceDays: number };
export function readDuesPolicy(level: { term_mode?; term_anchor?; duration_months; proration?; grace_days? }): DuesPolicy;
export function computeTermEnd(policy: DuesPolicy, startDate: string, now: string): string;   // supersedes computeMembershipEnd for policy-aware callers
export function prorateCents(policy: DuesPolicy, fullPriceCents: number, startDate: string): number;
export function describePolicy(policy: DuesPolicy): string;  // "Runs January to December. Join after July 1 and pay half."
export function lapseDate(policy: DuesPolicy, endDate: string): string;  // end + graceDays
```

`computeMembershipEnd` stays exported and unchanged so nothing that does not know about policies breaks; `activateMembership` and `extendMembership` gain an optional `policy` and fall back to today's math when it is absent.

### 4.2 Households

```
households (id, tenant_id, name, payer_member_id, created_at, updated_at)
household_members (household_id, member_id, role TEXT NOT NULL DEFAULT 'member', added_at)
   PRIMARY KEY (household_id, member_id)
   UNIQUE (member_id)          -- a person belongs to at most one household per tenant
membership_levels
  household_max     INTEGER NOT NULL DEFAULT 1   -- 1 = individual level (today); >1 = household level
  household_add_cents INTEGER NOT NULL DEFAULT 0 -- optional flat price per extra person
memberships
  household_id TEXT             -- set when this membership covers a household
```

The membership row still belongs to the payer. Membership for a non-payer is derived: a person is an active member if they have an active membership **or** they are in a household whose payer has one. One helper answers that question everywhere:

```ts
export function activeMembershipFilter(alias: string): string;  // SQL fragment reused by the roster, directory, portal, member pricing and the plan cap
export async function isActiveMember(db, tenantId, memberId): Promise<boolean>;
```

**The plan cap counts people, not payments** (`src/lib/plans.ts` counts active members): a household of three counts as three toward the free-30 cap. That is the honest reading of "active members" and keeps the pricing promise unambiguous.

### 4.3 Join and renewal flows

- Public join for a household level asks for the payer plus up to `household_max − 1` additional names and emails, in the same dialog, with the price updating as people are added. One checkout, one payment, one membership row, N member rows, one household.
- Each household person gets their own magic-link sign-in and portal. The portal shows "Your household membership, paid by Jane, renews December 31" and lets the payer manage names; non-payers can edit only themselves.
- Renewal reminders and win-back go to the payer, with the household named. Non-payers get a courtesy notice, not a payment link.
- `runRenewalJob` uses `lapseDate(policy, end_date)` instead of `end_date`, so a guild can give a 30-day grace without members disappearing on January 1.

### 4.4 Admin

Level editor: a "Membership year" control with three plain choices ("Runs from when they join", "Runs January to December", "Runs from a date I pick"), a proration choice that only appears for the fixed modes, a grace-period field, and a "This is a household membership" toggle with the number of people and any extra-person price. The screen shows `describePolicy` under the controls so the officer reads back what they chose in words. Members list gains a household column and a "Move out of household" action; the member detail shows household mates.

### 4.5 Import

`src/lib/importMapping.ts` gains optional columns: `household_name`, `household_role` (payer or member), and `membership_end` (already supported as a date). Rows sharing a household name in one import become one household; the payer row carries the membership. Nothing is inferred from a shared address or surname — the guild must say so in a column, because guessing family structure from data is exactly the kind of error a migration must not make.

## 5. Migration and compatibility

Migration `0030_dues_policy_households.sql` adds columns with defaults matching today's behavior and creates the two tables. No data is rewritten. A level only changes behavior when an officer edits it. Existing terms keep their end dates; a level switched to calendar mode affects **new and renewed** memberships only, and the editor says so before saving.

## 6. Testing and acceptance

- Unit: `computeTermEnd` across anniversary, calendar and fixed-date, including a start on the anchor date, a leap day, and a term that would otherwise land in the past; `prorateCents` at the boundary days and at zero price; `lapseDate` with and without grace; `describePolicy` wording for all nine combinations.
- Integration: joining a household level creates one membership, one household, N members, and one payment; each person can sign in; the directory lists all of them; member pricing applies to all of them; the plan cap counts all of them; removing a person from a household ends their derived membership but keeps their record.
- Renewal: a calendar-year guild's members all renew on the same date; grace days delay lapse; the payer gets the payment link and household mates do not.
- Import: two rows sharing `household_name` become one household with the payer's membership; a household row with no payer is a per-row warning, not a failed import.
- Regression: every existing test stays green, and a guild that never touches the new controls sees byte-identical behavior.

## 7. Phases

1. **Policy engine and level editor** — `src/lib/dues.ts`, schema, level UI, renewal job, portal and public copy that reads the policy. Ships alone and is useful alone (calendar-year dues are half the ask).
2. **Households** — tables, join flow, derived membership everywhere, portal and admin management, plan-cap counting.
3. **Import and reconciliation** — importer columns, a household view in the roster, and the migration guide.

## 8. Open decisions

- Whether a household counts as one or many toward the free-30 cap. This design says many, which is the honest reading; the alternative is a marketing choice the owner should make deliberately.
- Whether non-payers may renew on the payer's behalf. This design says no for the first release: it avoids a second payer and the refund questions that follow.
