# Site Foundation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One server-rendered site renderer for guild and business tenants, driven by a real design-token model (palette library, type pairs, shape, rhythm, header/footer variants), rendering styled sections, with the section and kit schemas frozen and a kit validator/preview/authoring brief so kit authoring can start immediately.

**Architecture:** `src/lib/site/` grows from "business SSR" into the platform renderer: `design/` (tokens, palettes, type pairs, derivation, migration), `sections/` (schema, block→section normalization, renderers), `pages/` (system page section stacks), `data.ts` (loaders for dynamic sections), `render.ts` (shell: head, header, footer, islands), `kits/` (schema, apply, reference kit). `src/routes/site.ts` becomes `serveSite` for every tenant host and `/g/:slug/*`, with `settings.site.renderer === "legacy"` falling back to `guild.html` during migration. `public/qh-site.css` is rewritten against tokens; `public/qh-site.js` becomes the island bundle (mobile nav, join/register dialog, cart, donate, calendar, lightbox, volunteer).

**Tech Stack:** Cloudflare Workers, Hono, Zod, D1, TypeScript ESM, vitest (unit), Playwright via Edge for browser checks (scratchpad only, not a dependency). No new runtime dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-08-site-design-system-and-kits-design.md` (approved, expanded scope). Non-goals: no tenant CSS/JS, no pixel drag, no dark mode for tenant sites.
- Every tenant string that reaches HTML goes through `escapeHtml`/`sanitizeHtml` from `src/lib/blocks.ts` / `src/lib/sanitize.ts`. Never emit `${b.html}` raw.
- Existing exports stay stable: `parseBlocks`, `blocksToHtml`, `contentFromPage`, `parseTheme`, `parseNav`, `BUSINESS_BLOCK_TYPES`, `GUILD_ONLY_BLOCK_TYPES` (`src/lib/blocks.ts`); `renderPageHtml`, `readBranding`, `readBusinessIdentity` (`src/lib/site/render.ts`); `buildRenderArgs`, `serveBusinessSite`, `ALLOWED_IMAGE_TYPES` (`src/routes/site.ts`); `readTenantTheme` (`themeMigrate.ts`). Add, don't break; `serveBusinessSite` becomes a thin alias of `serveSite`.
- Palette library ≥ 24 palettes in 7 families; type pairs ≥ 10 + system; every derived role pair used for text passes WCAG AA (4.5:1 body, 3:1 large) — enforced by tests.
- Section schema and kit schema are frozen at the end of Task 1 and Task 10; later phases only add types/variants.
- Copy rules for anything shipped in kits: real guild vocabulary, no lorem, no superlatives, sample text marked with `SAMPLE_MARKER` from `src/lib/starterSite.ts` ("Sample text — replace me:").
- CSS: no hard-coded colors except `#fff`/`#000` alpha overlays; everything from `--qh-*` variables. No horizontal page scroll at 360 px.
- Performance budget for a kit home page: HTML ≤ 60 KB, one CSS file, one JS file, two font families max.
- Tests: vitest (`npx vitest run`), typecheck (`npx tsc --noEmit`). Fake-D1 idiom as in `src/routes/pages.test.ts`. Commit after every task with the attribution trailer used in this repo.
- Work on branch `main` in `E:\quilthosting` (the shared checkout). Run `git status -sb` before committing; other agents may be editing `public/docs/` and `docs/*.md` — never `git add -A`; add task files explicitly.

---

### Task 1: Section schema and block → section normalization

**Files:**
- Create: `src/lib/site/sections/schema.ts`
- Create: `src/lib/site/sections/normalize.ts`
- Test: `src/lib/site/sections/schema.test.ts`, `src/lib/site/sections/normalize.test.ts`

**Interfaces:**
- Consumes: `PageBlock` and `parseBlocks(raw: unknown): PageBlock[]` from `src/lib/blocks.ts`; `sanitizeHtml`, `sanitizeUrl` from `src/lib/sanitize.ts`.
- Produces:
  ```ts
  export type SectionStyle = {
    bg: "none" | "tint" | "brand" | "dark" | "image" | "pattern";
    width: "narrow" | "normal" | "wide" | "full";
    spacing: "tight" | "normal" | "airy";
    align: "left" | "center";
    media: "left" | "right" | "top";
    imageId?: string;          // files.id, served at /public/:slug/img/:id
    imageFocal?: [number, number]; // 0..1, default [0.5,0.5]
  };
  export const DEFAULT_STYLE: SectionStyle;
  export type Section =
    | { type: "hero"; variant: "image" | "split" | "pattern" | "minimal" | "stats"; eyebrow?: string; title: string; subtitle?: string; ctaLabel?: string; ctaHref?: string; secondaryLabel?: string; secondaryHref?: string; stats?: { value: string; label: string }[]; style: SectionStyle; id: string }
    | { type: "rich_text"; variant: "prose" | "two_column" | "with_image"; heading?: string; html: string; style; id }
    | { type: "image"; variant: "single" | "full_bleed" | "duo"; items: { imageId?: string; url?: string; alt: string; caption?: string }[]; style; id }
    | { type: "feature_grid"; variant: "cards" | "icons" | "numbered"; heading?: string; items: { icon?: string; title: string; body?: string; href?: string; price?: string }[]; style; id }
    | { type: "faq"; heading?: string; items: { q: string; a: string }[]; style; id }
    | { type: "testimonials"; variant: "grid" | "single"; items: { quote: string; author?: string }[]; style; id }
    | { type: "gallery"; variant: "grid" | "masonry"; source: "manual" | "gallery"; gallerySlug?: string; items: { imageId?: string; url?: string; alt?: string; caption?: string }[]; style; id }
    | { type: "events"; variant: "cards" | "list" | "calendar" | "next_up"; heading?: string; limit: number; style; id }
    | { type: "membership_levels"; variant: "cards" | "compact"; heading?: string; style; id }
    | { type: "join_band"; title: string; body?: string; ctaLabel: string; style; id }
    | { type: "meeting_info"; heading?: string; when: string; where: string; address?: string; mapUrl?: string; note?: string; style; id }
    | { type: "store_teaser"; heading?: string; limit: number; style; id }
    | { type: "blog_teaser"; heading?: string; limit: number; style; id }
    | { type: "contact"; heading?: string; formSlug?: string; showDetails: boolean; style; id }
    | { type: "quote_cta"; projectType: string; heading?: string; submitLabel?: string; style; id }
    | { type: "cta"; label: string; href: string; kind: "primary" | "secondary"; style; id }
    | { type: "divider"; style; id }
    | { type: "spacer"; height: number; style; id }
    | { type: "embed"; html: string; style; id };
  export const SECTION_TYPES: readonly string[]; // every `type` above
  export const SECTION_VARIANTS: Record<string, readonly string[]>; // type -> allowed variants ("" for none)
  export function parseSections(raw: unknown): { sections: Section[]; issues: { path: string; message: string }[] };
  ```
  and in `normalize.ts`:
  ```ts
  export function blocksToSections(blocks: PageBlock[]): Section[];     // 1:1 mapping, DEFAULT_STYLE
  export function sectionsFromPage(row: { blocks_json?: string | null; sections_json?: string | null; content_json?: string | null }): Section[];
  export function isSectionDocument(raw: unknown): boolean;            // true when every item has a `style` object
  ```

Mapping table (must be exact, tested): `heading`→`rich_text` (`html` = `<h2>` or `<h3>` per level, escaped) · `text`→`rich_text` prose · `image`→`image` single · `button`→`cta` · `divider`→`divider` · `spacer`→`spacer` · `html`→`embed` · `join_cta`→`join_band` (title/body, ctaLabel "Join") · `events_list`→`events` cards · `store_list`→`store_teaser` · `hero`→`hero` (variant `image` when `imageUrl` else `minimal`; `imageUrl` becomes `style.bg="image"` only if it is a `/public/:slug/img/` or `/img/` URL, else kept as `items`-less minimal) · `service_cards`→`feature_grid` cards · `gallery_grid`→`gallery` grid manual · `faq`→`faq` · `testimonials`→`testimonials` grid · `contact_form`→`contact` with `formSlug` · `project_intake`→`quote_cta`.

`parseSections` accepts BOTH legacy block arrays (delegates to `parseBlocks` then `blocksToSections`) and section arrays (zod). Rich HTML fields (`rich_text.html`, `embed.html`, `faq.items[].a`) are sanitized with `sanitizeHtml` (`allowEmbeds: true` only for `embed`). URL fields go through `sanitizeUrl`. Unknown types → issue `{ path: "sections.N.type", message: 'Unsupported section type "x"' }` and the item is dropped. Ids: keep provided `id` if `/^[a-z0-9_-]{1,40}$/`, else generate `s_<index>`.

- [ ] **Step 1: Write failing tests** (`schema.test.ts`): parses a valid `hero` split section; rejects an unknown type with a path; rejects an invalid variant; sanitizes `<script>` in `rich_text.html`; defaults `style` when missing; `SECTION_TYPES` contains every type in the union (assert length 19). (`normalize.test.ts`): every legacy block type from `KNOWN_BLOCK_TYPES` in `src/routes/pages.ts` maps to a section (loop over the table above and assert `type` and key fields); `sectionsFromPage` prefers `sections_json`, then `blocks_json`, then legacy `content_json.html` → one `rich_text`; `isSectionDocument` distinguishes block arrays from section arrays.
- [ ] **Step 2: Run** `npx vitest run src/lib/site/sections` → FAIL (modules missing).
- [ ] **Step 3: Implement** `schema.ts` with zod (`z.discriminatedUnion("type", [...])`, `style: styleSchema.default(DEFAULT_STYLE)`), and `normalize.ts` per the mapping table.
- [ ] **Step 4: Run** the two test files → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(site): section schema and block-to-section normalization`.

### Task 2: Palette library, type pairs, and token derivation

**Files:**
- Create: `src/lib/site/design/color.ts` (hex↔OKLCH, contrast), `src/lib/site/design/palettes.ts`, `src/lib/site/design/typePairs.ts`, `src/lib/site/design/tokens.ts`, `src/lib/site/design/migrate.ts`
- Modify: `src/lib/site/fonts.ts` (add missing fonts: `dmserif`, `dmsans`, `karla`, `librebaskerville`, `nunitosans`, `manrope`, `spacegrotesk`, `bitter`, `opensans`, `newsreader`, `ibmplexsans`, `lato`, `cormorantgaramond`; keep existing keys)
- Test: `src/lib/site/design/color.test.ts`, `palettes.test.ts`, `tokens.test.ts`, `migrate.test.ts`

**Interfaces:**
```ts
// color.ts
export function hexToOklch(hex: string): { l: number; c: number; h: number };
export function oklchToHex(l: number, c: number, h: number): string;   // gamut-clipped sRGB
export function contrastRatio(hexA: string, hexB: string): number;      // WCAG 2.x
export function tint(hex: string, l: number): string;                   // same hue/chroma, lightness l (0..1)
export function bestInk(bg: string): "#111111" | "#ffffff";             // whichever passes higher contrast
// palettes.ts
export type PaletteInput = { brand: string; brandAlt: string; accent: string; neutral: string };
export type PaletteFamily = "heritage" | "modern" | "naturals" | "jewel" | "soft" | "seasonal" | "dark";
export type PaletteDef = { id: string; name: string; family: PaletteFamily; input: PaletteInput; dark?: boolean };
export const PALETTES: PaletteDef[];                     // ≥ 24; ids kebab-case, unique
export function paletteById(id: string): PaletteDef | null;
// typePairs.ts
export type TypePair = { id: string; name: string; display: string; body: string; sample: string }; // display/body are FONT_OPTIONS keys
export const TYPE_PAIRS: TypePair[];                    // ≥ 11 incl. { id: "system", display: "system", body: "system" }
export function typePairById(id: string): TypePair;    // falls back to "fraunces-inter"
// tokens.ts
export type Roles = { bg: string; surface: string; surfaceAlt: string; ink: string; inkMuted: string; border: string;
  primary: string; onPrimary: string; primaryHover: string; accent: string; onAccent: string; dark: string; onDark: string; tint: string };
export type SiteDesign = {
  palette: { id?: string; input: PaletteInput };
  typePair: string; scale: "compact" | "comfortable" | "editorial";
  shape: { radius: "sharp" | "soft" | "round"; shadow: "none" | "subtle" | "lifted" };
  rhythm: { spacing: "tight" | "normal" | "airy"; container: "narrow" | "normal" | "wide" };
  header: { variant: "left" | "centered" | "split"; sticky: boolean; cta: "join" | "quote" | "donate" | "none"; overlayHero: boolean };
  footer: { variant: "simple" | "columns" | "meeting" };
  pattern: { id: "none" | "nine-patch" | "flying-geese" | "log-cabin" | "churn-dash" | "bear-paw"; opacity: number };
};
export const DEFAULT_DESIGN: SiteDesign;               // palette "heritage-madder", "fraunces-inter", comfortable, soft/subtle, normal/normal, left/sticky/join, columns, none
export function deriveRoles(input: PaletteInput, dark?: boolean): Roles;  // every text/bg pairing AA; nudges lightness until it passes
export function buildDesignVars(design: SiteDesign): string;             // "--qh-bg:#...;--qh-ink:...;--qh-font-display:...;--qh-radius:...;--qh-section-y:...;--qh-container:..."
export function designFontsHref(design: SiteDesign): string | null;      // Google Fonts URL for the pair, null for system
// migrate.ts
export function readSiteDesign(settingsJson: string | null | undefined): SiteDesign;
// reads settings.design; else migrates settings.theme (13-token business) via brand=primary, brandAlt=secondary, accent=gold, neutral=textBase and fonts.heading/body → nearest type pair; else guild {primary, style, font} → brand=primary, brandAlt=tint(primary,0.35), accent="#d9a441", neutral="#2b2118", typePair by font ("serif"→"playfair-lato","rounded"→"nunito","system"→"system", default "fraunces-inter"); else DEFAULT_DESIGN.
```

Derivation rules (tested): `bg` = tint(neutral, 0.985) for light palettes (0.16 for `dark`); `surface` = 0.995/0.21; `surfaceAlt` = 0.95/0.26; `ink` = tint(neutral, 0.2)/0.93; `inkMuted` 0.45/0.7; `border` 0.88/0.3; `primary` = brand adjusted so `contrastRatio(primary, bg) ≥ 3` and `contrastRatio(onPrimary, primary) ≥ 4.5`; `primaryHover` = tint(brand, l−0.08); `accent`/`onAccent` same rule; `dark` = tint(brandAlt, 0.22), `onDark` = bestInk(dark); `tint` = tint(brand, 0.94).

- [ ] **Step 1: Write failing tests**: `contrastRatio("#000000","#ffffff")` ≈ 21; `oklchToHex(hexToOklch(x))` round-trips within 1/255 for 20 sample colors; `PALETTES.length ≥ 24`, unique ids, every family present at least 3 times; for every palette `deriveRoles` yields `contrastRatio(ink,bg) ≥ 4.5`, `contrastRatio(inkMuted,bg) ≥ 4.5`, `contrastRatio(onPrimary,primary) ≥ 4.5`, `contrastRatio(onAccent,accent) ≥ 4.5`, `contrastRatio(onDark,dark) ≥ 4.5`; `TYPE_PAIRS.length ≥ 11` and every `display`/`body` key exists in `FONT_OPTIONS` (or "system"); `buildDesignVars(DEFAULT_DESIGN)` contains `--qh-bg:`, `--qh-font-display:`, `--qh-radius:`; `readSiteDesign` migrates a 13-token theme and a guild theme and falls back to default on junk.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Palette ids to include (input hexes chosen by the implementer to fit the family names in the spec; must pass the tests): heritage-madder, heritage-indigo, heritage-wheat, heritage-walnut, modern-indigo-mustard, modern-charcoal-coral, modern-slate-lime, naturals-sage, naturals-clay, naturals-linen, naturals-moss, jewel-garnet, jewel-sapphire, jewel-emerald, jewel-amethyst, soft-blush, soft-sky, soft-lavender, soft-butter, seasonal-harvest, seasonal-winter, seasonal-spring, seasonal-summer, dark-charcoal-gold (dark), dark-ink-rose (dark), dark-forest-cream (dark).
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(site): palette library, type pairs, token derivation, design migration`.

### Task 3: Pattern art and the token-driven stylesheet

**Files:**
- Create: `src/lib/site/design/patterns.ts`
- Rewrite: `public/qh-site.css`
- Test: `src/lib/site/design/patterns.test.ts`, `src/lib/site/css.test.ts` (source assertions on the CSS file)

**Interfaces:**
```ts
export function patternSvg(id: SiteDesign["pattern"]["id"], colors: { a: string; b: string; c: string }, tile = 96): string; // <svg> tile
export function patternDataUri(id, colors, tile?): string;   // "url(\"data:image/svg+xml;utf8,...\")" for CSS background-image
```
Patterns: nine-patch (3×3 squares alternating a/b), flying-geese (triangles pointing right), log-cabin (concentric strips), churn-dash (corner triangles + bars), bear-paw (square + 4 triangles). All built from `<rect>`/`<polygon>` only.

CSS contract (class names the renderers in Tasks 4–5 emit):
- Shell: `.qh-site`, `.qh-header.qh-header--left|centered|split`, `.qh-header--sticky`, `.qh-header--overlay`, `.qh-nav`, `.qh-nav__item.has-children > .qh-nav__menu`, `.qh-nav-toggle`, `.qh-drawer[open]`, `.qh-header__cta`, `.qh-footer.qh-footer--simple|columns|meeting`, `.qh-container.qh-container--narrow|normal|wide|full`.
- Sections: `.qh-s` + `.qh-s--bg-none|tint|brand|dark|image|pattern`, `.qh-s--w-narrow|normal|wide|full`, `.qh-s--sp-tight|normal|airy`, `.qh-s--align-center`, `.qh-s--media-left|right|top`; per type `.qh-hero.qh-hero--image|split|pattern|minimal|stats`, `.qh-rich.qh-rich--prose|two_column|with_image`, `.qh-image--single|full_bleed|duo`, `.qh-features--cards|icons|numbered`, `.qh-faq`, `.qh-testimonials--grid|single`, `.qh-gallery--grid|masonry`, `.qh-events--cards|list|calendar|next_up`, `.qh-levels--cards|compact`, `.qh-join-band`, `.qh-meeting`, `.qh-store`, `.qh-blog`, `.qh-contact`, `.qh-quote-cta`, `.qh-cta`, `.qh-divider`, `.qh-spacer`, `.qh-embed`.
- Type scale from `--qh-scale` (compact 1.2, comfortable 1.25, editorial 1.333): `--qh-h1: calc(1rem * pow(var(--qh-scale), 5))` is not available in all engines — precompute the six sizes in `buildDesignVars` as `--qh-fs-1..6` instead and reference them here.
- Buttons `.qh-btn.qh-btn--primary|secondary|ghost`, cards `.qh-card`, badges `.qh-badge`, forms (carry over the existing form rules).
- Mobile: drawer under 800 px; `.qh-nav` hidden, `.qh-nav-toggle` shown; no horizontal overflow.

- [ ] **Step 1: Write failing tests**: `patternSvg("log-cabin", …)` starts with `<svg` and contains no `<script`/`on`; each of the five ids produces distinct output; `patternDataUri` is URL-safe (no raw `#`); `css.test.ts` reads `public/qh-site.css` and asserts every class in the contract list above appears, and that no `#` hex color other than `#fff`/`#000` variants appears outside comments.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** patterns and rewrite the stylesheet (keep existing form rules; migrate old class names by keeping `.qh-block-*` aliases for one release: `.qh-block-hero{…}` → `@extend`-like duplicate selectors).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(site): quilt-block pattern art and token-driven stylesheet`.

### Task 4: Section renderers

**Files:**
- Create: `src/lib/site/sections/render.ts`
- Create: `src/lib/site/sections/fixtures.ts` (one sample of every section/variant, real copy)
- Test: `src/lib/site/sections/render.test.ts`

**Interfaces:**
```ts
export type RenderContext = {
  slug: string; baseUrl: string; design: SiteDesign;
  data: SiteData;                                  // from Task 6; may be empty
  imgUrl: (fileId: string, w?: number) => string;  // `${baseUrl}/img/${id}` for business hosts, `/public/${slug}/img/${id}` on the platform host — provided by caller
};
export function renderSection(s: Section, ctx: RenderContext): string;
export function renderSections(sections: Section[], ctx: RenderContext): string;
export function sectionWrapper(s: Section, inner: string, extraClass?: string): string; // <section id class="qh-s …" style="…bg image/pattern…">
```
Rules: wrapper carries `id`, style classes, and for `bg:"image"` an inline `style="--qh-s-image:url(…);--qh-s-focal:X% Y%"` (URL sanitized); for `bg:"pattern"` `style="--qh-s-pattern:url(data:…)"` from `patternDataUri` using roles. Dynamic sections (`events`, `membership_levels`, `store_teaser`, `blog_teaser`, `gallery` with `source:"gallery"`) render from `ctx.data` when present and otherwise render an empty-state placeholder `<div class="qh-empty">` (never `<!-- events -->` comments). Every text field escaped; rich fields already sanitized at parse time are sanitized again at render (defense in depth, same as `blocksToHtml`).

- [ ] **Step 1: Write failing tests**: every fixture renders without throwing and output contains the type class; `hero` image variant emits `--qh-s-image` and focal; `<img onerror>` in `rich_text.html` is inert; `events` with two events renders two `<article class="qh-event">` with dates formatted `Sat, Sep 12 · 9:00 AM` (implementer: use `Intl.DateTimeFormat("en-US",{weekday:"short",month:"short",day:"numeric"})` + time); `membership_levels` renders price `$40.00` and a `<button data-join="LEVEL_ID">`; unknown type throws.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** renderers (one function per type, switch in `renderSection`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(site): section renderers with variants and style wrappers`.

### Task 5: Shell renderer — header/footer variants, menu, islands

**Files:**
- Modify: `src/lib/site/render.ts` (extend `RenderArgs`; keep `renderPageHtml` signature; add `renderSitePage`)
- Modify: `src/lib/site/render.test.ts`
- Modify: `src/lib/site/seo.ts` only if `buildSeoHead` needs the OG image from a section hero (add optional `ogImageUrl` fallback to the first hero image)

**Interfaces:**
```ts
export type SiteMenuItem = { label: string; href: string; external?: boolean; children?: SiteMenuItem[] };
export type SitePageArgs = {
  tenant: { name: string; slug: string; settings_json: string | null; tenant_type: "guild" | "business" };
  page: SeoPage & { sections: Section[]; membersOnly?: boolean };
  menu: SiteMenuItem[]; baseUrl: string; host: string; logoUrl?: string | null; ogImageUrl?: string | null;
  showPlatformCredit: boolean; design: SiteDesign; data: SiteData; imgUrl: RenderContext["imgUrl"];
  extraHead?: string;   // e.g. noindex while gated
};
export function renderSitePage(args: SitePageArgs): string;          // full document
export function renderPageHtml(args: RenderArgs): string;            // unchanged signature; now: sectionsFromPage(page) → renderSitePage
export function buildMenu(pages: {slug,title,nav_label,show_in_nav}[], settingsNav: NavItem[], baseUrl: string): SiteMenuItem[]; // settings nav wins; supports children via settings.nav[].children
```
Header variants: `left` (brand left, nav right, CTA last), `centered` (brand centered above nav), `split` (nav split around centered brand). `sticky` adds class; `overlayHero` adds class and the first section, when a `hero` with `bg:"image"`, gets `.qh-hero--under-header`. CTA per `design.header.cta`: join → `/membership` (guild) or first `join_band`; quote → `/request-a-quote` if a page with `quote_cta` exists else `/contact`; donate → `#donate`. Footer variants: `simple` (name + credit), `columns` (About: business identity or guild profile description; Links: menu; Members: Member sign-in link `/portal?slug=`; Contact), `meeting` (adds meeting when/where from `settings.profile`). Islands: emit `<script src="/qh-site.js" defer>` and `data-qh-slug`, `data-qh-base`, `data-qh-type` attributes on `<body>`. Utility row: "Member sign-in" and "Powered by QuiltHosting" (respecting `showPlatformCredit`) live in the footer, not the header.

- [ ] **Step 1: Write failing tests**: three header variants emit their classes; menu with children renders a nested `<ul class="qh-nav__menu">`; CTA resolves for guild join; footer `columns` includes member sign-in link; `overlayHero` adds `.qh-hero--under-header` only when the first section is an image hero; legacy `renderPageHtml` still renders a page with only `blocks_json` (regression: existing tests keep passing); no tenant string escapes unescaped (`<` in business name).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all `src/lib/site` tests → PASS.
- [ ] **Step 5: Commit** `feat(site): shell renderer with header/footer variants, nested menu, islands`.

### Task 6: Site data loaders for dynamic sections

**Files:**
- Create: `src/lib/site/data.ts`
- Test: `src/lib/site/data.test.ts`

**Interfaces:**
```ts
export type SiteData = {
  levels?: { id: string; name: string; description: string | null; price_cents: number; duration_months: number; renewal_type: string }[];
  events?: { id: string; title: string; start_at: string; end_at: string | null; location: string | null; description: string | null; member_price_cents: number; non_member_price_cents: number; registration_open: number; capacity: number | null }[];
  products?: { id: string; name: string; price_cents: number; description: string | null; image_file_id: string | null; stock: number | null }[];
  posts?: { slug: string; title: string; published_at: string; excerpt: string }[];
  galleries?: { slug: string; title: string; cover_photo_id: string | null; count: number }[];
  gallery?: { slug: string; title: string; description: string | null; photos: { id: string; caption: string | null }[] };
  profile?: { description?: string; meeting_info?: string; location?: string; website?: string; email?: string; donations_enabled?: boolean; directory_public?: boolean };
};
export type DataNeed = keyof SiteData;
export function needsFor(sections: Section[]): Set<DataNeed>;   // events→"events", membership_levels→"levels", store_teaser→"products", blog_teaser→"posts", gallery(source gallery)→"gallery"/"galleries", meeting_info/footer meeting→"profile"
export async function loadSiteData(env: Env, tenant: Tenant, needs: Set<DataNeed>, opts?: { gallerySlug?: string; limit?: number }): Promise<SiteData>;
```
Use ONE `env.DB.batch([...])` for all needed statements (D1 serializes per-request queries; batching is the perf rule established in commit 115cd50). Reuse the exact SQL from `src/routes/public.ts` `levelsPayload`/`eventsPayload`/`productsPayload`/`blogPayload`/galleries (refactor those to export the statement builders rather than duplicating SQL).

- [ ] **Step 1: Write failing tests** with a fake D1 recording `batch` statements: `needsFor` returns the right set; `loadSiteData` issues exactly one batch containing one statement per need; results map to the typed shapes; empty needs → no DB call.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (and `src/routes/public.test.ts` still green after the refactor).
- [ ] **Step 5: Commit** `feat(site): batched data loaders for dynamic sections`.

### Task 7: System pages as section stacks

**Files:**
- Create: `src/lib/site/pages/system.ts`
- Test: `src/lib/site/pages/system.test.ts`

**Interfaces:**
```ts
export type SystemPageKind = "membership" | "events" | "event" | "calendar" | "galleries" | "gallery" | "blog" | "post" | "members_only" | "not_found";
export function systemPageSections(kind: SystemPageKind, ctx: { tenant: Tenant; design: SiteDesign; data: SiteData; param?: string }): { title: string; sections: Section[]; noindex?: boolean; status?: number };
```
Stacks: `membership` → hero minimal (title "Membership", subtitle from profile) + `membership_levels` cards + `faq` if `settings.membership_faq` exists + `join_band`; `events` → hero minimal + `events` list (limit 50) + calendar link; `calendar` → `events` calendar variant; `event` → hero minimal (event title, date) + rich_text (description) + a `cta` "Register" with `data-register=ID` (rendered by the events renderer's detail mode: add `variant:"detail"` handling inside the `events` renderer keyed on `ctx.data.events.length===1 && param`); `galleries`/`gallery` → gallery sections from data; `blog`/`post` → blog_teaser list / rich_text; `members_only` → hero minimal + `cta` "Member sign-in" (href `/portal?slug=`) with `noindex: true`; `not_found` → hero minimal "Page not found" + cta home, `status: 404`.

- [ ] **Step 1: Write failing tests** for each kind: title, section types in order, `status` 404 for not_found, `noindex` for members_only.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(site): system pages as section stacks`.

### Task 8: `serveSite` for every tenant and the legacy flag

**Files:**
- Modify: `src/routes/site.ts` (add `serveSite`, keep `serveBusinessSite = serveSite`; extend `buildRenderArgs`)
- Modify: `src/index.ts` (host middleware: guild tenants → `serveSite` unless legacy; `/g/:slug/*` → `serveSite` with platform base path)
- Modify: `src/lib/platformPaths.ts` only if a new reserved path is needed (`/calendar` already reserved as a slug in pages.ts)
- Test: `src/routes/site.test.ts`, `src/lib/site/serve.test.ts` (new, routing table)

**Interfaces:**
```ts
export async function serveSite(c: Context<{ Bindings: Env }>, tenant: Tenant, opts?: { basePath?: string }): Promise<Response | null>;
// basePath "" on tenant hosts, "/g/<slug>" on the platform host; all internal links use ctx.baseUrl + path
export function useLegacyRenderer(tenant: Tenant): boolean; // settings.site.renderer === "legacy"; NEW guilds default to the new renderer; existing guild rows get {"site":{"renderer":"legacy"}} written by migration 0026 (data-only: UPDATE tenants SET settings_json = json_set(settings_json,'$.site.renderer','legacy') WHERE tenant_type='guild')
```
Routing inside `serveSite` (path after basePath): `/` → page `home` else composed default home (hero minimal from profile + membership_levels + events cards limit 3 + blog_teaser + page `home` sections) so every guild has a home; `/membership|/join|/join-renew` → system membership; `/events` → events; `/events/:id` → event; `/calendar` → calendar; `/galleries|/photos` → galleries; `/galleries/:slug` → gallery; `/blog` → blog; `/blog/:slug` → post; `/robots.txt`, `/sitemap.xml` (existing); `/qh-site.css`, `/qh-site.js` (existing); `/img/:id` (existing); `/:slug` → page (members-only pages → `members_only` stack when no portal session cookie/bearer; there is none on public HTML, so always the sign-in stack) ; slug miss → redirects (existing) → `not_found` (404). Cache: `cachedRender` with the existing key plus `tenant.updated_at` (theme changes bump it). The gate exemption logic in `siteGate.ts` (`isLaunchedSitePath`) must also allow `/membership`, `/events`, `/events/*`, `/calendar`, `/galleries`, `/galleries/*`, `/blog`, `/blog/*` on launched hosts — extend the allowlist and its tests.

- [ ] **Step 1: Write failing tests**: routing table (path → system kind or page); legacy flag returns null so index.ts falls back to `guild.html`; platform-host base path prefixes links; members-only page renders the sign-in stack and `noindex`; 404 status for unknown slug; `siteGate` allowlist covers the new paths on a launched tenant host.
- [ ] **Step 2–5:** FAIL → implement (+ `migrations/0026_site_renderer_flag.sql`) → PASS incl. `src/middleware/siteGate.test.ts` → commit `feat(site): serve guild and business sites through one renderer behind a legacy flag`.

### Task 9: Islands — `public/qh-site.js`

**Files:**
- Rewrite: `public/qh-site.js` (keep existing forms/events/store hydration; add modules)
- Modify: `public/qh-cal.js` only to export `window.qhCal.render(container, events, onClick)` if it doesn't already
- Test: `src/lib/site/islands.test.ts` (source assertions), Playwright script in scratchpad (not committed) for manual QA

Modules (each guarded by a DOM query so pages without the markup cost nothing): `nav` (toggle `.qh-drawer`, Escape closes, focus trap), `join` (`[data-join]` → dialog with name/email/custom fields from `/public/:slug/info` `join_fields`, POST `/public/:slug/join`, redirect to `checkout_url` or show success), `register` (`[data-register]` → dialog with event questions from `/public/:slug/events/:id`, POST `/register`), `cart`/`buy` (`[data-buy]`, `[data-add]` → POST `/products/:id/buy` or cart checkout — port from `guild.html`), `donate` (`[data-donate]` amounts → POST `/donate`), `calendar` (`.qh-events--calendar` → fetch month → `qhCal.render`), `lightbox` (`.qh-gallery a[data-lightbox]` → dialog with prev/next, keyboard), `volunteer` (`[data-volunteer]` → dialog → POST). All requests use `document.body.dataset.qhBase` for the API base and `qhSlug` for the slug. Dialogs are `<dialog>` elements created once and reused; every dialog has a close button and traps focus.

- [ ] **Step 1: Write failing source-assertion tests**: file defines the eight module names as functions; no `innerHTML =` with template literals containing `${` (DOM APIs only, matching qh-admin-ext.js's rule); every `fetch(` uses `qhBase`.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(site): interactive islands for the server-rendered site`.
- [ ] **Step 6: Browser QA** (scratchpad Playwright, Edge): on the local Worker with the seeded `smoke` guild set to the new renderer, click Join on `/membership`, Register on `/events`, open the phone drawer at 390 px, open a gallery lightbox. Record results in the commit message of Task 12.

### Task 10: Kit schema, validator, preview, authoring brief, reference kit

**Files:**
- Create: `src/lib/site/kits/schema.ts`, `src/lib/site/kits/apply.ts`, `src/lib/site/kits/index.ts`, `src/lib/site/kits/heritage.json`
- Create: `scripts/kits-validate.mjs`, `scripts/kits-preview.mjs`, `docs/KIT-AUTHORING.md`
- Modify: `package.json` scripts (`"kits:validate": "node scripts/kits-validate.mjs"`, `"kits:preview": "node scripts/kits-preview.mjs"`)
- Modify: `src/lib/starterSite.ts` (`starterPages` now = `applyKitPages("heritage", …)`; keep exported names)
- Test: `src/lib/site/kits/schema.test.ts`, `apply.test.ts`

**Interfaces:**
```ts
export type Kit = { id: string; name: string; audience: "guild" | "business" | "both"; character: string;
  defaults: Omit<SiteDesign, "palette"> & { palette: string /* palette id */ };
  pages: { slug: string; title: string; nav: boolean; navLabel?: string; membersOnly?: boolean; sections: Section[] }[];
  menu?: SiteMenuItem[]; imagery: { id: string; kind: "pattern" | "photo"; alt: string; src?: string }[]; previewSeed: { guildName: string; city: string } };
export const kitSchema: z.ZodType<Kit>;
export function validateKit(raw: unknown): { kit?: Kit; issues: { path: string; message: string }[] };  // schema + section/variant existence + palette/type-pair ids exist + no "lorem" + every imageId in imagery + every page slug not reserved (RESERVED_SLUGS from pages.ts) + contrast of the default palette
export const KITS: Kit[];                                     // registry (heritage only in phase 1)
export function kitById(id: string): Kit | null;
export function kitPageRows(kit: Kit, tenant: { id: string; name: string; city?: string; meetingInfo?: string }, now: string): PageInsert[]; // substitutes {{guild_name}}, {{city}}, {{meeting_info}}; marks copy with SAMPLE_MARKER; returns rows for the pages INSERT used by tenants.ts (same column list as starterPageRow)
export function kitSettingsJson(kit: Kit): string;             // {"design": <SiteDesign with palette input from the library>, "site": {"renderer": "sections", "kit": id}}
```
`scripts/kits-validate.mjs` imports the built registry via `npx tsx`-free approach: it runs `node --experimental-strip-types`? Not available on Node 22 without flag; instead compile-free path: the script spawns `npx vitest run src/lib/site/kits/schema.test.ts --reporter=dot` (the test iterates every kit file) — document this in the script header. `scripts/kits-preview.mjs`: starts `wrangler dev --port 8790`, applies each kit to a throwaway local tenant via the API, screenshots every page at 1366 and 390 with Playwright from the scratchpad dependency path given by `PLAYWRIGHT_PATH` env, writes `docs/kit-gallery/<kit>/<page>-<w>.png` and `docs/kit-gallery/index.html`.

`docs/KIT-AUTHORING.md` contains: purpose, the kit JSON schema with a complete annotated example (the heritage kit), the section catalogue (every type, variant, field, and what it renders), palette ids and type-pair ids, copy rules, imagery rules (pattern ids; photos must be supplied as files under `public/kit-assets/<kit>/` with a license note), how to validate (`npm run kits:validate`) and preview, and the PR checklist. Written so Codex/GLM can produce a kit with no other context.

- [ ] **Step 1: Write failing tests**: heritage kit validates with zero issues; a kit with an unknown section type / reserved slug / lorem / unknown palette reports the exact issue path; `kitPageRows` substitutes placeholders and includes the sample marker; `kitSettingsJson` parses to a `SiteDesign` via `readSiteDesign`.
- [ ] **Step 2–5:** FAIL → implement (author heritage.json with the eight pages from the spec, using phase-1 sections only) → PASS → commit `feat(kits): kit schema, validator, preview tooling, authoring brief, Heritage reference kit`.

### Task 11: Admin — Design panel (phase-1 subset) and the renderer switch

**Files:**
- Modify: `public/admin.html` (Website screen: add a "Design" card above "Look & feel" for guild tenants on the new renderer; replace the business Appearance tokens list with the same panel) and `public/qh-site-builder.js` (`renderTheme` delegates to the shared panel)
- Modify: `src/routes/tenants.ts` PATCH validation: accept `settings.design` (validate with a zod schema exported from `src/lib/site/design/tokens.ts`: `siteDesignSchema`) and `settings.site.renderer` ∈ {"legacy","sections"}; bump `updated_at` (already)
- Test: `src/routes/tenants.test.ts` (design validation), `src/lib/adminNavGating.test.ts` unchanged

Panel contents: **Design** — palette library as swatch tiles grouped by family (each tile shows bg/primary/accent/ink chips and the name; selected state), "Custom" with four color inputs and a live contrast readout ("Text on background 12.4:1 ✓"), type pair select with sample line rendered in the pair, shape (radius/shadow) and rhythm (spacing/container) as segmented controls, header variant + sticky + CTA, footer variant, pattern picker (five tiles rendered from `patternDataUri`), and a "Try the new design" / "Back to classic" switch for guilds still on legacy, with copy explaining it is reversible. Saving PATCHes `settings.design`. The editor canvas and preview already render through the server, so they pick up the design automatically after save; the canvas re-fetches `POST /preview` after the design is saved.

- [ ] **Step 1: Write failing test** in `tenants.test.ts`: PATCH with an invalid `settings.design.typePair` → 400 with issue path; valid design round-trips.
- [ ] **Step 2–5:** FAIL → implement server validation; implement the panel (DOM APIs, no innerHTML string templates for tenant data); `node --check` both inline scripts → PASS → commit `feat(admin): design panel (palettes, type, shape, rhythm, header, footer, pattern) and renderer switch`.

### Task 12: Migration of existing guilds, verification, deploy

**Files:**
- Create: `migrations/0026_site_renderer_flag.sql` (from Task 8; verify it is idempotent: only sets when `json_extract(settings_json,'$.site.renderer') IS NULL`)
- Modify: `docs/superpowers/specs/2026-09-08-site-design-system-and-kits-design.md` status line; `CLAUDE.md` architecture paragraph (one renderer, legacy flag)
- Modify: `package.json` + `src/version.ts` → `0.57.0-preview`

- [ ] **Step 1:** `npx tsc --noEmit` and `npx vitest run` green; `npx wrangler d1 migrations apply quilthosting-db --local` applies 0026.
- [ ] **Step 2:** Local browser pass (scratchpad Playwright): create a guild (gets Heritage kit on the new renderer) and screenshot `/g/<slug>`, `/membership`, `/events`, `/contact` at 1366 and 390; toggle an existing local guild to "Try the new design" and back; business site `stitchstudio` renders identically or better (compare screenshot heights, no console errors).
- [ ] **Step 3:** Commit `chore(release): v0.57.0-preview — site foundation`, push, `npm run db:migrate:remote`, `npx wrangler deploy`, verify `/api/version`, then verify `https://quilthosting.com/g/test-guild` still serves the classic shell (legacy flag) and a new test guild serves the new renderer.
- [ ] **Step 4:** Append the phase-1 implementation note to the spec (files, migration, evidence, residuals).

## Self-review

- Spec coverage: 4.1 renderer → Tasks 5, 8, 9; 4.2 tokens/palettes/type pairs → Task 2 (+ CSS Task 3); 4.3 sections (phase-1 subset of the library; the remaining sections — timeline, quote, officers, benefits, event_spotlight, projects, sponsors, newsletter_signup, services table, portfolio, hours_location, process, documents, donate — are phase 2 and the schema is designed to add them) → Tasks 1, 4; 4.4 system pages → Task 7; 4.5 imagery → phase 2 except the `imgUrl`/focal hooks in Tasks 1 and 4 and pattern art in Task 3; 4.6 kits → Task 10 (schema, validator, preview, brief, one reference kit; the other eleven are phase 3 / contributions); 4.7 navigation → Tasks 5, 9; 4.8 editor → Task 11 subset (Style tab is phase 2); 4.9 SEO/perf → existing `seo.ts` reused, budgets verified in Task 12; §5 migration → Tasks 8, 12.
- Type consistency: `Section`, `SectionStyle`, `SiteDesign`, `Roles`, `SiteData`, `SiteMenuItem`, `RenderContext`, `Kit` are defined once (Tasks 1, 2, 5, 6, 10) and referenced by those names elsewhere. `imgUrl` is provided by `serveSite`/preview callers, never computed in renderers.
- No placeholders: every task carries its interface, rules, and test list; implementers choose palette hex values and copy within the stated rules.
