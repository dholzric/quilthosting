# Template Design Remediation Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute these tasks with review checkpoints. Checkboxes track implementation; this document does not claim those tasks are complete.

**Author:** Codex · **Date:** 2026-09-11 · **Status:** Proposed implementation plan requested by the owner.

**Goal:** Make QuiltHosting's templates visually distinct, accurately previewable, practical to personalize, and reliable across public pages and the editor.

**Architecture:** Keep the shared server renderer, design tokens, section documents, and interactive islands. Complete the new signature compositions, make their selection explicit and editable, and consolidate previews around the same page/design inputs as production. Organize the existing kit library into curated visual families while retaining every installed kit and tenant's content.

**Tech stack:** Cloudflare Workers, Hono, TypeScript, Zod, D1/R2/KV, existing CSS and vanilla JavaScript; Vitest and a reproducible Playwright browser harness. Evaluate compiled Tailwind utilities in a bounded comparison before adopting them.

**Spec:** The design decisions below are the proposed extension to [the September 8 design-system spec](../specs/2026-09-08-site-design-system-and-kits-design.md). Read this plan with [QuiltHostingTemplates.md](../../../QuiltHostingTemplates.md), [GPT6Findings.md](../../../GPT6Findings.md), and [the signature collection](../../signature-collection.md). Historical documents describe earlier states; the refreshed inventory below takes precedence for this work.

## 1. Baseline and scope

The September 9 scan found 92 kits, no photo imagery entries, and 16 section types used. The September 11 checkout has **114 kits, 663 authored pages, 82 imagery entries classified as `photo`, and 24 section types used**. These are source-inventory counts, not counts of unique photographs or browser-verified pages. Some bundled imagery is AI-generated illustration, as its LICENSE files explicitly state.

At the resumed scan, package version is `0.74.4-preview`, HEAD is `108df30`, and active uncommitted work includes `public/qh-site.css`, `public/qh-site.js`, `public/sw.js`, `src/lib/site/render.ts`, `src/routes/tenants.ts`, and a new `src/lib/site/signature.ts`. Recheck before execution; another worker is editing this area. Do not overwrite, revert, or assume ownership of these changes.

The earlier 416 passing kit tests and successful typecheck were September 9 results. They are not current release evidence. Neither scan performed a comprehensive live browser audit. Task 1 establishes that evidence.

| Finding | Current evidence / status | Planned response |
|---|---|---|
| Kits were structurally repetitive | Earlier counts establish repetition; new signature kits and six composition families now exist | Validate and finish six families; curate library; add only necessary variants |
| No starter photography | Superseded: local assets, stock references, and 82 photo-classified entries now exist | Verify image resolution, responsive sizing, provenance, personalization, and failures |
| Too much reliance on basic sections | Improved from 16 to 24 used types out of 33 | Use existing specialized sections before adding new schemas |
| Preview can differ from application | Design preview renders a selected kit's sample home; Apply changes settings while retaining stored sections | Separate sample preview from actual-site preview; share rendering inputs |
| Composition is implicit in kit identity | Working `signature.ts` maps kit IDs to cinema/destination/poster/collage/journal/salon | Add a typed composition setting with compatibility fallback |
| Library selection is overwhelming | Existing Design panel iterates usable kits; thumbnails share miniature markup | Curated families, real thumbnails, audience/use-case filters |
| Registry is manually maintained | Static imports and KITS array | Coverage/order validation first; generation only if drift remains costly |
| Documentation is stale | Public builder guide still describes older appearance controls | Update after UI contracts are finalized |
| Preview/gallery coverage is limited | Gallery generates authored pages; system links are not full transaction coverage | Deterministic fixtures plus Worker/browser checks |
| Source-based editor tests dominate some coverage | `editorAssets.test.ts` checks function names and source substrings | Add behavioral browser tests for affected user jobs |

Already shipped cache invalidation, event navigation, timezone, and logo-upload fixes should be regression-tested when relevant, not scheduled as new implementation. Older security/payment findings from `astra.md` are outside this design plan unless a current reproduction shows that a design path still fails.

## 2. Proposed design decisions

### Preserve the working product foundation

One renderer remains an advantage: membership, events, galleries, forms, and authored pages share styling and behavior. The problem is the set of compositions and their application, not the existence of a shared renderer. Keep stable section IDs, existing content fields, sanitization, tenant scoping, and draft/revision contracts.

There are three distinct operations:

1. **Preview this example:** render a kit's sample pages, labelled as an example.
2. **Apply appearance to my site:** preserve content, section order, URLs, menu, images, and publishing state; change only the selected appearance settings. Preview the actual page before applying.
3. **Add a starter page:** copy a selected kit page into a new unpublished draft with a collision-safe slug. Existing pages remain untouched. Full-site replacement is not part of this release.

The appearance operation may alter visual layout within a section through a composition family. It does not import the kit's page stack. Explain that distinction in ordinary product language.

### Build on the six signature families already underway

| Family | Existing representative | Required visual identity | Secondary-page treatment |
|---|---|---|---|
| Cinema | `indigo-house` | Immersive image, low-set title, restrained rules | Compact title and readable prose; avoid repeating viewport-height heroes everywhere |
| Destination | `weekend-house` | Panoramic setting and inset information panel | Dates, practical visit details, directions, booking/quote path |
| Poster | `color-assembly` | Oversized type, strong grid, wide imagery | Ruled information rows, clear event/date hierarchy |
| Collage | `paper-pieces` | Offset frames, varied image scale, controlled asymmetry | Calm text sections; remove decorative offsets on narrow screens |
| Journal | `linen-journal` | Editorial columns, image/caption hierarchy, article rows | Readable long-form pages and chronological event/news layouts |
| Salon | `modern-heirloom` | Centered invitation, framed images, generous whitespace | Restrained services, portfolio, membership and contact layouts |

Keep `minimal` as a quiet reference and `heritage` as a compatibility reference. Begin with three deliberately different representatives (Cinema, Poster, Journal), then finish the other three. The release target is six reviewed families, not another large increase in kit count.

Acceptance for distinctness: in a comparison using the same neutral palette, font pair, sample copy, and photos, each family must differ from every other on at least three visible axes: hero geometry, navigation arrangement, image treatment, content grid, section rhythm, or footer structure. Record the comparison and a human verdict. This is a visual review criterion, not a claim that a numeric similarity metric proves quality.

### Tailwind decision

**Recommendation:** Preserve existing semantic CSS and tokens; compare Tailwind CLI utilities against scoped plain CSS for two new compositions before deciding. Tailwind can compile classes found in TypeScript templates into a static stylesheet, so React, Next.js, and a new frontend framework are unnecessary. [Official CLI documentation](https://tailwindcss.com/docs/installation/tailwind-cli).

The comparison must use identical DOM, assets, breakpoints, and visual goals. Adopt Tailwind only if it improves authoring/review enough to justify a build dependency while passing the same editor, browser, and size gates. Otherwise use the plain-CSS implementation and record the decision. Do not install several UI kits: additional component defaults would introduce another appearance system to reconcile.

If Tailwind is selected:

- Compile it during development/build/CI; never use a production browser compiler or CDN runtime.
- Scan explicit source paths for complete class strings. Store recipe names in tenant data, not arbitrary utility classes. Use literal class maps for variants; interpolated fragments can evade detection. [Source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files).
- Prefix generated utilities and omit Preflight in the coexistence build. Test cascade precedence against the existing unlayered CSS rather than assuming utilities override it. [Preflight](https://tailwindcss.com/docs/preflight), [utility prefixes](https://tailwindcss.com/docs/styling-with-utility-classes).
- Feed colors and type through the existing `--qh-*` roles. Utility defaults must not bypass tenant colors or the contrast derivation.
- Check the documented browser requirements against the chosen product support matrix before adoption. [Compatibility](https://tailwindcss.com/docs/compatibility).

## 3. Global constraints

- Existing kit IDs and stored sections remain readable. No blanket page regeneration, tenant migration, or removal of older kits.
- Keep one SSR renderer and the current `data-join`, `data-register`, cart, donate, calendar, lightbox, and form hooks.
- Existing phase-one schema fields retain their meanings. New options are additive, default to compatibility behavior, and are documented as an extension.
- Explicit section overrides take priority over family defaults. Missing media never yields an empty viewport-height hero.
- Preview is read-only: no checkout, registration, subscription, email, or publishing requests from a preview interaction.
- Preserve role checks and revision/conflict handling. Public pages never expose members-only content through alternate preview paths.
- Retain stealth/site-gate behavior. A private preview deployment is not a public launch.
- Use built-in browser motion sparingly; content and focus remain usable with JavaScript disabled and reduced motion enabled.
- Preserve image provenance and sample labels. Generated images must not be presented as real client quilts, officers, properties, or testimonials.
- Content/control contrast, focus visibility, 200% zoom, and keyboard operation are judged on rendered pages, not merely token calculations.
- Implementation may proceed in parallel along the lanes below, but shared renderer, schema, CSS, and admin edits need one integrator.

## 4. File responsibilities

Existing paths listed below are integration points. Proposed new paths are labelled; do not create duplicate modules if current work has already supplied an equivalent.

| Area | Paths | Responsibility |
|---|---|---|
| Composition model | `src/lib/site/signature.ts` (in progress); proposed `src/lib/site/design/compositions.ts`; `design/tokens.ts`, `design/migrate.ts` | Typed families, defaults, compatibility mapping |
| Rendering | `src/lib/site/render.ts`, `sections/render.ts`, `sections/schema.ts`, `sections/fixtures.ts`, `pages/system.ts` | Layout resolution, actual page rendering, safe variants |
| Site styling | `public/qh-site.css`, `public/qh-site.js`; optional proposed `src/styles/site-utilities.css` | Composition styles, motion, optional compiled utilities |
| Previews | `src/routes/tenants.ts`, `src/routes/pages.ts`; proposed `src/lib/site/preview.ts` | Shared read-only preview construction |
| Builder | `public/admin.html`, `public/qh-site-builder.js`, `public/qh.css`; proposed `public/qh-design-picker.js` | Family picker, thumbnails, preview mode, starter-page action |
| Imagery | `src/lib/site/kitAssets.ts`, `photos.ts`, `src/lib/images.ts`, `kits/apply.ts`, `src/routes/site.ts`, `public/kit-assets/` | Resolve bundled, external and uploaded media consistently |
| Kit organization | `src/lib/site/kits/index.ts`, `schema.ts`, individual JSON files; proposed `src/lib/site/kits/catalog.ts` | Curated family/audience metadata and registry coverage |
| Quality tooling | `scripts/kits-gallery.mjs`, `scripts/kits-preview.mjs`, `scripts/photos-check.mjs`; proposed `scripts/kits-audit.mjs`, `scripts/kits-browser.mjs` | Inventory, deterministic previews, browser checks |
| Documentation | `QuiltHostingTemplates.md`, `docs/signature-collection.md`, `docs/website-builder.md`, `public/docs/website-builder.html`, `docs/README.md`, `CLAUDE.md` | Accurate authoring and customer instructions |

## 5. Work packages

### Task 1 — Establish a reproducible baseline (P0)

**Files:** Create `scripts/kits-audit.mjs`; extend existing gallery/preview scripts only as necessary; create `docs/design-review/baseline.md` and generated audit JSON beside it.

**Steps**

- [ ] Record HEAD, dirty paths, package version and asset timestamps. Coordinate with the current signature work before editing shared files.
- [ ] Add an inventory command reporting registered/on-disk kit IDs, page counts, section/variant use, homepage sequences, family metadata, imagery-reference types, and duplicate normalized compositions. Report home and secondary-page repetition separately.
- [ ] Inventory the 22 newer kits separately from the original 92 so improvements are measurable. Do not equate `kind: photo` with unique photography.
- [ ] Capture desktop (1440), tablet (768), phone (390), and narrow-phone (320) views of the six representatives plus Heritage and Minimal. Include full page and first viewport; wait for images/fonts before capture.
- [ ] Use a disposable local Worker/D1 environment for actual-site comparisons. Inspect `kits-preview.mjs` first: it replaces local `kit-*` tenants. Never point its seed/replacement operations at remote D1.
- [ ] Run current kit validation and typecheck. Record failures with exact commands; do not call the September 9 checks current.

**Verification:** `npm run kits:validate`, `npx tsc --noEmit`, proposed `node scripts/kits-audit.mjs`. The report explicitly distinguishes source inspection, browser evidence, and unresolved checks. Screenshots contain source revision and fixture identity in their manifest.

**Exit:** Reproducible baseline and a short, prioritized defect list; no guessed production failures.

### Task 2 — Make preview and Apply agree (P0)

**Files:** Modify `src/routes/tenants.ts`, `src/routes/pages.ts`, `public/admin.html`, `src/lib/site/render.ts`; create `src/lib/site/preview.ts` and `preview.test.ts`; extend tenant/page route tests and browser coverage.

**Proposed request contract:** `POST /api/tenants/:id/design-preview` with `{ mode: "example" | "current", kitId, pageId?, source: "published" | "draft", design }`. Validate `design` with the existing design schema. `current` requires a page belonging to this tenant; `example` uses a registered, audience-compatible kit. Retain the GET endpoint as a compatibility wrapper until all callers move.

- [ ] Add route tests for unauthorized/cross-tenant page access, bad kit/appearance input, draft selection, and zero writes during preview.
- [ ] Factor the page/design/identity/menu assembly used for current-site preview so it matches production rendering. Reuse current data loaders, image metadata, host/link rules, explicit menus, timezone and branding. Do not approximate them with kit defaults.
- [ ] Render custom colors and unsaved header/footer/shape settings from the validated request. Currently palette/type query parameters cannot represent the entire unsaved appearance.
- [ ] Show **Example website** and **Your current page** as distinct preview modes. Apply appearance opens the latter by default. If no page exists, explain that state and offer starter-page creation.
- [ ] Add a trusted preview flag to the renderer/island boot path. Keep navigation drawer, FAQ, and lightbox usable; disable action submissions and external checkout in previews. Browser tests must intercept network and assert no mutation request occurred when buttons are clicked.
- [ ] On Apply, preserve content columns, sections/order/IDs, page revisions, publishing state, menu, uploaded media and unrelated settings. Save only intended appearance values; surface failed saves rather than leaving the UI looking applied.
- [ ] Keep a last-successful appearance snapshot for an explicit Undo action during the session. Before undoing, compare current saved settings with the result of this Apply; reject stale undo instead of overwriting another officer's changes.

**Example regression intent:** A tenant homepage containing a single custom rich-text section previews that same section in Journal, and remains that section after Apply; it never silently becomes Journal's sample homepage. Assert both rendered content and persisted page rows.

**Verification:** Focused preview/route tests; browser round-trip on a customized guild and business; check response `no-store` and `noindex`; compare draft/preview/published screenshots using identical saved inputs.

**Exit:** What Apply promises matches what it changes, and preview cannot trigger a real transaction.

### Task 3 — Complete the composition model and styling choice (P1)

**Files:** Integrate `signature.ts`; create `design/compositions.ts` and tests; modify `design/tokens.ts`, `design/migrate.ts`, `kits/apply.ts`, `render.ts`, `sections/render.ts`, `public/qh-site.css`; optional CSS build files/package scripts only after comparison.

**Proposed interface:**

```ts
export const COMPOSITION_IDS = [
  "classic", "cinema", "destination", "poster", "collage", "journal", "salon"
] as const;
export type CompositionId = typeof COMPOSITION_IDS[number];
// Extend SiteDesign additively: composition?: CompositionId.
export function resolveComposition(
  explicit: CompositionId | undefined,
  installedKitId: unknown
): CompositionId;
// Precedence: explicit setting -> existing signature mapping -> classic.
```

- [ ] Test precedence before changing the renderer. An explicitly chosen `classic` must win over a signature kit; missing composition must preserve current mapping behavior.
- [ ] Keep composition optional when reading old settings. Do not default it to `classic` during parsing before resolving the installed-kit fallback.
- [ ] Make kit defaults and appearance responses carry the explicit choice for new saves. Moving away from a hardcoded kit lookup must not make an installed signature site lose its style.
- [ ] Move family-specific CSS into clearly grouped, scoped rules. Preserve `data-qh-composition` and semantic classes so the current implementation can be incorporated incrementally.
- [ ] Mark eligible opening heroes deliberately in the renderer. Restrict immersive styling to a home opener with actual usable media. Test text-only heroes, removed images, moved sections, long titles and secondary pages.
- [ ] Give explicit section variant/style overrides precedence. A family may set defaults; it must not make the editor's chosen media side or compact spacing a silent no-op.
- [ ] Run the Tailwind/plain-CSS comparison for Cinema and Journal. Record edit surface, compiled/gzipped bytes, cascade conflicts, clean-build reproducibility, supported browsers and editor parity in `docs/design-review/styling-decision.md`.
- [ ] If adopted, use `tailwindcss` and `@tailwindcss/cli` as pinned dev dependencies, literal prefixed utilities, explicit source detection, no Preflight, and tokens for dynamic values. Add a `css:build` script invoked before dev packaging, galleries, CI and deployment. Otherwise retain scoped CSS and avoid creating an unused build pipeline.

**Contract test example:**

```ts
expect(resolveComposition(undefined, "indigo-house")).toBe("cinema");
expect(resolveComposition("journal", "indigo-house")).toBe("journal");
expect(resolveComposition("classic", "indigo-house")).toBe("classic");
expect(resolveComposition(undefined, "unknown-kit")).toBe("classic");
```

**Exit:** Families are explicit, predictable, backwards-compatible, and independent of palette changes. The styling decision is backed by a working comparison rather than framework preference.

### Task 4 — Validate and finish media integration (P1; parallel with Tasks 2–3)

**Files:** Modify `kitAssets.ts`, `photos.ts`, `kits/apply.ts`, `sections/render.ts`, `src/routes/site.ts`, gallery/preview scripts and `kits/bundledAssets.test.ts`; update relevant `public/kit-assets/<kit>/LICENSE.txt` and collection documentation.

- [ ] Trace each supported reference (`pattern:`, `photo:`, `kit-asset:`, tenant file ID) through kit application, editor save/reload, gallery, design preview, platform path and custom-domain rendering.
- [ ] Reuse current bundled-asset routing; do not introduce an unnecessary upload/import pipeline. Verify exact allowed paths, unknown IDs, traversal rejection and image MIME types.
- [ ] For each local image, verify original plus available 480/960 variants, width/height, alt/caption, focal behavior and responsive URL resolution. `srcset` entries must name actual variants, not repeat an original URL at different widths.
- [ ] Audit all 82 photo-classified entries. Separate generated illustration, owned photography, and external stock in the report. Deduplicate by source/content hash for asset budgeting.
- [ ] Keep explicit replacement prompts in the editor/onboarding. Real testimonials, people and portfolios must not be inferred from generic sample imagery. Respect current source-specific license/provenance records; reconcile the older no-stock decision with the implementation rather than silently claiming it is still followed.
- [ ] Test missing local assets, unavailable external hosts, deleted uploads and a tenant with no photos. Keep headings/actions usable and provide a restrained fallback.
- [ ] Add real product/gallery fixture images so store and gallery sections are reviewed as they will appear, not as empty tiles.

**Verification:** `npm run photos:check` plus bundled asset/renderer tests; browser network inspection on a 390px viewport and DPR 1/2. Network-based stock checks are separate from deterministic offline CI, with failures reported as external-source failures.

**Exit:** Representative pages have no broken images; imagery survives round-trips and has documented provenance. No remaining issue is described merely as “add photos.”

### Task 5 — Finish six coherent website families (P1)

**Files:** Modify the six representative kit JSONs, composition styles, approved section variants, and `docs/signature-collection.md`; create `docs/design-review/families.md` with screenshot links and verdicts.

- [ ] Build a cross-family comparison using the same content/palette/images. Review Cinema, Poster and Journal first; record concrete changes needed to satisfy distinctness.
- [ ] Design a whole user journey for each family: home, content/about, contact, plus membership/events for guilds or services/portfolio/quote for businesses. Do not approve a family based only on a hero image.
- [ ] Use existing `services`, `portfolio`, `process`, `hours_location`, `projects`, `event_spotlight`, `officers`, `sponsors`, `newsletter_signup` and `documents` where the audience calls for them. Verify actual schema support before authoring; several remain unused despite existing renderers.
- [ ] Add new variants only for demonstrated gaps. Initial candidates are `feature_grid:editorial`, `gallery:mosaic`, and `hero:inset`; each must ship with schema, renderer, editor catalogue/thumbnail, fixture, responsive styles and validation in the same change. Avoid a universal nested layout builder.
- [ ] Make header/footer treatments match the family and its primary action. Reuse existing left/centered/split and simple/columns/meeting options before adding new shell variants.
- [ ] Check system membership, event detail/calendar, galleries and blog pages under all six appearances. Preserve working actions, data/date hierarchy, member visibility, empty states and mobile navigation.
- [ ] Complete Destination, Collage and Salon using the same evidence gates. Revisit the first three after shared style changes.
- [ ] For each family record PASS/REVISE, desktop/mobile artifacts, content requirements, image-replacement behavior, and remaining defects. Keep unreviewed families out of the curated set.

**Exit:** Six complete, distinguishable websites pass the visual rubric and core user journeys. Legacy kits still render. No need to add more kit names to satisfy this task.

### Task 6 — Curate the library and remove registry drift (P1)

**Files:** Create `src/lib/site/kits/catalog.ts` and `catalog.test.ts`; modify `kits/index.ts`, `scripts/kits-validate.mjs`, `src/routes/tenants.ts`, `public/admin.html`; optionally extract only picker code into `public/qh-design-picker.js`.

**Metadata proposal:**

```ts
type KitCatalogEntry = {
  id: string;
  family: "classic" | "cinema" | "destination" | "poster" | "collage" | "journal" | "salon";
  collection: "featured" | "specialist" | "legacy";
  order: number;
  useCases: string[];
};
```

- [ ] Curate 6–10 reviewed recommendations, with the remainder available under All designs and use-case filters. Installed kits stay available even when outside Featured.
- [ ] Represent each family once in the default browsing experience; let users explore variations within it. Support guild/business/both compatibility, use case, search and remembered selection.
- [ ] Replace shared miniature drawings with generated thumbnails of actual kit homepages. Capture from the same renderer and fixture as the full example preview; include kit/content/style revision in thumbnail metadata.
- [ ] Lazy-load thumbnails and only open a live full-page preview for the selected card. Avoid fetching every font family or opening 114 live preview frames on the first screen.
- [ ] Add exact set-equality tests: disk JSON IDs = registered KITS IDs = catalog IDs. Validate unique IDs, allowed family, audience compatibility, deterministic ordering and assets for Featured entries.
- [ ] Retain static imports if those tests solve the maintenance problem. If generation is needed, add `kits:registry --check` and a deterministic generated module that CI verifies. Never runtime-scan the filesystem in Workers.

**Verification:** Unknown/unregistered kit fixtures fail validation; legacy selection works; filters are keyboard accessible; a slow connection shows placeholders without shifting card heights.

**Exit:** Officers see a manageable set of actual designs and can still find all existing specialized kits.

### Task 7 — Support starter pages and full editor parity (P1)

**Files:** Modify `public/admin.html`, `public/qh-site-builder.js`, `src/routes/pages.ts`, `src/routes/tenants.ts`, `src/lib/pageDrafts.ts`, section catalogues, and corresponding tests.

- [ ] Expose composition and new variants as named visual choices. Labels should describe what changes; hide utility classes and implementation details.
- [ ] Ensure the editing canvas receives the same composition context as the full page. Current signature selectors depend on a body attribute and `.qh-main > ...`; a section-only canvas must provide equivalent context or use renderer-resolved section classes.
- [ ] Offer **Add starter page** from the page list, selecting one kit page. The server validates kit, page, tenant, role and destination slug, substitutes tenant values, resolves imagery, and creates a new unpublished section draft through existing draft helpers.
- [ ] Proposed endpoint: `POST /api/tenants/:tenantId/pages/from-kit` with `{ kitId, sourceSlug, destinationSlug, title }`. Register it before `/:pageId` handlers. Reject reserved/colliding slugs and wrong-audience kits; preserve members-only flags.
- [ ] Add “Start from this design” to new-tenant creation before seeding, or clearly identify later design choice as appearance-only. A post-creation picker must not imply that it seeded a new set of kit pages.
- [ ] Verify rich text, image replacement, focal adjustment, section reorder, duplicate, undo/redo, autosave/reload, preview, publish and restore on representative new compositions.
- [ ] Test viewer rejection and two-editor conflicts with actual UI flows. Update source-assertion tests when extraction changes file boundaries; do not preserve obsolete function placement merely to satisfy substring checks.

**Exit:** A nontechnical officer can start from a selected layout, customize it, and publish through existing workflows without HTML or JSON.

### Task 8 — Repair documentation and authoring guidance (P2; draft in parallel)

**Files:** Update `QuiltHostingTemplates.md`, `docs/KIT-AUTHORING.md`, `docs/signature-collection.md`, `docs/website-builder.md`, `public/docs/website-builder.html`, relevant onboarding/business docs, `docs/README.md`, and targeted architecture notes in `CLAUDE.md`.

- [ ] Preserve historical reviewer attribution in `GPT6Findings.md`; append a dated implementation-status pointer rather than rewriting the original findings.
- [ ] Replace the “twelve launch kits” framing with current curated families plus specialized variations. Avoid duplicating volatile counts in multiple files; generate the catalogue reference where practical.
- [ ] Document example preview, current-page preview, Apply appearance, starter-page insertion, save/publish boundaries and undo separately.
- [ ] Update section types, composition choices, supported images, provenance, upload limits, navigation and current theme controls from the actual UI/API.
- [ ] Publish authoring examples for one photo-based family and one quiet text-focused family. Explain when existing sections suffice and the full checklist required to add a variant.
- [ ] Check help links and every changed instruction against a browser walk-through. Keep screenshots aligned with the shipped interface, not early mockups.

**Exit:** A designer can contribute a kit without guessing the schema, and an officer can follow the website guide without encountering retired controls.

### Task 9 — Make visual and behavioral verification repeatable (P1)

**Files:** Create `scripts/kits-browser.mjs` and deterministic fixture helpers under `scripts/lib/`; extend gallery/preview scripts, `.github/workflows/ci.yml`, and package scripts; add `docs/design-review/acceptance.md`.

- [ ] Pin Playwright as a dev dependency with explicit browser installation in CI. Keep manual `PLAYWRIGHT_PATH` support if useful, but remove it as the only reproducible test setup.
- [ ] Freeze fixture dates, tenant timezone, locale, data ordering and image assets. Capture fixture/revision metadata; wait for font readiness and image decode. Existing gallery dates based on the current day must not destabilize comparisons.
- [ ] Add gallery support for curated kit filters, deterministic output directory, system-page previews and actual asset URLs. Mark static interaction demos clearly; use Worker tests for real submission behavior.
- [ ] Run changed families and shared affected surfaces on each PR; run all-kit smoke on the release candidate. Upload screenshots/diffs and error logs. Human approval is required to accept intentional visual baselines.
- [ ] Cover empty, one-item, ordinary, long-copy, long-name, missing-image, no-logo and populated-data fixtures. Include sharp/round shapes and light/dark custom palette combinations on representative families.
- [ ] Assert no page overflow at 320/390/768/1440, no clipped focus target, no new console errors, no broken local image requests, and working menus/forms. Allow horizontal scrolling inside explicitly labelled table containers.
- [ ] Test keyboard-only use, 200% zoom, reduced motion (including preference changes), JavaScript-disabled content, and blocked web fonts. Run automated accessibility checks, then manual checks of menu, dialog and preview focus.
- [ ] Preserve prior targets: mobile LCP <= 2.5s, CLS <= 0.1, HTML <= 60KB, hero <= 200KB at approximately 1200px, and no layout-blocking JS. Measure repeatable local lab results separately from production field results.
- [ ] Add a provisional combined site-CSS budget <= 25KB gzip and site-JS growth <= 5KB gzip relative to Task 1. Treat any necessary exception as a documented design/performance decision, not an excuse to misreport passing. Run three lab samples and record the median under a fixed throttle/browser setup.

**Browser layout assertion example:**

```js
await page.setViewportSize({ width: 390, height: 844 });
// Navigate to the fixture URL before this assertion.
await page.evaluate(() => document.fonts.ready);
const layout = await page.evaluate(() => ({
  pageWidth: document.documentElement.scrollWidth,
  viewportWidth: document.documentElement.clientWidth,
}));
expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
```

For the preview mutation test, wait for preview loading to finish, capture subsequent requests, and operate every enabled action control. Disabled transaction controls must be asserted disabled; enabled demonstration controls must produce no POST/PUT/PATCH/DELETE requests. Include form submission by Enter, not just button clicks. Separate real-site action tests use disposable tenants and stub/test payment/email services; preview tests never send real messages or payments.

**Exit:** Schema-valid kits are no longer treated as visually accepted merely because unit tests pass.

### Task 10 — Stage, measure usability, and hand off a release candidate (P1)

**Files:** `docs/design-review/acceptance.md`, version files if packaging a candidate, deployment configuration only if needed for private staging.

- [ ] Assemble integrated work and rerun the focused/full checks required by the changed areas. Ensure unrelated concurrent work has its own review.
- [ ] Review the six families at desktop and mobile, including system pages, and record PASS/REVISE for each. Ship only families that pass; keep incomplete ones outside Featured.
- [ ] Conduct the earlier spec's product test with five representative officers/business owners: produce a branded five-page site in <= 20 minutes without code, with at least four rating the result professional. Preparing scripts/fixtures can proceed autonomously; recruiting participants is a separate coordination step. Record as pending if no real users have participated.
- [ ] Verify a fresh tenant, a heavily customized existing guild, and a business on platform/subdomain/custom-domain entry points in private staging. Check cache invalidation after appearance and asset changes, service-worker navigation, draft visibility and image routes.
- [ ] Prepare a reversible release: deploy readers/renderers for new options before enabling writes; keep old kit IDs/assets; record the last compatible build and settings snapshots. Once new variants are saved, roll back only to a build that understands them, or disable the picker while retaining compatible rendering.
- [ ] Deliver private preview URLs, screenshot comparisons, test results, byte/performance measurements and unresolved blockers. A public launch remains a separate decision.

**Exit:** A concrete release candidate with documented evidence and compatible rollback, not a claim of commercial readiness based solely on a build.

## 6. Parallel execution and checkpoints

| Lane | Work | Start condition | Shared-file constraint |
|---|---|---|---|
| A: Product correctness | Task 2 preview/apply, then Task 7 editor | Task 1 reproductions | Own preview routes and picker integration |
| B: Visual foundation | Task 3 model/CSS, then Task 5 families | Snapshot current signature work | One owner for renderer/schema/shared CSS |
| C: Content/media | Task 4, then Task 6 catalogue metadata | Task 1 inventory | Separate asset/kit files; coordinate registry edits |
| D: Evidence/docs | Task 9 harness and Task 8 drafts | Task 1 fixture decisions | Avoid concurrent package/CI rewrites |

Milestones:

1. **Truthful preview:** Task 2 passes against existing compositions.
2. **Three distinct designs:** Tasks 3–5 produce Cinema/Poster/Journal with real assets and editor parity.
3. **Curated six-family library:** remaining families, selection, starter pages and documentation pass.
4. **Release candidate:** integrated browser/performance/accessibility and user-job evidence; deployment stays private.

Rough effort estimate after baseline: 12–20 focused engineering/design days in total across lanes, plus user-review scheduling. This is a planning estimate; reduce it for already-complete tasks once their evidence passes. The first milestone should be delivered without waiting for all 114 kits to be redesigned.

## 7. Commands and completion record

Existing commands to use during implementation:

```powershell
npm run kits:validate
npx tsc --noEmit
npm test
npm run photos:check
npm run kits:gallery -- --build
```

Proposed commands become available only after their tasks are implemented:

```powershell
node scripts/kits-audit.mjs
node scripts/kits-browser.mjs --collection featured
node scripts/kits-browser.mjs --all --smoke
```

For every completed task record: commit/revision, files changed, exact verification commands and outcomes, screenshot/report links, remaining limitation, and whether the change is local or privately deployed. Tests added by this plan should target rendering, persistence, access control and user behavior; avoid checks that merely mirror implementation strings.

## 8. Plan review

- Original scan issues map to Tasks 3–6 (variety/imagery/library), Task 8 (docs), and Task 9 (verification).
- Newly confirmed preview/application mismatch maps to Task 2; canvas composition parity maps to Task 7.
- Existing imagery and six-family work are incorporated rather than scheduled for replacement.
- Tailwind is evaluated within the current SSR architecture with an explicit adopt/decline gate.
- Existing content protection and version-compatible rollback are specified; wholesale template replacement is excluded.
- Outstanding evidence is named explicitly: browser baseline, finished visual comparisons, current test results and real-user usability trials.
