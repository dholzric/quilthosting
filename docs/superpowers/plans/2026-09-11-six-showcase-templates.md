# Six Showcase Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six new, purpose-built showcase templates whose complete desktop and mobile page systems are visibly distinct.

**Architecture:** Extend the existing typed composition model with six showcase recipes and keep the shared SSR renderer, section schema, data loaders, image routing, and interaction hooks. Each new kit owns audience-specific pages and original media; composition CSS changes the shell, opener, section rhythm, image treatment, secondary pages, and footer. Renderer-generated artifacts and browser checks gate promotion into the featured Showcase collection.

**Tech Stack:** TypeScript, Hono, Zod, JSON site kits, semantic CSS, vanilla JavaScript, Vitest, Wrangler, existing gallery tooling, and Playwright for rendered browser evidence.

**Spec:** `docs/superpowers/specs/2026-09-11-six-showcase-templates-design.md`

## Global Constraints

- Add exactly these IDs: `quilt-biennial`, `common-thread-review`, `patchwork-social`, `atelier-noir`, `fieldstone-retreat`, `heirloom-house`.
- Keep all existing kit IDs and stored tenant pages readable and unchanged.
- Guild IDs are the first three; business IDs are the last three.
- Reuse the SSR renderer, design tokens, tenant scoping, sanitization, preview contract, and transaction hooks.
- Explicit section style and variant choices override composition defaults.
- Missing media must produce a designed text opening, never an empty tall hero.
- All content exists without JavaScript; keyboard focus follows DOM order; reduced motion shows final states.
- Generated imagery is identified as sample artwork and never represented as real client work, people, venues, or testimonials.
- A design cannot pass through palette, font, name, or hero-image differences alone.
- Review at 1440, 768, 390, and 320 pixels with no document overflow, clipped focus, broken local image, or new console error.
- Do not deploy a template into Showcase until its family verdict is PASS.

---

### Task 1: Define showcase composition identities and catalogue state

**Files:**
- Modify: `src/lib/site/signature.ts`
- Modify: `src/lib/site/design/tokens.ts`
- Modify: `src/lib/site/kits/catalog.ts`
- Test: `src/lib/site/signature.test.ts`
- Test: `src/lib/site/kits/catalog.test.ts`

**Interfaces:**
- Produces: six new `CompositionId` values matching the new kit IDs' art directions.
- Produces: `collection: "showcase" | "featured" | "specialist" | "legacy"` and deterministic showcase ordering.

- [ ] **Step 1: Write failing identity tests**

```ts
expect(resolveComposition(undefined, "quilt-biennial")).toBe("biennial");
expect(resolveComposition(undefined, "common-thread-review")).toBe("review");
expect(resolveComposition(undefined, "patchwork-social")).toBe("social");
expect(resolveComposition(undefined, "atelier-noir")).toBe("noir");
expect(resolveComposition(undefined, "fieldstone-retreat")).toBe("fieldstone");
expect(resolveComposition(undefined, "heirloom-house")).toBe("heirloom");
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npx vitest run src/lib/site/signature.test.ts src/lib/site/kits/catalog.test.ts`

Expected: failures for unknown composition values and missing showcase IDs.

- [ ] **Step 3: Extend the typed model and catalogue**

Add the six composition values to `COMPOSITION_IDS`, `SiteDesign.composition`, and `siteDesignSchema`. Add explicit kit mappings. Extend `KitCollection` with `showcase`; order the six new IDs before the current featured set while retaining every existing catalogue entry.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run src/lib/site/signature.test.ts src/lib/site/kits/catalog.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/site/signature.ts src/lib/site/signature.test.ts src/lib/site/design/tokens.ts src/lib/site/kits/catalog.ts src/lib/site/kits/catalog.test.ts
git commit -m "feat: define six showcase compositions"
```

### Task 2: Add Wave One kit documents

**Files:**
- Create: `src/lib/site/kits/quilt-biennial.json`
- Create: `src/lib/site/kits/common-thread-review.json`
- Create: `src/lib/site/kits/atelier-noir.json`
- Modify: `src/lib/site/kits/index.ts`
- Test: `src/lib/site/kits/schema.test.ts`

**Interfaces:**
- Consumes: composition IDs from Task 1.
- Produces: three registered, audience-specific `Kit` records with complete page systems.

- [ ] **Step 1: Add failing registry expectations**

```ts
for (const id of ["quilt-biennial", "common-thread-review", "atelier-noir"]) {
  expect(kitById(id), id).not.toBeNull();
}
expect(kitById("quilt-biennial")?.audience).toBe("guild");
expect(kitById("common-thread-review")?.audience).toBe("guild");
expect(kitById("atelier-noir")?.audience).toBe("business");
```

- [ ] **Step 2: Run the kit test and confirm RED**

Run: `npx vitest run src/lib/site/kits/schema.test.ts`

- [ ] **Step 3: Author complete Wave One JSON**

Create the exact page sets from the spec. Use existing specialized sections before adding variants. Quilt Biennial must include show dates, entries, program, visit information, and sponsors; Common Thread Review must include issue metadata, dispatches, gatherings, archive, guild identity, and join path; Atelier Noir must include selected work, commissions, numbered process, studio, and inquiry. Every page uses specific sample copy prefixed according to current kit rules and valid internal links.

- [ ] **Step 4: Register static imports and validate**

Run: `npm run kits:validate -- quilt-biennial common-thread-review atelier-noir`

Expected: all three kits and their pages validate.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/site/kits/index.ts src/lib/site/kits/quilt-biennial.json src/lib/site/kits/common-thread-review.json src/lib/site/kits/atelier-noir.json src/lib/site/kits/schema.test.ts
git commit -m "feat: add first three showcase websites"
```

### Task 3: Generate and integrate Wave One artwork

**Files:**
- Create: `public/kit-assets/quilt-biennial/*`
- Create: `public/kit-assets/common-thread-review/*`
- Create: `public/kit-assets/atelier-noir/*`
- Modify: Wave One kit JSON imagery arrays and section image references
- Test: `src/lib/site/kits/bundledAssets.test.ts`

**Interfaces:**
- Produces: `kit-asset:<kit-id>/<name>.webp` references with 480, 960, and 1600 derivatives.

- [ ] **Step 1: Write missing-asset tests**

Require each Wave One kit to resolve a hero and at least two supporting images at all three widths and require `LICENSE.txt`.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run src/lib/site/kits/bundledAssets.test.ts`

- [ ] **Step 3: Generate coherent image sets**

Use original generation prompts specific to each art direction: contemporary quilt exhibition installation for Biennial; tactile editorial textile studies and worktable details for Review; dramatic high-contrast studio quilts and material closeups for Noir. Do not generate identifiable real people, client claims, signage with fake awards, or testimonial imagery.

- [ ] **Step 4: Export responsive assets and provenance**

Write WebP files at 480, 960, and 1600 widths. Record generation date, tool, no external reference, and sample-only usage in each `LICENSE.txt`. Add useful alt text and crop-compatible image placement to kit JSON.

- [ ] **Step 5: Verify assets**

Run: `npm run photos:check && npx vitest run src/lib/site/kits/bundledAssets.test.ts`

- [ ] **Step 6: Commit**

```powershell
git add public/kit-assets/quilt-biennial public/kit-assets/common-thread-review public/kit-assets/atelier-noir src/lib/site/kits/quilt-biennial.json src/lib/site/kits/common-thread-review.json src/lib/site/kits/atelier-noir.json src/lib/site/kits/bundledAssets.test.ts
git commit -m "feat: add showcase artwork for wave one"
```

### Task 4: Build distinct shell and page-system rendering

**Files:**
- Modify: `src/lib/site/render.ts`
- Modify: `src/lib/site/sections/render.ts`
- Modify: `public/qh-signature.css`
- Modify: `public/qh-signature.js`
- Test: `src/lib/site/render.test.ts`
- Test: `src/lib/site/sections/render.test.ts`
- Test: `src/lib/site/css.test.ts`
- Test: `src/lib/site/islands.test.ts`

**Interfaces:**
- Consumes: the six typed composition IDs.
- Produces: semantic `data-qh-composition`, opener/secondary-page context, and family-specific shell behavior.

- [ ] **Step 1: Write structural renderer tests**

Assert Wave One output exposes semantic context for home versus secondary pages and real-media versus missing-media openings. Assert existing header/navigation hooks and transaction hooks remain present.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npx vitest run src/lib/site/render.test.ts src/lib/site/sections/render.test.ts`

- [ ] **Step 3: Add renderer context**

Emit stable classes or data attributes for home opener, secondary title, section ordinal, and usable hero media. Do not encode arbitrary utility strings in tenant data. Keep source order semantic.

- [ ] **Step 4: Implement Wave One art direction**

Biennial receives the date/venue utility band, compressed masthead, monumental opener, numbered ruled rows, hard-edge gallery, and program footer. Review receives publication masthead, issue line, lead-story grid, dispatch rows, readable long-form measure, archival lists, and colophon footer. Noir receives overlay navigation, full-viewport media opener, project chapters, numbered commission stages, dark portfolio pacing, and quiet inquiry footer.

- [ ] **Step 5: Implement responsive and reduced-motion states**

At 320/390 pixels, preserve each visual language while removing unsafe overlaps. Add final-state reduced-motion rules and keep the menu, lightbox, and preview behavior operational.

- [ ] **Step 6: Test CSS and islands**

Run: `npx vitest run src/lib/site/render.test.ts src/lib/site/sections/render.test.ts src/lib/site/css.test.ts src/lib/site/islands.test.ts`

- [ ] **Step 7: Commit**

```powershell
git add src/lib/site/render.ts src/lib/site/render.test.ts src/lib/site/sections/render.ts src/lib/site/sections/render.test.ts public/qh-signature.css public/qh-signature.js src/lib/site/css.test.ts src/lib/site/islands.test.ts
git commit -m "feat: art direct wave one showcase templates"
```

### Task 5: Render and reject weak Wave One designs

**Files:**
- Modify: `scripts/kits-gallery.mjs`
- Create: `docs/design-review/showcase/wave-one-manifest.json`
- Create: rendered screenshots under `docs/design-review/showcase/wave-one/`
- Create: `docs/design-review/showcase/wave-one-review.md`

**Interfaces:**
- Produces: deterministic visual evidence and PASS/REVISE verdicts.

- [ ] **Step 1: Make gallery dates and composition assets deterministic**

Freeze fixture date, timezone, data order, and asset rewriting. Ensure gallery output copies and links `qh-signature.css` and `qh-signature.js`.

- [ ] **Step 2: Capture all Wave One pages**

Capture first viewport and full page at 1440, 768, 390, and 320. Wait for `document.fonts.ready`, image decoding, and two animation frames. Record revision, fixture, viewport, console errors, failed requests, and overflow measurements.

- [ ] **Step 3: Run neutralized silhouette comparison**

Render the three home pages with identical neutral palette, type pair, copy lengths, and image set. Score all seven axes from the spec and require at least four pairwise differences.

- [ ] **Step 4: Review complete journeys**

Inspect every secondary page, mobile menu, long title, missing hero, empty/populated dynamic section, keyboard focus, 200% zoom, and reduced motion. Mark each design PASS or REVISE with concrete evidence.

- [ ] **Step 5: Revise until all three pass**

Change kit composition, renderer context, and scoped CSS based on recorded defects, then recapture affected artifacts. Do not promote a REVISE design.

- [ ] **Step 6: Commit evidence**

```powershell
git add scripts/kits-gallery.mjs docs/design-review/showcase
git commit -m "test: approve wave one showcase designs"
```

### Task 6: Add Wave Two kits and artwork

**Files:**
- Create: `src/lib/site/kits/patchwork-social.json`
- Create: `src/lib/site/kits/fieldstone-retreat.json`
- Create: `src/lib/site/kits/heirloom-house.json`
- Create: corresponding `public/kit-assets/<kit>/` trees
- Modify: `src/lib/site/kits/index.ts`
- Test: kit schema and bundled asset tests

**Interfaces:**
- Produces: three complete registered kits and responsive sample artwork.

- [ ] **Step 1: Add failing registry and asset expectations**

Assert exact IDs/audiences and hero plus two supporting image sets at 480/960/1600 with provenance files.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npx vitest run src/lib/site/kits/schema.test.ts src/lib/site/kits/bundledAssets.test.ts`

- [ ] **Step 3: Author Wave Two page systems**

Use the exact page sets from the spec. Social emphasizes meetings, events, member work, and joining; Fieldstone emphasizes house, retreats, itinerary, workshops, and planning; Heirloom emphasizes commissions, portfolio, materials, process, and consultation.

- [ ] **Step 4: Generate and document art sets**

Social uses bright tactile group-making still lifes and layered quilt details; Fieldstone uses coherent landscape, house, workroom, and detail imagery; Heirloom uses refined framed quilts, material studies, and calm studio interiors. Export required derivatives and provenance.

- [ ] **Step 5: Register and validate**

Run: `npm run kits:validate -- patchwork-social fieldstone-retreat heirloom-house && npm run photos:check`

- [ ] **Step 6: Commit**

```powershell
git add src/lib/site/kits/index.ts src/lib/site/kits/patchwork-social.json src/lib/site/kits/fieldstone-retreat.json src/lib/site/kits/heirloom-house.json public/kit-assets/patchwork-social public/kit-assets/fieldstone-retreat public/kit-assets/heirloom-house src/lib/site/kits/schema.test.ts src/lib/site/kits/bundledAssets.test.ts
git commit -m "feat: add second showcase wave"
```

### Task 7: Art direct and approve Wave Two

**Files:**
- Modify: renderer and signature assets from Task 4
- Create: `docs/design-review/showcase/wave-two-manifest.json`
- Create: rendered screenshots under `docs/design-review/showcase/wave-two/`
- Create: `docs/design-review/showcase/wave-two-review.md`

**Interfaces:**
- Produces: complete Social, Fieldstone, and Heirloom presentation and PASS/REVISE evidence.

- [ ] **Step 1: Implement three complete visual systems**

Social gets layered image planes, irregular bulletin modules, ticket-like events, bright utility labels, and a community-board footer. Fieldstone gets panoramic opening, floating facts panel, vertical itinerary, room/amenity bands, location treatment, and inquiry footer. Heirloom gets centered formal shell, framed portfolio procession, material details, numbered process, testimonial excerpts, and consultation footer.

- [ ] **Step 2: Add mobile and missing-media compositions**

Reduce Social overlap while preserving varied crops; place Fieldstone facts after its image and verticalize the route; reduce Heirloom framing without losing centered rhythm. Verify designed text-only openings.

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run src/lib/site/render.test.ts src/lib/site/sections/render.test.ts src/lib/site/css.test.ts src/lib/site/islands.test.ts`

- [ ] **Step 4: Capture and review every page/state**

Use the same deterministic procedure and seven-axis neutralized comparison as Task 5. Compare Wave Two against Wave One as well as internally.

- [ ] **Step 5: Revise until PASS and commit**

```powershell
git add src/lib/site/render.ts src/lib/site/sections/render.ts public/qh-signature.css public/qh-signature.js docs/design-review/showcase
git commit -m "feat: art direct and approve wave two"
```

### Task 8: Replace schematic picker cards with rendered Showcase thumbnails

**Files:**
- Create: `public/kit-assets/<showcase-id>/thumbnail.webp` for each new kit
- Modify: `src/lib/site/kits/catalog.ts`
- Modify: `src/routes/tenants.ts`
- Modify: `public/admin.html`
- Test: `src/routes/tenants.test.ts`
- Test: `src/lib/site/editorAssets.test.ts`

**Interfaces:**
- Produces: catalogue `thumbnail` metadata and a Showcase group in the design picker.

- [ ] **Step 1: Write failing API and picker tests**

Assert each Showcase entry returns audience, purpose, family, and renderer-generated thumbnail URL. Assert the picker labels Showcase separately and lazy-loads images.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npx vitest run src/routes/tenants.test.ts src/lib/site/editorAssets.test.ts`

- [ ] **Step 3: Generate thumbnails from approved renders**

Crop from the approved renderer output at one fixed viewport and revision. Store metadata in the visual manifest so thumbnails cannot silently drift from the example preview.

- [ ] **Step 4: Build Showcase picker group**

Render three audience-compatible Showcase cards first with real thumbnails, purpose text, and explicit “Preview example” action. Keep all existing compatible designs behind the existing expansion control.

- [ ] **Step 5: Verify and commit**

```powershell
npx vitest run src/routes/tenants.test.ts src/lib/site/editorAssets.test.ts
git add public/admin.html src/routes/tenants.ts src/routes/tenants.test.ts src/lib/site/kits/catalog.ts src/lib/site/editorAssets.test.ts public/kit-assets/*/thumbnail.webp docs/design-review/showcase
git commit -m "feat: present showcase designs with real previews"
```

### Task 9: Run integrated compatibility and preview safety gates

**Files:**
- Modify tests only when a reproduced integration gap requires coverage.
- Update: `docs/design-review/showcase/acceptance.md`

**Interfaces:**
- Produces: release-candidate evidence covering new and existing templates.

- [ ] **Step 1: Run static and unit gates**

```powershell
npx tsc --noEmit
npm test
npm run kits:validate
npm run photos:check
npm run kits:audit
```

Expected: all pass; audit reports 120 registered and on-disk kits.

- [ ] **Step 2: Verify preview and Apply behavior**

For one customized guild and business, preview draft and published home pages under each compatible Showcase design. Intercept requests and exercise every action control; assert zero POST/PUT/PATCH/DELETE requests in preview. Apply one design and assert page rows, revisions, slugs, navigation, media, and publishing fields remain byte-identical.

- [ ] **Step 3: Smoke all existing designs**

Render all 120 kits at 1440 and 390. Assert HTTP success, one page heading, no local image failure, no console error, and no document overflow.

- [ ] **Step 4: Record byte and visual results**

Measure combined site CSS and JS gzip changes against the pre-showcase revision. Record any justified exception and all six family verdicts in `acceptance.md`.

- [ ] **Step 5: Commit release evidence**

```powershell
git add docs/design-review/showcase/acceptance.md docs/design-review/baseline-audit.json
git commit -m "test: qualify six showcase templates"
```

### Task 10: Push and deploy the approved Showcase release

**Files:**
- Modify version/cache files only if required by current release practice.

**Interfaces:**
- Consumes: six PASS verdicts and green integrated gates.
- Produces: pushed commit and production Worker version.

- [ ] **Step 1: Confirm branch and remote state**

Run: `git fetch origin; git status --short --branch; git rev-list --left-right --count origin/main...main`

Rebase without force if remote advanced; rerun affected checks after resolving overlap.

- [ ] **Step 2: Run final full verification**

Run: `npm test && npx tsc --noEmit && npm run kits:validate && npm run photos:check`

- [ ] **Step 3: Push**

Run: `git push origin main`

- [ ] **Step 4: Deploy**

Run: `npm run deploy`

Record the Worker version and uploaded assets.

- [ ] **Step 5: Verify production picker and previews**

Authenticate to production, confirm each tenant type sees its three Showcase designs, open every example preview, verify thumbnails/assets load, and apply a disposable test design. Record production checks without changing a real customer tenant.

