# Site Sections + Imagery (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the section system complete and the imagery professional: responsive image variants with a focal point, the remaining fourteen sections from the spec, a polished Style tab with section thumbnails, palette-from-logo, and a real "Try the new design" migration for existing guilds. Then review the contributed kits' copy so all thirteen can be promoted.

**Architecture:** Builds on phase 1 (`docs/superpowers/plans/2026-09-08-site-foundation-phase1.md`, shipped as v0.57.0). Image variants are produced in the browser (canvas → WebP + JPEG at 480/960/1600/2400) and stored in R2 under the same file id; the image routes pick the nearest stored variant from `?w=`; renderers emit `srcset`. New sections extend the frozen schema additively. The editor's Style tab and thumbnails are UI over the existing catalog endpoint. Guild migration converts block pages to styled sections and composes a kit-quality home page, snapshotting the originals so "Back to classic" is lossless.

**Tech Stack:** unchanged (Workers, Hono, Zod, D1, R2, vitest; Playwright via Edge from the scratchpad for browser checks).

## Global Constraints

- Everything in phase 1's Global Constraints still applies (sanitize every tenant string, keep exported signatures, batch D1 queries, `--qh-*` variables only, explicit `git add`, trailers on commits, no `git add -A`).
- **Other tools are editing the shared checkout live** (`src/lib/site/kits/index.ts`, `src/lib/site/kits/longarm-studio.json`, `src/lib/site/kits/retreat-house.json`, `docs/kit-contributor-notes.md` were uncommitted at plan time). Never modify or stage those four paths; if `kits/index.ts` must change, describe the edit in the report instead.
- Schema changes are additive: new section types and optional fields only. `SECTION_TYPES` grows from 19 to 33; every new type gets a renderer, a fixture, catalog metadata (`SECTION_META`/`FIELD_LABELS` in `src/routes/pages.ts`), and CSS.
- Images: never serve a stored `content_type` outside `ALLOWED_IMAGE_TYPES`; variants are written only by the server after re-validating magic bytes; per-file cap 10 MB original, 25 MB total variants.
- Performance budget on a kit home page after this phase: hero image ≤ 200 KB at 1200 px wide (WebP), HTML ≤ 60 KB.

---

### Task A: Remaining sections (schema, renderers, fixtures, CSS, catalog)

**Files:**
- Modify: `src/lib/site/sections/schema.ts`, `sections/render.ts`, `sections/fixtures.ts`, `public/qh-site.css`, `src/routes/pages.ts` (only `SECTION_META`, `FIELD_LABELS`, group map), `src/lib/site/data.ts` + `data.types.ts` (new needs), `src/lib/site/kits/schema.ts` ONLY if it enumerates types (check), `QuiltHostingTemplates.md` §4 table (append the new rows; remove the "coming in phase 2" note)
- Test: `sections/schema.test.ts`, `sections/render.test.ts`, `src/lib/site/css.test.ts`, `src/routes/pages.test.ts` (catalog count 33), `src/lib/site/data.test.ts`

**Interfaces (new members of the `Section` union):**
```ts
| { type: "timeline"; heading?: string; items: { year: string; title: string; body?: string }[]; style; id }
| { type: "quote"; quote: string; author?: string; style; id }                         // single pull quote, large type
| { type: "officers"; heading?: string; items: { name: string; role: string; email?: string; imageId?: string }[]; style; id }
| { type: "benefits"; heading?: string; items: { title: string; body?: string }[]; style; id }   // checklist look
| { type: "event_spotlight"; eventId?: string; heading?: string; style; id }         // one featured event; falls back to next upcoming
| { type: "projects"; heading?: string; items: { title: string; body?: string; imageId?: string; href?: string; stat?: string }[]; style; id }
| { type: "sponsors"; heading?: string; items: { name: string; imageId?: string; href?: string }[]; style; id }   // logo strip
| { type: "newsletter_signup"; heading?: string; body?: string; buttonLabel?: string; style; id }  // posts to /public/:slug/newsletter (see below)
| { type: "services"; variant: "cards" | "table"; heading?: string; items: { title: string; body?: string; price?: string; unit?: string }[]; style; id }
| { type: "portfolio"; variant: "grid" | "featured"; heading?: string; items: { imageId?: string; url?: string; title?: string; caption?: string }[]; style; id }
| { type: "hours_location"; heading?: string; hours: { day: string; open: string }[]; address?: string; mapUrl?: string; phone?: string; email?: string; note?: string; style; id }
| { type: "process"; heading?: string; items: { title: string; body?: string }[]; style; id }   // numbered steps (the one place numbering is information)
| { type: "documents"; heading?: string; limit: number; style; id }                  // members-only file list from `files`; renders a sign-in prompt publicly
| { type: "donate"; heading?: string; body?: string; amounts: number[]; style; id }  // cents; buttons carry data-donate
```
`data.ts`: `needsFor` adds `event_spotlight`→`events`, `documents`→`documents` (new `SiteData.documents?: { id: string; filename: string; size: number | null }[]`, loaded only when the caller says the viewer is a member — `serveSite` never does on public HTML, so the loader is exercised by the portal later; for now the renderer shows the sign-in prompt when `data.documents` is undefined). `newsletter_signup` posts to a new public route `POST /public/:slug/newsletter { email, name? }` in `src/routes/public.ts` that upserts a `members` row with `status='subscriber'`? No — keep it simple and honest: it inserts into a new table `newsletter_signups (id, tenant_id, email, name, created_at, source)` (migration `0027_newsletter_signups.sql`), rate-limited, idempotent per (tenant, email), and the island in `qh-site.js` posts it (add `initNewsletter`). Admin can see them later (out of scope: UI).

CSS: `.qh-timeline`, `.qh-quote`, `.qh-officers`, `.qh-benefits`, `.qh-spotlight`, `.qh-projects`, `.qh-sponsors`, `.qh-newsletter`, `.qh-services--cards|table`, `.qh-portfolio--grid|featured`, `.qh-hours`, `.qh-process`, `.qh-documents`, `.qh-donate` with the same rhythm/token discipline as phase 1; sponsors logos grayscale until hover; process steps numbered with `counter()`; services table scrolls in its own wrapper.

- [ ] Steps: failing tests for each new type (parse, render with fixture, class present, escaping) → implement → catalog test expects 33 types with groups (add "Utility" group: documents, donate, newsletter_signup, hours_location) → `npx vitest run src/lib/site src/routes/pages.test.ts` → `npx tsc --noEmit` → commit `feat(site): complete the section library (14 new sections)`.

### Task B: Image pipeline — variants, focal point, srcset

**Files:**
- Create: `migrations/0028_image_variants.sql`: `ALTER TABLE files ADD COLUMN width INTEGER; ALTER TABLE files ADD COLUMN height INTEGER; ALTER TABLE files ADD COLUMN variants_json TEXT; ALTER TABLE files ADD COLUMN focal_json TEXT;`
- Modify: `src/routes/files.ts` (+ `files.test.ts`), `src/routes/public.ts` (`GET /:slug/img/:fileId`), `src/routes/site.ts` (`GET /img/:fileId`), `src/lib/site/sections/render.ts` (srcset), `src/lib/site/render.ts` (og image picks the 1200 variant), new `src/lib/images.ts` (+ test)

**Contract (server):**
- `POST /api/tenants/:id/files/image` — multipart or JSON `{ original: <base64 or raw body with X-Filename>, variants: [{ w, format: "webp" | "jpeg", data }] }`? Simpler and bandwidth-sane: the client uploads the ORIGINAL once (existing `POST /files` with `X-Filename`), receives `{ id }`, then `POST /api/tenants/:id/files/:fileId/variants` with a multipart body of up to 8 parts named `w480.webp`, `w480.jpg`, `w960.webp`, … The server re-validates each part with `sniffImageType`, stores under `r2_key + "/w<w>.<ext>"`, and writes `variants_json = [{ w, format, key, bytes }]`, `width`, `height` (from the client's declared dimensions of the original; server trusts only after sniffing). `PATCH /api/tenants/:id/files/:fileId` accepts `{ focal: [x, y] }` (0..1) and `{ alt }` (store `alt` in a new column? The `files` table has no alt — add `ALTER TABLE files ADD COLUMN alt TEXT` in 0028).
- `GET /public/:slug/img/:fileId?w=960&f=webp` and `GET /img/:fileId?w=&f=`: choose the smallest stored variant with `w >= requested` in the requested format (fallback other format, then original); `Cache-Control: public, max-age=31536000, immutable`; `Vary: Accept` when `f` omitted and you pick by `Accept: image/webp`.
- `src/lib/images.ts`: `pickVariant(variants, wantW, wantFormat, accept)`; `srcsetFor(imgUrl, id, widths)`; `focalToObjectPosition([x,y])`.
- Renderer: every `<img>` from an `imageId` gets `srcset` (480/960/1600) + `sizes` per section (hero 100vw, split 50vw, gallery 33vw…), `style="object-position:X% Y%"` from the file's focal (renderers receive focal via `ctx.imgMeta?.(id)` — extend `RenderContext` with optional `imgMeta: (id) => { w, h, focal } | undefined` that `serveSite` fills from one batched `SELECT id,width,height,focal_json FROM files WHERE id IN (...)` for the page's image ids; when absent, `style.imageFocal` still works).
- Tests: variant picking table; upload validation (bad magic → 415, over cap → 413); focal PATCH validation; srcset emission.

- [ ] Steps: tests → implement → `npx vitest run src/routes/files.test.ts src/lib/images.test.ts src/lib/site/sections/render.test.ts src/routes/public.test.ts src/routes/site.test.ts` → `npx tsc --noEmit` → local migration apply → commit `feat(images): stored variants, focal point, srcset`.

### Task C: Editor — client-side resize, focal picker, Style tab, thumbnails, palette-from-logo

**Files:**
- Modify: `public/admin.html` (editor + Design panel only), `public/qh-site-builder.js` (only if the business Appearance/Identity screens need the logo picker), `public/qh.css` (editor styles), `src/lib/adminNavGating.test.ts` unchanged, new `src/lib/site/editorAssets.test.ts` (source assertions)

**Behavior:**
1. **Upload pipeline in the browser** (`wbUploadImage`): read the file, decode with `createImageBitmap`, produce WebP and JPEG at 480/960/1600/2400 (skip widths larger than the original), quality 0.82, upload the original via `POST /files` then `POST /files/:id/variants` (Task B contract); show progress; store the file id in the section field. Reject > 10 MB with a clear message.
2. **Focal picker**: in the Style row's image field and in image/hero fields, a thumbnail the user clicks to set the focal point (crosshair; stores `style.imageFocal` and also `PATCH /files/:id { focal }`), with a 16:9 and 1:1 crop preview so they see what phones will show.
3. **Style tab**: replace the phase-1 Style row with a proper tab next to the section's fields: background (radio tiles rendered in the tenant's roles), width (icons), spacing, alignment, media side, image + focal, pattern override toggle. Reset-to-kit-defaults button.
4. **Thumbnails**: the section picker shows a small SVG/CSS thumbnail per type + variant (generic line-art, generated client-side from a small table, tinted with the tenant primary) instead of text chips; grouped; keyboard navigable; search box.
5. **Palette from your logo**: in the Design panel's Colors, a "From your logo" button reads the uploaded logo (existing `settings.profile.logo_file_id` / `settings.assets.logo_file_id`), quantizes to the 6 dominant colors on a canvas (median cut, ≤ 32 px sample), and proposes three candidate palettes (brand = most saturated dominant, brandAlt = darkest, accent = second saturated, neutral = darkest low-chroma) with the readability check; clicking one fills the Custom inputs.
6. **Migration buttons** (wired to Task D's endpoints): "Try the new design" runs `POST /api/tenants/:id/site/upgrade` (with a preview link first: `GET …/site/upgrade?preview=1` returns the composed home HTML shown in an iframe), "Back to classic" runs `POST …/site/downgrade`.
- `node --check` on inline scripts; DOM APIs only.

- [ ] Steps: source-assertion tests (functions exist, no innerHTML templates for data, endpoints referenced) → implement → manual QA in the scratchpad Playwright harness (upload a PNG, set focal, publish, verify `srcset` on the public page) → commit `feat(editor): image pipeline, focal picker, Style tab, thumbnails, palette from logo`.

### Task D: "Try the new design" for existing guilds

**Files:**
- Create: `src/lib/site/migrateGuild.ts` (+ test), routes in `src/routes/tenants.ts` (`GET/POST /:id/site/upgrade`, `POST /:id/site/downgrade`) + tests
- Modify: `src/lib/site/sections/normalize.ts` only to export `blocksToSectionsStyled(blocks, kit?)` if the plain 1:1 mapping needs style hints

**Behavior:**
- `composeUpgrade(tenant, pages, kitId = "heritage")`: for each block page → sections (1:1) with kit-style defaults applied by position (first `rich_text` after a heading becomes a `hero` minimal when the page is `home`; alternate `tint`/`none` backgrounds every other section; wrap consecutive `heading + text` pairs). Home page: if the guild has no `home` page, compose one from the legacy composition (hero from `profile.description` and name, `meeting_info` from profile, `events` cards 3, `membership_levels` cards, `blog_teaser` 3, `join_band`); if it has one, prepend the hero and append events/levels/join band. Design: `readSiteDesign(settings)` (the legacy guild theme migrates to a palette) unless the caller passes a kit id, in which case the kit's defaults are used.
- `POST /:id/site/upgrade { kit? }`: in ONE batch, snapshot every page into `page_revisions` (`kind = "pre_upgrade"`), write the converted sections into `blocks_json`, insert the composed home if missing (slug `home`), set `settings.site = { renderer: "sections", kit, upgraded_at, previous: { renderer: "legacy" } }`, bump `updated_at`. Returns the page list.
- `GET /:id/site/upgrade?preview=1`: renders the composed home through `renderSitePage` without writing (`Cache-Control: no-store`).
- `POST /:id/site/downgrade`: restores every page from its latest `pre_upgrade` revision, deletes the composed home if it was created by the upgrade (marker in `settings.site.upgrade_created_home`), sets renderer `legacy`. Idempotent.
- Owner/admin only; 409 if already on the requested renderer.
- Tests: conversion composes the expected stacks; upgrade batch contents; downgrade restores byte-identical blocks; permission checks.

- [ ] Steps: tests → implement → commit `feat(site): reversible upgrade of existing guilds to the new renderer`.

### Task E: Contributed kit copy review

**Files:** the eleven committed kit JSONs other than `heritage.json` and `retreat-house.json`, `docs/kit-gallery/` screenshots (optional), NOT `kits/index.ts`.

- Review each kit against `QuiltHostingTemplates.md` §1 and §9 rubric: thesis above the fold, no duplicate adjacent backgrounds, 5–7 nav items, quilter-specific copy, no filler, sample marker on every page, dynamic sections placed where empty states look fine, pattern imagery ids resolved (kind pattern). Fix copy and section order in place; keep ids stable.
- Run `npm run kits:validate` and the kit tests; render each kit's home with the scratchpad Playwright harness (create a local guild per kit) at desktop and phone and save `docs/kit-gallery/<kit>-home-{desk,phone}.png` (small PNG, ≤ 300 KB each).
- Commit `docs(kits): copy review and gallery screenshots for contributed kits`.

### Task F: Release

- [ ] `npx tsc --noEmit`, `npx vitest run`; local migrations apply; browser pass: upload an image into a hero, set focal, publish, verify `srcset` and focal on the public page at 390 px; upgrade an existing local block-page guild and view the composed home; downgrade and confirm the blocks are back.
- [ ] Bump to `0.58.0-preview` (`package.json`, `src/version.ts`); append implementation notes to the spec; commit `chore(release): v0.58.0-preview — sections, imagery, upgrade path`; push; deploy from a clean worktree after `db:migrate:remote` (0027, 0028); verify production (`/api/version`, the `design-preview` guild's hero `srcset`, an image request with `?w=960` returns the variant).

## Self-review

- Spec coverage: §4.3 remaining sections → A; §4.5 imagery (variants, focal, pattern art already done) → B + C; §4.8 Style tab, thumbnails → C; palette-from-logo → C; §5 migration step 2 → D; kit review → E. Kit picker "Browse designs" already exists (phase 1 Design panel).
- Interfaces: `RenderContext.imgMeta` (B) is optional so A's renderers compile before B lands; C consumes B's variant/focal endpoints and D's upgrade endpoints, which are specified here so all four can proceed in parallel; E is independent.
- No placeholders: each task lists files, contracts, tests, and the commit message.
