# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

QuiltHosting — a multi-tenant membership + events platform for quilt/craft guilds (an alternative to Wild Apricot, with QuiltMap synergies). Domain: quilthosting.com. Renamed from "guildbase"; ticket codes use the `QH` prefix (`generateTicketCode` in `src/lib/utils/id.ts`).

## Stack

Cloudflare Workers + Hono + Zod, TypeScript ESM. Bindings (see `src/types.ts` `Env`): D1 (`DB`), R2 (`FILES`), KV (`KV`). Stripe (raw REST via `src/lib/stripe/`, no SDK) and Resend (`src/lib/email/`). No framework on the frontend — `public/admin.html` and `public/portal.html` are standalone pages.

## Commands

```bash
npm run dev                 # wrangler dev (local, http://localhost:8787)
npm run deploy              # wrangler deploy
npm run db:create           # create the D1 database (one-time; paste ID into wrangler.toml)
npm run db:migrate:local    # apply D1 migrations locally
npm run db:migrate:remote   # apply D1 migrations to production
npm run cf-typegen          # regenerate Worker env types from wrangler.toml
npx tsc --noEmit            # typecheck (no test runner or linter configured)
```

The D1 `database_id` and KV `id` in `wrangler.toml` are still `REPLACE_WITH_YOUR_...` placeholders — dev/deploy fail until real resources are created and the IDs filled in.

## Architecture

Single Worker entry point `src/index.ts` exports `fetch` (Hono app) and `scheduled` (daily cron `0 8 * * *` → `runRenewalJob` in `src/lib/renewals.ts`, which sends renewal reminder emails at 30/14/7/1 days and lapses expired memberships; also triggerable via `GET|POST /__scheduled`).

**Multi-tenancy** is the core pattern. Tenants are guilds. `src/middleware/tenant.ts` resolves the tenant from (in priority order) the `:tenantId` path param, the `X-Tenant-Slug` header, or the subdomain (`slug.quilthosting.com`), then puts it on context as `tenant`. Every tenant-scoped table carries a `tenant_id` — always filter queries by it.

**Route groups** (`src/routes/`):
- `/api/auth` — register/login/magic-link (`auth.ts`)
- `/api/tenants` — tenant CRUD (`tenants.ts`)
- `/api/tenants/:tenantId/{levels,members,events}` — tenant-scoped admin routes, wrapped in `tenantMiddleware`
- `/api/portal` — member self-service (`portal.ts`)
- `/api/webhooks` — Stripe webhooks (`webhooks.ts`)
- `/public` — unauthenticated tenant pages (`public.ts`)

**Auth**: HS256 JWTs hand-rolled on WebCrypto (`src/lib/auth/jwt.ts`), PBKDF2 password hashing (`password.ts`). `requireAuth` / `optionalAuth` middleware in `src/middleware/auth.ts` attach `user` to context. Roles per tenant live in `tenant_users` (`owner|admin|membership|events|viewer`).

**Database**: D1/SQLite, schema in `migrations/0001_initial.sql`. Tables: tenants, users, tenant_users, membership_levels, members, memberships, events, event_registrations, payments, pages, files, email_logs. Query helpers `first`/`all` in `src/lib/db/`. JSON columns are TEXT with `_json` suffix; booleans are INTEGER 0/1; money is integer cents (`formatMoney` in `src/lib/utils/money.ts`); timestamps are ISO strings.

## Configuration & secrets

- Env vars: `ENVIRONMENT`, `APP_URL` in `wrangler.toml` `[vars]` (production `APP_URL` = https://quilthosting.com).
- Secrets (never in the repo): `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`. Locally in `.dev.vars` (gitignored); production via `wrangler secret put`.
- After changing bindings in `wrangler.toml`, run `npm run cf-typegen`.

## Gotcha: escaped source drops

The original source arrived via an archive whose files sometimes contain literal `\`` and `\${` escape artifacts (chatbot-generated tarball). If a file fails to parse with "Invalid character" / "Unterminated template literal", fix with the Edit tool's replace-all (`\`` → `` ` ``, `\$` → `$`) — shell `sed` mangles backticks on this setup.
