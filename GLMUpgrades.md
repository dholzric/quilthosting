# GLMUpgrades.md — recommendations for ease, quality, features, and price

**Author:** GLM agent scan, 2026-09-08 · **Scope:** whole codebase (`src/`, `public/`, `migrations/`, `docs/`) · **Baseline:** v0.57.0-preview

**The four goals, ranked as stated:**

1. **Easiest to use** — a guild officer with no tech help succeeds alone.
2. **Highest quality site** — every launched site looks professionally built.
3. **Most features** — more of what guilds and studios actually do than Wild Apricot, Raklet, MemberClicks, GrowthZone, or ClubExpress.
4. **Lowest price** — and *perceived* cheapest, because pricing is a feature.

**The governing idea for goal 5 (advanced-but-hidden):** every complex capability ships with a per-tenant **switch**, stored in `settings.features` (a JSON flag object). The admin UI gets one new screen — **Settings → Advanced** — that lists every switch in plain language with an on/off toggle and a one-sentence consequence ("Adds a Block of the Month page and a sign-up tab in the member portal"). Defaults are **off**, so the product a new officer sees stays simple no matter how much machinery exists underneath. **A switch hides complexity, never value: nothing in this document is paywalled.** The only paywall remains scale (the free ≤30-active-member limit), because Wild Apricot's biggest pricing complaint is contact-based billing — we count active members only, and we should never imitate their model.

---

## Scorecard against competitors (2026-09)

| Dimension | Wild Apricot | Raklet | MemberClicks / GrowthZone / ClubExpress | QuiltHosting today |
|---|---|---|---|---|
| Ease of setup | Dated, hard to customize | Code-based page builder | Quote-only + implementation | Kits + design panel: strong, can be best-in-class |
| Site quality | Rigid themes | Weak builder | Dated | 92 kits, design tokens, patterns — already ahead |
| Membership/events/payments | Deep but stagnant | Good | Deep | Broad parity claimed; see F1–F4 gaps |
| Refunds in-product | ❌ | ✅ | varies | ❌ — F2 below |
| Trend analytics without CSV | ❌ | ✅ | varies | 🟡 starter queries exist (`stats.ts`), not surfaced |
| Automations | Sequence builder | Sequences | varies | 🟡 1 trigger + hardcoded emails — F1 below |
| Pricing model | Contact-based, $250+/mo at 2,000 | Contact-based, from $49 | Quote-only ($5–15k/yr) | **Active members only, free ≤30, $24/mo** |
| Quilt-specific features | None | None | None | Longarm project intake; kits — F5–F7 go further |

The strategy this document serves: **keep the site-quality lead, close the three real feature gaps (automations, refunds, analytics), then open an uncontestable lead with quilt-specific modules no horizontal competitor will ever build.**

---

## A. Ease of use

**A1. First-run wizard: logo → kit → colors → done.** Creation currently seeds Heritage and drops the officer into a checklist. Build a single full-screen flow: upload logo (palette-from-logo already specced), pick a kit from visual thumbnails, pick a palette family, enter meeting info — then land on a *finished* home page. Target: **site live in under 10 minutes** (the spec's 20-minute goal, beaten). Effort M. This is the single highest-leverage ease item.

**A2. Sample-data mode.** New tenants start with example members, an event, and store items (clearly badged "Sample", one button "Remove all sample data"). Empty screens are the #1 cause of "this software is hard"; sample data makes every screen demonstrable and the automations/emails testable before real members arrive. Effort M. Gate: `features.sample_data`.

**A3. Dashboard with next-best-action.** Replace the admin landing grid with one card that names the single most valuable next step, computed from state: "Your home page still says *Sample text — replace me* in 3 places", "12 members have no email consent", "Renewal reminders start in 9 days — preview one". One button per card. This is how you hide 90 features behind one screen. Effort M.

**A4. Inline canvas editing.** Phase 3 of the site design doc (click a heading on the preview to edit it). The draft/preview/publish pipeline already renders the real SSR output, so this is postMessage + field mapping, not a new renderer. Effort L but the biggest perceived-simplicity win after A1.

**A5. Restore button for page revisions.** `page_revisions` already snapshots on every publish — surface a revision list with diff preview and a Restore button. Cheap (S) and removes publish-fear, the silent killer of site editing.

**A6. Import with preview.** The Wild Apricot importer already produces batch warnings; add a pre-import table preview ("these 4 rows will fail, here's why — fix inline"). Cuts the single most stressful migration step. Effort M.

**A7. Plain-language audit of the admin.** Grep the admin for internal vocabulary (blocks, tenants, IDs, JSON) and replace with task language ("Pages", "Your website"). Rename "tenants" to "organizations" in UI copy everywhere. Effort S, do it in one pass.

**A8. Launch checklist as a guided flow.** Stealth gate → custom domain → SEO description → first photo → first blast. One sequential card flow with green checks, so "going live" is a procedure, not a discovery. Effort S.

---

## B. Site quality

**B1. Ship the phase-2 imagery pipeline.** Client-side resize to 2400/1200/600 WebP + JPEG fallback into R2, focal-point picker, `?w=` variant serving. Kits are already built photo-light so sites don't look broken without images — the moment officers add photos, this pipeline is what keeps pages at LCP ≤ 2.5s. Effort M–L. Highest quality-per-dollar remaining.

**B2. Retire `guild.html`.** The legacy renderer is two code paths, two CSS files, and a permanent source of "my friend's guild site looks different." Migration 0026 gives the per-tenant switch; finish converting the seeded tenants and delete it (the spec's phase 4). One renderer = every future improvement lands everywhere at once. Effort M, mostly data work.

**B3. Kit gallery with real previews in the admin.** `kits:preview` screenshots exist for CI; render those screenshots into Design → Browse designs with a "try this kit on my content" preview (apply kit to a draft copy, view, discard). Choosing a design should be browsing a lookbook, not imagining one. Effort M.

**B4. SEO/social cards per page.** OG/Twitter cards from each page's hero (image + title + description), JSON-LD Organization/Event, per-page titles/descriptions editable in the page editor, sitemap already exists. Local search is how small guilds recruit. Effort M.

**B5. Empty states that recruit.** Every dynamic section's `qh-empty` box should include a one-line instruction and link ("Add your first event →" targeting the right admin screen). New-site embarrassment is a quality problem, and it is fully solvable in copy. Effort S.

**B6. Performance budget in CI.** HTML ≤ 60KB, one CSS, one JS, two fonts — already policy; make the browser check assert it on a kit home page so regressions fail loudly. Effort S.

**B7. Accessibility audit.** Contrast is derived and WCAG-checked at the token level (genuinely rare among competitors). Add a keyboard/screen-reader pass over admin + portal + a sample kit, fix, and *market* the accessibility — it is a differentiator nobody in this market claims. Effort M.

---

## C. Features (each behind a `settings.features` switch)

**C1. Automations 2.0 — the biggest real gap.** Today: one trigger (`member_activated`) plus hardcoded renewal/event-reminder crons. Guilds cannot build "30 days after an event, email attendees a survey" — the most requested automation shape anywhere. Build triggers (`member_activated`, `event_registered`, `event_ended`, `renewal_due`, `form_submitted`, `payment_received`, `membership_lapsed`), conditions (field equals / status), and delay steps ("wait 7 days"), executed by extending the existing crons into a small scheduler over an `automation_runs` table. Ship with 6 pre-built recipes ("Welcome series", "Renewal ladder", "Post-event thank-you + survey") so the switch hides the builder entirely. Effort L. *Switch: `features.automations_v2` (builder; recipes on by default).*

**C2. Native refunds.** Wild Apricot cannot process refunds; Raklet can and advertises it. Admin button on any payment: Stripe refund via the existing raw REST client, payment row status flip, stock/seat restoration, automatic receipt email. Effort S–M. *Switch: `features.refunds` (on by default for owners/admins).*

**C3. Analytics without exports.** `stats.ts` already has member growth, renewal, and registration trend queries nobody prominent sees. Build one Reports screen: growth sparkline, churn/renewal rate, revenue by source, event attendance over time, top events — plus a scheduled "monthly board report" email (PDF or HTML) that treasurers forward as-is. Direct hit on a documented WA complaint. Effort M. *Switch: `features.reports`.*

**C4. Waivers and agreements at registration.** Retreats and rides need liability waivers. Add an optional per-event waiver text with required checkbox; store text version + timestamp + IP with the registration, include in the portal receipt. Event registration flow already supports questions, so this is a field type plus storage. Effort S. *Switch: `features.waivers`.* This closes real retreat bookings.

**C5. Deposits and installment pay.** Big quilt retreats and workshops ($300–900) convert better with deposit + balance. Extend checkout with `amount_due_today` and a scheduled balance charge (the renewal cron already proves scheduled Stripe work works). Effort M. *Switch: `features.installments`.*

**C6. Block of the Month module — quilt-specific moat.** Guilds run BOM programs by hand over email. Ship: monthly block releases to members (pattern PDF + photo), a member "I finished it" gallery per month, progress tracking, and an auto-reminder on release day. No horizontal competitor will ever build this. Effort M–L. *Switch: `features.bom`.*

**C7. Quilt show module.** For the show-centric segment: entry categories, online entry form with photo + entry fee, jury/acceptance status visible to entrants, vendor booth registry with payment, printable program. `show-festival` kit already links to these pages; build the machinery under them. Effort L. *Switch: `features.quilt_show`.*

**C8. Lending library.** Guilds lend books, dies, and rulers (the `prairie` kit already promises a library page). Catalog + checkout/return by date + overdue email via the automations engine. Effort M. *Switch: `features.library`.*

**C9. Digital downloads for the store.** Pattern PDFs are the #1 digital good in this market. R2-stored files, signed `download`-purpose JWT URLs (the token plumbing exists in `auth/jwt.ts`), delivery email + portal re-download. Then a "patterns" kit category becomes fully self-serve. Effort M. *Switch: `features.digital_goods`.*

**C10. Coupons and gift cards.** Cart exists; add percentage/fixed codes with expiry and usage caps, plus gift-card products that mint a code. Effort S–M. *Switch: `features.coupons`.*

**C11. Virtual-meeting plumbing.** Virtual guilds (see `virtual-guild` kit) need the Zoom/Meet link on the event, in the confirmation email, and on the portal — plus "Add to calendar" (the `ical.ts` builder exists; wire it to public event pages). Start with a paste-a-link field; OAuth Zoom later. Effort S then M. *Switch: none (small) / `features.zoom_sync` (later).*

**C12. Officers, minutes, and polls.** Boards need: an officers grid page (phase-2 `officers` section), a members-only documents library (minutes; phase-2 `documents`), and lightweight polls with results visible to members. All portal-adjacent, all requested by every guild board. Effort M each. *Switches: `features.officers`, `features.documents`, `features.polls`.*

**C13. Referral and gift memberships.** "Gift a membership" checkout (buyer pays, recipient gets magic-link claim) and a member-get-member link with a simple tally. Membership growth is the product's own growth loop. Effort M. *Switch: `features.gifting`.*

**C14. Advanced: scoped custom CSS.** Competitors gate this; we can offer it safely as **token overrides only** — a small allowlisted set of `--qh-*` variable overrides and Google-Fonts swap, sanitized server-side, never raw CSS. One switch, one textarea with live preview, no script injection risk because no raw CSS is ever emitted. Effort S–M. *Switch: `features.design_overrides`.*

**C15. Advanced: member-facing mobile app store release.** The Expo apps exist unreleased. Store submission is a launch task, not a build task; the portal PWA already covers most members. Keep deferred until post-launch traffic justifies review overhead. Effort M (process).

---

## D. Lowest price — how we keep it true

**D1. The pricing story is a weapon; say it everywhere.** "Free under 30 active members. $24/month flat. We count active members, not contacts — lapsed members and alumni never cost you a cent. Price-lock guarantee for as long as you stay subscribed." This attacks WA's #1 documented complaint (contact-based billing at $250/mo) and Raklet's contact packs. Put the comparison on the public marketing page. Effort S (copy).

**D2. Keep the unit economics boring.** One Worker, one D1 database, edge-cached HTML, batched D1 statements (already a hard rule), no image-resizing dependency (variant pipeline in B1 instead), Resend for email. Fixed cost per tenant is near zero at 30 members and trivial at 3,000. Add an `email_send_log`-based monthly ceiling alert so a runaway blast can never surprise the platform's bill. Effort S.

**D3. Switches are not paywalls — enforce it culturally.** The Council (pro) tier should sell *scale* (member count, multi-chapter, priority support), never features. This is the anti-Wild Apricot position and it is defensible precisely because our marginal cost (D2) is near zero.

**D4. Orphan hygiene.** Files uploaded to drafts/abandoned signups should get an R2 lifecycle rule or a monthly sweep so storage never creeps. Effort S.

---

## E. The switch mechanism itself (build once, reuse forever)

- `settings.features` = JSON object of booleans; helper `hasFeature(tenant, key)` in `src/lib/`; defaults table in code so a missing flag means "off".
- **Settings → Advanced** admin screen: every switch, plain-language description, "what turns on" example, docs link. Grouped as "Power tools", not "Settings", so the main screens never mention them.
- Rollout discipline: default off → enable per-tenant → cohort → default on. Same switch doubles as the kill-switch when something misbehaves in production.
- Every switch gets one automated test asserting the *off* path renders/behaves exactly as before it existed — the guarantee that complexity is truly invisible.

---

## Priority order (my recommendation)

| # | Item | Goal | Effort | Switch |
|---|---|---|---|---|
| 1 | A1 first-run wizard | Ease | M | — |
| 2 | B1 imagery pipeline | Quality | M–L | — |
| 3 | C1 Automations 2.0 + recipes | Features | L | `automations_v2` |
| 4 | C2 native refunds | Features | S–M | `refunds` |
| 5 | A3 next-best-action dashboard | Ease | M | — |
| 6 | C3 reports + board report email | Features | M | `reports` |
| 7 | A2 sample-data mode | Ease | M | `sample_data` |
| 8 | B3 kit gallery previews in admin | Quality | M | — |
| 9 | C4 waivers at registration | Features | S | `waivers` |
| 10 | B4 SEO/social cards | Quality | M | — |
| 11 | A5 revision restore UI | Ease | S | — |
| 12 | C5 deposits/installments | Features | M | `installments` |
| 13 | C6 Block of the Month module | Features (moat) | M–L | `bom` |
| 14 | D1 pricing-page offensive | Price | S | — |
| 15 | B2 retire `guild.html` | Quality | M | existing flag |
| 16 | C9 digital downloads | Features | M | `digital_goods` |
| 17 | C11 calendar links + iCal wiring | Features | S | — |
| 18 | C10 coupons/gift cards | Features | S–M | `coupons` |
| 19 | C8 lending library | Features | M | `library` |
| 20 | C7 quilt show module | Features (moat) | L | `quilt_show` |
| 21 | A4 inline canvas editing | Ease | L | — |
| 22 | C12 officers/documents/polls | Features | M | three switches |
| 23 | B7 accessibility pass + claim | Quality | M | — |
| 24 | C13 gifting/referrals | Features | M | `gifting` |
| 25 | C14 scoped design overrides | Advanced | S–M | `design_overrides` |

Items 1–12 are roughly one strong release cycle and would, by themselves, make the product easier than everything in the comparison set while matching its feature depth at a tenth of the price. Items 13 and 20 are the moat: quilt-specific software is the one thing Wild Apricot structurally cannot chase.

## Risks and notes

- **"Route exists ≠ parity."** The gap analysis proved a ✅ was materially false once. Every claim above was checked against code this scan; before marketing any row (especially automations and API), run the same user-journey audit the integrations row got.
- **Security invariants stay fixed:** no raw tenant CSS/JS on the app origin (C14 is token-variables only), all tenant HTML through the sanitizer, every new output path escapes.
- **Stealth:** none of this ships publicly until the site gate comes off by explicit decision.
- **Sequencing:** A1 and B1 touch onboarding and images — land both *before* the public launch so every early user gets the good path on day one.
