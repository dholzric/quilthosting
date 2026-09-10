# The signature collection

Four starter kits that ship their own artwork rather than drawing on the
shared stock photography in `src/lib/site/photos.ts`. Every other kit picks
its imagery from that pool or from generated quilt-block patterns; these four
were built around a single piece of illustration each, and their palettes were
composed to match that image.

## Provenance and licence

The artwork is **original AI-generated illustration created for QuiltHosting**
using the built-in OpenAI image generation tool, on 2026-09-10. No third-party
photograph was used as an input, so there is no photographer to credit and no
stock licence to honour. Each directory under `public/kit-assets/` carries a
`LICENSE.txt` saying the same thing, and those files point back here.

Two constraints follow from what these images are:

- **Do not present them as photographs of a real place, a real quilt, or real
  client work.** They are illustration, and a starter template that implies
  otherwise puts the guild using it in an awkward position.
- **They are starting points.** A guild that keeps the artwork indefinitely is
  showing a picture of somebody else's studio. The onboarding guidance should
  push owners to replace the hero with their own photograph early.

## The four kits

### Linen Journal (`linen-journal`)

An editorial quilt journal in oatmeal and ink: literary headlines, quiet rules, generous margins, and a tactile heirloom star quilt.

- **Audience:** guild
- **Palette:** `signature-oat-ink` · **Type pair:** `newsreader-ibmplexsans`
- **Artwork:** `public/kit-assets/linen-journal/hero.webp` (plus `-960` and `-480`), referenced from the kit as `kit-asset:linen-journal/hero.webp`
- **Sizes:** 480 / 960 / 1600 px — 31 kB, 106 kB, 209 kB
- **Alt text:** An oatmeal, ink and ochre star quilt draped over an oak worktable in a sunlit studio

### Color Assembly (`color-assembly`)

A contemporary quilt collective with vermilion, cobalt, oversized geometric cloth, bold sans typography, and a manifesto-led home page.

- **Audience:** guild
- **Palette:** `signature-vermilion` · **Type pair:** `spacegrotesk-worksans`
- **Artwork:** `public/kit-assets/color-assembly/hero.webp` (plus `-960` and `-480`), referenced from the kit as `kit-asset:color-assembly/hero.webp`
- **Sizes:** 480 / 960 / 1600 px — 19 kB, 71 kB, 149 kB
- **Alt text:** A contemporary quilt of red, cobalt, butter yellow and pink geometric blocks on a gallery wall

### Indigo House (`indigo-house`)

A quiet luxury quilting atelier: midnight blue, ivory typography, immersive stitch photography, and a considered commission journey.

- **Audience:** business
- **Palette:** `signature-midnight` · **Type pair:** `cormorantgaramond-sourcesans`
- **Artwork:** `public/kit-assets/indigo-house/hero.webp` (plus `-960` and `-480`), referenced from the kit as `kit-asset:indigo-house/hero.webp`
- **Sizes:** 480 / 960 / 1600 px — 31 kB, 104 kB, 220 kB
- **Alt text:** Indigo and ivory patchwork with fine white running stitches, folded on a dark wooden workbench

### Weekend House (`weekend-house`)

A farmhouse quilt retreat with warm terracotta, generous photographic spaces, scalloped edges, and an unhurried invitation to sew and stay.

- **Audience:** business
- **Palette:** `signature-terracotta` · **Type pair:** `dmserif-dmsans`
- **Artwork:** `public/kit-assets/weekend-house/hero.webp` (plus `-960` and `-480`), referenced from the kit as `kit-asset:weekend-house/hero.webp`
- **Sizes:** 480 / 960 / 1600 px — 37 kB, 121 kB, 241 kB
- **Alt text:** A sunlit farmhouse sewing room with a communal oak table and terracotta and sage patchwork quilt

## How the artwork is wired

The kit JSON references the file by repository path (`public/kit-assets/<kit>/hero.webp`).
`resolveKitImagery` in `src/lib/site/kits/apply.ts` rewrites that to a
`kit-asset:<kit>/<file>` reference when a site is seeded, and
`kitAssetUrl` in `src/lib/site/kitAssets.ts` turns the reference into a URL,
picking the 480 or 960 variant when the renderer asks for a narrow width.

Two things have to stay true for the images to appear, and each has a test:

- The files must be **in the repository**. `src/lib/site/kits/bundledAssets.test.ts`
  fails if a kit references artwork that is not committed, alongside its
  `LICENSE.txt`. This is not hypothetical: the kits were once committed
  without the artwork, which passed locally only because the files were
  sitting untracked in a working tree.
- `/kit-assets/*` must be **routed to the asset binding, not to the site
  router**. On a tenant host the site router sees the whole origin, so a path
  it does not recognise comes back as the site's own 404 *page* — a broken
  image on the hero of a brand-new guild, with nothing in the console to say
  why. `src/lib/site/rendererAssets.test.ts` walks every kit's artwork at all
  four widths the renderer can request and asserts `resolveSiteRoute` hands
  each one back.

## Verification

`docs/kit-gallery/signature-checks.json` records the last render check: every
page of all four kits at 1440 px and 390 px, asserting HTTP 200, no horizontal
overflow, no broken images, headings present and a clean console. Regenerate
the gallery with `npm run kits:gallery -- --build`, serve it, and re-run the
check against `http://127.0.0.1:8791/sites/<kit>/<page>.html`.

Screenshots of each page at both widths live in `docs/kit-gallery/<kit>/`.
