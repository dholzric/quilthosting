# QuiltHosting site kits — authoring brief for Codex, GLM, and human designers

**Audience:** an AI model or designer producing one or more complete website designs ("kits") for QuiltHosting, a membership + events + website platform for quilt guilds and small quilting businesses (long-arm quilters, quilt shops, teachers). Kits compete with Wild Apricot, whose sites users describe as dated and rigid, and with Squarespace-class templates, which look good but have no membership features.

**What you deliver:** one JSON file per kit under `src/lib/site/kits/<kit-id>.json` (engineers: `docs/KIT-AUTHORING.md` is a pointer back to this file), plus (optional) pattern-free imagery under `public/kit-assets/<kit-id>/` with a license note, plus (optional) new palette proposals. The validator (`npm run kits:validate`) is the gate; the preview (`npm run kits:preview`) renders every page of your kit at desktop and phone widths so a human can judge it.

You do not write HTML, CSS, or JavaScript. A kit is data: a design (palette, type pair, shape, rhythm, header, footer, pattern) plus pages made of sections with real sample copy. The platform renders it.

---

## 1. The bar

A kit passes review when a guild officer who applies it, uploads a logo and one photo, and replaces the sample text has a site that looks like a professional studio built it. Concretely:

- One clear thesis above the fold on the home page: what this guild or business is, when it meets or what it offers, one action.
- Real hierarchy: a hero, then two to four teaser sections that link to deeper pages. Never a dump of every event, level, and product on the home page.
- Rhythm: alternate section backgrounds and widths (none / tint / brand / dark / image / pattern) so the page has a beat. Two identical section styles in a row is a smell.
- Navigation of five to seven items; nested menus for the rest; one call-to-action in the header.
- Typography does the personality work: pick the pair deliberately for the audience; do not default to the platform's own Fraunces/Inter pair.
- Copy is specific to quilters: bees, block of the month, show & tell, charity quilts, retreats, longarm edge-to-edge versus custom, per-square-inch pricing. No lorem ipsum, no "world-class", no exclamation marks.
- Every page reads well on a phone.

## 2. The twelve launch kits (claim one, or propose a thirteenth)

| Kit id | Audience | Character | Pages |
|---|---|---|---|
| `heritage` (reference, done in-house) | traditional guilds | warm paper, serif display, log-cabin band, generous spacing | Home, About & History, Membership, Meetings & Events, Community Projects, Newsletter, Gallery, Contact |
| `modern-guild` | modern quilt guilds | bold sans, high-contrast brand band, flying-geese geometry, tight rhythm | Home, About, Join, Events, Show & Tell, Bees & BOM, Contact |
| `show-festival` | show-centric guilds | photo-led hero, event spotlight first, sponsors strip | Home, The Show, About, Membership, Events, Gallery, Sponsors, Contact |
| `art-quilt` | art quilt groups, fiber collectives | gallery-led, dark ground, large imagery, minimal chrome | Home, Exhibitions, Members' Work, About, Join, Contact |
| `community-threads` | service-minded guilds | projects-led, impact numbers, volunteer calls | Home, Our Projects, Get Involved, Membership, Events, Gallery, Contact |
| `applique-bloom` | traditional and appliqué guilds | soft florals, rounded shapes, light pastel palette | Home, About, Membership, Programs, Gallery, Newsletter, Contact |
| `prairie` | rural and regional guilds | landscape-photo hero, earthy naturals, big friendly type | Home, Meetings, Join, Events, Bees, Library, Contact |
| `minimal` | guilds that want it quiet | white space, one accent, editorial type, no cards | Home, About, Join, Calendar, Contact |
| `one-pager` | small guilds | one home page with anchored sections and a compact sticky menu | Home only (system pages still exist) |
| `longarm-studio` | long-arm quilters | photo hero, services with pricing, portfolio, quote intake, testimonials | Home, Services & Pricing, Portfolio, About, Request a Quote, FAQ |
| `quilt-shop` | shops, classes | hours & location, classes, new arrivals, newsletter | Home, Classes, Services, About, Visit, Contact |
| `pattern-designer` | designers, teachers, retreat leaders | portfolio and shop teaser, workshop calendar, press quotes | Home, Patterns, Workshops, About, Press, Contact |

A proposed kit needs a one-line character statement that is distinguishable from all of the above.

## 3. Kit file format (schema v1, frozen)

```jsonc
{
  "id": "modern-guild",                 // kebab-case, matches the file name
  "name": "Modern Guild",
  "audience": "guild",                  // "guild" | "business" | "both"
  "character": "Bold sans, high-contrast brand band, flying-geese geometry, tight rhythm.",
  "defaults": {
    "palette": "modern-indigo-mustard", // a palette id from §5, or a proposal (see §5)
    "typePair": "manrope",              // a type pair id from §6 (exact ids; e.g. "cormorantgaramond-sourcesans")
    "scale": "comfortable",            // "compact" | "comfortable" | "editorial"
    "shape": { "radius": "sharp", "shadow": "none" },          // radius: sharp|soft|round · shadow: none|subtle|lifted
    "rhythm": { "spacing": "tight", "container": "normal" },   // spacing: tight|normal|airy · container: narrow|normal|wide
    "header": { "variant": "left", "sticky": true, "cta": "join", "overlayHero": false }, // variant: left|centered|split · cta: join|quote|donate|none
    "footer": { "variant": "columns" }, // simple | columns | meeting
    "pattern": { "id": "flying-geese", "opacity": 0.12 }       // none|nine-patch|flying-geese|log-cabin|churn-dash|bear-paw
  },
  "menu": [                             // optional; omit to list pages with nav:true in order
    { "label": "Join", "href": "/membership" },
    { "label": "Events", "href": "/events", "children": [ { "label": "Calendar", "href": "/calendar" } ] }
  ],
  "imagery": [                          // every imageId used below must appear here
    { "id": "hero-main", "kind": "pattern", "alt": "" },
    { "id": "bee-photo", "kind": "photo", "alt": "Four members around a design wall", "src": "public/kit-assets/modern-guild/bee.jpg" }
  ],
  "previewSeed": { "guildName": "Austin Modern Quilt Guild", "city": "Austin, Texas" },
  "pages": [
    {
      "slug": "home", "title": "Home", "nav": false,
      "sections": [ /* see §4 */ ]
    },
    { "slug": "about", "title": "About", "nav": true, "sections": [ /* … */ ] },
    { "slug": "board-minutes", "title": "Board minutes", "nav": false, "membersOnly": true, "sections": [ /* … */ ] }
  ]
}
```

Rules the validator enforces:

- `id` kebab-case and equal to the file name; a page with slug `home` is required; page slugs are kebab-case, unique within the kit, and not reserved (reserved: `membership, join, join-renew, events, calendar, galleries, photos, admin, portal, docs, embed, sites, api, t, public, g, guild, auth, assets, site-access, privacy, terms` — the exact set is `RESERVED_SLUGS` in `src/routes/pages.ts`). The first seven are **system pages** the platform renders itself (membership levels with a working Join, events with registration, calendar, galleries), alongside `/blog` and the member portal `/portal`; your kit links to them, it does not recreate them.
- Every internal link (`ctaHref`, `secondaryHref`, `href`, menu items) that starts with `/` must point at a page in the kit or a system page (`/membership, /join, /events, /calendar, /galleries, /photos, /blog, /portal`). External `https:` links, `mailto:`, and `#anchors` are not checked.
- Navigation: at most seven top-level items (an explicit `menu`, or the pages with `nav: true` when there is no menu); nest the rest as `children`.
- Every section `type` and `variant` exists in §4; every field is the right type; legacy block types (`text`, `heading`, `join_cta`, …) are rejected. Rich text is sanitized the same way the page editor sanitizes it (`p, br, h2–h4, strong, em, ul, ol, li, blockquote, a` and a few more; scripts, styles, and event handlers are removed). Section `id`s, when given, are kebab-case and unique within the page.
- Every `imageId` referenced by a section (`style.imageId`, `image`/`gallery` items) exists in `imagery`; imagery ids are unique; every `photo` has non-empty `alt`, an `src` under `public/kit-assets/<kit-id>/` that exists, and a `LICENSE.txt` next to it naming the source and license (only CC0, CC-BY with attribution text, or your own work). `style.bg: "image"` and `hero` variant `image` require `style.imageId`.
- No "lorem", no "ipsum", no "[placeholder]", no superlatives ("world-class", "premier", …), and no exclamation marks anywhere in copy. Copy may use the placeholders `{{guild_name}}`, `{{city}}`, `{{meeting_info}}`, which the platform substitutes when the kit is applied (HTML-escaped inside `html` fields; when the guild has not supplied a city or meeting schedule they become `your town` and `on the second Tuesday of every month at 6:30 pm`, so write sentences that still read with those values, e.g. `We meet {{meeting_info}}.`).
- Every page carries the sample marker `Sample text — replace me:` at least once, on the copy the officer must replace (as `<em>Sample text — replace me:</em>` at the start of a rich-text paragraph, or as a plain prefix in a subtitle or body field). The onboarding checklist counts pages that still contain it.
- The default palette passes the platform's contrast derivation (the platform nudges colors to pass WCAG AA; if it cannot, the palette is rejected).

## 4. Section catalogue (schema v1)

Every section has `type`, an optional `variant`, an optional `id` (kebab-case, used for one-pager anchors), and an optional `style`:

```jsonc
"style": {
  "bg": "none",        // none | tint | brand | dark | image | pattern
  "width": "normal",   // narrow | normal | wide | full
  "spacing": "normal", // tight | normal | airy
  "align": "left",     // left | center
  "media": "right",    // left | right | top   (for sections with an image)
  "imageId": "hero-main",       // required when bg is "image"; also used by hero/image sections
  "imageFocal": [0.5, 0.4]      // 0..1 horizontal, vertical — where the subject is
}
```

| type | variants | fields | Renders as |
|---|---|---|---|
| `hero` | `image`, `split`, `pattern`, `minimal`, `stats` | `eyebrow?`, `title`, `subtitle?`, `ctaLabel?`, `ctaHref?`, `secondaryLabel?`, `secondaryHref?`, `stats?: [{value,label}]` (stats variant, 3–4 items) | Page opener. `image` = full-bleed photo with scrim (needs `style.imageId`); `split` = text beside image or pattern; `pattern` = quilt-block band; `minimal` = centered type; `stats` = headline plus big numbers |
| `rich_text` | `prose`, `two_column`, `with_image` | `heading?`, `html` | Body copy (≤ 70-character measure). `with_image` uses `style.imageId` and `style.media` |
| `image` | `single`, `full_bleed`, `duo` | `items: [{imageId, alt, caption?}]` (1 or 2) | Photo with optional caption |
| `feature_grid` | `cards`, `icons`, `numbered` | `heading?`, `items: [{icon?, title, body?, href?, price?}]` (3–6 recommended, 12 max; `icon` is an emoji or short glyph, ≤ 8 characters) | Activities, services (with `price`), benefits |
| `faq` | — | `heading?`, `items: [{q, a}]` | Accordion |
| `testimonials` | `grid`, `single` | `items: [{quote, author?}]` | Member or customer quotes |
| `gallery` | `grid`, `masonry` | `source: "manual"` with `items: [{imageId, alt?, caption?}]`, or `source: "gallery"` with `gallerySlug` (uses the guild's real photo galleries) | Photo grid with lightbox |
| `events` | `cards`, `list`, `calendar`, `next_up` | `heading?`, `limit` (1–50; keep it ≤ 12 on a home page) | The guild's real upcoming events; `next_up` shows one |
| `membership_levels` | `cards`, `compact` | `heading?` | The guild's real levels with working Join buttons |
| `join_band` | — | `title`, `body?`, `ctaLabel` | Full-width call-to-action band |
| `meeting_info` | — | `heading?`, `when`, `where`, `address?`, `mapUrl?`, `note?` | When/where block with map link |
| `store_teaser` | — | `heading?`, `limit` | Real products, first N |
| `blog_teaser` | — | `heading?`, `limit` | Latest posts |
| `contact` | — | `heading?`, `formSlug?`, `showDetails` | Contact form plus the guild's details |
| `quote_cta` | — | `projectType`, `heading?`, `submitLabel?` | Business quote/intake form (business kits only) |
| `cta` | — | `label`, `href`, `kind: "primary" \| "secondary"` | Single button |
| `divider` | — | — | Rule |
| `spacer` | — | `height` (8–160 px) | Vertical space |
| `embed` | — | `html` | Allowlisted YouTube/Vimeo/Google Maps iframe only; scripts are removed |
| `timeline` | — | `heading?`, `items: [{year, title, body?}]` | Guild history as a vertical timeline, one entry per year |
| `quote` | — | `quote`, `author?` | One pull quote in large display type |
| `officers` | — | `heading?`, `items: [{name, role, email?, imageId?}]` | People grid: photo (or initials), name, role, email link |
| `benefits` | — | `heading?`, `items: [{title, body?}]` | Checklist of what membership includes |
| `event_spotlight` | — | `eventId?`, `heading?` | One featured event with date, place, price, description and Register; falls back to the next upcoming event |
| `projects` | — | `heading?`, `items: [{title, body?, imageId?, href?, stat?]` | Charity / community project cards with a photo and a headline number |
| `sponsors` | — | `heading?`, `items: [{name, imageId?, href?}]` | Logo strip, grayscale until hover; name text when there is no logo |
| `newsletter_signup` | — | `heading?`, `body?`, `buttonLabel?` | Email signup form posting to `/public/:slug/newsletter` |
| `services` | `cards`, `table` | `heading?`, `items: [{title, body?, price?, unit?}]` | Services with pricing as cards or a comparison table (table scrolls sideways on phones) |
| `portfolio` | `grid`, `featured` | `heading?`, `items: [{imageId?, url?, title?, caption?}]` | Finished work with lightbox; `featured` shows the first piece large |
| `hours_location` | — | `heading?`, `hours: [{day, open}]`, `address?`, `mapUrl?`, `phone?`, `email?`, `note?` | Opening hours plus address, map, phone and email links |
| `process` | — | `heading?`, `items: [{title, body?}]` | Numbered "how it works" steps (the one place numbering is information) |
| `documents` | — | `heading?`, `limit` (1–50) | Members-only shared file list; visitors see a member sign-in prompt |
| `donate` | — | `heading?`, `body?`, `amounts: number[]` (cents, 100–1,000,000, up to 6) | Suggested amounts as working Donate buttons plus "Other amount" |


## 5. Palettes

Use an id from the library, or propose a new one as four hex inputs. The platform derives every role color (background, surface, ink, muted ink, border, primary, on-primary, accent, dark) from these four and nudges them to pass contrast.

| Family | Ids |
|---|---|
| heritage | `heritage-madder`, `heritage-indigo`, `heritage-wheat`, `heritage-walnut` |
| modern | `modern-indigo-mustard`, `modern-charcoal-coral`, `modern-slate-lime` |
| naturals | `naturals-sage`, `naturals-clay`, `naturals-linen`, `naturals-moss` |
| jewel | `jewel-garnet`, `jewel-sapphire`, `jewel-emerald`, `jewel-amethyst` |
| soft | `soft-blush`, `soft-sky`, `soft-lavender`, `soft-butter` |
| seasonal | `seasonal-harvest`, `seasonal-winter`, `seasonal-spring`, `seasonal-summer` |
| dark | `dark-charcoal-gold`, `dark-ink-rose`, `dark-forest-cream` |

Proposal format (add it to `PALETTES` in `src/lib/site/design/palettes.ts` in the same PR — the validator only accepts library ids — and describe it in the PR):

```json
{ "id": "jewel-teal-copper", "name": "Teal & Copper", "family": "jewel", "input": { "brand": "#0f6b6b", "brandAlt": "#134e4a", "accent": "#b87333", "neutral": "#1f2a2a" } }
```

`brand` is the main action color, `brandAlt` a darker companion used for dark bands, `accent` the one highlight, `neutral` the ink family the backgrounds and text are tinted from. Add `"dark": true` for a dark-ground palette.

## 6. Type pairs

`fraunces-inter`, `cormorantgaramond-sourcesans`, `playfair-lato`, `dmserif-dmsans`, `lora-karla`, `librebaskerville-nunitosans`, `manrope`, `spacegrotesk-worksans`, `bitter-opensans`, `newsreader-ibmplexsans`, `nunito`, `system` (exact ids from `src/lib/site/design/typePairs.ts`; the validator rejects anything else). Choose for the audience: a heritage guild reads as serif display; a modern guild as heavy sans; a business as a confident serif over a neutral sans. Never more than the pair (the platform loads exactly two families).

## 7. Page and section guidance from real guild sites

From a survey of guild websites (Dallas, Asheville, Arizona, Piecing Partners, Mississippi Valley) and long-arm businesses: guilds need Home, About/History/Officers, Membership/Join, Events/Calendar/Workshops, Newsletter, Quilt Show, Gallery, Community Projects, Bees/Block of the Month, Resources, Contact, and a members-only area (directory, minutes, library). Businesses need services with pricing, a quote/intake path, portfolio, testimonials, hours and location, and resources for customers (how to prepare a top).

A good home page for a guild: `hero` → `meeting_info` or `join_band` → `events` (limit 3) → one `feature_grid` of activities → `gallery` or `blog_teaser` → `join_band`. A good home page for a long-arm studio: `hero image` → `feature_grid` of services with `price` → `gallery` → `testimonials` → `quote_cta`.

## 8. Imagery

- Prefer the platform's quilt-block **patterns** (`style.bg: "pattern"`, hero `pattern`/`split`) for anything decorative; they are generated in the tenant's own colors and never look like stock.
- Photos: only your own or CC0/CC-BY with attribution; landscape, at least 2000 px on the long side, with a real `alt`. Set `imageFocal` so the subject survives cropping on phones.
- Never bake text into images.

## 9. Deliverable and review

1. `src/lib/site/kits/<id>.json` (+ `public/kit-assets/<id>/` with `LICENSE.txt` if you ship photos), registered in `KITS` in `src/lib/site/kits/index.ts`. The reference kit is `src/lib/site/kits/heritage.json`; copy its shape.
2. Run `npm run kits:validate` → zero issues (it validates every kit file and then runs `vitest run src/lib/site/kits`).
3. Run `npm run kits:preview` → screenshots in `docs/kit-gallery/<id>/` at 1366 and 390 px; include them in the PR. It needs a local Worker and a Playwright install pointed to by `PLAYWRIGHT_PATH` — see the header of `scripts/kits-preview.mjs`.
4. PR description: the kit's one-line character, the audience, any palette proposals, and which phase-2 sections you would add if available.

Review rubric (a kit ships when all are yes): thesis above the fold · rhythm across the page · five-to-seven-item menu with one CTA · phone layout clean at 390 px · copy specific to quilters and free of filler · pair and palette chosen for the audience, not defaults · no two adjacent sections with the same background · every dynamic section (events, levels, gallery) placed where real data will look good and empty states won't embarrass a new guild.
