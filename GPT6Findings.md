# GPT-6 findings — site design system review

Captured 2026-09-09, verbatim from GPT-6's review of the repository. Kept
alongside `GLMUpgrades.md` and `CodexRecommendations.md` as input to the next
design phase. Not yet acted on.

## What it read

The site is a data-driven SSR platform:

- One renderer: `src/lib/site/render.ts`
- Sections defined in `src/lib/site/sections/schema.ts`
- One shared stylesheet: `public/qh-site.css`
- Kits are JSON files registered in `src/lib/site/kits/index.ts`
- The builder supports draft, preview, publish, revisions, and section editing.

## The main finding: structural sameness

There are 92 kits, but they mostly change copy, palette, fonts, and section
order:

- `hero → contact → meeting_info`: 72 occurrences
- `hero → rich_text → testimonials`: 58 occurrences
- `hero:minimal`: 453 occurrences
- Most sections use the same limited controls: background, width, spacing,
  alignment, and media side.

The current system has design tokens, but not enough composition-level
variation. It lacks overlapping blocks, asymmetric grids, alternate hero
proportions, editorial layouts, image mosaics, visual dividers, framed
content, pullout panels, and distinct navigation/footer systems.

## On Tailwind

Tailwind is not currently installed. GPT-6 would not make Tailwind the first
fix. It could help organize a future component system or the admin builder,
but adding it alone will not make the templates more distinctive. The stronger
path:

1. Expand the section schema with real layout recipes and visual variants.
2. Add several renderer-level compositions that use the existing design tokens.
3. Let each kit select a small number of composition recipes.
4. Use Tailwind only if we decide to move toward a component-based frontend
   build pipeline.

## Other issues

- None of the 92 kits has a real photo asset. The gallery explicitly uses
  pattern-only imagery, so photo-led templates are not being visually
  validated.
- The 92-kit library has become a content permutation library rather than 92
  clearly distinct designs.
- The authoring brief (`QuiltHostingTemplates.md`) still describes 12 launch
  kits, while the repository now contains 92. The selection and maintenance
  model needs consolidation.
- Kit registration is manually maintained with a large import/list in
  `src/lib/site/kits/index.ts`, which will become error-prone as the library
  grows.
- The public builder documentation appears stale: `public/docs/website-builder.html:219`
  still describes older guild "Look & feel" controls and older business
  presets, while the code now centers on kits, palettes, type pairs, and
  section designs.
- The generated gallery proves rendering consistency, but not real-world
  visual quality, because it lacks representative imagery and tenant content.

## Its recommendation

The next design phase should focus on creating perhaps 6–10 genuinely
different visual systems first, then expressing those systems through kits.
GPT-6 will be much more useful once those composition primitives and visual
boundaries are defined.

## Notes from Claude (2026-09-09)

- Agreed on the diagnosis, and it is the same axis as the "page tone" work
  shipped in v0.62.0: that fixed colour sameness (every light palette derived
  a near-white page); this is the structural equivalent, one level up.
- The stale `public/docs/website-builder.html` is real and now also predates
  the v0.61.0 removal of the classic renderer.
- The uncommitted `src/routes/site.ts` change GPT-6 saw was work in progress
  on the events nav link; it shipped in v0.63.0.
