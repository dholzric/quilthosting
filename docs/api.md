# QuiltHosting Public API (v1)

**Live HTML:** [/docs/api.html](../public/docs/api.html)  
**Base URL:** `https://quilthosting.com/api/v1`  
**Auth:** `Authorization: Bearer qh_…` (create keys in Admin → API)

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| GET | `/me` | read | Tenant id, name, slug, plan |
| GET | `/members?status=&page=&limit=` | read | Members (paginated; max 500/page) |
| GET | `/events` | read | Events |
| GET | `/payments` | read | Payments |
| GET | `/levels` | read | Active membership levels |

## Authentication

```bash
curl -s https://quilthosting.com/api/v1/me \
  -H "Authorization: Bearer qh_…"
```

Optional query form (less secure): `?api_key=qh_…`

API routes skip the site-access password gate; the key is the only auth.

## Examples

```bash
curl -s "https://quilthosting.com/api/v1/members?status=active" \
  -H "Authorization: Bearer qh_…" 

curl -s https://quilthosting.com/api/v1/payments \
  -H "Authorization: Bearer qh_…"
```

## Scopes

Keys are minted in Admin → API with any combination of:

| Scope | Grants |
|---|---|
| `read` | Always granted. All `GET` endpoints. |
| `members:write` | `POST /members`, `PATCH /members/:id` |
| `hooks:write` | `POST /hooks`, `DELETE /hooks/:id` |

A trigger-only Zap still needs `hooks:write`, because Zapier subscribes and
unsubscribes a hook when the Zap is turned on and off. It does **not** need
`members:write` — the split exists so a trigger cannot mutate your data.

Keys minted before v0.27.0 carry a legacy `write` scope that grants both.

Calling a write endpoint without the scope returns:

```json
{ "error": "This API key lacks the \"members:write\" scope.",
  "code": "insufficient_scope", "required": "members:write" }
```

## Write endpoints

### `POST /api/v1/members` — `members:write`

```bash
curl -s -X POST https://quilthosting.com/api/v1/members \
  -H "Authorization: Bearer qh_…" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: zap-01H8XYZ" \
  -d '{"email":"member@example.com","first_name":"Ada","status":"pending"}'
```

Body: `email` (required), `first_name`, `last_name`, `phone`, `status`
(`pending` | `active` | `lapsed` | `cancelled`, default `pending`).

`201 { "member": { … } }`. Setting `active` consumes a slot against the free
plan's 30-active-member limit.

### `PATCH /api/v1/members/:memberId` — `members:write`

Body: any of `first_name`, `last_name`, `phone`, `status`.

**`email` cannot be changed here**, unlike the admin UI. Changing the identity
key from an integration has no merge story — a mistyped Zap would silently
split a member's history in two.

### `Idempotency-Key`

Accepted only on `POST /api/v1/members` and `PATCH /api/v1/members/:memberId`.
`POST /api/v1/hooks` and `DELETE /api/v1/hooks/:hookId` do **not** accept an
`Idempotency-Key` and are not covered by anything below — a retried
`POST /hooks` will mint a second hook.

Optional but strongly recommended on `POST /members`. Zapier and Make retry
on timeout; without a key, a retried create hits the duplicate-email guard,
returns `409`, and the Zap reports failure for a member that was in fact
created.

**Scoping.** The key is scoped to the specific operation, not just to the raw
key string — `POST /v1/members` and `PATCH /v1/members/:memberId` are tracked
independently even if you pass the same key value to both. Reusing one id
across a workflow's steps (Zapier reuses its task id for a create and a later
update in the same Zap) is safe; the two calls don't collide.

**Behavior.** A reservation row is written *before* the handler runs, so two
concurrent requests carrying the same key cannot both execute the mutation
**provided the first request's handler finishes within `RESERVATION_SECONDS`**
— see Limitation 1 below for what happens when it runs longer than that.

- Same key + same request body → the original response is replayed verbatim,
  for as long as the record is retained (see Limitation 5 below — the real
  window is looser than a clean 24-hour cutoff).
- Same key + a different request body → `422` with
  `{ "code": "idempotency_key_reuse" }`. What's fenced is the request body
  **plus the route's path parameters** — for `PATCH`, that includes
  `memberId` — so the same key applied to two *different members* with
  otherwise-identical bodies also 422s, not only a body diff on the same
  member.
- Same key while the original request is still executing → `409` with
  `{ "code": "idempotency_in_progress" }` and a `Retry-After` header. **This
  is the correct, expected answer to a too-fast retry, not a failure** —
  it means a request with this key genuinely has not finished yet. Wait and
  retry the same request; don't surface it to an end user as an error.
- Transient refusals — `402` (`plan_limit`) and any `5xx` — are **not**
  cached. The reservation is released instead, so the identical request,
  retried once the underlying condition has changed (the guild upgrades off
  the free plan, a transient server error clears), gets a real re-run rather
  than a replayed stale failure.

**Limitations:**

1. **Takeover of a reservation is decided purely by elapsed time, not by
   knowing the original request actually died.** The takeover check tests
   only `reserved_until <= now` — it cannot tell a crashed holder from one
   that is still legitimately running slow. Two consequences fall out of
   that:
   - While the original handler is running and `RESERVATION_SECONDS` —
     currently **60 seconds** — hasn't elapsed, a concurrent retry with the
     same key just gets `409`, even though nothing is stuck.
   - If the original handler is *still running* once `RESERVATION_SECONDS`
     elapses — not crashed, just slow — a second, concurrent request with the
     same key **is allowed to take over the slot and execute the handler
     too**, running alongside the first. The "cannot both execute" guarantee
     above holds only inside the `RESERVATION_SECONDS` window, not past it.
2. **This is a time-bounded concurrency guard, not crash-safety, and not a
   guarantee of exactly-once execution end-to-end.** Two distinct gaps share
   the same root cause — nothing makes the mutation, the outbound response,
   and the idempotency record commit together:
   - A handler that legitimately runs past `RESERVATION_SECONDS` can have a
     concurrent duplicate run alongside it (Limitation 1).
   - A Worker that dies after mutating but before `complete()` writes the
     response leaves a reservation that simply lapses; a later *sequential*
     retry with the same key re-executes the handler and mutates again.
   Neither case is protected — only a request that both stays inside
   `RESERVATION_SECONDS` and doesn't crash is.
3. **A caller whose lease is taken over mid-handler still performs its
   mutation for real, but its response is silently not cached.**
   `complete()`/`release()` are fenced against the exact `reservedUntil` the
   caller was handed; if the slot was taken over while the handler ran, that
   fenced write matches zero rows, a warning is logged server-side, and
   nothing is recorded under the key — but the HTTP caller whose lease lapsed
   still gets its real response back over the wire. The practical effect: a
   later retry with that key finds either the new owner's record or nothing,
   never this caller's result, and re-executes instead of replaying.
4. **`429 hook_limit` is not reachable through this mechanism today.** Only
   the two member routes above are wired through the idempotency layer;
   `POST /v1/hooks` is not, so hitting the hook-count limit never touches
   idempotency caching at all. Don't read a mention of `429 hook_limit`
   elsewhere as evidence hook creation is idempotency-wrapped — it isn't.
5. **Retention is bounded, but the real worst case is closer to double
   `RETENTION_HOURS` than a clean cutoff.** Replaying a completed record does
   not check `expires_at` — it replays on `status`/`response_json` alone.
   `expires_at` only matters to the once-a-day sweep, which deletes rows
   where `expires_at <= now`. So a record can stay replayable for
   `RETENTION_HOURS` (currently **24 hours**) plus however long it sits
   already-expired waiting for the next sweep (up to another ~24 hours) —
   **up to roughly 48 hours** in the worst case, not a hard 24-hour boundary.
   Once the sweep actually removes the row, the same key is treated as new
   and the handler runs again.

## Bulk member import (Admin UI, not the v1 API)

`POST /api/tenants/:tenantId/members/import` — powers the CSV importer in
Admin → Members → Import. This is a **tenant-admin route** authenticated
with the admin's JWT session, not an `/api/v1` endpoint — API keys cannot
call it. Documented here because it's the primary bulk-write path for
members and this is where the members section of the docs lives.

### Request

Exactly one of `rows` or `raw_rows` may be present:

- **Legacy shape (unchanged, still fully supported):**
  `{ "rows": [{ "email": "...", "first_name": "...", "level_name": "...", ... }] }`
  — an array of already-normalized row objects. This is the shape the
  public v1 API and existing migration scripts have always sent; it needs
  no `header` and no `mapping`.
- **Column-mapping shape:**
  `{ "header": [...], "raw_rows": [[...], ...], "mapping"?: {...}, "dry_run"?: true }`
  — `raw_rows` is the file's data rows as raw string arrays (no header
  row); `header` (required whenever `raw_rows` is sent) is the file's
  header row. `mapping` is optional — when omitted, the server proposes one
  (`proposeMapping()` in `src/lib/importMapping.ts`) and returns it in the
  response so a UI can render a column table and let the admin adjust it.

| Condition | Response |
|---|---|
| Both `rows` and `raw_rows` present | `400 { "error": "Send either rows or raw_rows, not both", "code": "ambiguous_payload" }` |
| `raw_rows` present, `header` missing | `400 { "error": "raw_rows requires header", "code": "missing_header" }` |
| Neither present (or `rows` is empty) | `400 { "error": "rows array is required" }` |
| More than 5000 rows | `400 { "error": "Max 5000 rows per import — split larger files" }` |
| Two or more columns mapped to the same custom-field `key` | `400 { "error": "Two or more columns map to the same custom field: …", "code": "duplicate_custom_key", "duplicates": [{ "key", "headers": [...], "indices": [...] }] }` |

The `duplicate_custom_key` 400 is a **real-import-only** refusal: the check
runs after the dry-run branch has already returned, and before anything is
written — no members, no memberships, no custom-field definitions. A dry run
with the same mapping does not 400; it reports the same problem as a
`duplicate_custom_key` warning instead. The refusal exists because the second
column would otherwise silently overwrite the first with nothing recording
that a whole column of data was lost.

`dry_run: true` runs every check and returns the full reconciliation
**without writing anything** — no members, no memberships, no custom-field
definitions are created or changed.

### `mapping` shape

Keyed by **column index** (a stringified integer in JSON, e.g. `"0"`,
`"1"`) rather than header text, because CSV headers are not unique — an
export can have two "Notes" columns. Each entry is one of:

```json
{ "kind": "known", "target": "email" }
{ "kind": "custom", "key": "quilt_guild_number", "label": "Guild #" }
{ "kind": "ignore" }
```

`target` is one of the known member fields: `email`, `first_name`,
`last_name`, `phone`, `status`, `notes`, `level_name`, `end_date`,
`joined_at`. Header synonyms (matched case/punctuation-insensitively) live
in `TARGET_SYNONYMS` in `src/lib/importMapping.ts` — e.g. `end_date`
matches `Expiry`, `Expiration`, `Renewal Date`, `Membership Expires`;
`joined_at` matches `Joined`, `Join Date`, `Member Since`.

A `"custom"` entry creates a new custom-field definition on a real import
(never on a dry run) unless a field with that `key` already exists on the
tenant. Custom-field definitions are **additive only** — import never
renames, reorders, or removes an existing definition. On update, incoming
custom-field values are merged over the member's existing custom fields
(incoming wins per-key, everything else is kept), so hand-entered data
already on a member's record is never wiped by a re-import.

### Warnings

Both a dry run and a real import call the same `buildWarnings()` in
`src/routes/members.ts`, so the same **conditions** are detected on both
paths. The `message` text differs by tense (a `phase: "preview" | "applied"`
argument switches "will be skipped" to "were skipped"), and two codes are
preview-only in practice — see the table.

The `Lossy` column is the one that matters for the real import's `status`:
it is exactly the `LOSSY_WARNING_CODES` set in `src/routes/members.ts`, and
a real import whose file triggers any lossy code reports
`status: "partial"`, never `"completed"`.

| Code | Lossy | Message (preview wording) | When it fires |
|---|---|---|---|
| `unmapped_column` | yes | `"<header>" will not be imported` | A column is unmapped/ignored **and** at least one row has a non-empty value in it. A column that is entirely empty produces no warning. |
| `duplicate_target` | yes | `"<header>" also matches <target>; the first column wins and this one is ignored` | Two columns map to the same known target — the first (lowest index) wins; the rest report this warning and **are actually demoted to ignore** in the mapping the server applies. This holds whether the duplicate came from the server's own auto-proposed mapping or from an admin explicitly setting two columns to the same target by hand (the UI has no client-side guard against this) — the server re-derives and enforces it either way, so the warning text is never just advice the code doesn't follow. |
| `duplicate_custom_key` | n/a | `"<a>" and "<b>" would both import into the same custom field. Rename one column, or set one to "Do not import".` | **Dry run only.** Two columns map to the same custom-field `key`. A real import with the same mapping returns the `duplicate_custom_key` 400 above instead of importing, so this code can never appear in a real import's `warnings`. |
| `unparseable_date` | yes | Some renewal/expiry dates could not be read and will be left blank | A row's end/expiry/renewal/expiration value doesn't parse as a date. On a real import, where the row also names a level, the membership end date is computed from the level's duration instead of the file's date — a fabricated date, not the guild's. |
| `end_date_without_level` | yes | Some rows have a valid renewal/expiry date but no membership level — the date will not be stored | The row's date parsed fine, but with no level there is no membership to attach it to, so it is dropped. |
| `unparseable_join_date` | yes | Some "member since" dates could not be read; they will be stored exactly as typed, without validation | A row's `joined_at` doesn't parse **and** the row is an insert. There is no fallback for a non-empty bad string on insert: the value is bound into `members.joined_at` verbatim. |
| `joined_at_ignored_on_update` | **no** | Some "member since" dates differ from what's already on file for these existing members… | The row matches an existing member and the file's `joined_at` differs from the stored one by calendar day. Deliberately **not** lossy: the UPDATE statement has no `joined_at` column at all, so the existing (authoritative) value is kept. The file's value is used as the membership start date only on rows that also name a level; on a row with no level it is not used at all. It was excluded from the lossy set because it fires on nearly every updated row of a routine full-roster re-export, which would make `partial` meaningless. |
| `invalid_status` | yes | Some statuses are not one of: pending, active, lapsed, cancelled. Those rows import as active. | A row's status value isn't one of the four known statuses. The coercion to `active` consumes a plan slot and starts guild email. |
| `status_overridden_by_level` | yes | Some rows have a file status (pending, lapsed, or cancelled) that will be overridden to active because the row also names a membership level | The file's status is *valid* — so `invalid_status` cannot see it — but naming a level overrides it to active. |
| `level_not_found` | yes | Some membership levels do not exist in this guild; those members import without a membership | A row's level name doesn't match any active level for the tenant. |
| `column_count_mismatch` | yes | Some rows have a different number of columns than the header and will be skipped | A raw row's length doesn't match `header.length`; the row is skipped entirely rather than risk misaligning fields. |
| `plan_limit_will_hold` | no | Free plan allows 30 active members; N row(s) will import as pending until you upgrade | **Dry run only in practice.** Tenant is on the free plan and more rows want `active` status than there are remaining active-member slots. The real-import call site passes `planWillHold: 0`, so this code does not appear in a real import's `warnings` — the real import counts plan-limiting exactly and reports it as `plan_limited` plus per-row `plan_limited` errors instead. It is an estimate — see note below. |

Each warning object: `{ code, message, count, sample_rows: number[] (1-based row numbers, up to 3), header? }`.

A column demoted to ignore by the `duplicate_target` rule is treated exactly
like any other ignored column afterward: if it carries data it also produces
an `unmapped_column` warning (both warnings can legitimately appear for the
same column), and the `mapping` object echoed back in the dry-run response
reflects the demotion — a supplied `{kind:"known", target:"first_name"}` on
a losing column comes back as `{kind:"ignore"}`, not as the admin's original
(losing) choice, so a UI re-rendering that response shows the true state.

`plan_limit_will_hold` is only an estimate: it counts rows wanting `active`
against remaining slots, but the real import loop also checks whether an
existing member (by email) was *already* active, so the dry-run count can
over-report slightly on a re-import of a partially-imported file.

### Dry-run response

```json
{
  "dry_run": true,
  "total_rows": 120,
  "will_create": 80,
  "will_update": 35,
  "will_skip": 5,
  "header": [...],
  "mapping": {...},
  "unmapped": [{ "index": 4, "header": "Notes 2" }],
  "warnings": [...],
  "skipped": [{ "row": 12, "reason": "missing or invalid email" }],
  "sample": [{ "email": "...", "name": "...", "action": "create", "custom": "{}" }]
}
```

### Real import response

```json
{
  "ok": true,
  "batch_id": "…",
  "status": "partial",
  "created": 80,
  "updated": 35,
  "skipped": 5,
  "memberships_assigned": 58,
  "membership_failures": 2,
  "level_not_found": 0,
  "plan_limited": 0,
  "custom_fields_created": [{ "key": "guild_number", "label": "Guild #" }],
  "skipped_rows": [{ "row": 12, "reason": "missing or invalid email" }],
  "errors": [
    { "row_number": 41, "kind": "membership_failed", "reason": "…", "email": "…" }
  ],
  "warnings": [{ "code": "level_not_found", "message": "…", "count": 3, "sample_rows": [4, 9, 17] }],
  "error_kind_labels": { "membership_failed": "membership(s) failed to assign", "…": "…" }
}
```

`skipped_rows` uses the same shape and the same `reason` strings as the dry
run's `skipped` array — the admin UI's error-CSV download depends on this
matching exactly. Upsert is keyed on lowercased `email`; a row whose email
already exists on the tenant updates that member instead of creating a
duplicate.

`batch_id` is the id of the `import_batches` row this run wrote. Use it with
the history endpoints below.

#### `status`

The column is `import_batches.status` and takes four values:

| Value | Meaning |
|---|---|
| `running` | The batch row was inserted and the run is in flight. A row can only be observed in this state by reading the history endpoints while an import is executing. |
| `completed` | Nothing was lost. |
| `partial` | **Something was not fully imported.** Review the batch's `errors` and `warnings`. |
| `failed` | The run threw. The batch is closed as `failed` with whatever counts were known at the time and the request returns a 500. Rows already written by an earlier chunk stay written — see "What import does not do". |

`completed` requires **all** of: zero skipped rows, zero membership
failures, zero plan-limited rows, zero level-not-found rows, and no lossy
warning fired. Anything else is `partial`. The last condition is derived
from `LOSSY_WARNING_CODES` rather than hand-counted, so a lossy condition
`buildWarnings()` knows about forces `partial` even if nothing else counts it.

##### `partial` with zero row errors

`errors` and `warnings` are **not** two views of the same thing. `errors` is
per-row (`import_batch_errors`: which row, what kind, why). `warnings` is
column-level and whole-file — `unmapped_column` and `duplicate_target`
describe a *column*, not a row, so they never produce an `import_batch_errors`
row.

So a batch can legitimately be `partial` with an **empty `errors` array and a
non-empty `warnings` array**: e.g. a CSV with one ignored column that carries
data in every row loses an entire column of data, but no individual row
failed. A client that renders only `errors` shows an unexplained "partial".
Render both. Both history endpoints return `warnings` for this reason.

##### `partial` caused only by the free-plan cap

`plan_limited > 0` counts toward `partial`. That is intentional — members
held at `pending` by the free-plan cap really are not active — but it means
**a free-plan guild importing 40 members always gets `status: "partial"`**
even when their file is perfect. Nothing failed; the guild is over the free
plan's 30-active-member limit and the extra rows imported as `pending`.

The admin UI detects this specific case (every entry in `errors` has
`kind: "plan_limited"` and `warnings` is empty) and shows "Import complete —
N member(s) are waiting on your plan's active-member limit" rather than
"Import finished with problems". The **"Recent imports" history card still
shows the `partial` badge** for these batches: the batch list columns do not
carry enough information to distinguish the case reliably (there is no
`level_not_found` column on `import_batches`), so it is not second-guessed
there. Download the batch's errors to see that every held row is
`plan_limited`.

#### `errors` and `error_kind_labels`

Each entry: `{ row_number, kind, reason, email }` (`email` may be `null`).
`kind` is one of `skipped`, `membership_failed`, `level_not_found`,
`plan_limited`, `unparseable_date`, `unparseable_join_date`,
`joined_at_ignored_on_update`, `invalid_status`, `status_overridden_by_level`,
`end_date_without_level`.

`error_kind_labels` is a server-supplied `kind → human label` map. Clients
should group `errors` by `kind` and look the label up here rather than
hand-maintaining a parallel list — that drift is what previously let new
error kinds vanish from the UI and the downloadable report.

Note that `joined_at_ignored_on_update` produces error rows but is not a
lossy warning, so its presence alone does not make a batch `partial`.

### Import history

Both routes are tenant-admin routes under the same auth as the import itself
(`requireAuth` → `tenantMiddleware` → `requireTenantAccess`), and both filter
by `tenant_id`.

#### `GET /api/tenants/:tenantId/members/import/batches`

The tenant's last 50 batches, newest first (`ORDER BY started_at DESC LIMIT 50`).

```json
{
  "batches": [
    {
      "id": "…",
      "status": "partial",
      "mapping_json": "{…}",
      "warnings_json": "[…]",
      "warnings": [{ "code": "unmapped_column", "message": "…", "count": 12, "sample_rows": [1, 2, 3], "header": "Notes 2" }],
      "total_rows": 120,
      "created_count": 80,
      "updated_count": 35,
      "skipped_count": 5,
      "memberships_assigned": 58,
      "membership_failures": 2,
      "plan_limited": 0,
      "custom_fields_created": 1,
      "started_at": "…",
      "finished_at": "…",
      "actor_user_id": "…",
      "actor_email": "…"
    }
  ]
}
```

`warnings` is `warnings_json` already parsed (both are returned; the raw
column is left in place rather than removed from the row). `mapping_json` is
**not** parsed — it is returned as the stored JSON string.

`custom_fields_created` is a **count** here, unlike the import response where
it is an array of `{ key, label }`.

`actor_user_id` / `actor_email` record who ran the import. `actor_email` is a
snapshot taken at import time, not a live join to `users.email`, so it stays
accurate if the account's email later changes or the user is deleted. Both
are `null` on batches created before the column existed.

#### `GET /api/tenants/:tenantId/members/import/batches/:batchId/errors`

```json
{
  "batch_id": "…",
  "errors": [
    { "id": "…", "row_number": 41, "kind": "membership_failed", "reason": "…", "email": "…", "created_at": "…" }
  ],
  "warnings": [ … ],
  "error_kind_labels": { … }
}
```

The full, **uncapped** per-row list for one batch, `ORDER BY row_number ASC` —
this is what the admin downloads as a CSV after a migration. The batch is
looked up by `id` **and** `tenant_id` first; a batch id belonging to another
guild returns `404 { "error": "Import batch not found" }`, indistinguishable
from a batch that does not exist.

`warnings` is the same parsed array the list endpoint returns, present here so
a `partial` batch whose only loss was column-level is still explained in the
downloadable report.

### What import does not do

Stated plainly, because the batch reporting above makes it easy to assume
more than is true:

- **There is no rollback.** Nothing captures a before-state, so a `partial`
  or `failed` batch cannot be undone. The `batch_id` identifies what
  happened; it is not an undo handle.
- **Import is not one transaction.** Member inserts/updates execute as
  `DB.batch()` calls in chunks of 50, membership assignment runs afterwards
  per row, and the error rows are written in chunks of 50 after that. A
  throw part-way leaves earlier chunks written; the batch is closed as
  `failed` (best effort) and the request 500s.
- **There is no resume.** A `failed` batch cannot be continued from where it
  stopped.
- **There is no delta re-import.** Nothing computes "what is still missing"
  from a previous batch.

The supported recovery is to **fix the CSV and import it again.** That
converges because upsert is keyed on lowercased `email`: rows that already
landed update in place instead of duplicating. It converges on member
records; it does not roll anything back, and a re-import re-applies the same
rules (so, for example, a plan-limited row stays `pending` until the plan
changes).

**Known gap — custom-field creation is racy.** When a mapping introduces new
custom fields, the route reads `tenants.settings_json`, appends the new
definitions, and writes the whole column back (`SELECT` then `UPDATE`, with no
compare-and-swap). A settings edit committed between that read and that write
is overwritten. The window is narrow and the admin UI does not encourage
concurrent edits, but it is real. The write also happens *before* any member
row is written and is not undone if the import subsequently fails — custom
field definitions can outlive a failed batch. Definitions are additive only:
import never renames, reorders, or removes one.

## Hook endpoints (REST hooks)

### `GET /api/v1/hooks`

Lists subscriptions. **Never returns secrets.**

### `POST /api/v1/hooks` — `hooks:write`

```bash
curl -s -X POST https://quilthosting.com/api/v1/hooks \
  -H "Authorization: Bearer qh_…" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.zapier.com/…","events":["member.created"]}'
```

`201 { "hook": { "id", "url", "events", "secret" } }` — the `secret` is shown
**once**. URLs must be `https` and are checked against a hostname deny list.
Unknown event names are rejected, not filtered. Limit: 25 hooks per guild.

### `DELETE /api/v1/hooks/:hookId` — `hooks:write`

`200 { "deleted": true }`.

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `missing_field` | 400 | A required field was absent |
| `invalid_status` | 400 | Status not in the allowed list |
| `unknown_event` | 400 | Event name is not in the catalog |
| `invalid_hook_url` | 400 | Not https, or a blocked host |
| `insufficient_scope` | 403 | Key lacks the required scope |
| `not_found` | 404 | No such member or hook in this guild |
| `duplicate_email` | 409 | A member already uses that email |
| `idempotency_key_reuse` | 422 | Key reused with a different body |
| `plan_limit` | 402 | Free plan active-member limit reached |
| `hook_limit` | 429 | 25-hook-per-guild limit reached |

## Zapier / Make

There is a native Zapier app (private, not directory-listed) with **New
Member** and **New Event Registration** triggers and a **Create Member**
action — see `integrations/zapier/README.md`.

For anything it does not cover:

1. Admin → API → create a key with the scopes you need (copy once).
2. Zapier: **Webhooks by Zapier**, or **Code by Zapier** with `fetch`.
3. Subscribe a hook via `POST /api/v1/hooks`, or poll `/members` / `/payments`
   and filter by `created_at`.

## Related public (non-API-key) endpoints

| Path | Purpose |
|------|---------|
| `GET /public/:slug/info` | Profile, logo_url, join fields |
| `GET /public/:slug/logo` | Guild logo image |
| `GET /public/:slug/levels` | Public levels |
| `GET /public/:slug/events` | Public events |
| `POST /public/:slug/cart/checkout` | Store multi-SKU cart |
| `GET|POST /public/:slug/forms/:formSlug` | Public forms |

Admin/portal UIs use JWT auth, not API keys.
