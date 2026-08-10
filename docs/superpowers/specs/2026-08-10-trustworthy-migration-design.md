# Trustworthy Migration — Design

**Date:** 2026-08-10
**Status:** Approved, pending implementation plan
**Sub-project A of** pilot-guild onboarding prep (see Decomposition below)

## Problem

QuiltHosting's CSV import silently destroys data.

`public/admin.html:1040-1062` maps exactly nine columns — email, first/last name,
phone, status, notes, level, end date, joined date. Every other column in the
file is dropped in the browser before the request is even made, so the server
never sees it and the dry run cannot mention it.

A guild importing a Wild Apricot export containing "Committee", "Machine Type",
"Bee Group", or "Member Since" sees:

```
Import preview:
  240 new members
  0 existing members updated
  0 rows skipped
Import now?
```

They confirm. The custom columns are gone, with no warning at any point.

This sits at the exact moment a switching customer decides whether to trust the
product, and CSV import is the strongest switching claim in
`docs/wildapricot-gap-analysis.md`. It is also invisible: the guild has no way
to distinguish "QuiltHosting doesn't support this" from "QuiltHosting lost it".

## Goal

An admin can see every column in their file, decide where each one goes,
import the ones the product doesn't natively model as custom fields, and get a
reconciliation they can check against their old system — before anything is
written.

## Non-goals

- Importing anything other than members. Events, invoices, payments, and
  registration history are Phase 3 of the master program.
- Stable external source IDs and delta re-import. Re-run safety here is by
  email match only.
- A file upload/parse service. The browser keeps parsing the CSV.
- Undo. Re-running a corrected file converges; there is no rollback.

## Architecture

### New module: `src/lib/importMapping.ts`

Pure functions, no database access, so they are directly testable.

```ts
/** Native member fields an imported column can target. */
export const KNOWN_TARGETS = [
  "email", "first_name", "last_name", "phone",
  "status", "notes", "level_name", "end_date", "joined_at",
] as const;
export type KnownTarget = (typeof KNOWN_TARGETS)[number];

/** Header synonyms, lowercased and stripped of non-letters before matching. */
export const TARGET_SYNONYMS: Record<KnownTarget, string[]>;

export type MappingEntry =
  | { kind: "known"; target: KnownTarget }
  | { kind: "custom"; key: string; label: string }
  | { kind: "ignore" };

/**
 * Keyed by COLUMN INDEX, not header text. CSV headers are not unique — a
 * Wild Apricot export can contain two "Notes" columns — and keying by string
 * would silently collapse them, which is the same class of bug this whole
 * spec exists to fix.
 */
export type ImportMapping = Record<number, MappingEntry>;

export function proposeMapping(
  header: string[],
  existingCustomFields: Array<{ key: string; label: string }>
): { mapping: ImportMapping; unmapped: Array<{ index: number; header: string }> };

/** `row` is the raw cell array, so index-keyed mapping applies directly. */
export function applyMapping(
  row: string[],
  mapping: ImportMapping
): { member: Record<string, string>; customFields: Record<string, string> };
```

`proposeMapping` resolves in three passes: exact synonym match to a known
target; match against an existing custom field's key or label; otherwise
`ignore`, and the header is listed in `unmapped`. When two headers claim the
same known target, the first wins and the second becomes `ignore` — recorded
as a `duplicate_target` warning rather than silently discarded.

### Changed: `POST /api/tenants/:tenantId/members/import`

Request gains three optional fields. The existing `rows` field is untouched, so
every current caller — including the v1 API and any script — keeps working.

| Field | Meaning |
|---|---|
| `header` | Column names in file order. Required to propose or apply a mapping. |
| `raw_rows` | `string[][]` — cells in file order, parallel to `header`. Used **instead of** `rows` in the mapping flow, because an index-keyed mapping needs positional cells. |
| `mapping` | An `ImportMapping`. Omitted on the first dry run so the server proposes one. |

Exactly one of `rows` or `raw_rows` must be present; sending both is a `400`.
`raw_rows` requires `header`, and each row must have the same length as
`header` — a ragged row is skipped with reason `column_count_mismatch` rather
than silently misaligning every field after the gap.

Behaviour:

- `dry_run: true`, no `mapping` → server proposes one and returns it with the
  reconciliation. **Writes nothing**, including no custom-field definitions.
- `dry_run: true`, with `mapping` → uses it verbatim, returns the updated
  reconciliation. Still writes nothing.
- No `dry_run`, with `mapping` → applies it, creates any `kind: "custom"`
  definitions not already present, imports.
- No `header` at all → current nine-column behaviour on `rows`, so existing
  callers and the v1 API keep working unchanged.

### Response shape

Both dry run and real import return the same envelope, so the UI renders one
component:

```jsonc
{
  "dry_run": true,
  "total_rows": 240,
  "will_create": 238,
  "will_update": 0,
  "will_skip": 2,
  "header": ["E-Mail", "Committee", "Fax"],
  "mapping": { "0": { "kind": "known", "target": "email" },
               "1": { "kind": "custom", "key": "committee", "label": "Committee" },
               "2": { "kind": "ignore" } },
  "unmapped": [{ "index": 2, "header": "Fax" }],
  "warnings": [
    { "code": "unmapped_column", "message": "\"Fax\" will not be imported",
      "count": 31, "sample_rows": [2, 5, 9] }
  ],
  "skipped": [{ "row": 44, "reason": "missing or invalid email" }],
  "sample": [ /* up to 5 resolved rows, post-mapping */ ]
}
```

The real import additionally returns `created`, `updated`, `skipped`,
`memberships_assigned`, `plan_limited`, and `custom_fields_created`.

**`skipped` is returned in full, not capped.** The current dry run truncates to
20 (`skipped.slice(0, 20)`), which is fine for an alert box but useless for the
error CSV, whose entire purpose is letting a guild fix and re-import exactly the
failed rows. At the 5,000-row request ceiling the worst case is 5,000 short
objects — a few hundred KB, well within a Worker response. The UI still displays
only the first few.

### Warning codes

| Code | Fires when |
|---|---|
| `unmapped_column` | Column is `ignore` **and has a non-empty value in ≥1 row.** An empty column must not warn. |
| `duplicate_target` | Two headers resolve to the same known target |
| `level_not_found` | `level_name` matches no active membership level |
| `unparseable_date` | `end_date` or `joined_at` will not parse |
| `invalid_status` | Status is not in `MEMBER_STATUSES` |
| `plan_limit_will_hold` | Free plan will hold N rows below `active` |

Warnings never block. The only hard stop remains "no email column".

`plan_limit_will_hold` is new information, not a restatement: today
`plan_limited` is only reported *after* the import, so a guild on the free plan
discovers the 30-member cap by finding members mysteriously inactive.

### Custom-field definitions

Definitions live in `tenants.settings_json.custom_fields` as
`[{ key, label, ... }]`; values live in `members.custom_fields_json`. Both
already exist and are consumed by the join form, admin edit, and portal
profile.

Import is **additive only**: it may append a definition whose `key` is absent.
It never renames, reorders, or removes an existing one, so an import cannot
corrupt a guild's existing schema. Keys are slugified from the header and
de-duplicated with a numeric suffix on collision.

### Admin UI

`importMembers()` in `public/admin.html` loses its `confirm()` and gains a
screen:

1. File chosen → parse → POST dry run with `header` + `rows`.
2. Render a mapping table: one row per column, showing the header, a sample
   value from the file, and a `<select>` — every known target, "Import as
   custom field", or "Ignore".
3. Below it, the counts and the warning list.
4. Changing a select re-posts the dry run so counts and warnings stay truthful.
5. One **Import** button. On success, the skipped rows are offered as a
   downloadable error CSV: original row number, row data, reason.

The error CSV is what makes a failed import recoverable — a guild fixes 12 rows
and re-imports those, rather than re-running 240 and guessing.

### Re-run safety

Import matches on email and updates rather than duplicating, so re-importing a
corrected file converges. This is existing behaviour; the design's contribution
is to **assert it in the test suite** rather than assume it, because it is the
property a nervous migrating admin depends on most.

## Testing

No test runner exists in this repo; verification is `scripts/*.mjs`, matching
`scripts/e2e-auto-renew.mjs` and `scripts/verify-scale.mjs`.

**`scripts/verify-import.mjs`**, wired as `npm run test:import`.

*Layer 1 — pure functions.* Bundle the real `importMapping.ts` with esbuild and
call it directly, the same technique `verify-scale.mjs` uses to test shipped
code rather than a reimplementation:

- Synonym detection across WA header spellings ("E-Mail", "First name")
- Existing custom field matched by key and by label
- Two headers claiming one target → `duplicate_target`, first wins
- Unknown header → `ignore` + listed in `unmapped`

*Layer 2 — the flow, over HTTP against `wrangler dev`:*

- **Dry run writes nothing** — member count and `settings_json.custom_fields`
  identical before and after. Protects the "preview is safe" promise.
- Ignored column with data → `unmapped_column`; empty column → no warning
- Column mapped to a new custom field → definition created in `settings_json`
  **and** value stored in `members.custom_fields_json`
- Importing the same file twice → zero duplicates, converging counts
- `level_not_found`, `unparseable_date`, `invalid_status`,
  `plan_limit_will_hold` each fire on a crafted row
- Custom-field creation never removes or renames an existing definition

**Fixture:** `scripts/fixtures/wa-export-sample.csv` — a realistic Wild Apricot
export of ~25 columns containing the nine mapped fields, several custom columns
("Committee", "Machine Type", "Bee Group"), one entirely empty column, one
unparseable date, one invalid status, and one duplicate email.

> This fixture is an **assumption** about what a Wild Apricot export looks like.
> No real export was available when it was written. Correct it the first time a
> real one is seen — and re-run the suite, because the fixture is effectively
> the specification.

## Decomposition context

"Pilot-guild onboarding prep" is three subsystems. This spec is A.

| | Scope | Status |
|---|---|---|
| **A** | Trustworthy migration — this document | Designed |
| **B** | Import history: persist each run (mapping, counts, skipped rows) with an admin page to review. Today an import is a one-shot alert and the evidence is gone. Folds in the onboarding checklist's one real gap — progress is client-side, so it does not survive a browser change and is invisible to the platform admin. | Deferred until A is dogfooded |
| **C** | Onboarding checklist rework | **Downgraded.** It already works: four steps with genuine data-driven completion. Its one gap folds into B. |

B is deliberately deferred: dogfooding A will show what is worth recording, and
guessing before running a single real import is how B gets over-built.

## Decided during review

**Custom fields merge into the existing statements.** `applyMapping` returns
`customFields` per row, and the import loop currently builds one `INSERT` per
member without touching `custom_fields_json`. Rather than issue a second write
per row — which would double D1 calls on a 5,000-row import — the mapped
custom fields are serialised into `custom_fields_json` as part of the existing
INSERT and UPDATE.

On update, the incoming values are **merged over** the member's existing
`custom_fields_json` rather than replacing it, matching the behaviour already
in the admin PATCH route (`src/routes/members.ts:384-388`). A re-import that
omits a column must not wipe values a guild entered by hand.
