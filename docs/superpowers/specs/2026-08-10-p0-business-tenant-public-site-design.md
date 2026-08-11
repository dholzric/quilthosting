# P0 — Business Tenant + Public Site Renderer — Design

**Date:** 2026-08-10
**Status:** Approved, pending implementation plan
**Sub-project P0 of** the Stitch Studio Quilting build (see Decomposition below)

## Problem

Stitch Studio Quilting (stitchstudioquilting.com) is a Wimberley, TX longarm
quilting business operating since 2009. The owner needs a replacement site that
does four things — longarm quilting services, classes, a product store, and
custom/T-shirt quilts — with an owner-run admin for each, and the ability to
invoice customers who pay by Venmo, PayPal, or card.

The decision has been made to build her as **QuiltHosting tenant #1** rather
than as a second fork of austinlongarm. QuiltHosting already has events with
recurrence and iCal, products, a cart with tax, Stripe Connect, invoices, a
blog, forms, galleries, and custom domains. That is most of the commerce
surface she needs.

What QuiltHosting does not have is a public website worth putting a customer's
name on:

- A tenant's public site is `public/guild.html` — a 45KB client-rendered SPA
  that fetches JSON from `/public/:slug/*` and paints the page in the browser.
- It carries `<meta name="robots" content="noindex, nofollow">`
  (`public/guild.html:6`).
- `src/middleware/siteGate.ts` gates the entire product behind a shared
  password and returns `Disallow: /` for `robots.txt` on every host,
  unconditionally.
- `pages` has no SEO fields at all (`migrations/0001_initial.sql`) — no title
  override, no description, no OG image.
- `SiteTheme` (`src/lib/blocks.ts`) is five loose fields; the block set is ten
  types aimed at a guild's info pages.

So a business tenant today gets an unindexable, client-rendered, generically
styled page behind a password wall. Replacing a site with sixteen years of
accumulated search history with that would destroy her traffic.

Separately, the tenant model itself is guild-shaped. Membership levels,
renewals, chapters, forums, a member directory, and a member portal are all
irrelevant to a solo longarm quilter, and the renewal cron
(`runRenewalJob`, `src/lib/renewals.ts:27`) would email her about a membership
that does not exist.

## Goal

QuiltHosting can host a small business's primary public website: server-rendered,
indexable, themed to the business, on its own domain, live to the public while
the rest of the platform remains in stealth — with an admin the owner can run
herself.

## Non-goals

These are real requirements, deferred to later sub-projects. They are named here
so the P0 seams are built to receive them.

- Longarm intake, estimates, agreements, e-sign, and quilting-design galleries (P1).
- Class administration, the calendar view, and class registration (P2).
- Product images, store admin, and the storefront (P3).
- PayPal/Venmo integration and the unified invoice builder (P4).
- Blog content migration, videos, newsletter, 301 map, DNS cutover (P5).
- Converting existing guild tenants to the new renderer. Guilds keep
  `guild.html` until the business renderer proves itself.
- A visual drag-and-drop page builder. Blocks are edited as an ordered list.

## Decomposition

The full build is six sub-projects. Each gets its own spec, plan, and
implementation cycle.

| | Sub-project | Requirements covered |
|---|---|---|
| **P0** | Business tenant + public site renderer | Foundation for all of them |
| **P1** | Longarm services + custom/T-shirt quilt intake | 1, 4 |
| **P2** | Classes | 2 |
| **P3** | Store | 3 |
| **P4** | PayPal/Venmo + unified invoicing | 5 |
| **P5** | Blog/video/newsletter migration + launch | — |

P2 and P3 ship on Stripe alone; P4 adds PayPal and Venmo on top rather than
blocking them.

## Architecture

### 1. The `business` tenant type

One new column: `tenants.tenant_type TEXT NOT NULL DEFAULT 'guild'`, values
`'guild' | 'business'`. A single value read in a few places, not a scatter of
feature flags.

When `tenant_type = 'business'`:

- **Admin nav hides** Levels, Renewals, Chapters, Forums, Member Directory, and
  the member portal link.
- **"Members" is labelled "Customers"** in the admin UI. The `members` table is
  unchanged and still stores them — this is a label, not a schema change. Her
  customers are exactly what a CRM row is for.
- **`plans.ts` stops applying the member cap.**
  `activeMemberLimitForTenant` (`src/lib/plans.ts:52`) returns `null` for
  business tenants, so `assertCanActivateMember` (line 77) short-circuits.
  `FREE_ACTIVE_MEMBER_LIMIT = 30` is a membership-organisation concept and
  would otherwise cap her customer list at 30 people.
- **`runRenewalJob` skips the tenant** entirely — no renewal reminders, no
  lapse processing, no winbacks.

Guild tenants are unaffected. No tables fork. A tenant that is both a guild and
a shop remains expressible.

### 2. Per-tenant encrypted credential store

Required because PayPal, unlike Stripe, offers no way to transact on a
merchant's behalf without holding a secret (see Payment Architecture below).

```sql
CREATE TABLE tenant_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,        -- 'paypal'
  key TEXT NOT NULL,             -- 'client_id' | 'client_secret'
  ciphertext BLOB NOT NULL,      -- AES-GCM
  iv BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_tenant_credentials ON tenant_credentials(tenant_id, provider, key);
```

Rules:

- Encrypted with AES-GCM under a new `CREDENTIAL_KEY` Worker secret. A fresh
  random IV per write, stored alongside.
- **Values are never returned to any client.** The admin API exposes only
  `{ provider, key, configured: true|false, updated_at }`. Write and clear are
  the only mutations; there is no read-back.
- Decryption happens only inside the Worker at the moment of an outbound API
  call.
- `CREDENTIAL_KEY` is required in production. A tenant with credentials stored
  and the key missing must fail loudly, not silently fall back to unpaid.

Stripe stores nothing here — `tenants.stripe_account_id` is a public
identifier, not a secret.

### 3. The public site renderer

New module `src/lib/site/`. Host resolution already exists —
`getTenantByHost` (`src/lib/tenantHost.ts`) matches a custom domain or a
`{slug}.quilthosting.com` subdomain. P0 changes what happens after the match:
for a business tenant, the Worker renders complete HTML instead of serving
`guild.html`.

**Structure.** `renderSite(tenant, page, ctx) -> Response`. Header (logo, business
name, nav), the page's ordered blocks, footer. Nav comes from `settings.nav`
plus published pages with `show_in_nav`, exactly as `/public/:slug/site` already
assembles it (`src/routes/public.ts:1084`).

**Blocks.** The registry in `src/lib/blocks.ts` is the extension seam. Existing:
`heading | text | image | button | divider | html | join_cta | events_list |
store_list | spacer`. P0 adds:

| Block | Purpose |
|---|---|
| `hero` | Headline, subhead, background image, CTA |
| `service_cards` | Icon + title + body grid (longarm services) |
| `gallery_grid` | Image grid from R2, lightbox |
| `faq` | Question/answer accordion, emits FAQPage JSON-LD |
| `testimonials` | Customer quotes with attribution |
| `contact_form` | Posts to the existing forms endpoint |

`join_cta` is guild-only and is hidden from the business block picker.
`classes_calendar` (P2) and an enriched `store_list` (P3) register the same way.

Every block renders through a shared escaping helper. The `html` block is the
one deliberate exception and stays owner-authored only — it is already capped at
50,000 characters in `parseBlocks`.

**SEO.** New columns on `pages`:

```sql
ALTER TABLE pages ADD COLUMN seo_title TEXT;
ALTER TABLE pages ADD COLUMN seo_description TEXT;
ALTER TABLE pages ADD COLUMN og_image_file_id TEXT;
ALTER TABLE pages ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0;
```

The renderer emits per-page `<title>`, meta description, `<link rel=canonical>`
at the tenant's preferred base URL (`tenantPublicBaseUrl` already computes it),
OpenGraph and Twitter card tags, and JSON-LD `LocalBusiness` built from the
tenant's business identity. `seo_title` falls back to `title`; `seo_description`
falls back to the first text block, truncated.

Per-tenant `/sitemap.xml` listing published, non-`noindex`, non-members-only
pages, and a per-tenant `/robots.txt`. Both are served on the tenant's hostname
and are distinct from the platform's own.

**Caching.** Rendered HTML is stored in the Cache API keyed by
host + path + the page's `updated_at`, so a publish naturally produces a new key
and the stale entry ages out. R2 images are served under content-hashed keys
with `Cache-Control: public, max-age=31536000, immutable`.

**Theme.** `SiteTheme`'s five fields are replaced by the thirteen-token
`ThemeConfig` ported from austinlongarm (`src/types/site-config.ts`) —
`primary`, `primaryBright`, `primaryDark`, `secondary`, `secondaryBright`,
`accent`, `accentBright`, `gold`, `bg`, `card`, `textBase`, `textMuted`,
`themeColor` — emitted as CSS custom properties. `theme-presets.ts` and
`fonts.ts` port across with it, giving the picker real presets rather than raw
hex inputs.

Migration: existing guild themes map `primary -> primary`, `accent -> accent`,
and derive the remaining eleven tokens from the matching preset. `font` maps
into `FontsConfig`. This applies to all tenants — one theme system, no
divergence.

Because guilds keep `guild.html`, which reads the old five fields from
`/public/:slug/site` (`src/routes/public.ts:1084`), that endpoint must keep
emitting them — derived from the token set rather than stored separately, so
there is one source of truth. Without this, migrating the theme shape silently
unstyles every existing guild site. A test pins the derivation.

### 4. Per-tenant launch while the platform stays in stealth

`tenants.public_launched INTEGER NOT NULL DEFAULT 0`.

`siteGate` (`src/middleware/siteGate.ts`) currently decides on path alone. It
gains a host resolution step ahead of its existing logic: if the request's Host
maps to a tenant that is `business` **and** `public_launched = 1`, the gate is
skipped and the public renderer serves normally, including a permissive
`robots.txt` and a real sitemap.

Two invariants, written as tests, because getting these wrong is how the
platform leaks:

1. **The exemption keys off the resolved tenant, never off a path.** No path
   prefix may bypass the gate on a platform host.
2. **`/admin` and `/portal` stay gated even on a launched tenant's custom
   domain.** A launched business site must never expose the platform's admin
   surface.

Everything else is untouched: `quilthosting.com` itself, unlaunched tenants,
and the production fail-closed 503 when `SITE_ACCESS_PASSWORD` is absent.

### 5. Owner admin — the site builder

P0 ships the site-building half of her admin:

- Pages: create, edit, reorder, publish/unpublish, delete.
- Blocks: ordered add/edit/remove/reorder within a page.
- Theme and fonts: preset picker plus token overrides.
- Nav: label/href ordering.
- SEO: per-page title, description, OG image, noindex.
- Business identity: name, address, phone, email, social links — the source for
  the footer and the `LocalBusiness` JSON-LD.
- Images: upload to R2, reuse in blocks.
- Custom domain: setup with DNS instructions (`dnsInstructions` in
  `tenantHost.ts` already generates them) and live SSL status from
  `findSaasCustomHostname`.
- Launch toggle for `public_launched`.

Classes, store, and invoicing admin arrive with P2, P3, and P4. Guild-only
sections are hidden by the §1 `tenant_type` check.

## Payment architecture

Decided during design; **implemented in P4**, recorded here because §2 exists to
serve it and because it reverses the current code's model.

**Her payments are direct. Money never passes through QuiltHosting.**

*Stripe — Connect Standard with direct charges.* She connects her own Stripe
account by OAuth; QuiltHosting stores only `acct_…` and never a secret key.
Charges are created **on her account** via the `Stripe-Account` header, making
her merchant of record: she pays Stripe's fees, and owns refunds and disputes.

This reverses the current implementation, which uses **destination charges** —
`payment_intent_data[transfer_data][destination]` at
`src/lib/stripe/index.ts:168` and the subscription equivalent at line 152.
Those create the charge on the *platform* account and transfer the funds
onward, which means QuiltHosting is merchant of record and carries the dispute
liability. Concretely, P4 must:

- Add an optional `Stripe-Account` header to `stripeRequest`
  (`src/lib/stripe/index.ts:8`), which has no mechanism for it today.
- Remove `transfer_data` and `application_fee_amount` from the tenant-payment
  path. `applicationFeeAmount` (line 56) becomes dead on that path, and
  `STRIPE_PLATFORM_FEE_BPS` is 0 for business tenants.
- Move from Express to Standard onboarding (`createAccountLink`, line 266) so
  she keeps her own full Stripe dashboard.
- **Rebuild the webhook path.** Direct-charge events fire on her account and
  arrive as Connect webhooks carrying an `account` field under a different
  signing secret. The current `/api/webhooks` handler assumes one platform
  secret. This is the substantive cost of the change.

*PayPal and Venmo — her own account.* "Direct, not through us" rules out PayPal
Partner Referrals, which intermediates by definition. She creates a REST app in
her own PayPal account and enters the client ID and secret, which live in the §2
encrypted store. Venmo rides along free for US buyers through PayPal Checkout.

*Platform billing is separate and unaffected.* Any QuiltHosting subscription she
pays continues to run on the platform's own Stripe account. The two paths must
not be crossed.

## Data model summary

New migration `0019_business_tenants.sql`:

```sql
ALTER TABLE tenants ADD COLUMN tenant_type TEXT NOT NULL DEFAULT 'guild';
ALTER TABLE tenants ADD COLUMN public_launched INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pages ADD COLUMN seo_title TEXT;
ALTER TABLE pages ADD COLUMN seo_description TEXT;
ALTER TABLE pages ADD COLUMN og_image_file_id TEXT;
ALTER TABLE pages ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0;

CREATE TABLE tenant_credentials (...);  -- as specified in §2
```

Theme migration runs as a data backfill over `tenants.settings_json`, not as
DDL — `theme` is a JSON subtree, and the five old fields expand into the
thirteen-token set plus a font config.

## Testing

vitest, colocated as `src/**/*.test.ts`, matching the existing convention.

- **Gate matrix (highest risk).** Launched business host, unlaunched business
  host, guild host, platform apex, `/admin` on a launched custom domain,
  `/portal` on a launched custom domain, missing `SITE_ACCESS_PASSWORD` in
  production. Each asserts gated vs. open and the `robots.txt` body.
- **Block rendering.** Each block type renders expected structure; hostile input
  in every text field comes back escaped; `html` passes through intact.
- **Theme tokens.** Preset expansion, override precedence, and the five-field →
  thirteen-token migration for an existing guild.
- **SEO emission.** Title and description fallback chains, canonical URL against
  custom domain vs. subdomain, `noindex` honoured, sitemap excludes unpublished,
  members-only, and `noindex` pages.
- **Credential store.** Round-trip encrypt/decrypt, distinct IVs across writes,
  the admin API never emitting plaintext, and hard failure when
  `CREDENTIAL_KEY` is absent.
- **Tenant type.** Business tenants bypass the member cap and are skipped by
  `runRenewalJob`; guild tenants keep both behaviours.

## Risks

- **Platform stealth leak.** Mitigated by the §4 invariants and the gate matrix
  tests. This is the risk that matters most; a mistake exposes the whole product.
- **Worker CPU on render.** Server-rendering on every request is more expensive
  than serving a static SPA shell. Cache API keyed on `updated_at` is the
  mitigation; if render time proves marginal, the fallback is to persist
  rendered HTML into KV at publish time.
- **Theme migration touching live guild sites.** The backfill rewrites
  `settings_json` for every tenant. It needs a dry-run mode and a recorded
  before-image per tenant.
- **P0 delivers no customer-visible feature on its own.** She sees a site with
  pages on it and none of the four things she asked for. Sequencing is deliberate
  — P1 through P4 all render through this — but it should be set as the
  expectation.

## Open questions

Neither blocks implementation.

1. Does she want the QuiltHosting brand visible in the footer, or a fully
   white-labelled site? Affects the footer template only.
2. Which Stripe account is hers — an existing one, or new? Determines whether P4
   onboarding is a connect or a create.
