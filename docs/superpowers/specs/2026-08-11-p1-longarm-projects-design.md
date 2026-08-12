# P1 — Longarm Projects: Intake, Estimate, Agreement, E-Sign — Design

**Date:** 2026-08-11
**Status:** Approved, pending implementation plan
**Sub-project P1 of** the Stitch Studio Quilting build (see P0's Decomposition)
**Builds on:** `docs/superpowers/specs/2026-08-10-p0-business-tenant-public-site-design.md`

## Problem

P0 gave Stitch Studio Quilting a server-rendered, indexable, themed public site
on its own domain, with an admin the owner runs herself. It deliberately shipped
no customer-visible feature — P0's own risk section names this: "She sees a site
with pages on it and none of the four things she asked for."

P1 delivers the first of those four. Today a customer who wants a quilt quilted
emails or calls; Linda works the price out by hand, quotes it back, and there is
no signed record of what either party agreed to. Nothing in the platform models
a job, a quote, or an agreement.

## Goal

A customer can describe a quilt on the public site, get an immediate ballpark,
and receive a reviewed estimate; Linda can adjust and send that estimate from
admin; and the customer can sign a service agreement online, producing a record
that says what they agreed to and can prove it hasn't changed since.

## Scope

Covers client requirements **1** (longarm quilting: edge-to-edge and custom) and
**4** (custom and T-shirt quilts).

**In:** intake, instant ballpark, owner-reviewed estimate, agreement templates,
e-signature with audit trail, the owner's project queue, and the rate table.

**Out, deliberately:**

- **Quilting-design galleries** (moved to P1b during design). A gallery plus a
  picker is independent of the quote-to-signature workflow, and folding it in
  would widen this spec without sharing any machinery with it.
- **Payment of any kind.** The status machine ends at `completed` with no
  payment state. P4 owns PayPal/Venmo and the unified invoice builder; P1's
  `project_lines` are shaped to be copied into an invoice when it arrives.
- **A customer login.** See §2.
- **A drawn-canvas signature.** See §5.

## Decisions taken during design

Each of these was an open choice; recording the reasoning so the plan doesn't
relitigate them.

| Decision | Chosen | Rejected because |
|---|---|---|
| Scope | Full chain: intake → estimate → sign | Intake-only leaves the estimate object to be built twice; all-five widens the spec with galleries that share no machinery |
| Customer access | Emailed token link, no account | A signup wall in front of a one-off quilting customer costs more conversions than it buys; P0 already hides `/portal` for business tenants |
| Estimate price | Owner-set rate table, app computes, **Linda reviews before sending** | Fully automatic quoting turns a guess into a commitment she must honour or walk back — longarm price genuinely depends on the quilt's condition and backing |
| Project types | One record + `project_type` | Separate flows duplicate the queue, token link, agreement, and signing ceremony — the expensive parts — to avoid sharing three cheap field sets |
| Signature | Typed name + explicit consent | A drawn squiggle adds no legal weight over a typed name under ESIGN/UETA; the audit record does the real work |
| Intake photos | Yes, with hard limits | A T-shirt quilt cannot be quoted without seeing the shirts |
| Storage | Dedicated tables | Reusing `form_responses` gives untyped answers you can't compute a price from; reusing `invoices` burns a sequential invoice number on quotes that may never be accepted |

## Architecture

### 1. Data model

One migration, `0020_longarm_projects.sql`: three tables plus a counter.

**`projects`** — one row per quilt, from intake through completion.

```
id, tenant_id, project_type, status, reference,
customer_name, customer_email, customer_phone, member_id (nullable),
intake_json, estimate_notes,
subtotal_cents, total_cents, due_date,
access_token_hash, token_expires_at,
estimated_at, signed_at, completed_at, created_at, updated_at
```

`project_type` ∈ `{longarm, custom_quilt, tshirt_quilt}`.

`reference` is a short human-facing code (e.g. `SSQ-0042`) Linda can say on the
phone. It is per-tenant sequential, allocated from a **new `project_counters`
table** (`tenant_id PRIMARY KEY, next_number`) modelled on `invoice_counters`
but deliberately separate: an estimate that is never accepted must not consume
an invoice number, and P4 will allocate its own. This is a fourth table in the
migration, small enough not to change its shape.

Every query is `WHERE tenant_id = ?`. P0's `/img/:fileId` cross-tenant isolation
check exists because that clause is the only thing standing between tenants;
P1 inherits both the rule and the test pattern.

**`access_token_hash`, not the token.** The raw token is generated once, emailed,
and never persisted — only its SHA-256, looked up by that hash. A database
disclosure then exposes no customer's quote. The consequence is intended: "resend
link" cannot resend the old link, it mints a fresh token and invalidates the
previous one.

**`intake_json` is the only JSON blob, and it earns it.** A T-shirt quilt's
fields (shirt count, block size, sashing preference) share nothing with a longarm
top's (width, height, batting, thread, backing prep). Everything the application
computes on, filters on, or sorts by — dimensions used for pricing, totals,
status, timestamps — is a real column.

**`project_lines`** deliberately mirrors `invoice_lines`:

```
id, project_id, kind, description, quantity, unit_cents, amount_cents, sort_order
```

`kind` ∈ `{service, addon, discount}`. Matching the invoice shape means P4
converts a signed project by copying rows, not by reinterpreting a blob.

**`agreement_signatures`**:

```
id, tenant_id, project_id,
signer_name, signer_email, consent_text,
agreement_title, agreement_text, agreement_sha256,
signed_at, signer_ip, signer_user_agent, signing_token_hash
```

`signing_token_hash` is the SHA-256 of the token that was live *at the moment of
signing* — the same value `projects.access_token_hash` held then. Since "resend
link" rotates that column, storing it on the signature is what lets you say
later which issued link was actually used to sign, rather than only which link
is current.

`agreement_text` is a **full immutable snapshot**, not a foreign key to a
template. The table exists to answer "what exactly did this customer agree to,
and has it changed since?" two years later — a reference to a template Linda has
edited twice since cannot answer that. `agreement_sha256` makes tampering
detectable rather than merely unlikely.

### 2. Customer access: token links, no account

Intake mints 32 random bytes, base64url-encoded, delivered by email as
`https://<her-domain>/quote/<token>`.

The quote page is server-rendered through the P0 renderer, so it carries her
theme, and is `noindex` since it is per-customer. Default token lifetime is
90 days.

Because the token sits in the URL path, the quote page sends
**`Referrer-Policy: no-referrer`**. Without it, any outbound link the customer
clicks hands her token to a third party in a `Referer` header.

Invalid and expired tokens return the **same** generic "this link is no longer
valid" response with the studio's contact details. Distinguishing them would let
the endpoint be probed to learn which tokens exist.

### 3. Routing, and what the gate already permits

**This was checked against `src/middleware/siteGate.ts` rather than assumed, and
the answer is less new surface than expected:**

- The intake POST lives at `/public/<slug>/projects/intake`, which **rule 4
  already allows** for a launched business tenant on its own host. That rule
  deliberately already permits unauthenticated writes under the tenant's own
  slug — `/join`, `/donate`, `/cart/checkout`. Intake joins an established
  pattern rather than opening a new class of exposure.
- `/quote/<token>` is **already allowed by rule 5**, which passes any path that
  is not a reserved platform prefix. `quote` is not in `PLATFORM_PATH_PREFIXES`
  (`src/lib/platformPaths.ts:53`).

So **no new allowlist rules are required.** This is worth stating explicitly
because the temptation is to add rules for reassurance; every added rule is
another way to widen the gate by accident, and P0's design names the gate as the
risk that matters most.

Two consequences that do need handling:

1. `serveBusinessSite` must match the `/quote/` prefix **before** its page-slug
   lookup.
2. There is no collision with a page whose slug is `quote`. A page slug is one
   segment; `/quote/<token>` is two, and `slugify` strips `/`, so the path can
   never match a stored slug. No reserved-slug machinery is needed.

Admin uses the existing tenant-scoped API surface:
`/api/tenants/:tenantId/projects[...]`, gated by the same `owner|admin|platform`
role check the credentials routes settled on.

### 4. Money

Longarm rates are conventionally $0.02–$0.03 per square inch, which integer cents
cannot represent, and float money is not acceptable. Rates are therefore stored
as **cents per 100 square inches** — $0.025/sq in is `250` — keeping all
arithmetic in integers.

```
area_sqin   = width_in * height_in
service     = round(area_sqin * rate_cents_per_100sqin / 100)
```

Add-ons are flat, or per linear inch of perimeter (binding). Rush is a
percentage. Each project type carries a minimum charge applied after the sum.
T-shirt quilts price per block × block count, with a size tier, rather than by
area.

The rate table lives in `tenants.settings_json` under a `longarm` key — the same
place theme, fonts, business identity, and nav already live, so the existing
tenant PATCH path and its cache invalidation apply unchanged with no new save
path to test.

**If the rate table is missing or incomplete, the ballpark is suppressed, not
rendered as `$0`.** A confident wrong price is worse than no price.

### 5. The signing ceremony

The customer types their full name and ticks an explicit "I agree to be bound by
this agreement" box. On submit, the server writes an `agreement_signatures` row
capturing the typed name, the consent text as displayed, the agreement snapshot
and its SHA-256, `signed_at`, IP, user-agent, and the token used.

Under ESIGN/UETA what matters is intent to sign, attribution, and record
integrity — not the visual form of the mark. A drawn canvas signature adds mobile
touch handling, image storage, and rendering work while adding no legal weight,
so it is out of scope.

**Signing is idempotent.** A second POST against an already-signed project
returns the existing signature rather than creating a second one. Double-clicks
and retries are the normal case.

After signing, the page renders a printable signed copy — print-to-PDF, following
`src/lib/invoices.ts:131` rather than adding a PDF library to a Worker.

**This is legal-adjacent work and this document is not legal advice.** Linda
supplies her own agreement text. Whether her terms are enforceable in Texas is a
question for her attorney.

### 6. Surfaces

**Public intake** is a new block type, `project_intake`, carrying a `projectType`
attribute. Linda places it from the existing block editor; the P0 renderer emits
it server-side and `public/qh-site.js` hydrates it, exactly as `contact_form`
already does (`src/lib/blocks.ts:279`). No new page-building concept.

**Customer quote page** at `GET /quote/<token>`: quilt details, line items,
total, agreement text, signing controls; afterwards, the printable signed copy.

**Owner admin** adds one business-only nav item, Projects, with three screens —
the queue (filter by status and type), the estimate builder (line editor,
pre-filled from the ballpark), and settings for the rate table and agreement
templates. It follows the Task 13–14 pattern exactly: a `window.qhProjects`
module in a new `public/qh-projects.js`, mounted from `admin.html` the way
`qhSiteBuilder` is.

### 7. Status machine and flow

```
submitted → estimated → signed → in_progress → completed
                 ↓          ↓
             declined   cancelled
```

Illegal transitions are rejected server-side, not merely hidden in the UI.

1. Visitor submits intake → row at `submitted`, ballpark computed and shown
   immediately, token minted, email to Linda and an acknowledgement to the
   customer.
2. Linda opens the queue → estimate builder, lines pre-filled from the ballpark →
   adjusts → Send → `estimated`, customer emailed the token link.
3. Customer opens the link → reviews → signs → `signed`, both parties emailed.
4. Linda advances `in_progress` → `completed`.

Two deliberate product rules:

- **The instant ballpark is never emailed as a price.** It exists to convert a
  browsing visitor. Only the reviewed estimate goes out.
- **Intake does not create a customer record.** An anonymous public form that
  writes to the Customers list is a spam amplifier. The `members` row — relabeled
  Customers for business tenants in P0 — is created or matched by email at the
  moment Linda *sends the estimate*, a human-reviewed step. Repeat customers
  still aggregate; drive-by junk does not.

### 8. Photo uploads

Accepted at intake: **max 5 files, 10MB each**, MIME determined by **magic bytes,
not the client's `Content-Type`**, with SVG explicitly refused as active content.
Keys are tenant-scoped in R2, rows land in `files`, and they are served back only
through P0's existing `/img/:fileId`, which already enforces an image allowlist
and `X-Content-Type-Options: nosniff`.

Abuse of an endpoint that is by design open to the internet is bounded by the
**existing** `rateLimit` middleware (`src/middleware/rateLimit.ts`), applied the
way `/join` and `/donate` already apply it in `src/routes/public.ts:21-29` — a
KV sliding window keyed on `cf-connecting-ip`. Both the intake POST and the
upload endpoint get their own `keyPrefix`. One caveat inherited from that
middleware and worth knowing rather than discovering: it **fails open** when the
KV binding is absent (`if (!c.env.KV) return next()`), so it is a brake on
casual abuse, not a hard guarantee.

## Error handling

- **The intake row commits before any email is attempted.** A Resend outage must
  never lose a customer's submission; the queue shows the record regardless.
  Delivery retry is already covered by `0014_delivery_state.sql`.
- **Intake validation** is server-side: dimensions positive and within sane
  bounds, email well-formed, required fields present per project type. Errors
  return inline against the offending field.
- **Missing rate table** suppresses the ballpark; intake still succeeds.
- **Invalid/expired token** returns the generic not-valid page (§2).
- **Signing an already-signed project** returns the existing signature (§5).

## Testing

Following what P0 established, including its standard of proving assertions can
fail:

- **vitest** — pricing math (rounding at the cents-per-100-sq-in boundary,
  minimums, rush percentage, per-block T-shirt pricing), rejected illegal status
  transitions, token hash/verify, agreement hashing, magic-byte sniffing.
- **siteGate matrix** — the existing 59 tests extended to cover
  `/public/<slug>/projects/intake` and `/quote/<token>` across every
  tenant-type × launched combination, including the negative cases: a guild is
  never exempt, an unlaunched business is never exempt, another tenant's slug
  never passes rule 4.
- **`scripts/verify-business-site.mjs`** — extended with the full chain, intake →
  estimate → sign, asserting the stored `agreement_sha256` matches the text
  actually rendered to the signer. Negative controls: a wrong token 404s, a
  cross-tenant token does not resolve, a second signature does not duplicate,
  and an oversized or non-image upload is refused.
- **Mutation-checked.** New assertions must be shown to fail when the behaviour
  they cover is deliberately broken, as was done for the site-builder coverage at
  `81cee4e`. A green suite that cannot fail is not evidence.

## Risks

- **The gate.** P1 is the first phase to put an unauthenticated write behind a
  launched tenant's host. §3 establishes it rides rules that already exist and
  already permit exactly this, but the gate matrix must grow with it.
- **Open upload endpoint.** Bounded by size, count, magic-byte type check, and
  per-IP rate limiting — but it is genuinely open, and that is a deliberate
  trade for being able to quote a T-shirt quilt at all.
- **Token in a URL.** Mitigated by `Referrer-Policy: no-referrer`, hashed
  storage, and expiry. A customer who forwards their email forwards their quote;
  that is the accepted cost of not making them create an account.
- **Rate-table modelling may not survive contact with Linda's real pricing.**
  She has priced longarm work since 2009 and will have cases the table does not
  express. The mitigation is structural, not predictive: she reviews and can
  freely edit every line before it is sent, so an inexpressible case costs her an
  edit rather than a wrong quote.

## Open questions

Do not block implementation.

1. Linda's actual rate card — needed to seed the rate table with real values, not
   to build it.
2. Her existing service agreement text, if she has one, to seed the template.
3. Whether `reference` should continue an existing numbering scheme she already
   uses on paper.
