# Configurable Services — Design

**Date:** 2026-08-13
**Status:** Approved in discussion, pending written review
**Supersedes the service model in:** `docs/superpowers/specs/2026-08-11-p1-longarm-projects-design.md`
**Leaves intact:** everything else in P1

## Problem

P1 shipped a working intake → estimate → agreement → e-signature flow. It is well tested and the
security-sensitive parts are hardened. But its *service model* is compiled in:

- `ProjectType` is a TypeScript union of exactly three values (`src/lib/projects/types.ts:5`).
- `LongarmRates` is ten named fields encoding longarm quilting's specific pricing conventions
  (`types.ts:40-50`).
- `computeEstimate` carries four type-dependent branches — three on `projectType`
  (`pricing.ts:75, 95, 118`) and one on `serviceLevel` (`pricing.ts:97`).
- The public intake form hardcodes which fields each type collects (`public/qh-site.js`).
- The admin rate editor hardcodes its field list (`RATE_FIELDS` in `public/qh-projects.js`).
- `minimumCents` is keyed by the same fixed union.

Adding one service — **repairs**, which is reportedly the platform's highest-traffic search
term — means editing seven places and shipping a deploy.

That collides with the actual goal. This platform is intended to host **many longarm sites and quilt
stores**, on a template or derivatives of it, and the operating model is: **hand a shop the admin and
never touch their site again** except when the underlying platform (TypeScript, Cloudflare, D1) forces
it. A service model that requires a developer for every new service makes that impossible.

## Goal

A shop owner can define the services they sell — including ones nobody anticipated — set their own
prices, and have the public intake form and the estimate math follow, without a code change or a
deploy.

## Non-goals

- **A formula language.** Owners compose from a fixed vocabulary of rules. They do not write
  expressions. Shipping a DSL means shipping a sandbox, an error-reporting story a quilter can act on,
  and a support burden — the opposite of hands-off.
- **Changing the signature machinery.** The status machine, hashed tokens, agreement snapshot and
  hash binding, idempotent signing, and the five concurrency fixes are service-agnostic and stay.
- **Payment.** Still absent, still deferred.
- **Platform billing** (QuiltHosting invoicing its own customers). Raised separately; needs its own
  spec. See "Related work" below.

## Decisions taken, with reasoning

| Decision | Chosen | Rejected because |
|---|---|---|
| How configurable | Composable building blocks — a fixed vocabulary of field kinds and pricing rules | A preset library still sends every novel service back to us. A formula editor makes us maintain a language. |
| Repairs pricing | Owner's choice per service: a **priced menu**, or **quote on request** | We do not know how repair shops price, and we should not have to. Shops that can price from a list do; shops that need to see the quilt say so honestly instead of guessing a number. |
| First-run experience | Pre-seeded starter services with blank prices | An empty builder screen is where hands-off dies — the owner calls for help and now we are touching it. Blank prices mean the existing suppression rule shows no price until the owner enters theirs, so our placeholder numbers can never reach a customer. |
| Storage | A `services` table | `settings_json` already caused two read-modify-write races in P1 (the rate editor and intake-photo linking), both needing optimistic concurrency; a multi-row editable collection walks straight back into it, and a project cannot foreign-key to a blob. Full normalisation costs three tables and joins for data only ever edited by one owner and read whole. |

## Architecture

### 1. The `services` table

```
id, tenant_id, slug, name, description,
quote_on_request INTEGER NOT NULL DEFAULT 0,
active INTEGER NOT NULL DEFAULT 1,
sort_order INTEGER NOT NULL DEFAULT 0,
fields_json TEXT NOT NULL DEFAULT '[]',
rules_json  TEXT NOT NULL DEFAULT '[]',
created_at, updated_at
UNIQUE(tenant_id, slug)
```

`projects.service_id` replaces `projects.project_type`. Adding a service becomes an INSERT.

Real columns for anything queried or sorted; JSON only where the shape is genuinely open-ended.

**Services are deactivated, never deleted.** A signed agreement references the service that produced
it, and that reference must stay resolvable for as long as the signature matters.

### 2. Intake field vocabulary (`fields_json`)

An ordered list. Each entry has a `key`, a `label`, a `kind`, and `required`.

| Kind | Collects | Derived values it can feed |
|---|---|---|
| `dimensions` | width × height, inches | area (sq in), perimeter (linear in) |
| `count` | a positive integer | the count |
| `choice` | one option from a list; each option may carry `priceCents` | the selected option's price |
| `toggle` | yes / no | whether an add-on applies |
| `text` | free text | nothing — context for the owner |

Photos are available on every service and are not a field kind; the existing upload endpoint and its
magic-byte defence are unchanged.

### 3. Pricing rule vocabulary (`rules_json`)

An ordered list. Each rule names the field `key` it reads and the rate it applies.

| Rule | Reads | Computes |
|---|---|---|
| `per_sq_in` | a `dimensions` field | `round(area × rate / 100)` — rate in **cents per 100 square inches** |
| `per_linear_inch` | a `dimensions` field | `round(perimeter × rate)` |
| `per_unit` | a `count` field | `count × rate` |
| `flat` | optionally a `toggle` | `rate` |
| `menu` | a `choice` field | the selected option's `priceCents` |
| `percent` | nothing | `round(runningTotal × pct / 100)` |
| `minimum` | nothing | raises the total to `rate` if below it |

**The cents-per-100-square-inches convention is kept**, because it exists for a real reason: longarm
work is conventionally priced at $0.02–$0.03 per square inch, which integer cents cannot represent,
and float money is not acceptable.

**Rule order is evaluation order**, with one fixed constraint carried from P1: `minimum` applies
before `percent`, so a rush surcharge is never silently swallowed by the minimum charge. That was a
Critical finding in P1 and the ordering is not owner-configurable.

**Why this is smaller than it looks:** `computeEstimate` already *is* these seven rules. Its body
computes per-square-inch, per-linear-inch, per-unit, flat, percent, and a minimum today. The work is
deleting the `if (projectType === ...)` branches and iterating a list instead.

### 4. Suppression, unchanged

A rule whose rate is unset **suppresses the entire estimate** rather than contributing zero. A
customer shown `$0.00` reads "free quilt". This rule survives verbatim, including the client-side
fail-closed gate that requires `suppressed === false` and a finite numeric total before rendering any
price.

`quote_on_request` short-circuits earlier: no price is computed and the form says an assessment
follows, by design rather than by a missing rate.

### 5. Surfaces

- **Public block.** `project_intake` takes an optional **service slug**. Set, it renders that
  service's form (a dedicated Repairs page). Blank, it renders a picker across the tenant's active
  services, then the chosen service's fields. One block covers both a page-per-service and a single
  quote page.
- **Intake form becomes a generic renderer** driven by `fields_json`, deleting the per-type branching
  in `public/qh-site.js` rather than adding to it.
- **Admin gains a Services screen** — list, reorder, activate/deactivate, and an editor with a field
  builder and a rule builder. This **replaces** the current "Quilting rates" screen, whose hardcoded
  `RATE_FIELDS` is precisely what is being removed.

### 6. Seeding

A new business tenant is created with a starter set as ordinary `services` rows — longarm
edge-to-edge, custom longarm, T-shirt quilt, repairs — with field sets and rules populated and **every
price blank**. The owner fills in their numbers, renames to their own vocabulary, deletes what they do
not offer, and adds what they do.

## Worked example: repairs

Proof the vocabulary is sufficient for the case that motivated this work.

```
service: "Quilt repair"          quote_on_request: false
fields:
  choice  key=repairType  "What needs repairing?"
          [ patch a hole $40 | rebind an edge $80 | replace backing $120 ]
  count   key=areas       "How many areas?"
  text    key=notes       "Describe the damage"
rules:
  menu     reads repairType
  minimum  $35
```

A shop that cannot price sight-unseen sets `quote_on_request: true` and drops the menu rule; the form
then collects the description and photos and promises an assessment. Neither variant is a code change.

## Error handling

- A rule whose rate is unset suppresses the whole estimate (§4).
- A `quote_on_request` service never computes a price.
- Intake referencing an inactive or unknown service is refused, not silently priced.
- A rule referencing a field key that no longer exists is a validation error **at save time in the
  admin**, not a runtime surprise on the public form. The owner is the one who can fix it, and only
  while they are looking at it.
- Field and rule lists are bounded (20 fields, 20 rules per service) so an unbounded blob cannot reach
  the renderer.

## Testing

Following the pattern that earned its keep in P1:

- **Unit:** each rule type in isolation, then composition; suppression per rule; the
  minimum-before-percent ordering; field/rule validation including dangling key references.
- **Seeding:** a fresh business tenant has working starter services with blank prices, and its public
  form therefore shows no price.
- **E2E:** the existing chain grows a repairs path alongside longarm — including a
  `quote_on_request` service producing no price and still reaching a signable agreement.
- **Every new assertion mutation-checked.** Four tests that asserted nothing shipped during P1 and
  were caught (`expect(true).toBe(true)`, `a === a`, a header comparison passing on two nulls, and a
  batch test that passed against the pre-batch code). That is the failure mode to watch.

## Migration

**No production project data exists** — P1 shipped with zero projects, and the one deploy-check row
was removed. So `projects.project_type → service_id` needs no backfill.

**One live tenant does need converting.** The demo tenant `stitchstudio`
(`stitchstudio.quilthosting.com`, launched 2026-08-13) carries a `settings.longarm` rate block in the
old shape. It converts to seeded `services` rows as part of this work — it is the first and, for now,
only consumer of the old model.

## Risks

- **Scope.** New table, rule evaluator, generic field renderer, service editor UI, and a rewritten
  `computeEstimate`. Comparable to P1 in size, though against a well-understood target rather than a
  novel one.
- **The editor is the product.** For a hands-off platform, the service editor is what the shop owner
  actually experiences. A correct rule engine behind a confusing builder still generates support
  calls. This is the piece most worth getting in front of a real shop owner early.
- **The vocabulary may prove insufficient.** Seven rules and five field kinds cover every service we
  currently know of. A shop pricing by the hour, or by fabric consumed, would need an eighth rule.
  That is a small, additive change — but it is still us touching it, and each addition should be
  weighed against the DSL line we deliberately did not cross.
- **No browser coverage.** `public/qh-site.js` and `public/qh-projects.js` still have zero automated
  tests, and this work substantially rewrites both. That gap predates this spec and is not closed by
  it.

## Open questions

Do not block implementation.

1. Should a service be able to require photos rather than merely offer them? Repairs arguably should.
2. Should services be copyable between tenants, so a new shop can start from a neighbour's setup
   rather than the generic starter set? Attractive for onboarding, and it raises a data-ownership
   question worth deciding deliberately.
3. Real rate cards remain outstanding for every prospective shop, including the first one.

## Related work

Stephanie has asked whether the same agreement-and-signature pattern can bill QuiltHosting's own
website customers. The pattern transfers well — the snapshot, the hash, the audit record, the
tokenised link, the signing ceremony. Two things do not: P1's security model is `WHERE tenant_id = ?`
throughout, and platform billing inverts that axis (the platform is the vendor, the tenant is the
customer); and hosting recurs, which means subscription payment rather than the one-off P4 was scoped
for. That needs its own spec, and the extract-versus-rebuild decision for the shared machinery is best
made while this design is still fresh.
