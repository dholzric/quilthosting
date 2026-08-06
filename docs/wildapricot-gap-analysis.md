# Wild Apricot Gap Analysis — QuiltHosting v0.11

> Researched 2026-08-06 from wildapricot.com (homepage, /features, /pricing,
> /features/membership-management). Compares against QuiltHosting as deployed
> at v0.11.0. Note: Stripe Connect payouts + platform plan billing are in
> progress (Grok) and treated as "in flight" below.

## Wild Apricot quick profile

- 15,000+ organizations; positions as #1 membership management software
- Priced by **total contacts** (100 → 50,000): e.g. $66/mo at 100 contacts,
  monthly; 10%/15% discounts for 1/2-year prepay; 60-day free trial
- "No per-transaction fees" — but pushes their in-house Personify Payments
  processor; third-party processors cost extra
- Add-on products: Job Board, CommUnity (member community), Text Messaging,
  Registration Tech

## Feature-by-feature

### ✅ At parity (or ahead)

| Area | Notes |
|---|---|
| Member database | Search/filter, statuses, notes, custom fields, CSV import (WA-header-compatible) + export. **Ahead:** our import maps their exports directly. |
| Membership levels | Multiple tiers, pricing, durations, manual/auto renewal types. |
| Renewals & dues | Automated reminders (30/14/7/1d), auto-lapse, online renewal, invoices in portal. WA equivalent. |
| Events | Registration forms, member/non-member pricing, capacity, waitlists + promote, ticket codes, check-in (web), CSV export. |
| Email & communications | Segment blasts, delivery log, automated transactional emails, **newsletters readable online** (WA has archives too). |
| Member portal | Passwordless magic-link + Google sign-in, profile self-service, invoices, event registration, directory, documents. **Ahead:** no passwords at all. |
| Member directory | Members-only, searchable list. WA also offers *public* directories and richer profile showcases (see gaps). |
| Refunds | **Ahead** — one-click refund in-app; WA cannot refund natively (their most-complained gap). |
| Reporting | Dashboard stats: growth, renewals due, revenue by month, signups; payments CSV export. WA reporting is totals-oriented; we do trends in-app. |
| Donations | Online one-time donations with preset amounts. |
| Multi-admin roles | owner/admin/membership/events/viewer + invites. WA has admin roles too. |
| Pricing model | **Ahead (positioning):** priced on *active members*, not every contact ever collected. |

### 🟡 Partial — we have a lighter version

| Area | Wild Apricot | QuiltHosting today | Gap to close |
|---|---|---|---|
| Website builder | Full drag-and-drop site builder, themes, widgets embeddable in external sites | Public guild page + HTML content pages + profile hero | Blocks-based page editor, theme choices, nav menus; embeddable join/event widgets for guilds' existing WordPress sites |
| Custom forms | Form builder on applications, events, surveys; conditional fields | Custom member fields (text/dropdown) on join form | Per-event registration questions; surveys; required/conditional fields |
| Recurring payments | Auto-renewal via saved cards is core | `renewal_type: auto` + subscription checkout exists but untested end-to-end | Verify subscription lifecycle (invoice.paid → extend membership), card-update flow, cancellation |
| Financial exports | Excel + **QuickBooks** export | CSV exports (members, payments, registrations) | QuickBooks-formatted export (IIF/QBO) or integration |
| Directory | Public OR members-only, profile showcases, opt-out controls | Members-only names list | Privacy opt-in/out per member, richer profiles, optional public directory |
| Invoicing | Auto-generated invoices + receipts as documents | Payment history list in portal | Printable/PDF receipts and invoices |
| Automation | Scheduled/automated email sequences beyond renewals | Renewal reminders only | Welcome series, event reminders (day-before), lapsed win-back sequence |

### ❌ Missing entirely

| Area | Wild Apricot offering | Priority for quilt guilds |
|---|---|---|
| **Mobile apps** (admin + member, iOS/Android) | Full-featured native apps incl. mobile check-in | Medium — our pages are mobile-responsive; a PWA (installable, offline check-in) would cover 90% at 5% of the cost |
| **Online store** | Products, inventory, tax automation, order management | Medium-high — guilds sell patterns, kits, show tickets, raffle entries |
| **Members-only forums / community** | Forums; CommUnity add-on | Low-medium — Facebook groups already own this space |
| **Blogs** | Member-visible blog pages | Low — content pages cover most of it |
| **Integrations ecosystem** | "1,600+ apps" (Zapier etc.), widgets, SSO, public API docs | Medium — a documented public API + Zapier would check the box |
| **Text messaging (SMS)** | Paid add-on | Low for now |
| **Job board** | Paid add-on | Irrelevant for quilt guilds |
| **Multi-chapter / volume pricing** | Custom pricing for chapter organizations | Medium — maps to our "Council" tier; state guilds are a real segment |
| **Free trial mechanics** | 60-day trial, onboarding coach, boot camp, webinars | High at launch — we need a trial story + guided onboarding wizard |
| **Saved payment methods** | Cards on file for renewals/store | High once Connect lands |

### In flight (Grok)

- Stripe Connect Express payouts per guild (destination charges, platform fee)
- Platform plan billing (Free ≤30 active members; Guild $24/mo)

## Strategic read

WA's moat is **breadth** (site builder, store, apps, integrations) and **social
proof** (15k orgs, awards). Their weaknesses — the reasons people leave — remain
our strengths: contact-count pricing, no refunds, CSV-only trend reporting,
post-acquisition support decay, PE ownership.

For the quilt-guild niche specifically, the gaps that will actually block a
sale, in order:

1. **Guided onboarding + trial** — WA gives 60 days + a coach; we currently
   give a blank dashboard behind a password
2. **Recurring dues verified end-to-end** — auto-renewal is table stakes for
   treasurer trust
3. **Event registration questions** (per-event custom fields) — quilt workshops
   need "machine or hand piecing?", "lunch choice", etc.
4. **Receipts/invoices as documents** — treasurers ask on day one
5. **Online store lite** — patterns/kits/raffle tickets; even a single-item
   "product" checkout reusing the donation flow would demo well
6. **Embeddable widgets** — many guilds keep their WordPress site; a join
   widget meets them where they are
7. **PWA mobile story** — "add to home screen" + offline check-in beats
   building native apps

Everything else (forums, job board, SMS, 1,600 integrations) is noise for this
buyer.
