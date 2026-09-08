import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import {
  parseBlocks,
  blocksToHtml,
  BUSINESS_BLOCK_TYPES,
  GUILD_ONLY_BLOCK_TYPES,
} from "../lib/blocks";
import { PLATFORM_PATH_PREFIXES, PLATFORM_EXACT_PATHS } from "../lib/platformPaths";

export const pageRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type Ctx = Context<{ Bindings: Env; Variables: TenantVariables }>;

type PageRow = {
  id: string;
  slug: string;
  title: string;
  content_json: string;
  blocks_json?: string | null;
  page_type?: string;
  show_in_nav?: number;
  nav_label?: string | null;
  is_members_only: number;
  published: number;
  sort_order: number;
  seo_title?: string | null;
  seo_description?: string | null;
  noindex?: number;
  updated_at: string;
};

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

const pageFields = {
  slug: z.string().max(120).optional(),
  content_html: z.string().max(200_000).optional(),
  blocks: z.array(blockSchema).max(MAX_BLOCKS).optional(),
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
const patchSchema = z.object({ title: titleSchema.optional(), ...pageFields });

type CreateBody = z.infer<typeof createSchema>;
type PatchBody = z.infer<typeof patchSchema>;

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
 * the header is optional and untrusted.
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
function parseBlocksStrict(c: Ctx, raw: unknown[]): { ok: true; blocks: ReturnType<typeof parseBlocks> } | { ok: false; response: Response } {
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

// GET /api/tenants/:tenantId/pages
pageRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const type = c.req.query("type"); // page | blog_post
  let sql = `SELECT id, slug, title, content_json, blocks_json, page_type, show_in_nav, nav_label,
                    is_members_only, published, sort_order, seo_title, seo_description,
                    coalesce(noindex, 0) AS noindex, updated_at
             FROM pages WHERE tenant_id = ?`;
  const binds: string[] = [tenant.id];
  if (type === "blog_post" || type === "page") {
    sql += ` AND coalesce(page_type, 'page') = ?`;
    binds.push(type);
  }
  sql += ` ORDER BY sort_order, title`;
  // No "pre-migration" fallback: every migration through 0020 is applied in
  // production, so a failure here is a real error and must surface as one
  // rather than as a silently narrower result set.
  try {
    const rows = await all<PageRow>(c.env.DB.prepare(sql).bind(...binds));
    return c.json(rows);
  } catch (err) {
    return dbFailure(c, "list pages", err);
  }
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

  let blocks: ReturnType<typeof parseBlocks> = [];
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

  // Single statement, no fallback. All migrations through 0020 are applied
  // in production; the old "retry with the pre-migration column set" path
  // would have reported 201 while discarding blocks, SEO, nav and page_type.
  try {
    await c.env.DB.prepare(
      `INSERT INTO pages
       (id, tenant_id, slug, title, content_json, blocks_json, page_type, show_in_nav, nav_label,
        is_members_only, published, sort_order, seo_title, seo_description, noindex,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        body.published === false ? 0 : 1,
        body.sort_order ?? 0,
        cleanOptionalText(body.seo_title ?? null),
        cleanOptionalText(body.seo_description ?? null),
        body.noindex ? 1 : 0,
        now,
        now
      )
      .run();
  } catch (err) {
    return dbFailure(c, "create page", err);
  }
  const page = await first<PageRow>(
    c.env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id)
  );
  return c.json(page, 201);
});

// PATCH /api/tenants/:tenantId/pages/:pageId
pageRoutes.patch("/:pageId", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const existing = await first<PageRow>(
    c.env.DB.prepare(
      "SELECT * FROM pages WHERE id = ? AND tenant_id = ?"
    ).bind(pageId, tenant.id)
  );
  if (!existing) return c.json({ error: "Page not found" }, 404);

  const raw = await readJsonBody(c);
  if (!raw.ok) return raw.response;
  const parsed = patchSchema.safeParse(raw.json);
  if (!parsed.success) return validationError(c, parsed.error);
  const body: PatchBody = parsed.data;

  // Same home-page normalization as POST: a blank/unslugifiable explicit
  // slug becomes "home" (see the POST handler above for why "" never
  // matches -- serveBusinessSite only ever looks up "home").
  let nextSlug: string | null = null;
  if (body.slug !== undefined) {
    nextSlug = slugify(body.slug) || "home";
    if (nextSlug !== existing.slug) {
      if (RESERVED_SLUGS.has(nextSlug)) return reservedSlugError(c, nextSlug);
      const dupe = await first(
        c.env.DB.prepare(
          "SELECT id FROM pages WHERE tenant_id = ? AND slug = ? AND id != ?"
        ).bind(tenant.id, nextSlug, pageId)
      );
      if (dupe) return c.json({ error: "A page with that slug already exists" }, 409);
    }
  }

  // Every column is either "provided -> written" or "absent -> untouched".
  // The previous coalesce(?, col) form could not tell "clear this" apart
  // from "leave it alone": seo_title: "" became NULL in the bind, coalesce
  // kept the old value, and the customer's clear was lost with a 200.
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => {
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

  if (body.page_type !== undefined) set("page_type", body.page_type);
  if (body.is_members_only !== undefined) set("is_members_only", body.is_members_only ? 1 : 0);
  if (body.published !== undefined) set("published", body.published ? 1 : 0);
  if (body.sort_order !== undefined) set("sort_order", body.sort_order);
  if (body.show_in_nav !== undefined) set("show_in_nav", body.show_in_nav ? 1 : 0);
  if (body.noindex !== undefined) set("noindex", body.noindex ? 1 : 0);
  // Omitted -> unchanged; "" or null -> NULL.
  if (body.nav_label !== undefined) set("nav_label", cleanOptionalText(body.nav_label));
  if (body.seo_title !== undefined) set("seo_title", cleanOptionalText(body.seo_title));
  if (body.seo_description !== undefined) {
    set("seo_description", cleanOptionalText(body.seo_description));
  }

  const now = new Date().toISOString();
  set("updated_at", now);

  // Single statement, no fallback (see POST).
  try {
    await c.env.DB.prepare(
      `UPDATE pages SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`
    )
      .bind(...binds, pageId, tenant.id)
      .run();
  } catch (err) {
    return dbFailure(c, "update page", err);
  }

  const page = await first<PageRow>(
    c.env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(pageId)
  );
  if (nextSlug !== null && nextSlug !== existing.slug) {
    // No redirect table yet: the old URL 404s after a rename. Log it so the
    // change is at least traceable, and surface previous_slug to the caller.
    console.info("[pages] slug changed", {
      tenantId: tenant.id,
      pageId,
      previous_slug: existing.slug,
      slug: nextSlug,
    });
    return c.json({ ...page, previous_slug: existing.slug });
  }
  return c.json(page);
});

// DELETE /api/tenants/:tenantId/pages/:pageId
pageRoutes.delete("/:pageId", async (c) => {
  const tenant = c.get("tenant");
  const pageId = c.req.param("pageId");
  const res = await c.env.DB.prepare(
    "DELETE FROM pages WHERE id = ? AND tenant_id = ?"
  )
    .bind(pageId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Page not found" }, 404);
  return c.json({ ok: true });
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
