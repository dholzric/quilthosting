# Operations

Deploying, configuring and running QuiltHosting in production. Everything here is verified against the code at v0.56.0-preview; file references are given so it can be re-checked.

## Deploy

There is no deploy job in CI — deploys are run from a workstation.

```bash
npx tsc --noEmit                 # typecheck
npx vitest run                   # unit tests (src/**/*.test.ts, pure node env)
npm run db:migrate:remote        # wrangler d1 migrations apply quilthosting-db --remote
npm run deploy                   # wrangler deploy
```

Order matters: apply migrations before deploying code that reads new columns. Migrations are additive and idempotent to re-run (`wrangler` tracks applied ones); CI proves the whole chain applies to an empty database.

Post-deploy checks (manual — there is no script):

- `GET /api/version` → `{ "version": "0.56.0-preview" }` (behind the site gate; send the `qh_site` cookie or a session bearer).
- `GET /` with `Accept: application/json` → `{ name, version, status, environment, admin, portal, api }`.
- A 401 from either without credentials is the expected stealth signal, not a failure.
- After a deploy, tenant subdomains must still resolve. They are zone DNS records (`AAAA 100::`, proxied), not Workers custom domains, precisely so `wrangler deploy` cannot reconcile them away (`src/lib/tenantHost.ts`, commit `4851117`).

`wrangler.toml` notes:

- `workers_dev = true` must stay: declaring `[[routes]]` otherwise turns the `quilthosting.dholzric.workers.dev` hostname off, and the Stripe webhook was pointed there once (Aug 2026).
- Routes: `quilthosting.com` (custom domain) plus a zone-wide `*/*` catch-all so Cloudflare-for-SaaS custom hostnames and tenant subdomains reach the Worker.
- `[assets] run_worker_first = true` so the site gate applies to `admin.html`/`portal.html`; unmatched GET/HEAD falls through to `ASSETS.fetch` (`src/index.ts`).
- After changing any binding: `npm run cf-typegen`.

Version bump: `package.json` `version` **and** `src/version.ts` `APP_VERSION` — a manual two-file bump. `GET /api/version` and every page footer (`[data-qh-version]`) read `APP_VERSION`. Keep the `-preview` suffix while in stealth.

## Configuration

### `[vars]` (plain text, in `wrangler.toml`)

| Var | Purpose |
|---|---|
| `ENVIRONMENT` | `production`. Only `development` lets the site gate open without a password and widens CORS to localhost. |
| `APP_URL` | `https://quilthosting.com`. CORS platform origin, tenant host resolution, Google redirect URI, portal links, unsubscribe mailto host. |
| `GOOGLE_AUTH_REQUIRED` | `"true"` → password login/register return 403; admin is Google-only. Portal magic links unaffected. |
| `EMAIL_FROM` | Resend sender. Currently `QuiltHosting <noreply@quiltmap.com>` (one verified domain on the Resend free plan) — swap to quilthosting.com at launch. |
| `GOOGLE_CLIENT_ID` | Public OAuth client id (shared with sibling QuiltMap sites). |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_WORKER_NAME` | Subdomain and custom-hostname provisioning. `tenantHost.ts` also carries the zone id as a literal fallback — two places to change. |
| `SAAS_CNAME_TARGET` | `customers.quilthosting.com` — the CNAME target shown to customers. |

### Secrets (`wrangler secret put NAME`; locally in `.dev.vars`)

| Secret | Required | Without it |
|---|---|---|
| `JWT_SECRET` | yes | No auth at all; also keys the site-gate cookie HMAC and the `/__scheduled` trigger. |
| `STRIPE_SECRET_KEY` | yes | All Stripe calls fail; checkout returns 503 "Payments not configured". |
| `STRIPE_WEBHOOK_SECRET` | yes | Every Stripe webhook is rejected with 400. |
| `RESEND_API_KEY` | yes | `sendEmail` logs a warning and sends nothing. |
| `RESEND_WEBHOOK_SECRET` | production | `POST /api/webhooks/resend` returns 503; no delivered/bounced/complained statuses, no bounce or complaint suppression. Value is the Svix `whsec_…` from the Resend dashboard. |
| `SITE_ACCESS_PASSWORD` | production | Production returns 503 "Site access is not configured" (fail closed). |
| `GOOGLE_CLIENT_SECRET` | yes | Google sign-in button disappears; admin sign-in impossible. |
| `CREDENTIAL_KEY` | production | Base64 of exactly 32 random bytes. AES-GCM key for `tenant_credentials` (PayPal keys). Credential routes return 503 rather than storing plaintext. |
| `CLOUDFLARE_API_TOKEN` | production | Subdomain provisioning records `domain_status = skipped`; custom hostnames cannot be created. Needs Zone DNS edit + SSL for SaaS edit on the quilthosting.com zone. |
| `STRIPE_PLATFORM_FEE_BPS` | no | Connect application fee in basis points; default 0, capped at 3000. |
| `STRIPE_GUILD_PRICE_ID` | no | Stripe Price for the $24 Guild plan; else ad-hoc `price_data`. |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | no | QuickBooks Online card reports "not configured on the platform". |

Not env: Twilio credentials are per-tenant in `tenants.settings_json.twilio`; platform admins are a DB flag (below). `PUBLIC_LAUNCH` is declared in `src/types.ts` but read nowhere — it is not a launch switch.

`.dev.vars` keys for a new developer (there is no `.dev.vars.example`): `JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, SITE_ACCESS_PASSWORD, ENVIRONMENT=development, APP_URL=http://localhost:8787, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_AUTH_REQUIRED=false, CREDENTIAL_KEY`.

## External webhooks to configure

| Provider | URL | Events / notes |
|---|---|---|
| Stripe | `POST https://quilthosting.com/api/webhooks/stripe` | Handled: `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`, `account.updated`. One endpoint serves platform billing and Connect (enable Connect events on it). Make sure `checkout.session.expired` is enabled — without it abandoned seat/stock holds are only released by the minute sweeper. Signature is HMAC-SHA256 with a 300 s tolerance; duplicates are deduped by the `stripe_events` inbox (`src/routes/webhooks.ts`). |
| Resend | `POST https://quilthosting.com/api/webhooks/resend` | Svix-signed (`svix-id`, `svix-timestamp`, `svix-signature`; ±5 min). Subscribe `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.opened`, `email.clicked`. Put the endpoint secret in `RESEND_WEBHOOK_SECRET`. Duplicate `svix-id`s are ignored. |

Both paths are exempt from the site gate.

## Cron

`[triggers] crons = ["0 8 * * *", "* * * * *"]`, dispatched in `src/index.ts`.

**Daily 08:00 UTC** (`runDailyJobs`), in order:

1. `runRenewalJob` — reminders 30/14/7/1 days before `end_date`, lapse expired memberships (no grace), win-back 7 days after lapse, clear ended trials.
2. `runEventReminderJob` — 7 and 1 day before event start; deduped on `email_logs.template`.
3. `runScheduledBlasts`, `runAutomationJob`, `processQueuedBlasts` (plus up to 20 extra drain passes).
4. Idempotency sweep (`sweepExpired`, 24 h retention, looped up to 50×500 rows).
5. `sweepAuthTokens` — prunes expired magic-link tokens.

**Every minute** (three `waitUntil` tasks):

- `sweepOutbox` — safety net for webhook outbox rows the queue never acked (100 per pass).
- `sweepExpiredHolds` — releases event seat and store stock holds past `hold_expires_at` + 10 min grace (200 per pass).
- `runScheduledBlasts` + `processQueuedBlasts` — scheduled campaigns start within a minute; queued sends drain at roughly 200 emails per tick.

**Manual trigger:** `GET|POST /__scheduled` with `Authorization: Bearer <JWT_SECRET>` or `X-Cron-Secret: <JWT_SECRET>` runs the **daily** branch only.

## Queues

- Producer `WEBHOOK_QUEUE` → `quilthosting-webhooks`; consumer `max_batch_size 10`, `max_batch_timeout 1` (deliberately 1 s: Zap latency is user-visible), `max_retries 5`, DLQ `quilthosting-webhooks-dlq`.
- The binding is optional in `Env` so tests and local dev run without it; the minute sweeper then does all delivery.
- App-level retry is independent of the queue's: 6 attempts, jittered backoff 5 m / 25 m / 2 h / 10 h bases, then `dead`; endpoints auto-disable after 20 consecutive failures. The consumer calls `msg.retry({ delaySeconds })` with the same delay the row recorded.
- **There is no DLQ consumer.** Messages that reach the DLQ are visible only in the Cloudflare dashboard; the outbox row itself is still re-driven by the minute sweeper until it hits `MAX_ATTEMPTS`.

## Rate limiting

- `[[ratelimits]] RATE_LIMITER` — `simple = { limit = 10, period = 60 }`. Must be changed together with `RATE_LIMITER_BINDING_LIMIT` in `src/middleware/rateLimit.ts`.
- Two layers: the atomic Cloudflare binding for burst protection (sharded so larger budgets get more sub-keys), then a KV sliding window for the per-route budget. Key = `rl:<prefix>:<cf-connecting-ip>`.
- Both layers **fail open** on infrastructure errors; `failClosed` exists but no route uses it.
- Protected routes (all 600 s windows): `/api/auth/magic-link` 10, `/login` 30, `/register` 10; `/public/:slug/join` 30, `/donate` 20, event register 40, product buy 30, project intake 20, intake photos 40. Nothing on `/api/v1`, `/pages`, or public forms.
- Reset a key locally: `npx wrangler kv key delete --binding KV --local "rl:register:unknown"`.

## Site gate (stealth)

`src/middleware/siteGate.ts` runs before routing.

- Password → `qh_site` cookie (HMAC of `site-gate:<password>` keyed by `JWT_SECRET`), 30 days, HttpOnly/Secure/SameSite=Lax. Form posts to `/site-access`.
- Exempt: `/api/webhooks/*`, `/api/auth/*`, `/auth/verify`, `/t/o/*`, `/t/c/*`, `/u/*`, `/api/v1/*`, `/.well-known/*`, any `OPTIONS`, any request carrying a valid session JWT, and — on a **launched business tenant's own host** — an allowlist of public paths (`/`, page slugs, `/robots.txt`, `/sitemap.xml`, `/qh-site.css`, `/qh-site.js`, `/img/<id>`, `/public/<own slug>/…`).
- `robots.txt` is deny-all while gated. `/embed/*` and `/portal` are gated.
- Fail closed: production without `SITE_ACCESS_PASSWORD` → 503.
- **There is no production launch switch.** Opening the platform means changing `siteGate.ts` (or setting `ENVIRONMENT=development`, which also widens CORS — do not). Individual business tenants launch via `tenants.public_launched`.

## CI

`.github/workflows/ci.yml`, one job on push to `main` and every PR: Node 22, `npm ci`, `npx tsc --noEmit`, `npx vitest run`, `npx wrangler d1 migrations apply quilthosting-db --local` (fresh-DB migration check), and a `git grep` secret scan (`GOCSPX-`, `cfut_`/`cfat_`, `gho_`, `AKIA`, private-key headers, `sk_live_`/`sk_test_`, `re_`, `whsec_`). Run the same four steps locally before pushing. No deploy job; `apps/mobile/` is not built or typechecked by CI.

## Local development

```bash
npm run dev                # wrangler dev on http://localhost:8787
npm run db:migrate:local   # apply migrations to local D1
npm test                   # vitest
```

- Stripe webhooks locally: there is no Stripe CLI forwarding; `scripts/e2e-auto-renew.mjs` hand-signs payloads with `STRIPE_WEBHOOK_SECRET` and posts them to `/api/webhooks/stripe`.
- Verification harnesses (`package.json`): `test:scale` (no worker), `test:integrations` / `test:idempotency` / `test:delivery` / `test:import` (need `wrangler dev` on :8787 with `GOOGLE_AUTH_REQUIRED=false`), `test:business-site` (boots its own worker with `[[routes]]` stripped so host routing is testable).

## Migrations

`migrations/0001` … `0025`, applied in order by wrangler. Caveats:

- `0015_idempotency_scope.sql` rebuilds the idempotency table and discards its rows (safe only because the feature was unused in production then).
- `0022_payment_fulfillment.sql` adds the `stripe_events` inbox, `payments.fulfilled_at`, `hold_expires_at`, and partial unique indexes on Stripe refs — confirm there are no duplicate Stripe references before applying to an existing database.
- `0023_email_consent.sql` (suppressions, delivery state, blast leases), `0024_onboarding.sql` (`onboarding_json`, `domain_status`, `domain_error`), `0025_page_drafts.sql` (drafts, `page_revisions`, `page_redirects`, `deleted_at`).

## Platform admin

`users.is_platform_admin = 1`, read from D1 on every request (never in the JWT). No endpoint or script sets it — bootstrap with a manual D1 `UPDATE users SET is_platform_admin = 1 WHERE email = '…'`. Platform admins get the synthetic `platform` role (full access) on every tenant and can flip `tenant_type` via `PATCH /api/platform/tenants/:id`.

## Backups

**None exist in the repo** — no D1 export script, no R2 sync, no workflow step. Recovery depends on Cloudflare D1 Time Travel via the dashboard/CLI, which is neither scripted nor rehearsed. Treat this as an open item before public launch.

## Known operational gaps

- No script-restricting CSP (single-file pages need nonces first).
- No admin audit log; no server-side session revocation (sessions run their full 7 days).
- Twilio and QuickBooks tokens are stored in plaintext in `tenants.settings_json`; only PayPal uses the encrypted `tenant_credentials` store.
- Hook URL validation is a hostname deny list, not DNS-resolving SSRF protection.
- `docs/auto-renew-e2e.md`'s last automated run predates most of the payment rework; re-run before relying on it.
