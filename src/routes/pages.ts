import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import {
  parseBlocks,
  blocksToHtml,
  contentFromPage,
  BUSINESS_BLOCK_TYPES,
  GUILD_ONLY_BLOCK_TYPES,
  type PageBlock,
} from "../lib/blocks";
import { PLATFORM_PATH_PREFIXES, PLATFORM_EXACT_PATHS } from "../lib/platformPaths";
import { isBusiness } from "../lib/tenantType";
import { renderPageHtml } from "../lib/site/render";
import { buildRenderArgs } from "./site";
import {
  type PageRecord,
  type PageRevisionRecord,
  blocksFromJson,
  revisionBlocks,
  revisionOf,
  serializePage,
  slugRedirectStatements,
  revisionSnapshotStatement,
  pruneRevisionsStatement,
  MAX_PAGE_REVISIONS,
} from "../lib/pageDrafts";

export const pageRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type Ctx = Context<{ Bindings: Env; Variables: TenantVariables }>;

type PageRow = PageRecord;

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------------------------------------------------------------------------
// Block types the API accepts.
//
// This list mirrors the `case` labels in parseBlocks (src/lib/blocks.ts).
// parseBlocks itself silently DROPS any block whose type it doesn't know,
// which is exactly the failure this route must not pass through: a customer
// who saves a page with a misspelled or not-yet-supported block type would
// get a 2xx and lose the block. So the request is validated against this
// list first and rejected with a field-level 400 naming the offending type.
//
// Drift guard: pages.test.ts asserts every entry here round-trips through
// parseBlocks with its `type` intact, and that every type the admin picker
// offers (BUSINESS_BLOCK_TYPES + GUILD_ONLY_BLOCK_TYPES) is present. Adding a
// case to parseBlocks without adding it here fails that test.
// ---------------------------------------------------------------------------
export const KNOWN_BLOCK_TYPES = [
  "heading",
  "text",
  "image",
  "button",
  "divider",
  "html",
  "join_cta",
  "events_list",
  "store_list",
  "spacer",
  "hero",
  "service_cards",
  "gallery_grid",
  "faq",
  "testimonials",
  "contact_form",
  "project_intake",
] as const;

const KNOWN_BLOCK_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_BLOCK_TYPES);

// Sanity: the admin block picker must never offer a type the API rejects.
for (const t of [...BUSINESS_BLOCK_TYPES, ...GUILD_ONLY_BLOCK_TYPES]) {
  if (!KNOWN_BLOCK_TYPE_SET.has(t)) {
    throw new Error(`pages.ts KNOWN_BLOCK_TYPES is missing picker block type "${t}"`);
  }
}

// ---------------------------------------------------------------------------
// Reserved slugs.
//
// A tenant page is served at "/<slug>" on the tenant's host. Some of those
// paths are already taken: the guild site's own routes (membership, join,
// events, calendar, ...) and every platform surface in platformPaths.ts
// (admin, portal, api, docs, ...). A page created at one of those slugs is
// either unreachable (the platform route wins) or shadows a platform
// surface, and either way the customer sees a page that "saved" but never
// renders. Reject at write time instead.
//
// "home" is deliberately NOT reserved: the business site builder designates
// the home page by saving it with the literal slug "home" (see the POST
// handler's slug comment and serveBusinessSite in src/routes/site.ts).
// ---------------------------------------------------------------------------
const GUILD_ROUTE_SLUGS = [
  "membership",
  "join",
  "join-renew",
  "events",
  "calendar",
  "galleries",
  "photos",
] as const;

/**
 * "/admin" -> "admin", "/api/" -> "api", "/privacy.html" -> null (a slug can
 * never contain a dot, so static files can't collide), "/__" -> null.
 */
function slugFromPlatformPath(path: string): string | null {
  const s = path.replace(/^\/+|\/+$/g, "");
  if (!s || s.startsWith("__") || s.includes(".") || s.includes("/")) return null;
  return s;
}

export const RESERVED_SLUGS: ReadonlySet<string> = new Set(
  [
    ...GUILD_ROUTE_SLUGS,
    ...PLATFORM_PATH_PREFIXES.map(slugFromPlatformPath),
    ...[...PLATFORM_EXACT_PATHS].map(slugFromPlatformPath),
  ].filter((s): s is string => !!s)
);

function reservedSlugError(c: Ctx, slug: string) {
  return c.json(
    {
      error: `"${slug}" is a reserved path and cannot be used as a page slug`,
      issues: [{ path: "slug", message: `"${slug}" is reserved` }],
    },
    400
  );
}

// ---------------------------------------------------------------------------
// Request validation.
// ---------------------------------------------------------------------------
const MAX_BODY_BYTES = 512 * 1024;
const MAX_BLOCKS = 200;

const blockSchema = z
  .object({
    type: z.string().refine((t) => KNOWN_BLOCK_TYPE_SET.has(t), (t) => ({
      message: `Unsupported block type "${t}"`,
    })),
  })
  .passthrough();

/** "" and null both mean "clear"; absent means "leave unchanged" (PATCH). */
const clearableText = (max: number) => z.string().max(max).nullable().optional();

const blocksSchema = z.array(blockSchema).max(MAX_BLOCKS);

/** Optimistic-concurrency token: the `revision` the client last saw. */
const revisionSchema = z.number().int().nonnegative().optional();

const pageFields = {
  slug: z.string().max(120).optional(),
  content_html: z.string().max(200_000).optional(),
  blocks: blocksSchema.optional(),
  page_type: z.enum(["page", "blog_post"]).optional(),
  is_members_only: z.boolean().optional(),
  published: z.boolean().optional(),
  show_in_nav: z.boolean().optional(),
  noindex: z.boolean().optional(),
  sort_order: z.number().int().finite().optional(),
  nav_label: clearableText(60),
  seo_title: clearableText(70),
  seo_description: clearableText(200),
};

const titleSchema = z.string().trim().min(1, "title is required").max(200);

const createSchema = z.object({ title: titleSchema, ...pageFields });
const patchSchema = z.object({
  title: titleSchema.optional(),
  revision: revisionSchema,
  ...pageFields,
});
// Publish never takes raw content_html: content_json is always derived from
// the blocks being published.
const publishSchema = patchSchema.omit({ content_html: true });
const draftSchema = z.object({
  title: titleSchema.optional(),
  blocks: blocksSchema,
  revision: revisionSchema,
});
const previewSchema = z.object({ blocks: blocksSchema });
const revisionOnlySchema = z.object({ revision: revisionSchema });

type CreateBody = z.infer<typeof createSchema>;
type PatchBody = z.infer<typeof patchSchema>;
type PublishBody = z.infer<typeof publishSchema>;

/** Trim; "" and null both collapse to NULL. */
function cleanOptionalText(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t || null;
}

type BodyResult = { ok: true; json: unknown } | { ok: false; response: Response };

/**
 * Reads the JSON body with a hard size cap. Checks the declared
 * content-length first (cheap reject) and then the actual bytes read, since
 * the header is optional and untrusted. An empty body is `{}` so action
 * endpoints (publish, discard, restore) can be POSTed without one.
 */
async function readJsonBody(c: Ctx): Promise<BodyResult> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: bodyTooLarge(c) };
  }
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: bodyTooLarge(c) };
  }
  if (!text.trim()) return { ok: true, json: {} };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: c.json({ error: "Request body must be valid JSON" }, 400),
    };
  }
}

function bodyTooLarge(c: Ctx) {
  return c.json(
    { error: `Request body exceeds ${MAX_BODY_BYTES} bytes` },
    413
  );
}

function validationError(c: Ctx, error: z.ZodError) {
  return c.json(
    {
      error: "Invalid request body",
      issues: error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    },
    400
  );
}

/**
 * Runs parseBlocks over an already schema-validated array and refuses to
 * proceed if anything was dropped. Every element has a known type at this
 * point, so a count mismatch means parseBlocks discarded something (its
 * internal 80-block cap, or a new drop rule added there) -- and silently
 * saving fewer blocks than the customer sent is the bug this route exists
 * to prevent.
 */
function parseBlocksStrict(c: Ctx, raw: unknown[]): { ok: true; blocks: PageBlock[] } | { ok: false; response: Response } {
  const blocks = parseBlocks(raw);
  if (blocks.length !== raw.length) {
    return {
      ok: false,
      response: c.json(
        {
          error: "Invalid request body",
          issues: [
            {
              path: "blocks",
              message: `Only ${blocks.length} of ${raw.length} blocks can be stored; reduce the page to at most 80 blocks`,
            },
          ],
        },
        400
      ),
    };
  }
  return { ok: true, blocks };
}

function dbFailure(c: Ctx, what: string, err: unknown) {
  const tenant = c.get("tenant");
  console.error(`[pages] ${what} failed`, {
    tenantId: tenant?.id,
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json({ error: `Failed to ${what}` }, 500);
}

// ---------------------------------------------------------------------------
// Shared row access + concurrency helpers.
// ---------------------------------------------------------------------------

const SELECT_PAGE = "SELECT * FROM pages WHERE id = ? AND tenant_id = ?";

async function loadPage(c: Ctx, pageId: string): Promise<PageRow | null> {
  const tenant = c.get("tenant");
  return first<PageRow>(c.env.DB.prepare(SELECT_PAGE).bind(pageId, tenant.id));
}

function notFound(c: Ctx) {
  return c.json({ error: "Page not found" }, 404);
}

function trashed(c: Ctx) {
  return c.json({ error: "Page is in the trash; restore it first" }, 409);
}

/** 409 payload carrying the revision the client must re-fetch. */
function revisionConflict(c: Ctx, current: number) {
  return c.json({ error: "Page was changed elsewhere", revision: current }, 409);
}

/** Current stored revision after a compare-and-swap lost (re-read). */
async function currentRevision(c: Ctx, pageId: string): Promise<number> {
  const row = await loadPage(c, pageId);
  return row ? revisionOf(row) : 0;
}

/** requireAuth puts the caller on context; TenantVariables doesn't type it. */
function actorId(c: Ctx): string | null {
  const u = (c as unknown as { get(key: string): unknown }).get("user") as
    | { id?: string }
    | undefined;
  return u?.id ?? null;
}

/** D1 reports 0 changes when a CAS predicate failed; a missing meta is "unknown", not a loss. */
function lostRace(result: { meta?: { changes?: number } } | undefined): boolean {
  return result?.meta?.changes === 0;
}

/**
 * Slug normalisation shared by PATCH and publish. Same home-page rule as
 * POST: a blank/unslugifiable explicit slug becomes "home" (serveBusinessSite
 * only ever looks up the literal "home"). Returns the slug to write (or null
 * for "unchanged"), or an error response.
 */
async function resolveSlugChange(
  c: Ctx,
  existing: PageRow,
  requested: string | undefined
): Promise<{ ok: true; slug: string | null } | { ok: false; response: Response }> {
  if (requested === undefined) return { ok: true, slug: null };
  const tenant = c.get("tenant");
  const next = slugify(requested) || "home";
  if (next === existing.slug) return { ok: true, slug: next };
  if (RESERVED_SLUGS.has(next)) return { ok: false, response: reservedSlugError(c, next) };
  const dupe = await first(
    c.env.DB.prepare(
      "SELECT id FROM pages WHERE tenant_id = ? AND slug = ? AND id != ?"
    ).bind(tenant.id, next, existing.id)
  );
  if (dupe) {
    return { ok: false, response: c.json({ error: "A page with that slug already exists" }, 409) };
  }
  return { ok: true, slug: next };
}

type Setter = (column: string, value: unknown) => void;

/** Metadata columns: provided -> written; absent -> untouched; ""/null -> NULL. */
function applyMetadata(body: PatchBody | PublishBody, set: Setter) {
  if (body.page_type !== undefined) set("page_type", body.page_type);
  if (body.is_members_only !== undefined) set("is_members_only", body.is_members_only ? 1 : 0);
  if (body.sort_order !== undefined) set("sort_order", body.sort_order);
  if (body.show_in_nav !== undefined) set("show_in_nav", body.show_in_nav ? 1 : 0);
  if (body.noindex !== undefined) set("noindex", body.noindex ? 1 : 0);
  if (body.nav_label !== undefined) set("nav_label", cleanOptionalText(body.nav_label));
  if (body.seo_title !== undefined) set("seo_title", cleanOptionalText(body.seo_title));
  if (body.seo_description !== undefined) {
    set("seo_description", cleanOptionalText(body.seo_description));
  }
}

// ---------------------------------------------------------------------------
// Routes. Static paths (/preview, /site/settings) are registered before the
// /:pageId family so no page id can shadow them.
// ---------------------------------------------------------------------------

// GET /api/tenants/:tenantId/pages[?type=page|blog_post][&trash=1]
pageRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const type = c.req.query("type"); // page | blog_post
  const trash = c.req.query("trash") === "1";
  let sql = `SELECT id, slug, title, content_json, blocks_json, page_type, show_in_nav, nav_label,
                    is_members_only, published, sort_order, seo_title, seo_description,
                    coalesce(noindex, 0) AS noindex, updated_at, created_at,
                    revision, published_at, draft_updated_at, deleted_at,
                    CASE WHEN draft_blocks_json IS NOT NULL THEN 1 ELSE 0 END AS has_draft
             FROM pages WHERE tenant_id = ?
               AND deleted_at IS ${trash ? "NOT NULL" : "NULL"}`;
  const binds: string[] = [tenant.id];
  if (type === "blog_post" || type === "page") {
    sql += ` AND coalesce(page_type, 'page') = ?`;
    binds.push(type);
  }
  sql += ` ORDER BY sort_order, title`;
  // No "pre-migration" fallback: every migration through 0025 is applied in
  // production, so a failure here is a real error and must surface as one
  // rather than as a silently narrower result set.
  try {
    const rows = await all<PageRow & { has_draft: number }>(c.env.DB.prepare(sql).bind(...binds));
    return c.json(rows.map((r) => ({ ...r, revision: revisionOf(r) })));
  } catch (err) {
    return dbFailure(c, "list pages", err);
  }
});

// POST /api/tenants/:tenantId/pages/preview — render unsaved editor state.
// Writes nothing; permissions.ts opens this one sub-path to every tenant
// role (an events chair previewing a page she can't publish).
pageRoutes.post("/preview", async (c) => {
  const raw = await readJsonBody(c);
  if (!raw.ok) return raw.response;
  const parsed = previewSchema.safeParse(raw.json);
  if (!parsed.success) return validationError(c, parsed.error);
  const strict = parseBlocksStrict(c, parsed.data.blocks);
  if (!strict.ok) return strict.response;
  return c.json(
    { html: blocksToHtml(strict.blocks) },
    200,
    { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
  );
});

/** Site theme + custom nav links stored on tenant settings_json */
pageRoutes.get("/site/settings", async (c) => {
  const tenant = c.get("tenant");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  return c.json({
    theme: settings.theme || {},
    nav: settings.nav || [],
  });
});

pageRoutes.patch("/site/settings", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{ theme?: unknown; nav?: unknown }>();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  if (body.theme !== undefined) settings.theme = body.theme;
  if (body.nav !== undefined) {
    const nav = Array.isArray(body.nav)
      ? body.nav
          .map((n: any) => ({
            label: String(n.label || "").slice(0, 60),
            href: String(n.href || "").slice(0, 500),
            external: !!n.external,
          }))
          .filter((n: any) => n.label && n.href)
          .slice(0, 20)
      : [];
    settings.nav = nav;
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(JSON.stringify(settings), now, tenant.id)
    .run();
  return c.json({ theme: settings.theme || {}, nav: settings.nav || [] });
});

// POST /api/tenants/:tenantId/pages
pageRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const raw = await readJsonBody(c);
  if (!raw.ok) return raw.response;
  const parsed = createSchema.safeParse(raw.json);
  if (!parsed.success) return validationError(c, parsed.error);
  const body: CreateBody = parsed.data;

  // slug: an explicit body.slug (even "") lets the business site builder
  // designate the home page -- site.ts's home lookup only ever matches the
  // literal slug "home" (see serveBusinessSite), so a blank/unslugifiable
  // explicit slug is normalized to "home" rather than "". Callers that don't
  // send slug at all (the older guild page builder in admin.html) keep the
  // original title-derived behavior unchanged.
  const slug =
    body.slug !== undefined ? slugify(body.slug) || "home" : slugify(body.title);
  if (body.slug === undefined && !slug) {
    return c.json(
      {
        error: "title must contain letters or numbers",
        issues: [{ path: "title", message: "title must contain letters or numbers" }],
      },
      400
    );
  }
  if (RESERVED_SLUGS.has(slug)) return reservedSlugError(c, slug);

  let blocks: PageBlock[] = [];
  if (body.blocks !== undefined) {
    const strict = parseBlocksStrict(c, body.blocks);
    if (!strict.ok) return strict.response;
    blocks = strict.blocks;
  }

  const dupe = await first(
    c.env.DB.prepare(
      "SELECT id FROM pages WHERE tenant_id = ? AND slug = ?"
    ).bind(tenant.id, slug)
  );
  if (dupe) return c.json({ error: "A page with that slug already exists" }, 409);

  const id = generateId();
  const now = new Date().toISOString();
  // content_json is the legacy/plain-HTML view of the page. When the caller
  // gives blocks but no content_html, snapshot the rendered blocks into it so
  // readers that only know content_json (older portal code) see the current
  // content instead of an empty page.
  const contentJson = JSON.stringify({
    html:
      body.content_html !== undefined
        ? body.content_html
        : blocks.length
          ? blocksToHtml(blocks)
          : "",
  });
  const pageType = body.page_type === "blog_post" ? "blog_post" : "page";
  const published = body.published === false ? 0 : 1;

  // Single statement, no fallback. All migrations through 0025 are applied
  // in production; the old "retry with the pre-migration column set" path
  // would have reported 201 while discarding blocks, SEO, nav and page_type.
  //
  // A page created with published:false still stores its live blocks_json:
  // an unpublished page is simply not public, it is not a draft.
  try {
    await c.env.DB.prepare(
      `INSERT INTO pages
       (id, tenant_id, slug, title, content_json, blocks_json, page_type, show_in_nav, nav_label,
        is_members_only, published, sort_order, seo_title, seo_description, noindex,
        created_at, updated_at, revision, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenant.id,
        slug,
        body.title,
        contentJson,
        blocks.length ? JSON.stringify(blocks) : null,
        pageType,
        body.show_in_nav === false ? 0 : 1,
        cleanOptionalText(body.nav_label ?? null),
        body.is_members_only ? 1 : 0,
        published,
        body.sort_order ?? 0,
        cleanOptionalText(body.seo_title ?? null),
        cleanOptionalText(body.seo_description ?? null),
        body.noindex ? 1 : 0,
        now,
        now,
        1,
        published ? now : null
      )
      .run();
  } catch (err) {
    return dbFailure(c, "create page", err);
  }
  const page = await first<PageRow>(
    c.env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id)
  );
  return c.json({ ...page, revision: page ? revisionOf(page) : 1 }, 201);
});

// GET /api/tenants/:tenantId/pages/:pageId — full row incl. draft (trashed rows included)
pageRoutes.get("/:pageId", async (c) => {
  const row = await loadPage(c, c.req.param("pageId"));
  if (!row) return notFound(c);
  return c.json(serializePage(row));
});

// PATCH /api/tenants/:tenantId/pages/:pageId — legacy live write
pageRoutes.patch("/:pageId", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const existing = await loadPage(c, pageId);
  if (!existing) return notFound(c);
  if (existing.deleted_at) return trashed(c);

  const raw = await readJsonBody(c);
  if (!raw.ok) return raw.response;
  const parsed = patchSchema.safeParse(raw.json);
  if (!parsed.success) return validationError(c, parsed.error);
  const body: PatchBody = parsed.data;

  const expected = revisionOf(existing);
  if (body.revision !== undefined && body.revision !== expected) {
    return revisionConflict(c, expected);
  }

  const slugChange = await resolveSlugChange(c, existing, body.slug);
  if (!slugChange.ok) return slugChange.response;
  const nextSlug = slugChange.slug;

  // Every column is either "provided -> written" or "absent -> untouched".
  // The previous coalesce(?, col) form could not tell "clear this" apart
  // from "leave it alone": seo_title: "" became NULL in the bind, coalesce
  // kept the old value, and the customer's clear was lost with a 200.
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set: Setter = (column, value) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };

  if (body.title !== undefined) set("title", body.title);
  if (nextSlug !== null) set("slug", nextSlug);

  // Content. Three cases, in priority order:
  //   1. content_html given            -> content_json = { html: content_html }
  //   2. blocks given, non-empty       -> content_json = { html: blocksToHtml(blocks) }
  //      (snapshot for readers that only know content_json)
  //   3. blocks given, empty ([])      -> content_json = { html: "" }
  //      Without this, contentFromPage would fall back to whatever legacy
  //      HTML was still sitting in content_json and a page the customer
  //      emptied would resurrect its old content.
  if (body.blocks !== undefined) {
    const strict = parseBlocksStrict(c, body.blocks);
    if (!strict.ok) return strict.response;
    const blocks = strict.blocks;
    set("blocks_json", blocks.length ? JSON.stringify(blocks) : null);
    if (body.content_html !== undefined) {
      set("content_json", JSON.stringify({ html: body.content_html }));
    } else {
      set("content_json", JSON.stringify({ html: blocks.length ? blocksToHtml(blocks) : "" }));
    }
  } else if (body.content_html !== undefined) {
    set("content_json", JSON.stringify({ html: body.content_html }));
  }

  if (body.published !== undefined) set("published", body.published ? 1 : 0);
  applyMetadata(body, set);

  const now = new Date().toISOString();
  set("updated_at", now);
  set("revision", expected + 1);

  // Single UPDATE, compare-and-swapped on the revision we read: a write that
  // landed in between (another tab's autosave/publish) makes this one lose
  // with a 409 instead of silently overwriting it. A slug rename rides in
  // the same batch as its redirect rows.
  const update = c.env.DB.prepare(
    `UPDATE pages SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ? AND revision = ?`
  ).bind(...binds, pageId, tenant.id, expected);
  const redirects =
    nextSlug !== null && nextSlug !== existing.slug
      ? slugRedirectStatements(c.env.DB, tenant.id, existing.slug, nextSlug, now)
      : [];
  try {
    const results = await c.env.DB.batch([update, ...redirects]);
    if (lostRace(results[0])) return revisionConflict(c, await currentRevision(c, pageId));
  } catch (err) {
    return dbFailure(c, "update page", err);
  }

  const page = await first<PageRow>(
    c.env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(pageId)
  );
  const out = { ...page, revision: page ? revisionOf(page) : expected + 1 };
  if (nextSlug !== null && nextSlug !== existing.slug) {
    return c.json({ ...out, previous_slug: existing.slug });
  }
  return c.json(out);
});

// DELETE /api/tenants/:tenantId/pages/:pageId[?permanent=1]
pageRoutes.delete("/:pageId", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const existing = await loadPage(c, pageId);
  if (!existing) return notFound(c);
  const now = new Date().toISOString();

  if (c.req.query("permanent") === "1") {
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `DELETE FROM page_revisions WHERE tenant_id = ? AND page_id = ?`
        ).bind(tenant.id, pageId),
        // Redirects into a page that no longer exists would 301 to a 404.
        c.env.DB.prepare(
          `DELETE FROM page_redirects WHERE tenant_id = ? AND (to_slug = ? OR from_slug = ?)`
        ).bind(tenant.id, existing.slug, existing.slug),
        c.env.DB.prepare(`DELETE FROM pages WHERE id = ? AND tenant_id = ?`).bind(
          pageId,
          tenant.id
        ),
      ]);
    } catch (err) {
      return dbFailure(c, "delete page", err);
    }
    return c.json({ ok: true, permanent: true });
  }

  // Soft delete: unpublish + timestamp. Idempotent on an already-trashed
  // page (deleted_at keeps its first value).
  try {
    await c.env.DB.prepare(
      `UPDATE pages SET deleted_at = ?, published = 0, revision = revision + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
    )
      .bind(now, now, pageId, tenant.id)
      .run();
  } catch (err) {
    return dbFailure(c, "delete page", err);
  }
  return c.json({ ok: true, deleted_at: existing.deleted_at || now });
});

// POST /api/tenants/:tenantId/pages/:pageId/restore — undelete (stays unpublished)
pageRoutes.post("/:pageId/restore", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const existing = await loadPage(c, pageId);
  if (!existing) return notFound(c);
  if (existing.deleted_at) {
    const now = new Date().toISOString();
    try {
      await c.env.DB.prepare(
        `UPDATE pages SET deleted_at = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL`
      )
        .bind(now, pageId, tenant.id)
        .run();
    } catch (err) {
      return dbFailure(c, "restore page", err);
    }
  }
  const page = await loadPage(c, pageId);
  if (!page) return notFound(c);
  return c.json(serializePage(page));
});

// PUT /api/tenants/:tenantId/pages/:pageId/draft — autosave (one UPDATE)
pageRoutes.put("/:pageId/draft", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const raw = await readJsonBody(c);
  if (!raw.ok) return raw.response;
  const parsed = draftSchema.safeParse(raw.json);
  if (!parsed.success) return validationError(c, parsed.error);
  const body = parsed.data;
  const strict = parseBlocksStrict(c, body.blocks);
  if (!strict.ok) return strict.response;

  const now = new Date().toISOString();
  // Cheap by design: no pre-read, no revision snapshot. The optional
  // revision guard and the trash check both live in the WHERE clause, and
  // RETURNING hands back the bumped revision. Only on a miss do we read the
  // row to say WHY (404 / trashed / 409).
  const guard = body.revision !== undefined ? " AND revision = ?" : "";
  const binds: unknown[] = [
    JSON.stringify(strict.blocks),
    body.title ?? null,
    now,
    pageId,
    tenant.id,
  ];
  if (body.revision !== undefined) binds.push(body.revision);
  let row: { revision: number; draft_updated_at: string } | null;
  try {
    row = await first<{ revision: number; draft_updated_at: string }>(
      c.env.DB.prepare(
        `UPDATE pages SET draft_blocks_json = ?, draft_title = ?, draft_updated_at = ?, revision = revision + 1
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${guard}
         RETURNING revision, draft_updated_at`
      ).bind(...binds)
    );
  } catch (err) {
    return dbFailure(c, "save draft", err);
  }
  if (!row) {
    const existing = await loadPage(c, pageId);
    if (!existing) return notFound(c);
    if (existing.deleted_at) return trashed(c);
    return revisionConflict(c, revisionOf(existing));
  }
  return c.json({
    ok: true,
    revision: revisionOf(row),
    draft_updated_at: row.draft_updated_at,
    has_draft: 1,
  });
});

// POST /api/tenants/:tenantId/pages/:pageId/discard-draft
pageRoutes.post("/:pageId/discard-draft", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const raw = await readJsonBody(c);
  if (!raw.ok) return raw.response;
  const parsed = revisionOnlySchema.safeParse(raw.json);
  if (!parsed.success) return validationError(c, parsed.error);
  const guard = parsed.data.revision !== undefined ? " AND revision = ?" : "";
  const binds: unknown[] = [pageId, tenant.id];
  if (parsed.data.revision !== undefined) binds.push(parsed.data.revision);
  let row: { revision: number } | null;
  try {
    row = await first<{ revision: number }>(
      c.env.DB.prepare(
        `UPDATE pages SET draft_blocks_json = NULL, draft_title = NULL, draft_updated_at = NULL, revision = revision + 1
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${guard}
         RETURNING revision`
      ).bind(...binds)
    );
  } catch (err) {
    return dbFailure(c, "discard draft", err);
  }
  if (!row) {
    const existing = await loadPage(c, pageId);
    if (!existing) return notFound(c);
    if (existing.deleted_at) return trashed(c);
    return revisionConflict(c, revisionOf(existing));
  }
  return c.json({ ok: true, revision: revisionOf(row), has_draft: 0 });
});

// POST /api/tenants/:tenantId/pages/:pageId/publish
pageRoutes.post("/:pageId/publish", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const existing = await loadPage(c, pageId);
  if (!existing) return notFound(c);
  if (existing.deleted_at) return trashed(c);

  const raw = await readJsonBody(c);
  if (!raw.ok) return raw.response;
  const parsed = publishSchema.safeParse(raw.json);
  if (!parsed.success) return validationError(c, parsed.error);
  const body: PublishBody = parsed.data;

  const expected = revisionOf(existing);
  if (body.revision !== undefined && body.revision !== expected) {
    return revisionConflict(c, expected);
  }

  // What gets published, in priority order: explicit blocks in the body,
  // else the stored draft, else the current live content (metadata-only
  // republish).
  let source: "body" | "draft" | "live";
  let blocks: PageBlock[];
  if (body.blocks !== undefined) {
    const strict = parseBlocksStrict(c, body.blocks);
    if (!strict.ok) return strict.response;
    blocks = strict.blocks;
    source = "body";
  } else if (existing.draft_blocks_json != null) {
    blocks = blocksFromJson(existing.draft_blocks_json);
    source = "draft";
  } else {
    blocks = blocksFromJson(existing.blocks_json);
    source = "live";
  }
  const title =
    body.title ?? (source === "draft" ? existing.draft_title || existing.title : existing.title);

  const slugChange = await resolveSlugChange(c, existing, body.slug);
  if (!slugChange.ok) return slugChange.response;
  const nextSlug = slugChange.slug;

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set: Setter = (column, value) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };

  set("title", title);
  if (nextSlug !== null) set("slug", nextSlug);
  // A live republish of a legacy page (no blocks, only content_json HTML)
  // must not blank its content; every other case re-renders from blocks.
  if (source !== "live" || blocks.length) {
    set("blocks_json", blocks.length ? JSON.stringify(blocks) : null);
    set("content_json", JSON.stringify({ html: blocks.length ? blocksToHtml(blocks) : "" }));
  }
  applyMetadata(body, set);
  const now = new Date().toISOString();
  set("published", body.published === false ? 0 : 1);
  set("published_at", now);
  set("updated_at", now);
  set("revision", expected + 1);
  // Draft columns are cleared as literals (not binds) so the SET list stays
  // "provided columns only" for everything else.
  const clearDraft = "draft_blocks_json = NULL, draft_title = NULL, draft_updated_at = NULL";

  const statements: D1PreparedStatement[] = [
    // (1) History = what was live BEFORE this publish. Conditional on the
    //     same revision the UPDATE below is CAS'd on, so a lost race leaves
    //     no orphan snapshot.
    revisionSnapshotStatement(c.env.DB, {
      id: generateId(),
      tenantId: tenant.id,
      page: existing,
      kind: "publish",
      createdBy: actorId(c),
      now,
      expectedRevision: expected,
    }),
    // (2) Promote.
    c.env.DB.prepare(
      `UPDATE pages SET ${sets.join(", ")}, ${clearDraft} WHERE id = ? AND tenant_id = ? AND revision = ?`
    ).bind(...binds, pageId, tenant.id, expected),
    // (3) Slug rename -> redirect rows.
    ...(nextSlug !== null && nextSlug !== existing.slug
      ? slugRedirectStatements(c.env.DB, tenant.id, existing.slug, nextSlug, now)
      : []),
    // (4) Keep the newest MAX_PAGE_REVISIONS.
    pruneRevisionsStatement(c.env.DB, tenant.id, pageId),
  ];

  try {
    const results = await c.env.DB.batch(statements);
    if (lostRace(results[1])) return revisionConflict(c, await currentRevision(c, pageId));
  } catch (err) {
    return dbFailure(c, "publish page", err);
  }

  const page = await loadPage(c, pageId);
  if (!page) return notFound(c);
  const out = serializePage(page);
  if (nextSlug !== null && nextSlug !== existing.slug) out.previous_slug = existing.slug;
  return c.json(out);
});

// GET /api/tenants/:tenantId/pages/:pageId/revisions — newest first, no bodies
pageRoutes.get("/:pageId/revisions", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const existing = await loadPage(c, pageId);
  if (!existing) return notFound(c);
  try {
    const rows = await all<{
      id: string;
      kind: string;
      title: string;
      created_at: string;
      created_by: string | null;
      created_by_name: string | null;
      block_count: number;
    }>(
      c.env.DB.prepare(
        `SELECT r.id, r.kind, r.title, r.created_at, r.created_by,
                coalesce(u.name, u.email) AS created_by_name,
                CASE WHEN r.blocks_json IS NULL THEN 0 ELSE json_array_length(r.blocks_json) END AS block_count
         FROM page_revisions r
         LEFT JOIN users u ON u.id = r.created_by
         WHERE r.tenant_id = ? AND r.page_id = ?
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ${MAX_PAGE_REVISIONS}`
      ).bind(tenant.id, pageId)
    );
    return c.json(rows);
  } catch (err) {
    return dbFailure(c, "list revisions", err);
  }
});

async function loadRevision(c: Ctx, pageId: string, rid: string): Promise<PageRevisionRecord | null> {
  const tenant = c.get("tenant");
  return first<PageRevisionRecord>(
    c.env.DB.prepare(
      `SELECT * FROM page_revisions WHERE id = ? AND page_id = ? AND tenant_id = ?`
    ).bind(rid, pageId, tenant.id)
  );
}

// GET /api/tenants/:tenantId/pages/:pageId/revisions/:rid — full revision
pageRoutes.get("/:pageId/revisions/:rid", async (c) => {
  const rev = await loadRevision(c, c.req.param("pageId"), c.req.param("rid"));
  if (!rev) return c.json({ error: "Revision not found" }, 404);
  return c.json({ ...rev, blocks: revisionBlocks(rev) });
});

// POST /api/tenants/:tenantId/pages/:pageId/revisions/:rid/restore
// Loads the revision INTO THE DRAFT (live is untouched) after snapshotting
// the current live content as 'pre_restore', so the admin previews before
// publishing.
pageRoutes.post("/:pageId/revisions/:rid/restore", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const existing = await loadPage(c, pageId);
  if (!existing) return notFound(c);
  if (existing.deleted_at) return trashed(c);
  const raw = await readJsonBody(c);
  if (!raw.ok) return raw.response;
  const parsed = revisionOnlySchema.safeParse(raw.json);
  if (!parsed.success) return validationError(c, parsed.error);
  const expected = revisionOf(existing);
  if (parsed.data.revision !== undefined && parsed.data.revision !== expected) {
    return revisionConflict(c, expected);
  }
  const rev = await loadRevision(c, pageId, c.req.param("rid"));
  if (!rev) return c.json({ error: "Revision not found" }, 404);

  const now = new Date().toISOString();
  const blocks = revisionBlocks(rev);
  try {
    const results = await c.env.DB.batch([
      revisionSnapshotStatement(c.env.DB, {
        id: generateId(),
        tenantId: tenant.id,
        page: existing,
        kind: "pre_restore",
        createdBy: actorId(c),
        now,
        expectedRevision: expected,
      }),
      c.env.DB.prepare(
        `UPDATE pages SET draft_blocks_json = ?, draft_title = ?, draft_updated_at = ?, revision = ?
         WHERE id = ? AND tenant_id = ? AND revision = ?`
      ).bind(JSON.stringify(blocks), rev.title, now, expected + 1, pageId, tenant.id, expected),
      pruneRevisionsStatement(c.env.DB, tenant.id, pageId),
    ]);
    if (lostRace(results[1])) return revisionConflict(c, await currentRevision(c, pageId));
  } catch (err) {
    return dbFailure(c, "restore revision", err);
  }
  return c.json({
    ok: true,
    revision: expected + 1,
    draft_updated_at: now,
    has_draft: 1,
    restored_from: rev.id,
  });
});

// GET /api/tenants/:tenantId/pages/:pageId/preview?source=draft|live
// Business tenants: full-page HTML for an iframe (same renderer as the live
// site). Guild tenants: { title, html, slug } JSON -- guild.html paints the
// preview client-side.
pageRoutes.get("/:pageId/preview", async (c) => {
  const tenant = c.get("tenant");
  const row = await loadPage(c, c.req.param("pageId"));
  if (!row) return notFound(c);

  const wantDraft = c.req.query("source") !== "live";
  const useDraft = wantDraft && row.draft_blocks_json != null;
  let title = row.title;
  let blocksJson = row.blocks_json;
  let contentJson = row.content_json;
  if (useDraft) {
    const draftBlocks = blocksFromJson(row.draft_blocks_json);
    title = row.draft_title || row.title;
    blocksJson = JSON.stringify(draftBlocks);
    contentJson = JSON.stringify({ html: blocksToHtml(draftBlocks) });
  }
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    // What was actually rendered: "draft" only when a draft exists.
    "X-Preview-Source": useDraft ? "draft" : "live",
  };

  if (isBusiness(tenant)) {
    const host = c.req.header("host") || new URL(c.req.url).host;
    const args = await buildRenderArgs(
      c.env,
      tenant,
      {
        ...row,
        title,
        slug: row.slug === "home" ? "" : row.slug,
        blocks_json: blocksJson,
        content_json: contentJson,
      },
      host
    );
    return new Response(renderPageHtml(args), {
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return c.json(
    {
      title,
      slug: row.slug,
      html: contentFromPage({ blocks_json: blocksJson, content_json: contentJson }).html,
    },
    200,
    headers
  );
});
