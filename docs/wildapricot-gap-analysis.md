# Wild Apricot Gap Analysis — QuiltHosting

> **WA research:** 2026-08-06 from wildapricot.com (homepage, /features, /pricing,
> /features/membership-management).
>
> **QuiltHosting baseline in original draft:** v0.11.0  
> **Updated against deployed code:** v0.22.0 (2026-08-06)  
> **Audited and re-framed:** v0.27.0-preview (2026-08-09) — see below

---

## ⚠️ Read this before citing any row in this document

**Every ✅ in the tables below was originally assigned on the basis that code
exists.** That is not the same as parity, and on 2026-08-09 an audit proved it
can be badly wrong.

### The precedent

The "Public API + Zapier" row was marked closed (`v0.20 REST + v0.22 outbound
webhooks`). Reading the code found:

- The v1 REST API was **read-only** — five `GET`s, zero writes. A Zapier app
  could have triggers but no actions.
- The admin UI advertised six webhook events. **Two never fired.**
  `member.created` and `event.registration` were accepted by the subscription
  validator, shown to guild admins, and had no emitter anywhere.
- The `write` API-key scope was mintable but enforced by nothing.
- Hook management was JWT-only, so an API key could not subscribe a hook —
  making a Zapier app impossible to build regardless.

A guild could have subscribed a Zap to "new event registration", tested it,
seen nothing, and had no way to tell our bug from theirs. That row read ✅ for
months. It was fixed in v0.27.0-preview (see
`docs/superpowers/plans/2026-08-09-integration-ecosystem.md`).

### The rule this document now follows

> **"Route exists" is not an exit criterion.**

A row may claim parity only with evidence: a complete user job, performed with
real data, including the failure modes. Anything else is `AUDIT PENDING` — not
✅ — regardless of how much code is behind it.

### Audit status

This re-framing has **not** re-verified every row. Only the rows in the table
below were audited on 2026-08-09. **Assume the rest are as unreliable as the
integrations row was** until someone checks them.

| Row | Audit result |
|---|---|
| Public API + Zapier | ❌ **Was materially false.** Fixed in v0.27.0-preview. |
| Email & communications → "Automations" | 🟡 **Overstated — see note below.** |
| Website builder → "themes" | 🟡 Thin. `theme` is a free-form object on `settings_json` consumed by `lib/blocks.ts`; there is no theme gallery or marketplace. Not false, but "+ themes" oversells it. |
| Forums, blogs, galleries, SMS, chapters, invoice numbering, saved-card last4, QBO, open/click tracking, `show_if` form conditionals, block editor | ✅ Code confirmed present. **Existence only — no user-journey verification.** |

#### The automation overstatement

The ✅ row reads: *"Automations: welcome, renewals, event confirm + 7d/1d
reminders, waitlist promote, donation receipt."*

That aggregates one configurable engine with several unrelated hardcoded
paths, which makes it sound like WA's sequence builder. What actually exists:

| Claimed | Reality |
|---|---|
| welcome | The configurable engine. **One trigger — `member_activated`** (`enrollMemberActivated`, two call sites). |
| renewals | `runRenewalJob` — a separate cron, not a sequence. |
| event confirm + 7d/1d reminders | `runEventReminderJob` — a separate cron. |
| waitlist promote | A direct `sendEmail` in the events route. |
| donation receipt | A direct `sendEmail` in the Stripe webhook handler. |

So: **one automation trigger plus four hardcoded transactional emails.** A
guild cannot build "30 days after an event, email attendees" — the single most
requested automation shape. WA parity here is not close.

Hardened during the audit: `POST /automations` accepted a `trigger_event`
field and silently coerced every value to `member_activated`. It now rejects
unsupported triggers with `400 unsupported_trigger` rather than storing a
sequence that would enroll nobody — the same failure mode as the dead webhook
events.

## Wild Apricot quick profile

- 15,000+ organizations; positions as #1 membership management software
- Priced by **total contacts** (100 → 50,000): e.g. $66/mo at 100 contacts,
  monthly; 10%/15% discounts for 1/2-year prepay; 60-day free trial
- "No per-transaction fees" — but pushes their in-house Personify Payments
  processor; third-party processors cost extra
- Add-on products: Job Board, CommUnity (member community), Text Messaging,
  Registration Tech

## Status key

| Symbol | Meaning | Evidence required |
|---|---|---|
| ✅ | At parity or ahead for quilt-guild use | A complete user job done with real data, edge cases included, verified by a human or an automated check |
| 🟡 | Partial — lighter version; saleable with caveats | Same, with the gap named explicitly |
| ❌ | Missing; may block some sales | — |
| 🚀 | Shipped after original v0.11 draft (v0.12–v0.16) | — |

**The symbols below predate this evidence bar.** Except for the rows named in
the audit table above, treat every ✅ as "code exists", not as verified parity.

---

## Feature-by-feature

### ✅ At parity (or ahead)

| Area | Notes |
|---|---|
| Member database | Search/filter, statuses, notes, custom fields, CSV import (WA-header-compatible) + export. **Ahead:** import maps their exports; levels + expiry on import. |
| Membership levels | Multiple tiers, pricing, durations, manual/auto renewal. Soft-archive levels. Admin assign / offline payment. |
| Renewals & dues | Automated reminders (30/14/7/1d), auto-lapse, portal renew, invoices list. Membership stacking fixed; single active membership. |
| Events | Registration, member/non-member pricing, capacity (+ pending_payment hold), waitlists + promote **with email**, ticket codes, check-in, CSV export, delete. |
| Email & communications | Status / **group** / **level** segments; merge fields; layouts + templates; schedule send; delivery log; online newsletter archive. Automations: welcome, renewals, event confirm + **7d/1d reminders**, waitlist promote, donation receipt. |
| Member portal | Passwordless magic-link + Google, profile, invoices, events, directory, documents, newsletters. **Ahead:** no passwords required. |
| Refunds | **Ahead** — one-click in-app; WA’s most-cited gap. |
| Reporting | Dashboard trends (growth, renewals due, revenue by month, signups); CSV exports. |
| Donations | Online one-time + **receipt email**. |
| Multi-admin roles | owner/admin/membership/events/viewer + invites; **nav filtered by role** in admin UI. |
| Pricing model | **Ahead (positioning):** active members only, not all contacts. Free ≤30 enforced; Guild $24/mo platform billing. |
| Stripe Connect 🚀 | Express onboarding; destination charges for dues/events/donations; optional platform fee BPS. |
| Platform billing 🚀 | Free / Guild (starter) plan; upgrade Checkout; customer portal; plan limit enforcement. |
| Ops 🚀 | Rate limits on public/auth POSTs; site gate; fleet footer (QuiltMap LLC). |

### 🟡 Partial — lighter version (closed in v0.20 unless noted)

| Area | Wild Apricot | QuiltHosting v0.20 | Notes |
|---|---|---|---|
| Website builder | Full drag-and-drop site, themes, embed widgets | **DnD builder** (palette → canvas, live preview, props panel) + themes + nav + embeds | Guild microsites; not full WA theme marketplace |
| Custom forms | Applications, events, surveys; conditionals | **Surveys + show_if conditionals** + event questions | |
| Recurring payments | Saved cards, mature auto-renew | Auto-renew + E2E + cancel + **card brand/last4 + update flow** | |
| Financial exports | Excel + **QuickBooks** | CSV + **IIF** + **QBO OAuth export/push** | Needs `QBO_CLIENT_*` secrets |
| Directory | Public OR members-only, showcases, opt-out | Directory + **photos / bio / showcase** | |
| Invoicing | Auto invoices + PDF documents | **Numbered multi-line invoices** + print | |
| Automation | Sequences beyond renewals | **Multi-step welcome** + open + **click tracking** | |
| Onboarding / trial | 60-day trial + coach | Trial + checklist + **coach/webinar links** | |
| Mobile | Native admin + member apps | **PWA** + **Expo iOS/Android apps** (`apps/mobile`) | Store submit when launching |
| Recurring dues | Mature saved-card UX | Cancel + **payment-method panel** + Stripe portal | |

### ❌ Missing entirely (quilt-guild relevance)

| Area | Wild Apricot | Priority for quilt guilds |
|---|---|---|
| **Online store** | Products, inventory, tax, orders | **v0.20** — multi-SKU cart + tax rate BPS + SKU |
| **Embeddable widgets** | Join/event widgets on external sites | **Shipped v0.18** |
| **Public API + Zapier** | Large ecosystem | **v0.27.0-preview.** Was marked closed at v0.20/v0.22 and was materially false — see the audit note at the top. Now: durable delivery with retry/replay, 7 verified events, idempotent writes, REST hooks, private Zapier app. **Still only 2 of 7 events have Zapier triggers, 1 of 11 resources is well covered, and the app is not directory-listed.** Not parity. |
| **Saved payment methods UX** | Cards on file | **v0.22** — last4/brand + update-card flow |
| **Members-only forums** | Forums / CommUnity | **v0.20** — topics/replies in portal |
| **Blogs** | Blog pages | **v0.20** — `page_type=blog_post` |
| **SMS** | Paid add-on | **v0.20** — Twilio optional + log |
| **Job board** | Paid add-on | Irrelevant — skipped |
| **Native mobile apps** | iOS/Android | **v0.22** — Expo app (member + admin check-in) |
| **Multi-chapter product** | Volume / chapter pricing | **v0.20** — parent/child chapters |

---

## What closed since the v0.11 draft

| Gap (original) | Resolution |
|---|---|
| Stripe Connect / guild bank | v0.13 Connect Express + destination charges |
| Platform plan billing + free cap | v0.13 plan column + $24 Checkout + ≤30 active |
| Membership lifecycle bugs | v0.12 activate/expire/idempotent webhooks |
| Email groups | v0.14 |
| Personalization, level segments, templates, event reminders | v0.15 |
| Scheduled blasts | v0.16 |
| Onboarding checklist | v0.16 |
| Waitlist promote email, donation receipts | v0.16 |
| Rate limits, role-aware nav, level archive, event delete | v0.16 |
| Parent branding | QuiltMap LLC (not Holzrichter) |

---

## Strategic read (still true)

WA’s moat is **breadth** (site builder, store, apps, integrations) and **social
proof** (15k orgs). Their weaknesses remain our strengths: contact-count pricing,
no native refunds, weak trend reporting, PE ownership narrative.

For **quilt guilds**, sales-blocking gaps **remaining** (priority order):

| # | Gap | Status |
|---|-----|--------|
| 1 | Recurring dues E2E | **PASSED 2026-08-06** (automated webhooks) — see [auto-renew-e2e.md](./auto-renew-e2e.md) |
| 2 | Exit stealth / trial | **Stay stealth** (gate + noindex). 30-day Guild trial code remains for when we launch |
| 3 | Event registration questions | **Shipped v0.17** |
| 4 | Printable receipts | **Shipped v0.17** |
| 5 | Store lite | **Shipped v0.18** |
| 6 | Embed widgets | **Shipped v0.18** |
| 7 | PWA check-in | **Shipped v0.18** |
| 8 | Open tracking / win-back / public directory / QBO | **Shipped v0.19** |

### Remaining (launch / intentional)

- **Public launch** — drop site gate (blocked until you say go)
- Job board (irrelevant for quilt guilds)
- Zapier *marketplace* app listing (outbound webhooks + REST cover Catch Hook Zaps)
- Full WA-grade marketing CMS (we ship visual blocks, not page-layout DnD)

Noise for this buyer: job board, 1,600 marketplace integrations.

---

## Recommended sequence (post-v0.16) — superseded

The list below is kept for history. Sequencing now lives in
`docs/superpowers/plans/2026-08-09-wildapricot-master-program.md`, which
organises the work into phases with measurable exit criteria. Items 1–5 here
have shipped.

1. ~~E2E auto-renew test pass~~ (done — `scripts/e2e-auto-renew.mjs`)
2. ~~Event custom questions~~
3. ~~Printable receipt page~~
4. ~~Product/store lite~~
5. ~~Embed widgets~~
6. **Trial / drop gate** when ready to sell — still open, and it now blocks
   more than sales: the Zapier directory listing needs 10 live users, which
   needs an un-gated product.

## Next audit targets

Highest risk first — these are the rows most likely to be overstated in the
same way the integrations row was, because they are the ones a guild would
lean on hardest:

1. **Email & communications** — segments, merge fields, scheduled send,
   delivery log. Verify a real blast to a real segment, including bounces.
2. **Events** — capacity, waitlist promote, check-in, non-member pricing.
   Verify a full sold-out-then-promote cycle.
3. **Website builder** — the ✅/🟡 split assumes the block editor produces a
   usable guild site. Have someone build one from scratch and time it.
4. **CSV import** — the strongest switching claim in the document, and the one
   with the most silent-failure surface (unknown columns, custom fields,
   levels, dates).

---

## Sources

- Wild Apricot marketing site (features, pricing, membership management) — 2026-08-06  
- QuiltHosting codebase + deploys through v0.16.0  
- Internal: `docs/competition-wild-apricot-alternatives.md`
