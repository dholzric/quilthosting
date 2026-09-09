# Kit contributor notes — GLM agent contribution (2026-09-08)

Notes accompanying the ten kits authored by the GLM agent, plus a design review
of the full set and two palette proposals. Companion to `docs/KIT-AUTHORING.md`.

## What was contributed

Ten kit JSON files under `src/lib/site/kits/`, all registered in
`src/lib/site/kits/index.ts` and all validating with zero issues under
`npm run kits:validate`. Nine of the ten use palettes no other kit used, so
the set stays visually distinct across the whole gallery.

| Kit | Audience | Character (one line) | Palette · pair |
|---|---|---|---|
| `retreat-house` | business | Barn-wood hospitality: schedule-led, sleep-and-sew practical, generous type for a house full of quilters. | heritage-walnut · fraunces-inter |
| `virtual-guild` | guild | An online-first guild: bold sans, screen-friendly rhythm, members who meet on video and swap by mail. | modern-slate-lime · spacegrotesk-worksans |
| `quilt-museum` | both | Quiet institutional serif: collection-led, visiting information up front, supporter levels instead of guild dues. | heritage-indigo · newsreader-ibmplexsans |
| `memory-quilts` | business | Soft palettes and rounded corners for keepsake work: quilts sewn from the clothes you cannot sort alone. | soft-lavender · lora-karla |
| `barn-quilt-trail` | both | Barn quilts, back roads, and a map worth driving: golden prairie palette, big friendly signage type. | heritage-wheat · librebaskerville-nunitosans |
| `young-stitchers` | guild | Bright, sturdy, and forgiving: a club for ages 8 to 18 where pins are optional and finished beats perfect. | soft-butter · nunito |
| `state-association` | guild | An umbrella organization: steady governance voice for a state's chapters, the spring gathering, and teaching grants. | naturals-moss · bitter-opensans |
| `slow-stitch-studio` | business | Sashiko, whole cloth, and big-stitch hand quilting, taught slowly and sold as kits, in sage and cream. | naturals-sage · dmserif-dmsans |
| `market-quilter` | business | A weekend-market maker: bright, clear, and stocked, with booth dates and custom slots front and center. | soft-sky · manrope |
| `quilt-appraiser` | business | Certified appraisal and gentle restoration in quiet garnet serif: written values, honest condition reports. | jewel-garnet · cormorantgaramond-sourcesans |

Design decisions worth defending:

- **Distinct audiences, no overlaps.** Each kit serves a niche the launch set
  does not: online guilds, museums/study centers, keepsake studios, quilt
  trails, youth clubs, state umbrella organizations, handwork ateliers,
  market vendors, and appraisers. None competes with `heritage`,
  `longarm-studio`, `quilt-shop`, or the rest.
- **`fraunces-inter` on retreat-house is a deliberate choice, not a default.**
  Every other pair in the library was claimed; Fraunces is the right warm
  literary serif for a bed-and-breakfast-style brand.
- **Every kit has one header CTA** (guilds `join`, businesses `quote`), and
  every business kit names its intake page slug `request-a-quote` so the
  renderer's CTA resolution finds it (see the longarm-studio fix below).
- **No stock photos anywhere.** Decorative imagery is the platform's
  pattern art (`hero-art`, kind `photo` never used), so there are no
  licensing files to manage; real photos arrive through the galleries that
  tenants upload.

## Review findings across the full set

1. **Fixed — `longarm-studio` dead header CTA.** With `defaults.header.cta:
   "quote"`, the renderer resolves the CTA to a menu item whose href is
   `/request-a-quote` (see `renderSitePage` in `src/lib/site/render.ts`) and
   falls back to `/contact` otherwise. The kit had neither: the page slug was
   `quote` and there was no contact page, so "Request a quote" 404'd on five of
   six pages. Fixed by renaming the slug to `request-a-quote` (title/nav
   unchanged) and updating the three internal links. Business kits that use the
   `quote` CTA should either name the intake page `request-a-quote` or ship a
   `contact` page.
2. **Intentional, left as-is — `quilt-shop` and `pattern-designer` set
   `header.cta: "none"`.** The rubric prefers one header CTA, but the only
   available labels are Join / Request a quote / Donate; neither a fabric shop
   nor a pattern shop has an honest use for them. A phase-2 "custom label CTA"
   (label + href) would close this gap.
3. **Minor — `community-threads` and `show-festival` gallery pages have two
   sections each** (hero + gallery + a short note reads thin against the 3–6
   section guideline). One more block (faq, testimonials, or a rich_text) would
   give both pages a proper close.
4. **`one-pager` home carries eight anchored sections.** This is the point of
   the kit (anchors are its navigation) and reads fine; flagged only so
   reviewers do not count it against the 3–6 guideline.

Everything else in the set passes: no two adjacent sections share a background
in any kit; every home opens with a hero; all internal hrefs resolve to kit
pages or system paths; copy is quilter-specific with no filler, lorem, or
exclamation marks.

## Palette proposals (per §5 of the authoring brief)

```json
{ "id": "heritage-feedsack", "name": "Feed Sack", "family": "heritage", "input": { "brand": "#4a6b8a", "brandAlt": "#2c4358", "accent": "#c25b4e", "neutral": "#3a382f" } }
{ "id": "dark-slate-copper", "name": "Slate & Copper", "family": "dark", "input": { "brand": "#e8b48f", "brandAlt": "#26323a", "accent": "#c87941", "neutral": "#1f262b" }, "dark": true }
```

- **Feed Sack** — faded chambray, madder red, warm gray-cream: 1930s feed-sack
  prints. A softer alternative to `heritage-madder` for traditional guilds.
- **Slate & Copper** — warm copper on deep slate for art-quilt groups and fiber
  collectives that want a dark ground less rose-toned than `dark-ink-rose`.

## Phase-2 sections these kits would adopt

- `retreat-house`: `hours_location` (check-in and directions), `process`
  ("how a retreat weekend runs" as steps), `documents` (packing list, use
  agreement, floor plan for booked groups).
- `quilt-museum`: `donate` (the benefit auction and conservation adoption),
  `sponsors` for the annual funders strip.
- `virtual-guild`: `newsletter_signup` on the home page and `event_spotlight`
  for the annual retreat weekend.
- `barn-quilt-trail`: `donate` for the paint fund and `projects` for the
  season's route builds.
- `young-stitchers`: `benefits` ("what members learn" as a proper grid) and
  `newsletter_signup` for parents.
- `state-association`: `sponsors` for gathering vendors, `donate` for the
  grant fund, `documents` for bylaws and charter forms.
