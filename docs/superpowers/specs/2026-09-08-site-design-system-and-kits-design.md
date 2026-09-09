# Design: professional-grade tenant websites — design system, sections, and site kits

**Date:** 2026-09-08 · **Status:** approved 2026-09-08 with expanded scope (owner: "more color choices and more designs; Codex and GLM can create some") · **Author:** Claude (with competitor research and screenshots of current sites)

## 1. What is wrong today

Evidence: screenshots of `/g/aaqg` (desktop 5,837 px tall, mobile), `/g/amqg`, and the launched business site `stitchstudio.quilthosting.com`; source of `public/guild.html`, `public/qh-site.css`, `src/lib/blocks.ts`, `src/lib/site/render.ts`.

1. **The guild site is a fixed one-column scroll, not a designed page.** `guild.html` hard-codes the home composition: profile card → every membership level → every upcoming event (11 for AAQG) → every store item (15) → donate → blog → and only then the page's own content. Nothing is optional, nothing has hierarchy, and the admin cannot change it. This is the "one page you scroll through" the owner noticed.
2. **No imagery model.** No hero image, no photo treatment, no focal point, no responsive variants; the AAQG logo is served as a raw 250 KB PNG. Sites made of text cards cannot look professional no matter how good the typography is.
3. **Blocks are primitives with one look.** Sixteen block types each render exactly one way inside an 880 px column. There is no section-level style (background, width, spacing, columns, media side), so every page has the same rhythm.
4. **Navigation breaks at scale.** AAQG has 14 top-level links wrapping to three rows on desktop and four on a phone; no nesting, no drawer, no sticky header, no primary call-to-action.
5. **Two renderers, two CSS files, two theme models.** Guilds get a client-rendered shell (`guild.html` + `qh.css`, theme = primary/style/font); businesses get SSR (`render.ts` + `qh-site.css`, theme = 13 raw tokens). Every improvement must be made twice, and guild pages are invisible to search engines and social previews.
6. **Themes are palettes, not designs.** Four presets change colors only. Squarespace's model (5 brand colors → 10 generated section themes, site-wide type pairing, per-section style) is the bar users expect.

Competitor findings that matter (full report in the research agent output; sources are public reviews and the sites themselves):

- Wild Apricot: users describe sites as dated and "very difficult to customize"; themes are rigid and module based; customization needs HTML/CSS. This is the opening.
- ClubExpress / MemberClicks: functional, dated. MembershipWorks punts on the website entirely (bring your own Squarespace). Join It / Springly / Raklet: fast setup, generic templates.
- Squarespace, Framer, Webflow: what reads as professional is a **site-wide style system** (tokens for color roles, type pairing, spacing, radius) applied across a **section library with variants**, on **templates that ship complete with pages, copy, and imagery**.
- Real guild sites (Dallas, Asheville, Arizona, Piecing Partners, Mississippi Valley) converge on: Home, About/History/Officers, Membership/Join, Events/Calendar/Workshops, Newsletter, Quilt Show, Gallery, Community Projects/Charity, Bees/Block of the Month, Resources, Contact, Members-only (directory, minutes, library). Long-arm businesses: services + pricing, quote/intake, portfolio, testimonials, hours/location, resources.

## 2. Goals and non-goals

Goals, in priority order:

1. A guild officer picks a kit, adds a logo, colors and one photo, and has a site that looks designed by a professional in under 20 minutes.
2. Guild and business sites share one rendering, styling, and editing system.
3. Every site is multi-page with a curated home page; a deliberate one-page kit exists for small guilds.
4. Sites are fast (server-rendered, cached at the edge, responsive images) and discoverable (SEO, social cards, sitemap).
5. Existing tenants keep their content and get the new look through a migration that is reversible page by page.

Non-goals: custom CSS/JS from tenants on the app origin (security model unchanged), a page-builder with pixel-level dragging (Wix style), a theme marketplace, dark mode for tenant sites (v2).

## 3. Approaches considered

- **A. Restyle what exists.** Better CSS for `guild.html` and the business renderer. Cheap, but keeps two renderers, the fixed home page, no imagery model, and no section styles. Cannot reach the bar.
- **B. Sections + design system + kits on one SSR renderer (recommended).** Replace "blocks" with styled, variant-bearing sections; add site-wide design tokens; ship complete kits; render guild sites server-side like business sites with small interactive islands. Reuses the draft/preview/publish editor shipped this week. Roughly 4 phases of agent-sized work.
- **C. Adopt an external builder (embed Framer/Webflow exports, or "bring your own site" like MembershipWorks).** Fastest path to pretty, but abandons the integrated join/events/members-only story that is the product's reason to exist.

B is the design below.

## 4. Architecture

### 4.1 One renderer

- `src/lib/site/render.ts` becomes the renderer for every tenant. It gains: header variants, footer with columns, mobile drawer, nested menus, section rendering with style props, responsive image markup, page-type templates (home, content, events index, event detail, membership, galleries, gallery, blog index, post, members-only wrapper).
- Guild routes (`/g/:slug/*` on the platform host, `/` on tenant hosts) are served by `serveSite()` (generalized `serveBusinessSite`) instead of shipping `guild.html`. `guild.html` stays deployable behind a per-tenant flag `settings.site.renderer = "legacy"` during migration and is removed once every tenant is migrated.
- Interactive pieces become **islands** in one small script `public/qh-site.js` (already used for business forms): join/register dialog, cart, donation buttons, calendar grid, gallery lightbox, volunteer sign-up, mobile nav, members-only sign-in redirect. The server renders the static parts (event cards, level cards) so first paint needs no JS.
- Edge cache stays keyed on `page.updated_at : tenant.updated_at : max(pages.updated_at)`; theme changes bump `tenant.updated_at`, so re-themes propagate.

### 4.2 Design tokens (`src/lib/site/theme.ts`, extended)

A theme is no longer 13 colors. It is:

```
palette:   { brand, brandAlt, accent, neutral }        // 4 brand inputs
roles:     derived → bg, surface, surfaceAlt, ink, inkMuted, border, primary, onPrimary,
           accent, onAccent, dark, onDark                 // generated, WCAG-checked
type:      { pair: "fraunces-inter" | "playfair-source" | "dm" | "lora-karla" |
             "cormorant-nunito" | "system", scale: "compact" | "comfortable" | "editorial" }
shape:     { radius: "sharp" | "soft" | "round", shadow: "none" | "subtle" | "lifted" }
rhythm:    { sectionSpacing: "tight" | "normal" | "airy", container: "narrow" | "normal" | "wide" }
header:    { variant: "left" | "centered" | "split", sticky: bool, cta: "join" | "quote" | "none", overlayHero: bool }
footer:    { variant: "simple" | "columns" | "meeting" }
pattern:   { id: "none" | "nine-patch" | "flying-geese" | "log-cabin" | "churn-dash" | "bear-paw", opacity }
```

Role colors are derived from the four inputs (tints/shades in OKLCH) and checked for contrast; the admin never sees "primaryBright".

**Palette library.** The Design panel offers a curated library of at least 24 named palettes (`src/lib/site/palettes.ts`), grouped by family: Heritage (madder, indigo, wheat, walnut), Modern (indigo/mustard, charcoal/coral, slate/lime), Naturals (sage, clay, linen, moss), Jewel (garnet, sapphire, emerald, amethyst), Soft (blush, sky, lavender, butter), Seasonal (harvest, winter, spring, summer), Dark (charcoal/gold, ink/rose, forest/cream). Each is a 4-color input with a preview swatch and the derived roles. Two more ways in: custom (four pickers with live contrast feedback) and **From your logo** (client-side dominant-color extraction from the uploaded logo, offered as three candidate palettes). Any palette works with any kit; kits only choose a default.

**Type pairs.** At least 10 curated pairs with a sample line each: Fraunces/Inter, Cormorant Garamond/Source Sans 3, Playfair Display/Lato, DM Serif Display/DM Sans, Lora/Karla, Libre Baskerville/Nunito Sans, Manrope/Manrope, Space Grotesk/Work Sans, Bitter/Open Sans, Newsreader/IBM Plex Sans, plus a system pair for speed. `buildRootVars()` emits CSS variables; `qh-site.css` is rewritten against roles, type scale, and rhythm. Existing 13-token themes migrate through `themeMigrate.ts` (brand = primary, brandAlt = secondary, accent = gold, neutral from bg/text).

### 4.3 Sections (`src/lib/site/sections/`)

A section replaces a block. Schema:

```
{ type, id, variant?, style?: { bg: "none"|"tint"|"brand"|"dark"|"image"|"pattern", width: "narrow"|"normal"|"wide"|"full",
  spacing: "tight"|"normal"|"airy", align: "left"|"center", media: "left"|"right"|"top" , imageId?, imageFocal?: [x,y] },
  ...content fields }
```

Library (variants in parentheses). Each has a renderer, an editor form, a canvas thumbnail, and a fixture for tests.

| Group | Sections |
|---|---|
| Openers | `hero` (image full-bleed with overlay; split image; pattern band; minimal centered; stat strip) |
| Content | `rich_text` (prose; two-column; with image left/right), `image` (single; full-bleed; duo), `feature_grid` (icons; cards; numbered), `timeline` (guild history), `faq`, `quote` (single pull quote) |
| Membership | `membership_levels` (pricing cards; compact list) with real Join, `join_band` (CTA band), `meeting_info` (when/where + map link), `officers` (people grid), `benefits` |
| Events | `events` (cards; list; calendar; next-up single), `event_spotlight` (one featured event, e.g. the show) |
| Community | `gallery` (grid; masonry; carousel) with lightbox, `projects` (charity/community cards), `sponsors` (logo strip), `testimonials`, `newsletter_signup`, `blog_teaser` |
| Business | `services` (cards with price; comparison table), `portfolio`, `quote_cta` (intake), `hours_location` (hours + map + directions), `process` (how it works steps) |
| Utility | `contact` (form + details), `documents` (members-only file list), `store_teaser`, `donate`, `divider`, `spacer`, `embed` (allowlisted iframes; unchanged) |

Old block types map 1:1 onto sections with default style (`heading` → `rich_text`, `html` → `embed` or `rich_text`, `join_cta` → `join_band`, `service_cards` → `services`, `gallery_grid` → `gallery`, `events_list` → `events`, `store_list` → `store_teaser`, `contact_form` → `contact`, `project_intake` → `quote_cta`). `parseBlocks` keeps accepting the old shapes forever (the sanitizer and validation stay).

### 4.4 System pages

Membership, events (index/detail/calendar), galleries, blog, members-only and the join/checkout flows are **rendered by the same section system** using fixed section stacks the kit defines, so they match the site instead of looking like the admin.

### 4.5 Imagery

- Upload pipeline in the admin: resize on the client (canvas) to 2400/1200/600 px WebP + JPEG fallback, upload the variants to R2 under one file id, store `{ width, height, variants[], focal }` on the `files` row. Serve via `/public/:slug/img/:id?w=` selecting the nearest stored variant; long immutable cache. No dependency on Cloudflare image resizing (unavailable on the free zone plan).
- Focal-point picker in the editor (click the subject) so crops stay on the quilt, not the wall.
- **Pattern art**: parametric SVG quilt blocks (nine-patch, flying geese, log cabin, churn dash, bear paw) generated from the theme roles, used for hero bands, dividers, and empty-state imagery. License-free, unique to the platform, on-brand for the audience.
- Placeholder photos in kits are clearly labelled sample imagery and are replaced by the officer's first upload prompt in onboarding.

### 4.6 Site kits

A kit is data (`src/lib/site/kits/*.ts`): theme, header/footer, pages with section stacks and sample copy, nav, and sample imagery ids. Kits separate **look** (theme + section variants + header/footer) from **content** (page text, images), so "Change design" swaps the look and keeps every word.

**Kits are an authoring format, not hand-written code.** `src/lib/site/kits/schema.ts` (zod) defines a kit as JSON: `{ id, name, audience: "guild"|"business"|"both", character (one line), defaults: { palette, typePair, shape, rhythm, header, footer, pattern }, pages: [{ slug, title, nav, sections: [...section JSON with sample copy...] }], menu, imagery: [{ id, kind: "pattern"|"photo", ... }], previewSeed }`. Tooling: `npm run kits:validate` (schema, every section type/variant exists, every referenced image exists, copy contains no lorem, contrast passes), `npm run kits:preview` (renders every page of every kit with the real renderer at desktop and phone widths via Playwright into `docs/kit-gallery/`), and a **kit gallery** in the admin (Website → Design → Browse designs) with live previews. `docs/KIT-AUTHORING.md` is the brief we hand to Codex, GLM, or a human designer: the schema, the section catalogue with every variant and field, the palette and type-pair ids, the copy rules (real guild vocabulary, no lorem, no superlatives), and the acceptance checks. Contributed kits land as a JSON file plus gallery screenshots; the validator is the gate.

Launch set (twelve; more as contributions land):

| Kit | Audience | Character | Pages |
|---|---|---|---|
| Heritage | traditional guilds | warm paper, serif display, log-cabin pattern band, generous spacing | Home, About & History, Membership, Meetings & Events, Community Projects, Newsletter, Gallery, Contact |
| Modern Guild | modern quilt guilds | bold sans, high-contrast brand band, flying-geese geometry, tight rhythm | Home, About, Join, Events, Show & Tell, Bees & BOM, Contact |
| Show & Festival | show-centric guilds | photo-led hero, event spotlight first, sponsors strip, countdown | Home, The Show (enter/vendors/volunteer), About, Membership, Events, Gallery, Sponsors, Contact |
| Art Quilt | art quilt groups, fiber collectives | gallery-led, dark ground, large imagery, minimal chrome | Home, Exhibitions, Members' Work, About, Join, Contact |
| Community Threads | service-minded guilds | projects-led (charity quilts, NICU, veterans), impact numbers, volunteer calls | Home, Our Projects, Get Involved, Membership, Events, Gallery, Contact |
| Applique & Bloom | traditional and appliqué guilds | soft florals, rounded shapes, light pastel palette | Home, About, Membership, Programs, Gallery, Newsletter, Contact |
| Prairie | rural and regional guilds | landscape photo hero, earthy naturals, big friendly type | Home, Meetings, Join, Events, Bees, Library, Contact |
| Minimal | guilds that want it quiet | white space, one accent, editorial type, no cards | Home, About, Join, Calendar, Contact |
| One-Pager | small guilds | single home page with anchored sections and a compact sticky nav | Home (anchors), plus system pages |
| Longarm Studio | long-arm quilters | photo hero, services with pricing, portfolio, quote intake, testimonials | Home, Services & Pricing, Portfolio, About, Request a Quote, FAQ |
| Quilt Shop | shops, classes | hours & location, classes (events), new arrivals, newsletter | Home, Classes, Services, About, Visit, Contact |
| Pattern Designer / Teacher | designers, retreat leaders | portfolio and shop teaser, workshop calendar, press quotes | Home, Patterns, Workshops, About, Press, Contact |

Kit picker appears in guild creation (replacing the fixed starter site) and under Website → Design → "Browse designs". The onboarding checklist gains "Add your first photo" and "Pick your colors".

### 4.7 Navigation

- Nested menus (one level) with a page picker; mobile drawer; sticky header option; primary CTA (Join / Request a quote / Donate) in the header; member sign-in moves to the footer/utility row.
- Nav is generated from pages with `show_in_nav` unless the owner has arranged a menu; the menu editor already exists.

### 4.8 Editor changes (builds on this week's editor)

- Section picker with visual thumbnails grouped as above; per-section **Style** tab (variant, background, width, spacing, media side, image + focal point).
- **Design** panel: kit, four brand colors with generated preview, type pair, shape, rhythm, header/footer variants, pattern; live canvas and full preview.
- Canvas renders the real SSR output with the real CSS (already true via `POST /preview`), so what the officer sees is the site.
- Inline text editing on the canvas for headings/paragraphs (click to edit) — phase 3.

### 4.9 Performance and SEO

- Targets: mobile LCP ≤ 2.5 s, CLS ≤ 0.1, no layout-blocking JS, HTML ≤ 60 KB, hero image ≤ 200 KB at 1200 px.
- Per page: title/description, OpenGraph/Twitter card with the hero or logo, canonical, JSON-LD (Organization/Event/LocalBusiness), sitemap, `robots` honoring the stealth gate until launch.
- Fonts: two families max via Google Fonts with `display=swap` and preconnect; system pair for the "fast" option.

## 5. Migration

1. Ship the renderer with the legacy flag on for existing guilds; new guilds get kits.
2. "Try the new design" in Website → Design converts a guild: blocks → sections, theme → new tokens (migration helper), home page composed from the old home order (hero from profile, membership_levels, events, blog_teaser, page content) so nothing disappears. Reversible for 30 days.
3. Business tenants migrate automatically (their pages are already sections with default style).
4. Remove `guild.html` when all tenants are converted.

## 6. Testing and acceptance

- Unit: theme derivation and contrast (every generated role pair passes AA), section renderers (fixture → HTML snapshot, sanitized), block→section migration, kit integrity (every kit page parses; every referenced sample image exists).
- Browser (Playwright, as used this week): each kit renders home, membership, events, gallery, and contact on desktop and phone with no console errors and no horizontal overflow; Join/Register/Cart work on SSR pages; lighthouse mobile performance ≥ 90 on the Heritage home page.
- Product gate (from the readiness review): five volunteer admins build a branded five-page site in ≤ 20 minutes with no JSON/HTML; ≥ 4 of 5 rate the result "looks professional".

## 7. Phases

1. **Foundation (renderer, tokens, formats):** unified SSR for guilds behind the flag; token model with palette library, type pairs, derivation and migration; rewritten `qh-site.css`; header/footer variants; mobile nav; islands for join, register, cart, calendar, lightbox; system page templates; **section schema and kit schema frozen**; `kits:validate`, `kits:preview`, and `docs/KIT-AUTHORING.md`, so kit authoring by Codex, GLM, or humans can start while phase 2 is underway. Existing content renders at least as well as today.
2. **Sections + imagery:** section library with variants and style props, upload pipeline with variants and focal point, pattern art, section thumbnails, Style tab in the editor, palette-from-logo.
3. **Kits + Design panel:** the twelve launch kits (the first three authored in-house as the reference; the rest may come through the authoring pipeline), kit gallery with live previews, Design panel, onboarding steps, "Try the new design" migration for existing guilds.
4. **Polish + gate:** inline editing, SEO and social cards, performance budgets verified, usability test with real officers, removal of `guild.html`.

Each phase is one implementation plan and one deploy; phases 1 and 2 overlap (renderer versus section library) once the section schema is frozen at the start of phase 1.

## 8. Decisions

- Owner asked for more ambition on 2026-09-08: at least twelve kits and a palette library of 24+ palettes, with Codex and GLM invited to author kits through the authoring pipeline. Adopted above.
- Sample imagery: pattern art plus QuiltMap-owned quilt photography; no licensed stock.
- One-pager ships as a kit.


## Implementation notes

**Phase 1 shipped 2026-09-08 as v0.57.0-preview** (plan: `docs/superpowers/plans/2026-09-08-site-foundation-phase1.md`). One SSR renderer for guilds and businesses behind the legacy flag (migration 0026 stamps existing guilds `legacy`); token model with 26 palettes, 12 type pairs, contrast-checked derivation and migration from both old theme shapes; token-driven stylesheet with header/footer variants, drawer, and quilt-block pattern art; 19-section library with variants and style props; batched data loaders; system pages; islands for join/register/cart/donate/calendar/lightbox/volunteer; kit schema + validator + preview tooling + authoring brief; twelve kits on disk (Heritage authored in-house; the rest contributed through the authoring pipeline and validated, copy not yet reviewed); admin Design panel and renderer switch; pages API and editor accept section documents. New guilds are seeded from the Heritage kit on the new renderer. Evidence: 1502 unit tests, local browser pass on desktop and phone for five kits (no console errors, no horizontal overflow), editor round-trip on a kit page. Residual: phase 2 items (image upload variants/focal picker, Style tab polish, palette-from-logo, remaining sections), kit copy review for contributed kits, guild.html retirement after migration.

**Phase 2 shipped 2026-09-08 as v0.58.0-preview** (plan: `docs/superpowers/plans/2026-09-08-site-sections-imagery-phase2.md`). Section library completed to 33 types (timeline, quote, officers, benefits, event spotlight, projects, sponsors, newsletter signup, services, portfolio, hours and location, process, documents, donate) with a newsletter signup route and table (migration 0027). Imagery: stored WebP/JPEG variants at 480/960/1600/2400 with focal point and alt text (migration 0028), width-negotiated serving on both image routes, and `srcset`/`sizes`/`object-position`/intrinsic size on every uploaded image; the hero scrim is now its own layer so photo heroes stay legible. Editor: browser-side resize and variant upload with progress, focal-point picker with crop previews, a Style tab, section thumbnails for all 33 types, palette-from-logo, and the upgrade/downgrade controls. Existing guilds can move to the new renderer and back losslessly (`/site/upgrade`, `/site/downgrade`, snapshots as `pre_upgrade` revisions). SSR parity with the classic shell: event calendar links (ICS and Google), volunteer sign-up, public member directory, donate page, full sitemap including system paths and blog posts, Organization and Event JSON-LD. 92 kits contributed through the authoring pipeline, all passing the validator, with a copy review and gallery screenshots for the guild kits. Evidence: 2013 unit tests, typecheck clean, local end-to-end pass (variant upload, width negotiation, focal crop, published hero, upgrade/downgrade round trip, newsletter, 404) and a desktop/phone browser pass with no console errors or horizontal overflow. Residual: phase 3 (inline canvas editing, performance budget in CI, accessibility pass, retiring `guild.html`) plus the product items in `GLMUpgrades.md` and `CodexRecommendations.md`.