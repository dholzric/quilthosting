# Wild Apricot Gap Analysis — QuiltHosting

> **WA research:** 2026-08-06 from wildapricot.com (homepage, /features, /pricing,
> /features/membership-management).
>
> **QuiltHosting baseline in original draft:** v0.11.0  
> **Updated against deployed code:** v0.18.0 (2026-08-06)

## Wild Apricot quick profile

- 15,000+ organizations; positions as #1 membership management software
- Priced by **total contacts** (100 → 50,000): e.g. $66/mo at 100 contacts,
  monthly; 10%/15% discounts for 1/2-year prepay; 60-day free trial
- "No per-transaction fees" — but pushes their in-house Personify Payments
  processor; third-party processors cost extra
- Add-on products: Job Board, CommUnity (member community), Text Messaging,
  Registration Tech

## Status key

| Symbol | Meaning |
|---|---|
| ✅ | At parity or ahead for quilt-guild use |
| 🟡 | Partial — lighter version; saleable with caveats |
| ❌ | Missing; may block some sales |
| 🚀 | Shipped after original v0.11 draft (v0.12–v0.16) |

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

### 🟡 Partial — lighter version

| Area | Wild Apricot | QuiltHosting v0.16 | Gap to close |
|---|---|---|---|
| Website builder | Full drag-and-drop site, themes, embed widgets | Public `/g/:slug` + HTML pages + profile | Blocks editor, themes, nav; **embeddable join/event widgets** for WordPress |
| Custom forms | Applications, events, surveys; conditionals | Custom member fields on join + **per-event registration questions** (text/select, required) | Surveys; conditional fields |
| Recurring payments | Saved cards, mature auto-renew | `renewal_type: auto` + subscription Checkout + `invoice.paid` extend | **E2E test** in Stripe test mode; card-update / cancel UX in portal |
| Financial exports | Excel + **QuickBooks** | CSV (members, payments, regs) | QuickBooks IIF/QBO or integration |
| Directory | Public OR members-only, showcases, opt-out | Members-only names list | Privacy opt-in/out, richer profiles, optional public directory |
| Invoicing | Auto invoices + PDF documents | Payment history + **printable receipts** (admin + portal, Print → PDF) + receipt emails | Full auto-invoice numbering / multi-line invoices |
| Automation | Sequences beyond renewals | Renewals + event reminders + welcome + waitlist + receipts | Welcome series, lapsed win-back sequence; open/click tracking |
| Onboarding / trial | 60-day trial + coach | **Dashboard checklist** + stealth gate | Real free trial (no gate), trial clock, optional coach path |
| Mobile | Native admin + member apps | Responsive web + **PWA** (install admin, offline check-in queue) | Richer offline member app optional |

### ❌ Missing entirely (quilt-guild relevance)

| Area | Wild Apricot | Priority for quilt guilds |
|---|---|---|
| **Online store** | Products, inventory, tax, orders | **Shipped v0.18 lite** — products, inventory, Stripe Checkout; no tax engine |
| **Embeddable widgets** | Join/event widgets on external sites | **Shipped v0.18** — `/embed/:slug/join|events|store` iframes |
| **Public API + Zapier** | Large ecosystem | Medium — document REST + Zapier later |
| **Saved payment methods UX** | Cards on file | Medium — Stripe Customer Portal / portal “update card” once Connect stable |
| **Members-only forums** | Forums / CommUnity | Low — Facebook already owns this |
| **Blogs** | Blog pages | Low — content pages suffice |
| **SMS** | Paid add-on | Low |
| **Job board** | Paid add-on | Irrelevant |
| **Native mobile apps** | iOS/Android | Medium — prefer PWA first |
| **Multi-chapter product** | Volume / chapter pricing | Medium — maps to Council tier; not built |

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

| # | Gap | Why it blocks | Suggested next build |
|---|-----|---------------|----------------------|
| 1 | **Recurring dues verified E2E** | Treasurers won’t trust auto-renew without a proven test path | Stripe test-mode checklist doc + portal cancel/update card |
| 2 | **Exit stealth / trial story** | Gate + no public trial vs WA’s 60 days | Soft gate for marketing pages; 30-day Guild trial on signup |
| 3 | ~~Event registration questions~~ | **Shipped v0.17** | Admin questions + public form + CSV |
| 4 | ~~Printable receipts~~ | **Shipped v0.17** | Admin + portal Print → Save as PDF |
| 5 | ~~Store lite~~ | **Shipped v0.18** | Admin Store + public shop + inventory |
| 6 | ~~Embed widgets~~ | **Shipped v0.18** | join / events / store iframes |
| 7 | ~~PWA check-in~~ | **Shipped v0.18** | Manifest + SW + offline check-in queue |

Noise for this buyer: forums, job board, SMS, 1,600 integrations, native apps
before PWA.

---

## Recommended sequence (post-v0.16)

1. **E2E auto-renew test pass** (no new features — prove invoice.paid path)  
2. **Event custom questions** (schema already supports answers)  
3. **Printable receipt page** (`/portal` or admin print)  
4. **Product/store lite** (one SKU type)  
5. **Embed widgets**  
6. **Trial / drop gate** when ready to sell  

---

## Sources

- Wild Apricot marketing site (features, pricing, membership management) — 2026-08-06  
- QuiltHosting codebase + deploys through v0.16.0  
- Internal: `docs/competition-wild-apricot-alternatives.md`
