# Website builder — draft/publish API contract

Developer reference for the page editor's server contract (`src/routes/pages.ts`, `src/lib/pageDrafts.ts`, `src/lib/blocks.ts`, `src/lib/sanitize.ts`). The end-user guide is [`/docs/website-builder.html`](../public/docs/website-builder.html).

All routes are mounted at `/api/tenants/:tenantId/pages` behind `requireAuth` + `requireTenantAccess` + the permission matrix. `pages` is writable by `owner`/`admin`/`platform`; `membership`/`events`/`viewer` may read everything and call `POST /preview` (the one write-method route open to readers).

## Data model (`migrations/0025_page_drafts.sql`)

| Column | Meaning |
|---|---|
| `blocks_json`, `title`, `slug`, `published`, … | Live page. |
| `draft_blocks_json` | `NULL` = no draft. Draft writes never touch live columns. |
| `draft_title`, `draft_updated_at` | Draft metadata. |
| `revision` | Monotonic version, default 1, bumped by every successful write. The CAS token. |
| `published_at` | Set on publish. |
| `deleted_at` | Soft delete (trash). Trashed rows keep their slug. |
| `page_revisions` | Snapshots: `kind ∈ publish | restore | pre_restore`, capped at `MAX_PAGE_REVISIONS = 50` per page. |
| `page_redirects (tenant_id, from_slug, to_slug)` | Slug-change redirects, single hop. |

`has_draft` in list responses = `draft_blocks_json IS NOT NULL`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/` (`?type=`, `?trash=1`) | List live pages, or trashed ones. |
| POST | `/preview` `{blocks}` | Renders unsaved blocks with the production `blocksToHtml` → `{html}`. Open to all reader roles. |
| GET / PATCH | `/site/settings` | Theme + nav (`nav` ≤ 20 items of `{label ≤60, href ≤500, external}`). **No body-size cap** on this route; hrefs are validated on render, not on write. |
| POST | `/` | Create. `published:false` from the editor; the legacy path may create published. |
| GET | `/:pageId` | Row plus parsed `blocks` and `draft_blocks`. |
| PATCH | `/:pageId` | Legacy live write / unpublish. CAS via `revision`. Writes slug redirects on rename. |
| DELETE | `/:pageId` | Soft delete: sets `deleted_at`, forces `published=0`, bumps `revision`. Idempotent. `?permanent=1` deletes the row, its revisions and its redirects. |
| POST | `/:pageId/restore` | Out of trash; page comes back **unpublished**. |
| PUT | `/:pageId/draft` `{title, blocks, revision}` | Autosave. Conditional UPDATE with the revision in the WHERE clause. |
| POST | `/:pageId/discard-draft` | Clears draft columns only. |
| POST | `/:pageId/publish` | Blocks source: body → stored draft → current live. Snapshots previous live as `publish`, promotes, clears draft, sets `published_at`, bumps `revision`, writes redirects, prunes history. |
| GET | `/:pageId/revisions` | Up to 50 (`kind`, title, timestamp, author, block count). |
| GET | `/:pageId/revisions/:rid` | One snapshot. |
| POST | `/:pageId/revisions/:rid/restore` | Snapshots current live as `pre_restore`, then writes the chosen revision **into the draft**. Live untouched. Pre-block-editor content is wrapped in one sanitized `html` block. |
| GET | `/:pageId/preview?source=draft|live` | Business tenants: a full HTML document built by the same `buildRenderArgs` + `renderPageHtml` as the live site; headers `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `X-Preview-Source`. Guild tenants: `{title, slug, html}` JSON, which the editor wraps in the site shell and renders in its own iframe. |

## Concurrency (CAS)

Every write may carry `revision` = the value the client last saw. On mismatch:

```
409 { "error": "Page was changed elsewhere", "revision": <current> }
```

Draft/discard use the guard in the WHERE clause; PATCH/publish/restore compare-and-swap inside a `DB.batch` and detect a lost race via `changes === 0`. A 409 **without** `revision` is a duplicate-slug conflict (`A page with that slug already exists`), which the editor distinguishes from a concurrency conflict. Any write to a trashed page returns `409 Page is in the trash; restore it first`.

## Validation

- Body limit `MAX_BODY_BYTES = 512 KiB` on every page write route (declared `Content-Length` first, then actual bytes) → `413 Request body exceeds 524288 bytes`. Non-JSON → `400 Request body must be valid JSON`.
- `title` 1–200 chars (trimmed); `slug` ≤120 before slugify (`[^a-z0-9]+` → `-`, trimmed); empty slug becomes `home`.
- Reserved slugs (400 `"<slug>" is a reserved path…`): `membership join join-renew events calendar galleries photos admin portal docs embed sites api t public g guild auth assets site-access privacy terms`. `home` is deliberately not reserved.
- `blocks`: array ≤200 by schema, but `parseBlocksStrict` rejects anything `parseBlocks` would truncate — i.e. >80 blocks → 400. Unknown `type` → field-level 400, never dropped silently.
- `seo_title` ≤70, `seo_description` ≤200, `nav_label` ≤60; `""`/`null` clears to SQL NULL, omitting the key leaves it unchanged.
- `content_html` ≤200,000 chars (legacy).

## Block schema (`src/lib/blocks.ts`)

`KNOWN_BLOCK_TYPES`: `heading text image button divider html join_cta events_list store_list spacer hero service_cards gallery_grid faq testimonials contact_form project_intake`. The server accepts every type for every tenant; the guild/business palette split is UI-only (`WB_GUILD_TYPES` / `WB_BUSINESS_TYPES` in `admin.html`).

Per-block clamps: heading text ≤200, level 1–3; text html ≤20,000 (sanitized); image url ≤2000 http(s), alt ≤200, caption ≤300; button label ≤80, href link-safe else `#`, style `primary|secondary`; html ≤50,000 sanitized with `allowEmbeds`; join_cta title ≤120, body ≤500; events_list/store_list limit 1–20; spacer 8–120 px; hero eyebrow ≤80, title ≤160, subtitle ≤300; service_cards ≤12 items; gallery_grid ≤40; faq ≤30; testimonials ≤20; contact_form formSlug ≤100; project_intake projectType ∈ `longarm|custom_quilt|tshirt_quilt`.

`events_list`, `store_list`, `contact_form`, `project_intake` render as empty hydration stubs (`<div class="qh-block-…" data-…>`) filled client-side by `public/qh-site.js`.

## Sanitizer (`src/lib/sanitize.ts`)

Allowlist tokenizer; output is re-serialized, never passed through. Allowed tags: `p br h1–h6 strong b em i u s del ins a ul ol li blockquote pre code img figure figcaption table thead tbody tfoot tr th td hr span div small sub sup mark`. Dropped with contents: `script style svg math template noscript object embed iframe textarea xmp plaintext title head frameset frame` (`iframe` re-allowed only with `allowEmbeds`). Always stripped: `on*`, `style`, `id`, `srcdoc`, `srcset`, `formaction`, any attribute containing `:`. URL schemes: links `http https mailto tel sms`; images `http https`. Embed hosts (https only): `www.youtube.com/embed/`, `www.youtube-nocookie.com/embed/`, `player.vimeo.com/video/`, `www.google.com/maps/embed`. `target=_blank` forces `rel="noopener noreferrer"`. Max nesting depth 64.

## Redirects

`slugRedirectStatements(tenantId, from, to)` on PATCH/publish rename: delete any redirect *from* the new slug, re-point every redirect that targeted the old slug at the new one, upsert old→new. Lookup is therefore single-hop. Business hosts answer `301` to `${baseUrl}/<newSlug>` (query preserved); guild `/g/<slug>/<page>` gets a `redirects` map from `GET /public/:slug/pages` for clients that still resolve slugs themselves. Trashing writes no redirect; permanent delete removes redirects touching the slug.

## Editor behaviour worth knowing

- Autosave 1500 ms after the last edit; a save already in flight queues one more 300 ms after it settles. Rich-text keystrokes are debounced 350 ms; the canvas re-render via `POST /preview` 600 ms.
- Pill states: Saved / Saving… / Unsaved changes / Add a title to save / Save failed — retry / Out of date / Read-only.
- Conflict banner: "Someone else changed this page — reload to see their version. Your unsaved edits here will be replaced."
- Preview widths: desktop 100 %, tablet 768 px, mobile 390 px. The business preview iframe is `sandbox="allow-scripts allow-same-origin allow-forms"`.
- Tenant image URLs (`/img/:id`, `/public/:slug/img/:id`) only resolve on the tenant host, so the admin canvas swaps them for authenticated blob URLs.
- `sort_order` and `og_image_file_id` are not exposed by the editor; all builder-created pages have `sort_order = 0`.

## Known inconsistencies

- Trashed pages keep their slug reserved; the duplicate check does not exclude `deleted_at IS NOT NULL`.
- Restore-from-trash leaves the page unpublished without saying so.
- Server-rendered placeholders for events/store/form blocks are blank on the canvas once the server HTML replaces the local preview.
- `starterSite.ts` header comment still says hero/faq are business-only; both are in the guild palette.
- API says "at most 80 blocks", editor says "80 sections".
