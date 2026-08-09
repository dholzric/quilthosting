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

Optional but strongly recommended on `POST`. Zapier and Make retry on timeout;
without a key, a retried create hits the duplicate-email guard, returns `409`,
and the Zap reports failure for a member that was in fact created.

- Same key, same body → replays the original response verbatim.
- Same key, different body → `422 idempotency_key_reuse`.
- 5xx responses are never cached, so transient failures stay retryable.

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
