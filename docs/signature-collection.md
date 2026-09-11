# The signature collection

Twelve starter kits that ship their own artwork rather than drawing on the shared stock-photo pool. Each was composed around one original illustration, with its own audience, voice, navigation, page sequence, conversion path, palette, and typography.

## Provenance and licence

The artwork is **original AI-generated illustration created for QuiltHosting** using the built-in OpenAI image generation tool on 2026-09-10. No third-party photograph or reference image was supplied. Each `public/kit-assets/<kit>/LICENSE.txt` carries the asset-level notice.

Do not present these illustrations as photographs of a real place, quilt, or client work. They are starting points, and each kit tells the owner to replace the artwork with photographs of their guild, work, or property before launch.

## The collection

| Kit | Audience | Design thesis | Palette · type |
|---|---|---|---|
| Linen Journal | Guild | Editorial oatmeal-and-ink journal with an heirloom star quilt | `signature-oat-ink` · `newsreader-ibmplexsans` |
| Color Assembly | Guild | Vermilion manifesto, oversized geometry, and direct sans typography | `signature-vermilion` · `spacegrotesk-worksans` |
| Indigo House | Guild or business | Midnight luxury, tactile stitching, and a considered commission path | `signature-midnight` · `cormorantgaramond-sourcesans` |
| Weekend House | Guild or business | Warm farmhouse hospitality and an unhurried retreat enquiry path | `signature-terracotta` · `dmserif-dmsans` |
| Paper Pieces | Guild or business | Mulberry-and-parchment EPP salon built around close looking and portable handwork | `signature-mulberry-paper` · `newsreader-ibmplexsans` |
| Blackbird Studio | Guild or business | Severe black-and-bone gallery design with one acid-yellow line | `signature-blackbird` · `spacegrotesk-worksans` |
| Blue Ridge Circle | Guild or business | Expansive mountain tradition in indigo, cream, and porch-light warmth | `signature-ridge-blue` · `librebaskerville-nunitosans` |
| Sunroom Society | Guild or business | Bright social sewing in tangerine, raspberry, lilac, and sky | `signature-sunroom` · `manrope` |
| Redwork Archive | Guild or business | Scholarly ivory-and-red textile documentation with museum restraint | `signature-redwork` · `cormorantgaramond-sourcesans` |
| Quilt Show Edition | Guild or business | Exhibition-scale ultramarine, scarlet, and marigold for shows and entries | `signature-exhibition` · `spacegrotesk-worksans` |
| Mending Circle | Guild or business | Humane service-guild design centered on useful work and many ways to help | `signature-mending` · `bitter-opensans` |
| Pattern House | Guild or business | Exacting graphic studio balancing portfolio, workshops, and patterns | `signature-pattern-house` · `dmserif-dmsans` |

Each artwork ships as responsive WebP files at 480, 960, and 1600 pixels. The kit JSON holds `public/kit-assets/<kit>/hero.webp`; `resolveKitImagery` rewrites it to a safe `kit-asset:<kit>/hero.webp` reference, and `kitAssetUrl` selects the appropriate public file for the rendered width.

## Verification

`docs/kit-gallery/signature-checks.json` records the render check for every page at 1440 and 390 pixels: HTTP 200, no horizontal overflow, no broken images, one page heading, and a clean browser console. Representative screenshots live in `docs/kit-gallery/<kit>/`.

The image source files, licence notice, responsive variants, public routing, path safety, social image URL, and tenant-page rendering are covered by the site and kit test suites.
