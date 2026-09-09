# QuiltHosting product recommendations

**Date:** 8 September 2026  
**Baseline:** code at v0.57.0-preview; product docs still say v0.56.  
**Ask:** easiest to use, highest-quality public site, more useful features than competitors, lowest price — with advanced tools behind a switch so most officers never see the complexity.

This is a product brief, not an implementation plan. Evidence comes from the live admin (`public/admin.html`), SSR site (`src/lib/site/`), plans (`src/lib/plans.ts`), feature reference (`public/docs/features.html`), Wild Apricot gap analysis, and competitor notes.

---

## 1. The strategy in one page

QuiltHosting already has **more surface area than a volunteer quilt guild will use in year one**, at a **price that undercuts Wild Apricot and most AMS peers** ($24/month, active members only, or free ≤30). The default admin still shows ~22 equal-weight sidebar items, including SMS, API, Zapier, JSON automations, and invoice pipe-syntax. That is the opposite of “easiest.”

**Do not win by adding more default screens.** Win by making the everyday jobs feel inevitable, making the public site look like a real guild, and putting everything else behind one switch.

| Goal | How we actually win |
|------|---------------------|
| Easiest | Simple admin by default. Dollars, not cents. Forms, not JSON. Empty states that teach. Role-tailored nav. |
| Highest quality site | Finish the new renderer: real image variants, donate / ICS / directory / volunteers on SSR, SEO inventory, join/register without JavaScript. Migrate off `guild.html`. |
| Most features | Keep building breadth, but **opt-in**. The catalog can be larger than Wild Apricot if the default product is smaller than ClubExpress. |
| Lowest price | Keep **$24 Guild / free ≤30 / active-only**. Do not invent contact-count tiers. Fair-use (mail, storage) later via a Council SKU if costs force it — not by hiding core guild jobs. |

The switch is the product: **Simple (default) vs Advanced**. It is a UI preference, not a paid plan. New guilds start Simple. Power users flip one control in Settings.

---

## 2. Competitive position (honest)

Wild Apricot’s moat is breadth + 15k orgs. Their weaknesses are ours: contact-count billing, no native refunds, weak trend reporting, PE ownership, stagnant cadence.

| Buyer job | QuiltHosting today | WA / peers | Recommendation |
|-----------|--------------------|------------|----------------|
| Price at 200–2,000 **active** members | **$24/mo** (or free ≤30) | WA ~$108–$250; Raklet ~$99–$199; ClubExpress cheaper only at tiny clubs | Keep the promise. Market “active members, not every old email.” |
| Native refunds | In-app full refunds | WA’s most-cited gap | Keep ahead. Add partial refunds + restock/unseat later (Advanced). |
| Public website | Strong kits + design tokens; dual renderer; no `srcset` on live routes | WA’s historical reason to stay | **This is the quality fight.** Finish Phase 2 imagery + sections; close the legacy-feature gap. |
| Join / renew / events | Shipped, but some conversion is JS-only; money fields mix dollars and cents | WA is familiar, clunky | Reliability and volunteer language beat more event types. |
| Household / calendar-year dues | **Missing** (docs admit it) | Default quilt-guild SKU at WA | Highest-leverage **new** feature for this buyer. |
| Automations | One trigger (`member_activated`) + hardcoded crons | WA sequences | Don’t fake a sequence builder. Ship 3 extra triggers, then stop. |
| Store / show merch | Lite: SKU, tax BPS, no photos, no orders screen | WA store | Good enough for raffle tickets. Photos + orders belong behind Advanced. |
| Migration | Strong WA-header CSV + dry-run | Switching cost protects WA | Member CSV is not a migration product. Guided import is a sales feature. |
| Integrations | API + 7 webhooks; Zapier private, 2 triggers | WA catalog | Fine behind Advanced. Directory listing after launch, not before. |
| Mobile | PWA + Expo not in stores | WA branded apps | PWA check-in is enough until launch. Don’t spend on App Store while stealth. |

**Do not chase MemberClicks / iMIS / GrowthZone.** Quote-only AMS is a different buyer. Quilt guilds are 40–200 people and a rotating treasurer.

**ClubExpress / MemberPlanet** are the price floor. We can stay above them if we look modern and if Simple mode feels as small as they do.

---

## 3. The Advanced switch

Add `settings.ui.advanced` (boolean, default **false**). One Settings control: **“Show advanced features.”** Persist per tenant (officers share the same guild). Optional later: per-user override.

### Simple (default) — everyday guild

**Nav**

- Home: Dashboard  
- People: Members, Levels, Team  
- Calendar: Events  
- Site: Website  
- Money: Payments  
- Email: Email  
- Settings  

**Allowed in those screens, still simple**

- Add / import members (keep the dry-run wizard — it is the best flow in the product)  
- Membership levels in **dollars**  
- Events: when, where, free vs priced, capacity  
- Email: compose, pick audience, send  
- Website: pages + **Browse designs** (curated 6–8 kits) + publish  
- Payments: history, refund, Stripe Connect  
- Dashboard checklist: edit home, add a level, preview site, first member  

### Advanced (switch on) — everything we already built

Unhide and/or expand:

- Store, Invoices, Automations, Forms, Blog, Forum, Documents, Photos, Reports, SMS, Chapters, API, Zapier  
- Recurring events, volunteer sheets, waitlists, event questions  
- Custom fields, groups, QBO / IIF, embed widgets, custom domain  
- Design: 26 palettes, 12 type pairs, patterns, custom four-color, header/footer, overlay  
- Editor: all ~19 (soon 33) section types  
- Raw HTML email, JSON leftovers until those UIs are rebuilt  
- Business-only: Projects, rates, quote, Appearance, Domain & Launch (already tenant-type gated — keep that)

**Role-tailored nav is the second switch.** An events chair in Simple mode should see Dashboard + Events + Photos, not 18 read-only items. The permission matrix already exists (`src/lib/permissions.ts`); the sidebar does not use it enough.

**Plan gating is the third lever, later.** Today the Guild plan only lifts the 30-member cap (`src/lib/plans.ts`). That is the right story for “lowest price.” If Council is ever sold, gate Zapier write APIs, QBO, SMS, and extra email volume — never Join, Renew, Events, or the website.

---

## 4. Recommendations, ranked

Priorities: **P0** before a paid pilot feels kind; **P1** to beat WA for a quilt guild; **P2** once the core is easy.

### P0 — Easiest: stop scaring volunteers

1. **Ship Simple / Advanced.** Group the sidebar. Default Simple. This is the single highest-leverage UX change and it uses features you already have.

2. **Money in human units everywhere.** Levels already use dollars. Events, store, invoices, and “amount paid” still speak **cents**; store tax is **basis points** (“700 = 7%”). Invoices use `description | qty | unit cents`. That will produce wrong dues. Dollars and percent, always. Sync docs (`getting-started.html` still says levels are cents).

3. **Replace JSON / HTML authoring in the default path.** Automations = delay / subject / body rows. Forms = field builder. Invoices = line-item rows. Blog = the page editor or a simple rich-text control. Keep JSON as an Advanced escape hatch if you must.

4. **Empty states that teach.** Several lists `.map` an empty array into a blank table (Levels, Events). Replace `"No products yet"` with one sentence, a primary button, and “You can skip this.” Store / SMS / API should say *why you’d turn this on*, not dump a developer form.

5. **First-run focus.** After create-guild, the dashboard should be three actions (Edit home page, Add a $35 level, Preview site), not 22 links. The checklist (`src/lib/onboarding.ts`) is the right idea; it does not hide complexity. Fix `team_invited` `href` (`"#settings"` should be `"#team"`). Persist `location.hash` so refresh does not dump officers on Dashboard.

6. **Website progressive disclosure.** Kits: show a **curated 6–8** (Heritage, Modern Guild, Prairie, Show & Festival, Community Threads, Longarm Studio, plus one quiet and one festival). Put the other ~80 under “More designs.” Palettes / type / shape / patterns / custom colors behind **“Customize further.”** Editor palette: Hero, Text, Image, Events, Join, Contact first; remaining sections under “More.”

7. **Email as tabs.** Default = compose + send. Groups, archive, and delivery log as secondary tabs.

8. **Events as a short stepper.** When/where → free or priced → Save. Waitlist, questions, repeats, volunteers after the event exists (or under Advanced).

### P0 — Highest quality public site

The new SSR path (`serveSite`, kits, `--qh-*` tokens) is the quality bet. Legacy `guild.html` still has jobs the new site dropped. Dual renderer means some guilds get a worse site after “Try the new design.”

9. **Wire image variants on live routes.** `src/lib/images.ts` already serves `?w=` / WebP. `serveSite` `imgUrl` and `/img/` still stream originals. Emit `srcset` + width/height. This is the biggest speed and CLS win; Phase 2 already specified it.

10. **Close the `guild.html` feature gap on SSR** before pushing remaining guilds off classic:
    - Event ICS + Google Calendar on event detail  
    - Volunteer sign-up hooks on event detail  
    - Donate **section** (header CTA currently points at `#donate` with no target on the new site)  
    - Public member directory when `directory_public`  
    - A real `/store` page, not only a teaser section  

11. **Join / Register without JavaScript.** Membership and event CTAs that are `href="#"` plus an island are dead for no-JS, broken clones, and some crawlers. Dedicated `/join` and `/events/:id/register` forms that POST. Thank-you pages instead of a toast on home.

12. **SEO inventory.** Sitemap today is authored pages only, and blog posts are listed as `/{slug}` while they live at `/blog/{slug}`. Include `/membership`, `/events`, `/events/:id`, `/calendar`, `/galleries`, `/blog`. Add Organization / Event / FAQ / Article JSON-LD (business sites already get LocalBusiness).

13. **Finish Phase 2 sections that kits and tests already assume** (donate, officers, newsletter signup, event spotlight, sponsors, hours, process, …). Tests in `sections/schema.test.ts` are ahead of the 19 live types in `SECTION_TYPES`. Shipping those sections is how the site looks “complete” next to WA, not another kit JSON file.

14. **Migrate remaining `renderer === "legacy"` guilds** only after 10–13. “Back to classic” can stay as Advanced.

15. **Portal feels like the same product.** Today `portal.html` is admin chrome: eight tabs, no deep links, no directory search, ticket = a code in `<code>`, Renew has no level picker, magic link is secondary to a password field. Minimum: Home = **your next event + renew with price**; QR or large ticket code + ICS; hash-routed tabs; restyle onto `qh-site.css`.

### P1 — Features quilt guilds actually buy (then hide extras)

These beat “another sidebar item.” They are why a guild leaves Wild Apricot.

16. **Household / family memberships.** One payment, two (or more) named members, shared directory listing. Docs already list this as not included. Quilt guilds sell this SKU every January.

17. **Calendar-year and fixed-date renewals**, with a simple half-year join rule (“join after July = half dues”). Terms today are join-date + N months only.

18. **Guided Wild Apricot import as a product.** Member CSV + dry-run is strong. Switching still fails on groups, households, event history, and “what do I do next.” A wizard: upload → map → preview → members live → “now pick a website design” is the moat. Full payment/page history can wait.

19. **Three automation triggers beyond welcome:** membership lapsed, event attended (or event ended), form submitted. That covers “win-back,” “thank you for the show,” and “someone used Contact.” Do not build a generic Zapier-in-the-admin.

20. **Combined checkout (renew + event)** as Advanced. “Pay dues and register for the retreat” is a real quilt-guild Saturday.

21. **Level-gated pages** (members-only is a boolean today). Needed for “library is for members,” not for day one.

22. **Store photos + a simple orders screen** (Advanced). Enough for raffle and show boutique. Skip shipping until someone asks.

23. **Partial refunds** that also release a seat or restock. Full refund today does not unwind the membership/seat/stock side.

### P1 — Quality of operations (quiet, but it is “highest quality”)

24. **Keep the Astra rule:** *route exists is not an exit criterion.* Dashboard trends, refunds, import, and Connect payouts should have a volunteer-journey checklist you actually run before claiming parity.

25. **Failed auto-renew communication.** Card on file + lapse on end date is not a treasurer experience. Email the member and the treasurer when a renewal charge fails.

26. **Contact island should load the form schema.** Custom forms exist; the public contact block is still name / email / message.

27. **Site search + blog RSS.** Small; expected on a “real website.”

### P2 — Price, packaging, things to delay

28. **Do not raise the Guild price** to pay for Advanced features. The $24 story vs WA’s contact tiers is the wedge. If costs hurt, sell **Council** for API / QBO / high email volume / chapters — not for Events.

29. **Fair-use later, not now.** Unlimited members + unlimited mail at $24 has no cost model (`astra.md`). Soft-cap email with a friendly “you sent a lot; want a digest?” before a hard paywall.

30. **Native App Store apps:** keep Expo in the repo; do not submit while stealth. PWA check-in is the event-day job.

31. **SMS:** BYO Twilio, legal risk, hide until connected. Never mention `settings_json` in the UI.

32. **90 kits:** keep them as a library for Advanced “More designs.” Do not put 90 equal cards in front of a new guild. Curate. Quality of Heritage-class copy beats kit count.

33. **Configurable longarm services** (`docs/superpowers/specs/2026-08-13-configurable-services-design.md`) stay spec-only until guild Simple mode is done. Business is a second product.

---

## 5. What not to do

- **Do not add a 23rd default sidebar item** (job board, SMS newsletters, certification, career center).
- **Do not match Wild Apricot’s theme marketplace.** Kits + palettes + one “Browse designs” strip is the quilt-guild version of a marketplace.
- **Do not feature-gate Join, the website, or refunds** behind Guild vs Free. Free ≤30 must feel like the real product.
- **Do not claim automation / Zapier / “themes” parity** from route existence. The gap analysis already documented that failure mode.
- **Do not launch** until Simple mode exists and join/register work on the SSR site without a console. Stealth until you say go remains correct.

---

## 6. Suggested sequence (90 days of product, not 90 days of features)

| Weeks | Outcome a volunteer can feel |
|-------|------------------------------|
| 1–2 | Advanced switch + grouped nav + dollars everywhere + empty states + hash routing + team checklist href |
| 3–5 | Image `srcset` on live routes; donate / ICS / volunteers / directory on SSR; join/register URLs; sitemap fix |
| 6–7 | Curated kit strip + “Customize further”; editor “More sections”; blog uses the real editor |
| 8–10 | Household + calendar-year dues (the WA-killer for quilt guilds) |
| 11–12 | Automation triggers (lapse, event ended, form); WA import wizard polish; portal Home = tickets + renew |

Everything else (Zapier directory, store photos, chapters, Council SKU, App Store) waits until a real guild has completed that path without a screenshare.

---

## 7. Simple vs Advanced cheat sheet

| Capability | Simple | Advanced |
|------------|--------|----------|
| Members, levels, events, email, website, payments, team | Yes | Yes |
| Store, invoices, forms builder, automations, blog, forum, photos, documents, reports | Hidden | Yes |
| SMS, chapters, API, Zapier, QBO | Hidden | Yes |
| 6–8 starter kits | Yes | Yes |
| Full kit library (~90) | “More designs” | Full grid |
| Palettes / fonts / patterns | Hidden behind Customize | Open |
| Recurrence, volunteers, waitlist, 20 questions | Optional extras on an event | First-class |
| Household, calendar-year | When built: Simple (it’s a dues concept) | — |
| JSON / HTML / cents / bps | Never | Escape hatch only, then delete |

---

## 8. Evidence (where this came from)

| Area | Paths |
|------|--------|
| Admin nav (22 items, ungrouped) | `public/admin.html` lines 115–144 |
| No feature flags; plan = member cap only | `src/lib/plans.ts`; no `settings.ui` |
| Onboarding; `team_invited` → `#settings` | `src/lib/onboarding.ts` |
| Cents / BPS / JSON / HTML editors | `public/admin.html` events, store, invoices, automations, forms, blog |
| 19 live section types vs Phase 2’s 33 | `src/lib/site/sections/schema.ts`; `docs/superpowers/plans/2026-09-08-site-sections-imagery-phase2.md` |
| Image variants unused on live site | `src/lib/images.ts` vs `src/routes/site.ts` `imgUrl` |
| Honest “not included” list | `public/docs/features.html` `#not` |
| Pricing vs WA | `docs/competition-wild-apricot-alternatives.md`; Guild $24 in `plans.ts` |
| Parity discipline | `docs/wildapricot-gap-analysis.md`; `docs/superpowers/plans/2026-08-09-wildapricot-master-program.md` |
| Quality / launch bar | `astra.md` (some P0s have since been addressed in code; the *jobs not routes* rule still applies) |

---

## 9. Bottom line

QuiltHosting can be the **easiest** membership site for quilt guilds **and** the **broadest**, but only if those are two layers of one product.

The cheapest honest version of that is: **Simple mode this month, public-site quality next, household/calendar-year dues after that.** Feature count in the default sidebar is how Wild Apricot lost volunteer goodwill. Do not copy that mistake with a better price.
