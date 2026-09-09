# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

QuiltHosting — a multi-tenant membership + events platform for quilt/craft guilds (an alternative to Wild Apricot). Product of **QuiltMap LLC** (parent company). Domain: quilthosting.com. Renamed from "guildbase". Event ticket codes are `EV-XXXXXX` (`generateTicketCode("EV")` in `src/routes/public.ts`; the helper in `src/lib/utils/id.ts` defaults to a `QH` prefix, but no caller uses the default).

## Documentation

- **Product docs (deployed):** `public/docs/*` → https://quilthosting.com/docs/ (site-gated while stealth)
- **Repo index:** `docs/README.md`
- **HTML library index:** `docs-library.html` (project root)
- Admin → Settings links to `/docs/`

## Stack

Cloudflare Workers + Hono + Zod, TypeScript ESM. Bindings (see `src/types.ts` `Env`): D1 (`DB`), R2 (`FILES`), KV (`KV`). Stripe (raw REST via `src/lib/stripe/`, no SDK) and Resend (`src/lib/email/`). No framework on the frontend — `public/admin.html` and `public/portal.html` are standalone pages served via the `[assets]` binding (reachable at `/admin` and `/portal`; assets take precedence over the Worker's routes for those paths).

## Commands

```bash
npm run dev                 # wrangler dev (local, http://localhost:8787)
npm run deploy              # wrangler deploy
npm run db:create           # create the D1 database (one-time; paste ID into wrangler.toml)
npm run db:migrate:local    # apply D1 migrations locally
npm run db:migrate:remote   # apply D1 migrations to production
npm run cf-typegen          # regenerate Worker env types from wrangler.toml
npx tsc --noEmit            # typecheck
npm test                    # vitest unit tests (src/**/*.test.ts); scripts/verify-*.mjs need a running Worker + local D1
```

Production D1/KV/R2/Queue IDs are real and committed in `wrangler.toml`. CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, a fresh local migration apply, and a literal-secret scan on every push.

## Architecture

Single Worker entry point `src/index.ts` exports `fetch` (Hono app) and `scheduled` (daily cron `0 8 * * *` → `runRenewalJob` in `src/lib/renewals.ts`, which sends renewal reminder emails at 30/14/7/1 days and lapses expired memberships; also triggerable via `GET|POST /__scheduled` with `Authorization: Bearer <JWT_SECRET>` or `X-Cron-Secret: <JWT_SECRET>`).

**Multi-tenancy** is the core pattern. Tenants are guilds. `src/middleware/tenant.ts` resolves the tenant from (in priority order) the `:tenantId` path param, the `X-Tenant-Slug` header, or the subdomain (`slug.quilthosting.com`), then puts it on context as `tenant`. Every tenant-scoped table carries a `tenant_id` — always filter queries by it.

**Route groups** (`src/routes/`):
- `/api/auth` — register/login/magic-link (`auth.ts`)
- `/api/tenants` — tenant CRUD (`tenants.ts`)
- `/api/tenants/:tenantId/{levels,members,events}` — tenant-scoped admin routes, wrapped in `tenantMiddleware`
- `/api/portal` — member self-service (`portal.ts`)
- `/api/webhooks` — Stripe webhooks (`webhooks.ts`)
- `/public` — unauthenticated tenant pages (`public.ts`)
- `/api/webhooks/resend`, `/u/:token` — email delivery events and one-click unsubscribe (`emailWebhooks.ts`, `unsubscribe.ts`)

**Tenant websites are server-rendered by one renderer** (`src/routes/site.ts` `serveSite`, `src/lib/site/render.ts`): sections (`src/lib/site/sections/`, schema frozen; legacy blocks normalize 1:1) styled by a design-token model (`src/lib/site/design/`: 26 palettes, 12 type pairs, derived contrast-checked roles, `buildDesignVars` → `--qh-*` variables consumed by `public/qh-site.css`; interactive islands in `public/qh-site.js`). Guild tenants with `settings.site.renderer === "legacy"` (stamped on pre-existing guilds by migration 0026) still get the classic `public/guild.html` shell until an admin clicks "Try the new design"; new guilds are seeded from a kit (`src/lib/site/kits/*.json`, Heritage by default; `QuiltHostingTemplates.md` is the authoring brief, `npm run kits:validate` the gate). `/g/:slug/__preview` always serves guild.html for the classic editor preview.

**Website builder = draft → preview → publish** (`src/routes/pages.ts`, `src/lib/pageDrafts.ts`, migration 0025): `PUT /pages/:id/draft` autosaves into `draft_*` columns, `POST /pages/:id/publish` promotes the draft in one batch and snapshots the previous live content into `page_revisions`; every write is CAS-guarded on `pages.revision` (409 on conflict). `DELETE` soft-deletes (`deleted_at`), slug changes write `page_redirects`. The shared editor lives in `public/admin.html` (`qhOpenPageEditor`) for both guild and business tenants; guild preview uses `guild.html`'s `__preview` postMessage mode, business preview uses the SSR renderer.

**Dues are policy-driven** (`src/lib/dues.ts`, migration 0030): a level runs on the join anniversary (default, unchanged), a calendar year, or a fixed date, with optional first-term proration and a grace period before lapse. **Households** (`src/lib/households.ts`, migration 0031) let one payment cover several people; the membership belongs to the payer and everyone else's is derived, so every query that asks "is this person an active member" must use `activeMembershipFilter` — a test fails if any other SQL in `src/` decides it alone. The plan cap counts people, not payments.

**Two switches shape the admin** (`src/lib/features.ts`, `src/lib/adminNav.ts`): `settings.ui.advanced` (default false) hides screens but never capability — the Simple sidebar is nine grouped entries; `settings.features` gates machinery that adds real complexity (recipes on by default, everything else off). `visibleNav()` crosses that with the permission matrix and tenant type, and `src/lib/adminNavGating.test.ts` fails if `public/admin.html`'s mirrored copy drifts. Money is dollars and percent in every input (`src/lib/utils/money.ts`, mirrored client-side); storage stays integer cents and basis points.

**Images**: uploads store resized WebP/JPEG variants (480/960/1600/2400) plus focal point and alt (`src/lib/images.ts`, migration 0028); both image routes negotiate on `?w=`/`Accept`, and renderers emit `srcset`/`sizes`/`object-position`/intrinsic size. Files without variants serve the original at every width.

**Tenant content is untrusted HTML.** Every rich-text/HTML block and legacy `content_json.html` goes through the allowlist sanitizer in `src/lib/sanitize.ts` at parse and render time. Never add a new output path that emits tenant strings without `escapeHtml`/`sanitizeHtml`.

**Stripe fulfillment is a two-step idempotent state machine** (`src/routes/webhooks.ts` + `src/lib/fulfillment.ts`): events are claimed in `stripe_events`, the payment row is recorded (unique on the Stripe ref), then fulfillment runs in one D1 batch guarded by `payments.fulfilled_at`. Seats/stock are reserved atomically at checkout with `hold_expires_at`; the minute cron releases expired holds.

**Auth**: HS256 JWTs hand-rolled on WebCrypto (`src/lib/auth/jwt.ts`) carry a `purpose` claim (`session|magic|receipt|download`); `verifyJwt` defaults to `session`, magic links are one-time rows in `auth_tokens` (`src/lib/auth/magic.ts`). PBKDF2 password hashing (`password.ts`). `requireAuth` / `optionalAuth` middleware in `src/middleware/auth.ts` attach `user` to context. Roles per tenant live in `tenant_users` (`owner|admin|membership|events|viewer`) and are enforced for every `/api/tenants/:tenantId/*` route by `src/middleware/permissions.ts` using the matrix in `src/lib/permissions.ts` (route-level checks may be stricter, never looser).

**Database**: D1/SQLite, schema in `migrations/` (0001 initial through 0024; apply in order). Keep `src/version.ts` in sync with `package.json` when bumping. Tables: tenants, users, tenant_users, membership_levels, members, memberships, events, event_registrations, payments, pages, files, email_logs. Query helpers `first`/`all` in `src/lib/db/`. JSON columns are TEXT with `_json` suffix; booleans are INTEGER 0/1; money is integer cents (`formatMoney` in `src/lib/utils/money.ts`); timestamps are ISO strings.

## Configuration & secrets

- Env vars: `ENVIRONMENT`, `APP_URL` in `wrangler.toml` `[vars]` (production `APP_URL` = https://quilthosting.com).
- Secrets (never in the repo): `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SITE_ACCESS_PASSWORD`. Locally in `.dev.vars` (gitignored); production via `wrangler secret put`.
Optional vars: `STRIPE_PLATFORM_FEE_BPS` (Connect application fee in basis points; default 0), `STRIPE_GUILD_PRICE_ID` (Stripe Price for $24 Guild plan; else ad-hoc price_data).

**Billing:** Free plan ≤30 active members (`src/lib/plans.ts`). Guild plan = `plan=starter` via platform Stripe subscription. Guild payouts use Stripe Connect Express (`tenants.stripe_account_id`); Checkout uses destination charges when connected.
- **Site gate (stealth):** `src/middleware/siteGate.ts` password-gates the whole site when `SITE_ACCESS_PASSWORD` is set. Production fails closed (503) if the secret is missing; open only in `ENVIRONMENT=development` without a password. `robots.txt` is always deny-all. Exempt: `/api/webhooks/*`, `/t/o/*`, OPTIONS. Stay stealth until explicitly told to launch. Assets use `run_worker_first`.
- **Trial:** New guilds get `trial_ends_at` = now+30d (Guild limits/features); after expiry without subscription, free ≤30 active members again.
- After changing bindings in `wrangler.toml`, run `npm run cf-typegen`.

## Gotcha: escaped source drops

The original source arrived via an archive whose files sometimes contain literal `\`` and `\${` escape artifacts (chatbot-generated tarball). If a file fails to parse with "Invalid character" / "Unterminated template literal", fix with the Edit tool's replace-all (`\`` → `` ` ``, `\$` → `$`) — shell `sed` mangles backticks on this setup.
