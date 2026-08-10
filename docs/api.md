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
concurrent requests carrying the same key can never both execute the
mutation — one of them always loses the race and gets an answer below
instead of running.

- Same key + same request body → the original response is replayed verbatim,
  for as long as the record is retained (see Retention below).
- Same key + a different request body → `422` with
  `{ "code": "idempotency_key_reuse" }`.
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

1. **An abandoned reservation isn't taken over immediately.** If a request
   that claimed a key never finishes (worker crash, hung handler), the key
   keeps answering `409 idempotency_in_progress` for up to
   `RESERVATION_SECONDS` — currently **60 seconds** — before another request
   with the same key is allowed to take the slot over and actually execute.
   A client that retries faster than that will see `409` for the full window
   even though nothing is actually still running.
2. **This protects against concurrent double-execution, not against
   re-execution after a crash.** The reservation guarantees two *simultaneous*
   requests with the same key can't both run the handler. It does **not**
   guarantee exactly-once execution end-to-end: if the Worker process dies
   after the member row is mutated but before the response is written back to
   the idempotency record, the reservation simply lapses after
   `RESERVATION_SECONDS`, and a later retry with the same key re-executes the
   handler and mutates again. There is no transaction spanning the mutation
   and the idempotency-record write — only the concurrent case is covered.
3. **`429 hook_limit` is not reachable through this mechanism today.** Only
   the two member routes above are wired through the idempotency layer;
   `POST /v1/hooks` is not, so hitting the hook-count limit never touches
   idempotency caching at all. Don't read a mention of `429 hook_limit`
   elsewhere as evidence hook creation is idempotency-wrapped — it isn't.
4. **Retention is bounded, not indefinite.** A completed record is replayable
   for `RETENTION_HOURS` — currently **24 hours** — after it's written, and
   is cleared by a maintenance sweep that runs once a day on the cron. Once a
   record ages out and is swept, the same key is treated as new and the
   handler runs again on the next request.

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

Computed identically for a dry run and a real import:

| Code | Message | When it fires |
|---|---|---|
| `unmapped_column` | `"<header>" will not be imported` | A column is unmapped/ignored **and** at least one row has a non-empty value in it. A column that is entirely empty produces no warning. |
| `duplicate_target` | `"<header>" also matches <target>; the first column wins and this one is ignored` | Two columns map to the same known target — the first (lowest index) wins; the rest report this warning and **are actually demoted to ignore** in the mapping the server applies. This holds whether the duplicate came from the server's own auto-proposed mapping or from an admin explicitly setting two columns to the same target by hand (the UI has no client-side guard against this) — the server re-derives and enforces it either way, so the warning text is never just advice the code doesn't follow. |
| `unparseable_date` | Some renewal/expiry dates could not be read and will be left blank | A row's end/expiry/renewal/expiration value doesn't parse as a date. |
| `invalid_status` | Some statuses are not one of: pending, active, lapsed, cancelled. Those rows import as active. | A row's status value isn't one of the four known statuses. |
| `level_not_found` | Some membership levels do not exist in this guild; those members import without a membership | A row's level name doesn't match any active level for the tenant. |
| `column_count_mismatch` | Some rows have a different number of columns than the header and will be skipped | A raw row's length doesn't match `header.length`; the row is skipped entirely rather than risk misaligning fields. |
| `plan_limit_will_hold` | Free plan allows 30 active members; N row(s) will import as pending until you upgrade | Tenant is on the free plan and more rows want `active` status than there are remaining active-member slots. This is an estimate — see note below. |

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
  "created": 80,
  "updated": 35,
  "skipped": 5,
  "memberships_assigned": 60,
  "plan_limited": 0,
  "custom_fields_created": [{ "key": "guild_number", "label": "Guild #" }],
  "skipped_rows": [{ "row": 12, "reason": "missing or invalid email" }]
}
```

`skipped_rows` uses the same shape and the same `reason` strings as the dry
run's `skipped` array — the admin UI's error-CSV download depends on this
matching exactly. Upsert is keyed on lowercased `email`; a row whose email
already exists on the tenant updates that member instead of creating a
duplicate.

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
