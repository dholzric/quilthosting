# QuiltHosting Zapier app

Private Zapier Platform CLI app for QuiltHosting. Built in v0.27.0-preview.

## Status: private app, not publicly listed

Public directory listing needs a Zapier account, a review submission, and 10
live users — and the product is still behind the stealth gate, so none of that
is possible yet. This package is complete and usable via private invite; the
listing is tracked as Phase 6 in `docs/superpowers/plans/2026-08-09-wildapricot-master-program.md`.

## What it does

| Kind | Name | Event / endpoint |
|---|---|---|
| Trigger | New Member | `member.created` (REST hook) |
| Trigger | New Event Registration | `event.registration` (REST hook) |
| Action | Create Member | `POST /api/v1/members` |

## Not yet available as Zapier triggers

QuiltHosting emits seven webhook events. These four are **not** exposed as
triggers in this app yet — they work as raw webhooks (Admin → Zapier → add
endpoint) but have no native trigger:

- `member.updated`
- `member.activated`
- `membership.activated`
- `payment.succeeded`
- `form.response`

Adding them is Phase 2 work. Do not describe this app as covering the full
event catalog.

## API key scopes

The app asks for one API key. It must carry:

- **`hooks:write`** — required for *any* trigger, because Zapier subscribes and
  unsubscribes a REST hook when the Zap is turned on and off. A trigger-only
  Zap still needs it.
- **`members:write`** — only needed for the Create Member action.

`read` is always granted.

## Site URL field

The auth form has an optional **Site URL** defaulting to
`https://quilthosting.com`. It exists so the app can be tested against a
preview deployment or a tunnel without forking the package. Leave it alone in
production.

## Development

```bash
cd integrations/zapier
npm install
npx zapier-platform validate   # offline structural check, no account needed
```

`zapier-platform validate` alone is **not** sufficient evidence the app works — it only
checks structure. Before shipping to any user, run a real cycle:

1. `npx zapier-platform push` to a private app version.
2. Turn on a Zap using **New Member** → confirm a hook appears in
   `GET /api/v1/hooks`.
3. Create a member in QuiltHosting → confirm the Zap fires.
4. Run the **Create Member** action → confirm the member appears, and that
   running it twice with the same task does not duplicate.
5. Turn the Zap off → confirm the hook is gone from `GET /api/v1/hooks`.

## Fixtures

`fixtures/*.json` are copies of `scripts/fixtures/events/*.json` from the repo
root, kept local so this package stays self-contained if it is ever published
standalone. `npm run test:integrations` at the repo root asserts the two copies
have not drifted.

## Idempotency

The Create Member action sends an `Idempotency-Key` derived from the Zapier
task id. The API replays the original `201` for a retry with the same body, so
Zapier's automatic retries cannot create duplicate members or report a false
failure.
