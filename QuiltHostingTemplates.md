# QuiltHosting site kits — authoring brief for Codex, GLM, and human designers

**Audience:** an AI model or designer producing one or more complete website designs ("kits") for QuiltHosting, a membership + events + website platform for quilt guilds and small quilting businesses (long-arm quilters, quilt shops, teachers). Kits compete with Wild Apricot, whose sites users describe as dated and rigid, and with Squarespace-class templates, which look good but have no membership features.

**What you deliver:** one JSON file per kit under `src/lib/site/kits/<kit-id>.json`, plus (optional) pattern-free imagery under `public/kit-assets/<kit-id>/` with a license note, plus (optional) new palette proposals. The validator (`npm run kits:validate`) is the gate; the preview (`npm run kits:preview`) renders every page of your kit at desktop and phone widths so a human can judge it.

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
    "typePair": "manrope",              // a type pair id from §6
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

- `id` unique; page slugs unique within the kit and not reserved (`home` is allowed and means the home page; reserved: `membership, join, join-renew, events, calendar, galleries, photos, portal, admin, api, docs, embed, auth, site-access, privacy, terms, g, guild, assets, t, public, sites, u, img, blog`). Those reserved paths are **system pages** the platform renders itself (membership levels with a working Join, events with registration, calendar, galleries, blog); your kit links to them, it does not recreate them.
- Every section `type` and `variant` exists in §4; every field is the right type; rich text contains only the allowed HTML tags (`p, br, h2, h3, h4, strong, em, ul, ol, li, blockquote, a`).
- Every `imageId` referenced by a section exists in `imagery`; every `photo` has an `src` file present and a `LICENSE.txt` next to it naming the source and license (only CC0, CC-BY with attribution text, or your own work).
- No "lorem", no "ipsum", no "[placeholder]"; copy may use placeholders `{{guild_name}}`, `{{city}}`, `{{meeting_info}}`, which the platform substitutes.
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
| `feature_grid` | `cards`, `icons`, `numbered` | `heading?`, `items: [{icon?, title, body?, href?, price?}]` (3–6) | Activities, services (with `price`), benefits |
| `faq` | — | `heading?`, `items: [{q, a}]` | Accordion |
| `testimonials` | `grid`, `single` | `items: [{quote, author?}]` | Member or customer quotes |
| `gallery` | `grid`, `masonry` | `source: "manual"` with `items: [{imageId, alt?, caption?}]`, or `source: "gallery"` with `gallerySlug` (uses the guild's real photo galleries) | Photo grid with lightbox |
| `events` | `cards`, `list`, `calendar`, `next_up` | `heading?`, `limit` (1–12) | The guild's real upcoming events; `next_up` shows one |
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

Coming in phase 2 (do not use yet; note in your PR if your kit wants them): `timeline`, `quote`, `officers`, `benefits`, `event_spotlight`, `projects`, `sponsors`, `newsletter_signup`, `services` table variant, `portfolio`, `hours_location`, `process`, `documents`, `donate`.

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

Proposal format (put it in your PR description and set `defaults.palette` to the new id):

```json
{ "id": "jewel-teal-copper", "name": "Teal & Copper", "family": "jewel", "input": { "brand": "#0f6b6b", "brandAlt": "#134e4a", "accent": "#b87333", "neutral": "#1f2a2a" } }
```

`brand` is the main action color, `brandAlt` a darker companion used for dark bands, `accent` the one highlight, `neutral` the ink family the backgrounds and text are tinted from. Add `"dark": true` for a dark-ground palette.

## 6. Type pairs

`fraunces-inter`, `cormorant-source`, `playfair-lato`, `dmserif-dmsans`, `lora-karla`, `baskerville-nunito`, `manrope`, `spacegrotesk-work`, `bitter-opensans`, `newsreader-plex`, `system`. Choose for the audience: a heritage guild reads as serif display; a modern guild as heavy sans; a business as a confident serif over a neutral sans. Never more than the pair (the platform loads exactly two families).

## 7. Page and section guidance from real guild sites

From a survey of guild websites (Dallas, Asheville, Arizona, Piecing Partners, Mississippi Valley) and long-arm businesses: guilds need Home, About/History/Officers, Membership/Join, Events/Calendar/Workshops, Newsletter, Quilt Show, Gallery, Community Projects, Bees/Block of the Month, Resources, Contact, and a members-only area (directory, minutes, library). Businesses need services with pricing, a quote/intake path, portfolio, testimonials, hours and location, and resources for customers (how to prepare a top).

A good home page for a guild: `hero` → `meeting_info` or `join_band` → `events` (limit 3) → one `feature_grid` of activities → `gallery` or `blog_teaser` → `join_band`. A good home page for a long-arm studio: `hero image` → `feature_grid` of services with `price` → `gallery` → `testimonials` → `quote_cta`.

## 8. Imagery

- Prefer the platform's quilt-block **patterns** (`style.bg: "pattern"`, hero `pattern`/`split`) for anything decorative; they are generated in the tenant's own colors and never look like stock.
- Photos: only your own or CC0/CC-BY with attribution; landscape, at least 2000 px on the long side, with a real `alt`. Set `imageFocal` so the subject survives cropping on phones.
- Never bake text into images.

## 9. Deliverable and review

1. `src/lib/site/kits/<id>.json` (+ `public/kit-assets/<id>/` with `LICENSE.txt` if you ship photos).
2. Run `npm run kits:validate` → zero issues.
3. Run `npm run kits:preview` → screenshots in `docs/kit-gallery/<id>/`; include them in the PR.
4. PR description: the kit's one-line character, the audience, any palette proposals, and which phase-2 sections you would add if available.

Review rubric (a kit ships when all are yes): thesis above the fold · rhythm across the page · five-to-seven-item menu with one CTA · phone layout clean at 390 px · copy specific to quilters and free of filler · pair and palette chosen for the audience, not defaults · no two adjacent sections with the same background · every dynamic section (events, levels, gallery) placed where real data will look good and empty states won't embarrass a new guild.
