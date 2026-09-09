// src/routes/pages.test.ts
// Task 13 needs the business site builder's page editor (SEO title/
// description/noindex fields, and an explicit slug -- including "leave it
// blank for the home page") to actually persist. Before this task pages.ts
// accepted none of that on write and didn't return seo_title/
// seo_description/noindex on the list GET, which would have made those
// editor fields silently no-op. This file locks in the fix.
//
// The 2026-09-08 audit added the content-integrity cases further down:
// no silent pre-migration fallback, unknown block types rejected instead of
// dropped, clear-vs-omit metadata semantics, legacy-HTML resurrection,
// reserved slugs, Zod validation + body size cap.
//
// Same idiom as src/routes/credentials.test.ts: dispatch through the
// exported `pageRoutes` app with a thin stand-in for the tenantMiddleware
// context, and a keyword-routed fake D1 that records every write.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { pageRoutes, KNOWN_BLOCK_TYPES, RESERVED_SLUGS, sectionCatalog } from "./pages";
import { parseBlocks, BUSINESS_BLOCK_TYPES, GUILD_ONLY_BLOCK_TYPES } from "../lib/blocks";
import { SECTION_TYPES, SECTION_VARIANTS, parseSections } from "../lib/site/sections/schema";
import type { Env, Tenant, TenantVariables } from "../types";

const TENANT_ID = "tenant-1";

type Write = { sql: string; binds: unknown[] };

function fakeDb(
  opts: {
    dupeSlug?: string;
    existingPage?: Record<string, unknown>;
    /** Every INSERT/UPDATE .run() throws (after being recorded). */
    failWrites?: boolean;
    /** Every .all() throws. */
    failReads?: boolean;
  } = {}
) {
  const writes: Write[] = [];
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind(...binds: unknown[]) {
          return {
            async first<T = Record<string, unknown> | null>(): Promise<T> {
              if (sql.startsWith("SELECT id FROM pages")) {
                const slugArg = binds[1];
                return (opts.dupeSlug && slugArg === opts.dupeSlug
                  ? { id: "other-page" }
                  : null) as T;
              }
              if (sql.startsWith("SELECT * FROM pages WHERE id = ? AND tenant_id")) {
                return (opts.existingPage || null) as T;
              }
              if (sql.startsWith("SELECT * FROM pages")) {
                // Final read-back after INSERT/UPDATE -- content doesn't
                // matter for these tests, just needs to be a plausible row.
                return { id: "new-page", slug: "x", title: "x" } as T;
              }
              return null as T;
            },
            async all() {
              if (opts.failReads) throw new Error("D1_ERROR: no such column");
              return { results: [] };
            },
            async run() {
              if (sql.startsWith("INSERT INTO pages") || sql.startsWith("UPDATE pages")) {
                writes.push({ sql, binds });
                if (opts.failWrites) throw new Error("D1_ERROR: table pages has no column named blocks_json");
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    // PATCH now runs its UPDATE (plus any redirect rows) as one batch;
    // delegate to each statement's own run() so `writes` still records it.
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return { db, writes, prepared };
}

function buildApp(dbOpts?: Parameters<typeof fakeDb>[0]) {
  const { db, writes, prepared } = fakeDb(dbOpts);
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, settings_json: "{}" } as Tenant);
    await next();
  });
  app.route("/", pageRoutes);
  const env = { DB: db } as unknown as Env;
  return { app, env, writes, prepared };
}

const jsonReq = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/**
 * Maps the columns in an UPDATE's dynamic SET clause to their bound values,
 * so tests can assert "seo_title was written as NULL" vs "seo_title was not
 * written at all" by name instead of by positional index.
 */
function boundColumns(write: Write): Map<string, unknown> {
  const m = write.sql.match(/SET\s+([\s\S]*?)\s+WHERE/);
  if (!m) throw new Error("not an UPDATE with a SET clause: " + write.sql);
  const cols = m[1].split(",").map((s) => s.trim().replace(/\s*=\s*\?$/, ""));
  const out = new Map<string, unknown>();
  cols.forEach((col, i) => out.set(col, write.binds[i]));
  return out;
}

/** Bind order of the INSERT: id, tenant_id, slug, title, content_json, blocks_json, ... */
const INSERT_COL = {
  slug: 2,
  title: 3,
  content_json: 4,
  blocks_json: 5,
  page_type: 6,
  show_in_nav: 7,
  nav_label: 8,
  is_members_only: 9,
  published: 10,
  sort_order: 11,
  seo_title: 12,
  seo_description: 13,
  noindex: 14,
} as const;

describe("POST /api/tenants/:id/pages — slug + SEO fields", () => {
  it("derives the slug from the title when slug is omitted (legacy guild page builder callers)", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", { title: "About Us" }), env);
    expect(res.status).toBe(201);
    expect(writes).toHaveLength(1);
    // bind order: id, tenant.id, slug, title, ...
    expect(writes[0].binds[INSERT_COL.slug]).toBe("about-us");
  });

  it("normalizes an explicit blank slug to 'home' (site.ts only ever looks up literal 'home')", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", { title: "Home Page", slug: "" }), env);
    expect(res.status).toBe(201);
    expect(writes[0].binds[INSERT_COL.slug]).toBe("home");
  });

  it("persists seo_title, seo_description, and noindex on create", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request(
      "/",
      jsonReq("POST", {
        title: "Services",
        seo_title: "Longarm Quilting Services",
        seo_description: "Hand-guided quilting.",
        noindex: true,
      }),
      env
    );
    expect(res.status).toBe(201);
    const binds = writes[0].binds;
    expect(binds[INSERT_COL.seo_title]).toBe("Longarm Quilting Services");
    expect(binds[INSERT_COL.seo_description]).toBe("Hand-guided quilting.");
    expect(binds[INSERT_COL.noindex]).toBe(1);
  });

  it("rejects a duplicate explicit slug with 409", async () => {
    const { app, env, writes } = buildApp({ dupeSlug: "about" });
    const res = await app.request("/", jsonReq("POST", { title: "About Redux", slug: "about" }), env);
    expect(res.status).toBe(409);
    expect(writes).toHaveLength(0);
  });
});

describe("PATCH /api/tenants/:id/pages/:pageId — slug + SEO fields", () => {
  const existingPage = {
    id: "page-1",
    slug: "old-slug",
    title: "Old",
    content_json: "{}",
    blocks_json: null,
  };

  it("updates seo_description and noindex", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request(
      "/page-1",
      jsonReq("PATCH", { seo_description: "New description", noindex: true }),
      env
    );
    expect(res.status).toBe(200);
    const cols = boundColumns(writes[0]);
    expect(cols.get("seo_description")).toBe("New description");
    expect(cols.get("noindex")).toBe(1);
  });

  it("rejects renaming to a slug already used by another page with 409, without writing", async () => {
    const { app, env, writes } = buildApp({ existingPage, dupeSlug: "taken" });
    const res = await app.request("/page-1", jsonReq("PATCH", { slug: "taken" }), env);
    expect(res.status).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it("404s for a page that doesn't belong to this tenant", async () => {
    const { app, env, writes } = buildApp({ existingPage: undefined });
    const res = await app.request("/page-1", jsonReq("PATCH", { title: "x" }), env);
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it("returns previous_slug when the slug changes", async () => {
    const { app, env, writes, prepared } = buildApp({ existingPage });
    const res = await app.request("/page-1", jsonReq("PATCH", { slug: "New Slug" }), env);
    expect(res.status).toBe(200);
    expect(boundColumns(writes[0]).get("slug")).toBe("new-slug");
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.previous_slug).toBe("old-slug");
    // ...and a page_redirects row (old -> new) rides in the same batch.
    expect(prepared.some((s) => s.includes("INSERT INTO page_redirects"))).toBe(true);
  });

  it("does not report previous_slug when the slug is unchanged", async () => {
    const { app, env } = buildApp({ existingPage });
    const res = await app.request("/page-1", jsonReq("PATCH", { slug: "old-slug", title: "T" }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("previous_slug");
  });
});

// ---------------------------------------------------------------------------
// Audit 2026-09-08: content integrity
// ---------------------------------------------------------------------------

describe("KNOWN_BLOCK_TYPES stays in sync with parseBlocks", () => {
  it("every listed type round-trips through parseBlocks with its type intact", () => {
    for (const type of KNOWN_BLOCK_TYPES) {
      const out = parseBlocks([{ type }]);
      expect(out, `parseBlocks dropped "${type}"`).toHaveLength(1);
      expect(out[0].type).toBe(type);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(KNOWN_BLOCK_TYPES).size).toBe(KNOWN_BLOCK_TYPES.length);
  });

  it("covers every type the admin block picker offers", () => {
    const known = new Set<string>(KNOWN_BLOCK_TYPES);
    for (const t of [...BUSINESS_BLOCK_TYPES, ...GUILD_ONLY_BLOCK_TYPES]) {
      expect(known.has(t), `picker offers "${t}" but the API would reject it`).toBe(true);
    }
  });

  it("parseBlocks really does drop an unknown type (the behavior the route guards against)", () => {
    expect(parseBlocks([{ type: "carousel" }])).toHaveLength(0);
  });
});

describe("unsupported block types are rejected, not dropped", () => {
  const existingPage = { id: "page-1", slug: "p", title: "P", content_json: "{}", blocks_json: null };

  it("POST: 400 naming the type and its position, and nothing is written", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request(
      "/",
      jsonReq("POST", {
        title: "Gallery",
        blocks: [{ type: "heading", text: "Hi" }, { type: "carousel", images: [] }],
      }),
      env
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues: { path: string; message: string }[] };
    expect(json.issues).toEqual([
      { path: "blocks.1.type", message: 'Unsupported block type "carousel"' },
    ]);
    expect(writes).toHaveLength(0);
  });

  it("PATCH: 400 naming the type, and nothing is written", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request(
      "/page-1",
      jsonReq("PATCH", { blocks: [{ type: "slideshow" }] }),
      env
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: { path: string; message: string }[] };
    expect(json.issues[0].path).toBe("blocks.0.type");
    expect(json.issues[0].message).toContain("slideshow");
    expect(writes).toHaveLength(0);
  });

  it("rejects a block array that parseBlocks would silently truncate (its 80-block cap)", async () => {
    const { app, env, writes } = buildApp();
    const blocks = Array.from({ length: 81 }, () => ({ type: "divider" }));
    const res = await app.request("/", jsonReq("POST", { title: "Long", blocks }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: { path: string; message: string }[] };
    expect(json.issues[0].path).toBe("blocks");
    expect(json.issues[0].message).toContain("80 of 81");
    expect(writes).toHaveLength(0);
  });
});

describe("request validation (Zod)", () => {
  const existingPage = { id: "page-1", slug: "p", title: "P", content_json: "{}", blocks_json: null };

  it("rejects an oversized title with a field-level issue and no write", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", { title: "x".repeat(201) }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues: { path: string; message: string }[] };
    expect(json.error).toBe("Invalid request body");
    expect(json.issues.map((i) => i.path)).toEqual(["title"]);
    expect(writes).toHaveLength(0);
  });

  it("rejects a missing/blank title", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", { title: "   " }), env);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("rejects wrong types, bad enums and non-integer sort_order in one pass", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request(
      "/page-1",
      jsonReq("PATCH", {
        published: "yes",
        page_type: "landing",
        sort_order: 1.5,
        seo_title: "t".repeat(71),
        seo_description: "d".repeat(201),
        nav_label: "n".repeat(61),
        slug: "s".repeat(121),
      }),
      env
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: { path: string; message: string }[] };
    const paths = json.issues.map((i) => i.path).sort();
    expect(paths).toEqual(
      ["nav_label", "page_type", "published", "seo_description", "seo_title", "slug", "sort_order"].sort()
    );
    expect(writes).toHaveLength(0);
  });

  it("rejects content_html over 200k and more than 200 blocks", async () => {
    const { app, env, writes } = buildApp();
    let res = await app.request(
      "/",
      jsonReq("POST", { title: "Big", content_html: "a".repeat(200_001) }),
      env
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: { path: string }[] }).issues[0].path).toBe("content_html");

    res = await app.request(
      "/",
      jsonReq("POST", { title: "Many", blocks: Array.from({ length: 201 }, () => ({ type: "divider" })) }),
      env
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: { path: string }[] }).issues[0].path).toBe("blocks");
    expect(writes).toHaveLength(0);
  });

  it("rejects a non-JSON body with 400 instead of throwing", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", "{not json"), env);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("rejects a body over the size cap by declared content-length (413) without reading it", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request(
      "/",
      jsonReq("POST", { title: "x" }, { "content-length": String(600 * 1024) }),
      env
    );
    expect(res.status).toBe(413);
    expect(writes).toHaveLength(0);
  });

  it("rejects a body over the size cap by actual bytes (413) even when content-length is absent", async () => {
    const { app, env, writes } = buildApp();
    // Under the per-field cap for content_html (200k) but over the whole-body
    // cap once three such fields are present -- exercises the byte check.
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "x",
          content_html: "a".repeat(190_000),
          seo_description: "b".repeat(190_000),
          nav_label: "c".repeat(190_000),
        }),
      },
      env
    );
    expect(res.status).toBe(413);
    expect(writes).toHaveLength(0);
  });
});

describe("metadata: omitted leaves unchanged, '' or null clears to NULL", () => {
  const existingPage = {
    id: "page-1",
    slug: "p",
    title: "P",
    content_json: "{}",
    blocks_json: null,
    seo_title: "Keep me",
  };

  it("seo_title: '' writes NULL", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request("/page-1", jsonReq("PATCH", { seo_title: "" }), env);
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    const cols = boundColumns(writes[0]);
    expect(cols.has("seo_title")).toBe(true);
    expect(cols.get("seo_title")).toBeNull();
    // and no coalesce() anywhere that could swallow the NULL
    expect(writes[0].sql).not.toMatch(/coalesce/i);
  });

  it("seo_title omitted is not written at all", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request("/page-1", jsonReq("PATCH", { title: "Renamed" }), env);
    expect(res.status).toBe(200);
    const cols = boundColumns(writes[0]);
    expect(cols.has("seo_title")).toBe(false);
    expect(cols.get("title")).toBe("Renamed");
    // Only the provided column, the timestamp and the revision bump are written.
    expect([...cols.keys()]).toEqual(["title", "updated_at", "revision"]);
  });

  it("nav_label and seo_description: null clears, '  ' clears, a value trims and persists", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request(
      "/page-1",
      jsonReq("PATCH", { nav_label: null, seo_description: "   ", seo_title: "  Trimmed  " }),
      env
    );
    expect(res.status).toBe(200);
    const cols = boundColumns(writes[0]);
    expect(cols.get("nav_label")).toBeNull();
    expect(cols.get("seo_description")).toBeNull();
    expect(cols.get("seo_title")).toBe("Trimmed");
  });

  it("POST: '' metadata is stored as NULL, not empty string", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request(
      "/",
      jsonReq("POST", { title: "Testing", seo_title: "", seo_description: "", nav_label: "" }),
      env
    );
    expect(res.status).toBe(201);
    expect(writes[0].binds[INSERT_COL.seo_title]).toBeNull();
    expect(writes[0].binds[INSERT_COL.seo_description]).toBeNull();
    expect(writes[0].binds[INSERT_COL.nav_label]).toBeNull();
  });
});

describe("content_json vs blocks_json (legacy HTML must not resurrect)", () => {
  const existingPage = {
    id: "page-1",
    slug: "p",
    title: "P",
    content_json: JSON.stringify({ html: "<p>OLD LEGACY HTML</p>" }),
    blocks_json: JSON.stringify([{ type: "heading", text: "Old" }]),
  };

  it("PATCH blocks: [] clears blocks_json AND writes content_json {\"html\":\"\"}", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request("/page-1", jsonReq("PATCH", { blocks: [] }), env);
    expect(res.status).toBe(200);
    const cols = boundColumns(writes[0]);
    expect(cols.get("blocks_json")).toBeNull();
    expect(cols.get("content_json")).toBe(JSON.stringify({ html: "" }));
  });

  it("PATCH non-empty blocks without content_html snapshots blocksToHtml into content_json", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request(
      "/page-1",
      jsonReq("PATCH", { blocks: [{ type: "heading", text: "Hello", level: 2 }] }),
      env
    );
    expect(res.status).toBe(200);
    const cols = boundColumns(writes[0]);
    expect(JSON.parse(cols.get("blocks_json") as string)).toEqual([
      { type: "heading", text: "Hello", level: 2 },
    ]);
    const content = JSON.parse(cols.get("content_json") as string) as { html: string };
    expect(content.html).toContain('<h2 class="qh-block-heading">Hello</h2>');
    expect(content.html).not.toContain("OLD LEGACY HTML");
  });

  it("PATCH content_html wins over the blocks snapshot when both are sent (admin.html sends both)", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request(
      "/page-1",
      jsonReq("PATCH", { blocks: [{ type: "divider" }], content_html: "<p>explicit</p>" }),
      env
    );
    expect(res.status).toBe(200);
    const cols = boundColumns(writes[0]);
    expect(cols.get("content_json")).toBe(JSON.stringify({ html: "<p>explicit</p>" }));
  });

  it("PATCH without blocks or content_html leaves both content columns untouched", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request("/page-1", jsonReq("PATCH", { published: false }), env);
    expect(res.status).toBe(200);
    const cols = boundColumns(writes[0]);
    expect(cols.has("content_json")).toBe(false);
    expect(cols.has("blocks_json")).toBe(false);
  });

  it("POST non-empty blocks without content_html snapshots html into content_json", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request(
      "/",
      jsonReq("POST", { title: "New", blocks: [{ type: "heading", text: "Welcome" }] }),
      env
    );
    expect(res.status).toBe(201);
    const content = JSON.parse(writes[0].binds[INSERT_COL.content_json] as string) as { html: string };
    expect(content.html).toContain("Welcome");
    expect(writes[0].binds[INSERT_COL.blocks_json]).toBeTypeOf("string");
  });

  it("POST blocks: [] writes content_json {\"html\":\"\"} and NULL blocks_json", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", { title: "Empty", blocks: [] }), env);
    expect(res.status).toBe(201);
    expect(writes[0].binds[INSERT_COL.content_json]).toBe(JSON.stringify({ html: "" }));
    expect(writes[0].binds[INSERT_COL.blocks_json]).toBeNull();
  });
});

describe("reserved slugs", () => {
  const existingPage = { id: "page-1", slug: "about", title: "A", content_json: "{}", blocks_json: null };

  it("covers every guild route and platform path from the audit list (home excepted)", () => {
    const expected = [
      "membership", "join", "join-renew", "events", "calendar", "galleries", "photos",
      "portal", "admin", "api", "docs", "embed", "auth", "site-access", "privacy", "terms",
      "g", "guild", "assets", "t", "public",
    ];
    for (const s of expected) {
      expect(RESERVED_SLUGS.has(s), `"${s}" should be reserved`).toBe(true);
    }
    expect(RESERVED_SLUGS.has("home")).toBe(false);
  });

  it("POST: explicit reserved slug -> 400, no write", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", { title: "Members", slug: "membership" }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(json.error).toContain("membership");
    expect(json.issues[0].path).toBe("slug");
    expect(writes).toHaveLength(0);
  });

  it("POST: title-derived reserved slug -> 400 (e.g. a page titled 'Events')", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", { title: "Events" }), env);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("POST: 'home' stays allowed (business builder home page)", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request("/", jsonReq("POST", { title: "Welcome", slug: "home" }), env);
    expect(res.status).toBe(201);
    expect(writes[0].binds[INSERT_COL.slug]).toBe("home");
  });

  it("PATCH: renaming to a reserved slug -> 400, no write", async () => {
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request("/page-1", jsonReq("PATCH", { slug: "Admin" }), env);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

describe("database failures surface as 500 with exactly one write attempt (no fallback)", () => {
  const existingPage = { id: "page-1", slug: "p", title: "P", content_json: "{}", blocks_json: null };

  it("POST: 500, one INSERT attempted, and it carries the full column set", async () => {
    const { app, env, writes } = buildApp({ failWrites: true });
    const res = await app.request(
      "/",
      jsonReq("POST", { title: "Testing", blocks: [{ type: "divider" }], seo_title: "S" }),
      env
    );
    expect(res.status).toBe(500);
    expect((await res.json()) as object).toEqual({ error: "Failed to create page" });
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain("blocks_json");
    expect(writes[0].sql).toContain("seo_title");
  });

  it("PATCH: 500, one UPDATE attempted, no narrower retry", async () => {
    const { app, env, writes } = buildApp({ existingPage, failWrites: true });
    const res = await app.request("/page-1", jsonReq("PATCH", { title: "T", seo_title: "S" }), env);
    expect(res.status).toBe(500);
    expect((await res.json()) as object).toEqual({ error: "Failed to update page" });
    expect(writes).toHaveLength(1);
    expect(boundColumns(writes[0]).has("seo_title")).toBe(true);
  });

  it("GET list: 500 with a single SELECT, no narrower fallback query", async () => {
    const { app, env, prepared } = buildApp({ failReads: true });
    const res = await app.request("/", { method: "GET" }, env);
    expect(res.status).toBe(500);
    const selects = prepared.filter((s) => s.trimStart().startsWith("SELECT"));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain("blocks_json");
  });

  it("GET list: returns the full column set on success", async () => {
    const { app, env, prepared } = buildApp();
    const res = await app.request("/?type=blog_post", { method: "GET" }, env);
    expect(res.status).toBe(200);
    expect(prepared[0]).toContain("seo_description");
    expect(prepared[0]).toContain("coalesce(page_type, 'page') = ?");
  });
});

// ---------------------------------------------------------------------------
// Draft -> preview -> publish workflow (migration 0025).
//
// These need real state: a draft save must leave live content untouched, a
// publish must promote the draft AND snapshot what was live before it, a
// revision restore must land in the draft, and so on. So instead of the
// keyword-routed stateless fake above, this section uses a tiny in-memory
// D1 that actually executes the handful of statement shapes pages.ts
// emits (generic `UPDATE pages SET ... WHERE ...` parsing included) and
// records every batch, so assertions read the resulting rows rather than
// trusting the response.
// ---------------------------------------------------------------------------

type MemPage = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  revision: number;
  deleted_at: string | null;
  published: number;
};
type MemRevision = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  page_id: string;
  kind: string;
  title: string;
  blocks_json: string | null;
  content_json: string | null;
  created_at: string;
};
type MemRedirect = { tenant_id: string; from_slug: string; to_slug: string; created_at: string };

type MemState = {
  pages: MemPage[];
  revisions: MemRevision[];
  redirects: MemRedirect[];
  batches: string[][];
  statements: { sql: string; binds: unknown[] }[];
};

function memPage(overrides: Partial<MemPage> = {}): MemPage {
  return {
    id: "page-1",
    tenant_id: TENANT_ID,
    slug: "about",
    title: "About",
    content_json: JSON.stringify({ html: '<h2 class="qh-block-heading">Live</h2>' }),
    blocks_json: JSON.stringify([{ type: "heading", text: "Live", level: 2 }]),
    page_type: "page",
    show_in_nav: 1,
    nav_label: null,
    is_members_only: 0,
    published: 1,
    sort_order: 0,
    seo_title: null,
    seo_description: null,
    og_image_file_id: null,
    noindex: 0,
    draft_blocks_json: null,
    draft_title: null,
    draft_updated_at: null,
    revision: 3,
    published_at: "2026-09-01T00:00:00.000Z",
    deleted_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function memState(pages: MemPage[] = [memPage()]): MemState {
  return { pages, revisions: [], redirects: [], batches: [], statements: [] };
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Evaluate one `col = expr` SET assignment against a row. */
function evalAssignment(expr: string, row: MemPage, binds: unknown[], cursor: { i: number }): unknown {
  if (expr === "?") return binds[cursor.i++];
  if (expr === "NULL") return null;
  if (expr === "revision + 1") return Number(row.revision) + 1;
  if (/^-?\d+$/.test(expr)) return Number(expr);
  throw new Error(`memDb: unsupported SET expression "${expr}"`);
}

function execMem(state: MemState, rawSql: string, binds: unknown[]): { results: unknown[]; changes: number } {
  const sql = norm(rawSql);
  state.statements.push({ sql, binds });
  const T = (p: { tenant_id: string }, t: unknown) => p.tenant_id === t;

  // ----- pages: reads -----
  if (sql === "SELECT * FROM pages WHERE id = ? AND tenant_id = ?") {
    const r = state.pages.find((p) => p.id === binds[0] && T(p, binds[1]));
    return { results: r ? [{ ...r }] : [], changes: 0 };
  }
  if (sql === "SELECT * FROM pages WHERE id = ?") {
    const r = state.pages.find((p) => p.id === binds[0]);
    return { results: r ? [{ ...r }] : [], changes: 0 };
  }
  if (sql.startsWith("SELECT id FROM pages WHERE tenant_id = ? AND slug = ?")) {
    const excl = sql.endsWith("AND id != ?") ? binds[2] : null;
    const r = state.pages.find((p) => T(p, binds[0]) && p.slug === binds[1] && p.id !== excl);
    return { results: r ? [{ id: r.id }] : [], changes: 0 };
  }
  if (sql.startsWith("SELECT id, slug, title, content_json, blocks_json, page_type")) {
    const wantDeleted = sql.includes("deleted_at IS NOT NULL");
    const rows = state.pages
      .filter((p) => T(p, binds[0]) && (wantDeleted ? p.deleted_at !== null : p.deleted_at === null))
      .map((p) => ({ ...p, has_draft: p.draft_blocks_json != null ? 1 : 0 }));
    return { results: rows, changes: 0 };
  }
  if (sql.startsWith("SELECT slug, title, nav_label FROM pages")) {
    const rows = state.pages.filter(
      (p) => T(p, binds[0]) && p.published === 1 && p.deleted_at === null && p.is_members_only === 0
    );
    return { results: rows.map((p) => ({ slug: p.slug, title: p.title, nav_label: p.nav_label })), changes: 0 };
  }

  // ----- pages: writes -----
  if (sql.startsWith("INSERT INTO pages")) {
    const cols = sql.match(/INSERT INTO pages \((.*?)\) VALUES/)![1].split(",").map((s) => s.trim());
    const row = {} as MemPage;
    cols.forEach((col, i) => ((row as Record<string, unknown>)[col] = binds[i]));
    row.deleted_at = row.deleted_at ?? null;
    state.pages.push(row);
    return { results: [], changes: 1 };
  }
  if (sql.startsWith("UPDATE pages SET")) {
    const m = sql.match(/^UPDATE pages SET (.*?) WHERE (.*?)(?: RETURNING (.*))?$/)!;
    const assignments = m[1].split(",").map((s) => s.trim());
    const conditions = m[2].split(" AND ").map((s) => s.trim());
    const returning = m[3] ? m[3].split(",").map((s) => s.trim()) : null;
    // SET binds precede WHERE binds; count SET placeholders first.
    const setPlaceholders = assignments.filter((a) => a.endsWith("= ?")).length;
    const whereBinds = binds.slice(setPlaceholders);
    let wi = 0;
    const where: Record<string, unknown> = {};
    for (const cond of conditions) {
      if (cond === "id = ?") where.id = whereBinds[wi++];
      else if (cond === "tenant_id = ?") where.tenant_id = whereBinds[wi++];
      else if (cond === "revision = ?") where.revision = whereBinds[wi++];
      else if (cond === "deleted_at IS NULL") where.notDeleted = true;
      else if (cond === "deleted_at IS NOT NULL") where.deleted = true;
      else throw new Error(`memDb: unsupported WHERE "${cond}"`);
    }
    const results: unknown[] = [];
    let changes = 0;
    for (const p of state.pages) {
      if (where.id !== undefined && p.id !== where.id) continue;
      if (where.tenant_id !== undefined && p.tenant_id !== where.tenant_id) continue;
      if (where.revision !== undefined && Number(p.revision) !== Number(where.revision)) continue;
      if (where.notDeleted && p.deleted_at !== null) continue;
      if (where.deleted && p.deleted_at === null) continue;
      const cursor = { i: 0 };
      const next: Record<string, unknown> = {};
      for (const a of assignments) {
        const eq = a.indexOf(" = ");
        const col = a.slice(0, eq).trim();
        const expr = a.slice(eq + 3).trim();
        next[col] = evalAssignment(expr, p, binds, cursor);
      }
      Object.assign(p, next);
      changes++;
      if (returning) {
        const out: Record<string, unknown> = {};
        for (const col of returning) out[col] = (p as Record<string, unknown>)[col];
        results.push(out);
      }
    }
    return { results, changes };
  }
  if (sql === "DELETE FROM pages WHERE id = ? AND tenant_id = ?") {
    const before = state.pages.length;
    state.pages = state.pages.filter((p) => !(p.id === binds[0] && T(p, binds[1])));
    return { results: [], changes: before - state.pages.length };
  }

  // ----- page_revisions -----
  if (sql.startsWith("INSERT INTO page_revisions")) {
    const [id, tenantId, pageId, kind, title, blocksJson, contentJson, createdBy, createdAt, gPage, gTenant, gRev] = binds;
    const guard = state.pages.find(
      (p) => p.id === gPage && T(p, gTenant) && Number(p.revision) === Number(gRev)
    );
    if (!guard) return { results: [], changes: 0 };
    state.revisions.push({
      id: id as string,
      tenant_id: tenantId as string,
      page_id: pageId as string,
      kind: kind as string,
      title: title as string,
      blocks_json: blocksJson as string | null,
      content_json: contentJson as string | null,
      created_by: createdBy as string | null,
      created_at: createdAt as string,
    });
    return { results: [], changes: 1 };
  }
  if (sql.startsWith("SELECT r.id, r.kind, r.title, r.created_at, r.created_by")) {
    const rows = state.revisions
      .filter((r) => T(r, binds[0]) && r.page_id === binds[1])
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1))
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        created_at: r.created_at,
        created_by: r.created_by,
        // LEFT JOIN users — the fake has no users table; mirror the coalesce.
        created_by_name: r.created_by ? `name-of-${r.created_by}` : null,
        block_count: r.blocks_json ? (JSON.parse(r.blocks_json) as unknown[]).length : 0,
      }));
    return { results: rows, changes: 0 };
  }
  if (sql === "SELECT * FROM page_revisions WHERE id = ? AND page_id = ? AND tenant_id = ?") {
    const r = state.revisions.find((x) => x.id === binds[0] && x.page_id === binds[1] && T(x, binds[2]));
    return { results: r ? [{ ...r }] : [], changes: 0 };
  }
  if (sql.startsWith("DELETE FROM page_revisions WHERE tenant_id = ? AND page_id = ? AND id NOT IN")) {
    const mine = state.revisions
      .filter((r) => T(r, binds[0]) && r.page_id === binds[1])
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const keep = new Set(mine.slice(0, 50).map((r) => r.id));
    const before = state.revisions.length;
    state.revisions = state.revisions.filter((r) => r.page_id !== binds[1] || keep.has(r.id));
    return { results: [], changes: before - state.revisions.length };
  }
  if (sql === "DELETE FROM page_revisions WHERE tenant_id = ? AND page_id = ?") {
    const before = state.revisions.length;
    state.revisions = state.revisions.filter((r) => !(T(r, binds[0]) && r.page_id === binds[1]));
    return { results: [], changes: before - state.revisions.length };
  }

  // ----- page_redirects -----
  if (sql === "DELETE FROM page_redirects WHERE tenant_id = ? AND from_slug = ?") {
    const before = state.redirects.length;
    state.redirects = state.redirects.filter((r) => !(T(r, binds[0]) && r.from_slug === binds[1]));
    return { results: [], changes: before - state.redirects.length };
  }
  if (sql === "DELETE FROM page_redirects WHERE tenant_id = ? AND (to_slug = ? OR from_slug = ?)") {
    const before = state.redirects.length;
    state.redirects = state.redirects.filter(
      (r) => !(T(r, binds[0]) && (r.to_slug === binds[1] || r.from_slug === binds[2]))
    );
    return { results: [], changes: before - state.redirects.length };
  }
  if (sql === "UPDATE page_redirects SET to_slug = ? WHERE tenant_id = ? AND to_slug = ?") {
    let changes = 0;
    for (const r of state.redirects) {
      if (T(r, binds[1]) && r.to_slug === binds[2]) {
        r.to_slug = binds[0] as string;
        changes++;
      }
    }
    return { results: [], changes };
  }
  if (sql.startsWith("INSERT INTO page_redirects")) {
    const [tenantId, from, to, createdAt] = binds as string[];
    const existing = state.redirects.find((r) => r.tenant_id === tenantId && r.from_slug === from);
    if (existing) {
      existing.to_slug = to;
      existing.created_at = createdAt;
    } else {
      state.redirects.push({ tenant_id: tenantId, from_slug: from, to_slug: to, created_at: createdAt });
    }
    return { results: [], changes: 1 };
  }
  if (sql === "SELECT to_slug FROM page_redirects WHERE tenant_id = ? AND from_slug = ?") {
    const r = state.redirects.find((x) => T(x, binds[0]) && x.from_slug === binds[1]);
    return { results: r ? [{ to_slug: r.to_slug }] : [], changes: 0 };
  }
  if (sql === "SELECT from_slug, to_slug FROM page_redirects WHERE tenant_id = ?") {
    return { results: state.redirects.filter((x) => T(x, binds[0])), changes: 0 };
  }

  throw new Error(`memDb: unhandled SQL: ${sql}`);
}

function memDb(state: MemState): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            __sql: sql,
            __binds: binds,
            async first<T>(): Promise<T | null> {
              return ((execMem(state, sql, binds).results[0] as T) ?? null);
            },
            async all<T>() {
              return { results: execMem(state, sql, binds).results as T[] };
            },
            async run() {
              const { changes } = execMem(state, sql, binds);
              return { success: true, meta: { changes } };
            },
          };
        },
      };
    },
    async batch(stmts: { __sql: string; __binds: unknown[] }[]) {
      state.batches.push(stmts.map((s) => norm(s.__sql).split(" ").slice(0, 3).join(" ")));
      return stmts.map((s) => {
        const { results, changes } = execMem(state, s.__sql, s.__binds);
        return { success: true, meta: { changes }, results };
      });
    },
  } as unknown as D1Database;
}

function buildMemApp(state: MemState, tenantOverrides: Partial<Tenant> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", {
      id: TENANT_ID,
      name: "Stitch Guild",
      slug: "stitchguild",
      tenant_type: "guild",
      custom_domain: null,
      settings_json: "{}",
      updated_at: "2026-09-01T00:00:00.000Z",
      ...tenantOverrides,
    } as Tenant);
    (c as unknown as { set(k: string, v: unknown): void }).set("user", { id: "user-9" });
    await next();
  });
  app.route("/", pageRoutes);
  const env = { DB: memDb(state), APP_URL: "https://quilthosting.com" } as unknown as Env;
  return { app, env };
}

const DRAFT_BLOCKS = [{ type: "heading", text: "Draft heading", level: 2 }, { type: "divider" }];

describe("GET list + GET /:id — draft flags and trash", () => {
  it("lists live pages with has_draft/revision/published_at and hides trashed rows", async () => {
    const state = memState([
      memPage(),
      memPage({ id: "page-2", slug: "drafty", draft_blocks_json: JSON.stringify(DRAFT_BLOCKS), draft_updated_at: "2026-09-05T00:00:00.000Z" }),
      memPage({ id: "page-3", slug: "gone", deleted_at: "2026-09-06T00:00:00.000Z", published: 0 }),
    ]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual(["page-1", "page-2"]);
    expect(rows[0]).toMatchObject({ has_draft: 0, revision: 3, published_at: "2026-09-01T00:00:00.000Z" });
    expect(rows[1]).toMatchObject({ has_draft: 1, draft_updated_at: "2026-09-05T00:00:00.000Z" });
  });

  it("?trash=1 lists ONLY trashed rows", async () => {
    const state = memState([memPage(), memPage({ id: "page-3", slug: "gone", deleted_at: "x", published: 0 })]);
    const { app, env } = buildMemApp(state);
    const rows = (await (await app.request("/?trash=1", { method: "GET" }, env)).json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["page-3"]);
  });

  it("GET /:id returns the full row with parsed blocks and draft_blocks", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(DRAFT_BLOCKS), draft_title: "Draft title" })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.has_draft).toBe(1);
    expect(json.draft_title).toBe("Draft title");
    expect(json.draft_blocks).toEqual(DRAFT_BLOCKS);
    expect(json.blocks).toEqual([{ type: "heading", text: "Live", level: 2 }]);
    expect(json.revision).toBe(3);
  });

  it("GET /:id 404s for another tenant's page", async () => {
    const state = memState([memPage({ tenant_id: "someone-else" })]);
    const { app, env } = buildMemApp(state);
    expect((await app.request("/page-1", { method: "GET" }, env)).status).toBe(404);
  });
});

describe("PUT /:id/draft — autosave", () => {
  it("writes the draft columns, bumps revision, and leaves live content untouched", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request(
      "/page-1/draft",
      jsonReq("PUT", { title: "New title", blocks: DRAFT_BLOCKS, revision: 3 }),
      env
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, revision: 4, has_draft: 1 });
    expect(typeof json.draft_updated_at).toBe("string");

    const page = state.pages[0];
    expect(JSON.parse(page.draft_blocks_json as string)).toEqual(DRAFT_BLOCKS);
    expect(page.draft_title).toBe("New title");
    expect(page.revision).toBe(4);
    // Live untouched.
    expect(page.title).toBe("About");
    expect(JSON.parse(page.blocks_json as string)).toEqual([{ type: "heading", text: "Live", level: 2 }]);
    expect(page.updated_at).toBe("2026-09-01T00:00:00.000Z");
    expect(page.published_at).toBe("2026-09-01T00:00:00.000Z");
    // No revision snapshot on autosave.
    expect(state.revisions).toHaveLength(0);
  });

  it("is a single UPDATE (no pre-read) on the happy path", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    await app.request("/page-1/draft", jsonReq("PUT", { blocks: DRAFT_BLOCKS }), env);
    expect(state.statements).toHaveLength(1);
    expect(state.statements[0].sql).toMatch(/^UPDATE pages SET draft_blocks_json = \?/);
    expect(state.statements[0].sql).toContain("RETURNING revision, draft_updated_at");
  });

  it("409s with the current revision when the client's revision is stale, writing nothing", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/draft", jsonReq("PUT", { blocks: DRAFT_BLOCKS, revision: 2 }), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Page was changed elsewhere", revision: 3 });
    expect(state.pages[0].draft_blocks_json).toBeNull();
    expect(state.pages[0].revision).toBe(3);
  });

  it("rejects unsupported block types with a field-level 400", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/draft", jsonReq("PUT", { blocks: [{ type: "carousel" }] }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: { path: string }[] };
    expect(json.issues[0].path).toBe("blocks.0.type");
    expect(state.pages[0].revision).toBe(3);
  });

  it("404s for an unknown page and 409s for a trashed page", async () => {
    const state = memState([memPage({ id: "trashed", deleted_at: "x", published: 0 })]);
    const { app, env } = buildMemApp(state);
    expect((await app.request("/nope/draft", jsonReq("PUT", { blocks: [] }), env)).status).toBe(404);
    const res = await app.request("/trashed/draft", jsonReq("PUT", { blocks: [] }), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/trash/);
  });
});

describe("POST /:id/publish", () => {
  it("promotes the draft, clears it, snapshots the PREVIOUS live content, bumps revision, and sets published_at", async () => {
    const state = memState([
      memPage({ draft_blocks_json: JSON.stringify(DRAFT_BLOCKS), draft_title: "Draft title", draft_updated_at: "2026-09-05T00:00:00.000Z" }),
    ]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/publish", jsonReq("POST", { revision: 3 }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ id: "page-1", revision: 4, has_draft: 0, published: 1, title: "Draft title" });
    expect(json.blocks).toEqual(DRAFT_BLOCKS);

    const page = state.pages[0];
    expect(JSON.parse(page.blocks_json as string)).toEqual(DRAFT_BLOCKS);
    expect(JSON.parse(page.content_json as string).html).toContain("Draft heading");
    expect(page.draft_blocks_json).toBeNull();
    expect(page.draft_title).toBeNull();
    expect(page.draft_updated_at).toBeNull();
    expect(page.revision).toBe(4);
    expect(page.published_at).not.toBe("2026-09-01T00:00:00.000Z");
    expect(page.updated_at).toBe(page.published_at);

    // History = what was live before.
    expect(state.revisions).toHaveLength(1);
    expect(state.revisions[0]).toMatchObject({ kind: "publish", title: "About", page_id: "page-1", created_by: "user-9" });
    expect(JSON.parse(state.revisions[0].blocks_json as string)).toEqual([{ type: "heading", text: "Live", level: 2 }]);

    // Snapshot + promote + prune arrived in ONE batch.
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0]).toEqual(["INSERT INTO page_revisions", "UPDATE pages SET", "DELETE FROM page_revisions"]);
  });

  it("publishes explicit blocks from the body (and still clears any stored draft)", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(DRAFT_BLOCKS), draft_title: "Stale draft" })]);
    const { app, env } = buildMemApp(state);
    const blocks = [{ type: "text", html: "<p>Explicit</p>" }];
    const res = await app.request("/page-1/publish", jsonReq("POST", { blocks, title: "Explicit title", seo_title: "SEO" }), env);
    expect(res.status).toBe(200);
    const page = state.pages[0];
    expect(JSON.parse(page.blocks_json as string)).toEqual(blocks);
    expect(page.title).toBe("Explicit title");
    expect(page.seo_title).toBe("SEO");
    expect(page.draft_blocks_json).toBeNull();
    expect(page.draft_title).toBeNull();
  });

  it("409s with the current revision on a stale revision and writes nothing (no snapshot either)", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(DRAFT_BLOCKS) })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/publish", jsonReq("POST", { revision: 1 }), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Page was changed elsewhere", revision: 3 });
    expect(state.revisions).toHaveLength(0);
    expect(state.batches).toHaveLength(0);
    expect(state.pages[0].draft_blocks_json).not.toBeNull();
  });

  it("a concurrent write between the read and the batch loses cleanly: no snapshot, no promote, 409", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(DRAFT_BLOCKS) })]);
    const { app, env } = buildMemApp(state);
    // Simulate another tab landing an autosave after this request read the row.
    const db = env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown> };
    const realBatch = db.batch;
    db.batch = async (stmts) => {
      state.pages[0].revision = 4;
      return realBatch.call(db, stmts);
    };
    const res = await app.request("/page-1/publish", jsonReq("POST", { revision: 3 }), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Page was changed elsewhere", revision: 4 });
    expect(state.revisions).toHaveLength(0);
    expect(state.pages[0].draft_blocks_json).not.toBeNull();
  });

  it("metadata-only republish of a legacy page (no blocks) keeps its content_json", async () => {
    const legacy = JSON.stringify({ html: "<p>legacy</p>" });
    const state = memState([memPage({ blocks_json: null, content_json: legacy })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/publish", jsonReq("POST", { noindex: true, published: false }), env);
    expect(res.status).toBe(200);
    const page = state.pages[0];
    expect(page.content_json).toBe(legacy);
    expect(page.blocks_json).toBeNull();
    expect(page.noindex).toBe(1);
    expect(page.published).toBe(0);
    expect(page.revision).toBe(4);
  });

  it("accepts an empty body", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/publish", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(state.pages[0].revision).toBe(4);
  });

  it("a slug change on publish writes a redirect row (old -> new)", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/publish", jsonReq("POST", { slug: "about-us" }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { previous_slug: string }).previous_slug).toBe("about");
    expect(state.pages[0].slug).toBe("about-us");
    expect(state.redirects).toEqual([
      expect.objectContaining({ tenant_id: TENANT_ID, from_slug: "about", to_slug: "about-us" }),
    ]);
  });

  it("prunes history to the newest 50 revisions", async () => {
    const state = memState();
    for (let i = 0; i < 55; i++) {
      state.revisions.push({
        id: `old-${String(i).padStart(3, "0")}`,
        tenant_id: TENANT_ID,
        page_id: "page-1",
        kind: "publish",
        title: "old",
        blocks_json: null,
        content_json: null,
        created_by: null,
        created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      } as MemRevision);
    }
    const { app, env } = buildMemApp(state);
    await app.request("/page-1/publish", { method: "POST" }, env);
    expect(state.revisions).toHaveLength(50);
    // The one just written (newest) survives; the oldest were dropped.
    expect(state.revisions.some((r) => r.kind === "publish" && r.title === "About")).toBe(true);
    expect(state.revisions.some((r) => r.id === "old-000")).toBe(false);
  });
});

describe("PATCH /:id — revision guard and redirects", () => {
  it("409s on a stale revision without writing", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1", jsonReq("PATCH", { title: "X", revision: 2 }), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Page was changed elsewhere", revision: 3 });
    expect(state.pages[0].title).toBe("About");
  });

  it("bumps revision on success and returns it", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1", jsonReq("PATCH", { title: "X", revision: 3 }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revision: number }).revision).toBe(4);
    expect(state.pages[0].revision).toBe(4);
  });

  it("a slug change writes old -> new, collapses chains, and drops a redirect FROM the new slug", async () => {
    const state = memState();
    // "ancient" used to redirect to "about"; "about-us" used to redirect elsewhere.
    state.redirects.push({ tenant_id: TENANT_ID, from_slug: "ancient", to_slug: "about", created_at: "x" });
    state.redirects.push({ tenant_id: TENANT_ID, from_slug: "about-us", to_slug: "somewhere", created_at: "x" });
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1", jsonReq("PATCH", { slug: "about-us" }), env);
    expect(res.status).toBe(200);
    const map = Object.fromEntries(state.redirects.map((r) => [r.from_slug, r.to_slug]));
    expect(map).toEqual({ ancient: "about-us", about: "about-us" });
  });

  it("refuses to PATCH a trashed page", async () => {
    const state = memState([memPage({ deleted_at: "x", published: 0 })]);
    const { app, env } = buildMemApp(state);
    expect((await app.request("/page-1", jsonReq("PATCH", { title: "X" }), env)).status).toBe(409);
  });
});

describe("POST /:id/discard-draft", () => {
  it("clears the draft columns and bumps revision", async () => {
    const state = memState([memPage({ draft_blocks_json: "[]", draft_title: "T", draft_updated_at: "x" })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/discard-draft", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revision: 4, has_draft: 0 });
    expect(state.pages[0]).toMatchObject({ draft_blocks_json: null, draft_title: null, draft_updated_at: null, revision: 4 });
    expect(state.pages[0].title).toBe("About");
  });

  it("409s on a stale revision", async () => {
    const state = memState([memPage({ draft_blocks_json: "[]" })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/discard-draft", jsonReq("POST", { revision: 1 }), env);
    expect(res.status).toBe(409);
    expect(state.pages[0].draft_blocks_json).toBe("[]");
  });
});

describe("revisions", () => {
  function seedRevisions(state: MemState) {
    state.revisions.push(
      {
        id: "rev-a",
        tenant_id: TENANT_ID,
        page_id: "page-1",
        kind: "publish",
        title: "Older",
        blocks_json: JSON.stringify([{ type: "heading", text: "Older", level: 2 }, { type: "divider" }]),
        content_json: "{}",
        created_by: "user-1",
        created_at: "2026-08-01T00:00:00.000Z",
      } as MemRevision,
      {
        id: "rev-b",
        tenant_id: TENANT_ID,
        page_id: "page-1",
        kind: "publish",
        title: "Newer",
        blocks_json: null,
        content_json: JSON.stringify({ html: "<p>legacy html</p>" }),
        created_by: null,
        created_at: "2026-08-15T00:00:00.000Z",
      } as MemRevision
    );
  }

  it("GET /revisions lists newest first with block_count and no bodies", async () => {
    const state = memState();
    seedRevisions(state);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/revisions", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual(["rev-b", "rev-a"]);
    expect(rows[1]).toEqual({ id: "rev-a", kind: "publish", title: "Older", created_at: "2026-08-01T00:00:00.000Z", created_by: "user-1", created_by_name: "name-of-user-1", block_count: 2 });
    expect(rows[0]).not.toHaveProperty("blocks_json");
  });

  it("GET /revisions/:rid returns the full revision with parsed blocks (legacy HTML wrapped in an html block)", async () => {
    const state = memState();
    seedRevisions(state);
    const { app, env } = buildMemApp(state);
    let json = (await (await app.request("/page-1/revisions/rev-a", { method: "GET" }, env)).json()) as Record<string, unknown>;
    expect(json.blocks).toEqual([{ type: "heading", text: "Older", level: 2 }, { type: "divider" }]);
    json = (await (await app.request("/page-1/revisions/rev-b", { method: "GET" }, env)).json()) as Record<string, unknown>;
    expect(json.blocks).toEqual([{ type: "html", html: "<p>legacy html</p>" }]);
    expect((await app.request("/page-1/revisions/nope", { method: "GET" }, env)).status).toBe(404);
  });

  it("restore loads the revision INTO THE DRAFT, snapshots current live as pre_restore, and leaves live untouched", async () => {
    const state = memState();
    seedRevisions(state);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/revisions/rev-a/restore", jsonReq("POST", { revision: 3 }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, revision: 4, has_draft: 1, restored_from: "rev-a" });

    const page = state.pages[0];
    expect(JSON.parse(page.draft_blocks_json as string)).toEqual([{ type: "heading", text: "Older", level: 2 }, { type: "divider" }]);
    expect(page.draft_title).toBe("Older");
    expect(page.revision).toBe(4);
    expect(page.title).toBe("About");
    expect(JSON.parse(page.blocks_json as string)).toEqual([{ type: "heading", text: "Live", level: 2 }]);

    const pre = state.revisions.find((r) => r.kind === "pre_restore");
    expect(pre).toBeDefined();
    expect(pre!.title).toBe("About");
    expect(JSON.parse(pre!.blocks_json as string)).toEqual([{ type: "heading", text: "Live", level: 2 }]);
    expect(state.batches[0]).toEqual(["INSERT INTO page_revisions", "UPDATE pages SET", "DELETE FROM page_revisions"]);
  });

  it("restore 409s on a stale revision and writes nothing", async () => {
    const state = memState();
    seedRevisions(state);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/revisions/rev-a/restore", jsonReq("POST", { revision: 9 }), env);
    expect(res.status).toBe(409);
    expect(state.pages[0].draft_blocks_json).toBeNull();
    expect(state.revisions).toHaveLength(2);
  });
});

describe("DELETE /:id — trash, restore, permanent", () => {
  it("soft delete sets deleted_at and unpublishes; the page vanishes from the list and shows in trash", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1", { method: "DELETE" }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(typeof state.pages[0].deleted_at).toBe("string");
    expect(state.pages[0].published).toBe(0);
    expect(state.pages[0].revision).toBe(4);

    const live = (await (await app.request("/", { method: "GET" }, env)).json()) as unknown[];
    expect(live).toEqual([]);
    const trash = (await (await app.request("/?trash=1", { method: "GET" }, env)).json()) as { id: string }[];
    expect(trash.map((r) => r.id)).toEqual(["page-1"]);
  });

  it("POST /:id/restore undeletes (still unpublished until the owner publishes again)", async () => {
    const state = memState([memPage({ deleted_at: "2026-09-06T00:00:00.000Z", published: 0 })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/restore", { method: "POST" }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.deleted_at).toBeNull();
    expect(json.published).toBe(0);
    expect(json.revision).toBe(4);
    expect(state.pages[0].deleted_at).toBeNull();
  });

  it("?permanent=1 hard-deletes the page, its revisions, and redirects touching its slug", async () => {
    const state = memState();
    state.revisions.push({ id: "r1", tenant_id: TENANT_ID, page_id: "page-1", kind: "publish", title: "x", blocks_json: null, content_json: null, created_by: null, created_at: "x" } as MemRevision);
    state.redirects.push({ tenant_id: TENANT_ID, from_slug: "old-about", to_slug: "about", created_at: "x" });
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1?permanent=1", { method: "DELETE" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, permanent: true });
    expect(state.pages).toHaveLength(0);
    expect(state.revisions).toHaveLength(0);
    expect(state.redirects).toHaveLength(0);
  });

  it("404s for a page that isn't this tenant's", async () => {
    const state = memState([memPage({ tenant_id: "other" })]);
    const { app, env } = buildMemApp(state);
    expect((await app.request("/page-1", { method: "DELETE" }, env)).status).toBe(404);
    expect((await app.request("/page-1?permanent=1", { method: "DELETE" }, env)).status).toBe(404);
    expect(state.pages).toHaveLength(1);
  });
});

describe("POST /preview — render unsaved editor state", () => {
  it("returns sanitized HTML (script payload inert) and writes nothing", async () => {
    const state = memState();
    const { app, env } = buildMemApp(state);
    const res = await app.request(
      "/preview",
      jsonReq("POST", {
        blocks: [
          { type: "heading", text: "<script>alert(1)</script>Hi" },
          { type: "text", html: '<p onclick="evil()">Body</p><script>evil()</script>' },
          { type: "button", label: "Go", href: "javascript:alert(1)" },
        ],
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { html } = (await res.json()) as { html: string };
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;Hi");
    expect(html).toContain("<p>Body</p>");
    expect(state.statements).toHaveLength(0);
  });

  it("400s on an unsupported block type", async () => {
    const { app, env } = buildMemApp(memState());
    const res = await app.request("/preview", jsonReq("POST", { blocks: [{ type: "carousel" }] }), env);
    expect(res.status).toBe(400);
  });
});

describe("GET /:id/preview", () => {
  it("guild tenant: JSON { title, html, slug } from the draft, no-store + noindex", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(DRAFT_BLOCKS), draft_title: "Draft title" })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/preview?source=draft", { method: "GET" }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("x-preview-source")).toBe("draft");
    const json = (await res.json()) as { title: string; html: string; slug: string };
    expect(json.title).toBe("Draft title");
    expect(json.slug).toBe("about");
    expect(json.html).toContain("Draft heading");
    expect(json.html).not.toContain(">Live<");
  });

  it("guild tenant: source=live renders live content; source=draft with no draft falls back to live", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(DRAFT_BLOCKS) })]);
    const { app, env } = buildMemApp(state);
    let res = await app.request("/page-1/preview?source=live", { method: "GET" }, env);
    expect(((await res.json()) as { html: string }).html).toContain(">Live<");
    expect(res.headers.get("x-preview-source")).toBe("live");

    state.pages[0].draft_blocks_json = null;
    res = await app.request("/page-1/preview", { method: "GET" }, env);
    expect(res.headers.get("x-preview-source")).toBe("live");
    expect(((await res.json()) as { html: string }).html).toContain(">Live<");
  });

  it("business tenant: full-page HTML through the live renderer", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(DRAFT_BLOCKS), draft_title: "Draft title" })]);
    const { app, env } = buildMemApp(state, { tenant_type: "business", name: "Stitch Studio" });
    const res = await app.request("/page-1/preview", { method: "GET", headers: { host: "quilthosting.com" } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Draft heading");
    expect(html).toContain("<title>Draft title");
    expect(html).toContain("Stitch Studio");
  });
});

// ---------------------------------------------------------------------------
// Section documents (the new site renderer). Kits and the section editor
// store section arrays in the same blocks_json column; the API must accept,
// validate (parseSections), store verbatim, snapshot html for content_json,
// and read them back without ever running them through parseBlocks.
// ---------------------------------------------------------------------------

const STYLE = { bg: "none", width: "normal", spacing: "normal", align: "left", media: "right" };
const SECTION_DOC = [
  {
    type: "hero",
    variant: "minimal",
    id: "s_hero",
    title: "Welcome to the guild",
    subtitle: "Guests are welcome at any meeting.",
    ctaLabel: "Join",
    ctaHref: "/membership",
    style: { ...STYLE, bg: "tint", align: "center" },
  },
  { type: "rich_text", variant: "prose", id: "s_about", heading: "About", html: "<p>We meet monthly.</p>", style: { ...STYLE } },
  { type: "events", variant: "list", id: "s_events", heading: "Coming up", limit: 4, style: { ...STYLE, width: "narrow" } },
  { type: "divider", id: "s_div", style: { ...STYLE, spacing: "tight" } },
];

describe("section documents are first-class in the pages API", () => {
  it("POST stores the section array verbatim in blocks_json and snapshots section html into content_json", async () => {
    const state = memState([]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/", jsonReq("POST", { title: "Home", slug: "home", blocks: SECTION_DOC }), env);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { format: string }).format).toBe("sections");
    expect(state.pages).toHaveLength(1);
    const row = state.pages[0];
    expect(JSON.parse(String(row.blocks_json))).toEqual(SECTION_DOC);
    const html = String(JSON.parse(String(row.content_json)).html);
    expect(html).toContain('class="qh-s ');
    expect(html).toContain("Welcome to the guild");
    expect(html).toContain("<p>We meet monthly.</p>");
    // Section html, never the legacy block markup.
    expect(html).not.toContain("qh-block-");
  });

  it("PUT /:id/draft stores sections; GET /:id returns format, draft_format and draft_sections with blocks: []", async () => {
    const state = memState([memPage()]);
    const { app, env } = buildMemApp(state);
    const put = await app.request("/page-1/draft", jsonReq("PUT", { blocks: SECTION_DOC, revision: 3 }), env);
    expect(put.status).toBe(200);
    expect((await put.json()) as object).toMatchObject({ ok: true, has_draft: 1, format: "sections" });
    expect(JSON.parse(String(state.pages[0].draft_blocks_json))).toEqual(SECTION_DOC);
    // Live is still the legacy block page.
    expect(state.pages[0].blocks_json).toBe(JSON.stringify([{ type: "heading", text: "Live", level: 2 }]));

    const get = await app.request("/page-1", { method: "GET" }, env);
    const json = (await get.json()) as Record<string, unknown>;
    expect(json.format).toBe("blocks");
    expect(json.sections).toBeNull();
    expect((json.blocks as unknown[]).length).toBe(1);
    expect(json.draft_format).toBe("sections");
    expect(json.draft_blocks).toEqual([]);
    expect(json.draft_sections).toEqual(SECTION_DOC);
  });

  it("POST /:id/publish promotes a section draft verbatim and snapshots section html", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(SECTION_DOC), draft_title: "New home" })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/publish", jsonReq("POST", { revision: 3 }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.format).toBe("sections");
    expect(json.blocks).toEqual([]);
    expect(json.sections).toEqual(SECTION_DOC);
    const row = state.pages[0];
    expect(JSON.parse(String(row.blocks_json))).toEqual(SECTION_DOC);
    expect(String(JSON.parse(String(row.content_json)).html)).toContain('class="qh-s ');
    expect(row.draft_blocks_json).toBeNull();
    expect(row.title).toBe("New home");
    // History snapshot holds the block page that was live before.
    expect(state.revisions).toHaveLength(1);
    expect(state.revisions[0].blocks_json).toContain('"heading"');
  });

  it("publishing explicit sections in the body works the same way", async () => {
    const state = memState([memPage()]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/publish", jsonReq("POST", { revision: 3, blocks: SECTION_DOC }), env);
    expect(res.status).toBe(200);
    expect(JSON.parse(String(state.pages[0].blocks_json))).toEqual(SECTION_DOC);
  });

  it("rejects an unsupported section type with a sections.N.type issue and writes nothing", async () => {
    const state = memState([memPage()]);
    const { app, env } = buildMemApp(state);
    const bad = [SECTION_DOC[0], { type: "carousel", id: "s_c", style: { ...STYLE } }];
    for (const req of [
      app.request("/", jsonReq("POST", { title: "X", blocks: bad }), env),
      app.request("/page-1/draft", jsonReq("PUT", { blocks: bad }), env),
      app.request("/page-1/publish", jsonReq("POST", { blocks: bad }), env),
      app.request("/page-1", jsonReq("PATCH", { blocks: bad }), env),
      app.request("/preview", jsonReq("POST", { blocks: bad }), env),
    ]) {
      const res = await req;
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; issues: { path: string; message: string }[] };
      expect(json.error).toBe("Invalid request body");
      expect(json.issues).toEqual([{ path: "sections.1.type", message: 'Unsupported section type "carousel"' }]);
    }
    expect(state.pages).toHaveLength(1);
    expect(state.pages[0].draft_blocks_json).toBeNull();
    expect(state.pages[0].revision).toBe(3);
  });

  it("rejects a section that fails field validation with a sections.N.field path", async () => {
    const { app, env } = buildMemApp(memState([memPage()]));
    const res = await app.request(
      "/page-1/draft",
      jsonReq("PUT", {
        blocks: [
          { type: "hero", id: "s_h", style: { ...STYLE } },
          { type: "spacer", id: "s_s", height: 9999, style: { ...STYLE } },
        ],
      }),
      env
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: { path: string }[] };
    expect(json.issues.map((i) => i.path)).toEqual(["sections.0.title", "sections.1.height"]);
  });

  it("a legacy block document is unaffected: stored as blocks with blocksToHtml markup", async () => {
    const state = memState([]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/", jsonReq("POST", { title: "Classic", blocks: DRAFT_BLOCKS }), env);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { format: string }).format).toBe("blocks");
    expect(JSON.parse(String(state.pages[0].blocks_json))).toEqual([
      { type: "heading", text: "Draft heading", level: 2 },
      { type: "divider" },
    ]);
    expect(String(JSON.parse(String(state.pages[0].content_json)).html)).toContain("qh-block-heading");
  });

  it("a mixed document (blocks and sections together) normalizes to sections", async () => {
    const state = memState([memPage()]);
    const { app, env } = buildMemApp(state);
    const mixed = [{ type: "heading", text: "Hi there", level: 2 }, SECTION_DOC[0], { type: "text", html: "<p>Body</p>" }];
    const res = await app.request("/page-1/draft", jsonReq("PUT", { blocks: mixed }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { format: string }).format).toBe("sections");
    const stored = JSON.parse(String(state.pages[0].draft_blocks_json)) as Record<string, unknown>[];
    expect(stored).toHaveLength(3);
    expect(stored.every((s) => typeof s.style === "object" && typeof s.id === "string")).toBe(true);
    expect(stored[0]).toMatchObject({ type: "rich_text", variant: "prose", html: "<h2>Hi there</h2>" });
    expect(stored[1]).toMatchObject({ type: "hero", id: "s_hero", title: "Welcome to the guild" });
    expect(stored[2]).toMatchObject({ type: "rich_text", html: "<p>Body</p>" });
  });

  it("POST /preview returns format for both formats, and design tokens for sections", async () => {
    const { app, env } = buildMemApp(memState());
    const blocks = await app.request("/preview", jsonReq("POST", { blocks: DRAFT_BLOCKS }), env);
    expect(blocks.status).toBe(200);
    const b = (await blocks.json()) as Record<string, unknown>;
    expect(b.format).toBe("blocks");
    expect(String(b.html)).toContain("qh-block-heading");
    expect(b.designVars).toBeUndefined();

    const sections = await app.request("/preview", jsonReq("POST", { blocks: SECTION_DOC }), env);
    expect(sections.status).toBe(200);
    const s = (await sections.json()) as Record<string, unknown>;
    expect(s.format).toBe("sections");
    expect(String(s.html)).toContain('class="qh-s ');
    expect(String(s.html)).toContain("qh-hero--minimal");
    expect(String(s.designVars)).toContain("--qh-");
    expect(sections.headers.get("cache-control")).toBe("no-store");
  });

  it("GET list rows carry format", async () => {
    const state = memState([memPage(), memPage({ id: "page-2", slug: "home", blocks_json: JSON.stringify(SECTION_DOC) })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/", { method: "GET" }, env);
    const rows = (await res.json()) as { id: string; format: string }[];
    expect(rows.map((r) => [r.id, r.format])).toEqual([["page-1", "blocks"], ["page-2", "sections"]]);
  });

  it("GET /:id/preview (guild) renders a section draft standalone, never through parseBlocks", async () => {
    const state = memState([memPage({ draft_blocks_json: JSON.stringify(SECTION_DOC), draft_title: "Sections draft" })]);
    const { app, env } = buildMemApp(state);
    const res = await app.request("/page-1/preview?source=draft", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { title: string; html: string; format: string };
    expect(json.title).toBe("Sections draft");
    expect(json.format).toBe("sections");
    expect(json.html).toContain('class="qh-s ');
    expect(json.html).toContain("Welcome to the guild");
    expect(json.html).toContain("<p>We meet monthly.</p>");
  });

  it("revisions: a section revision is returned as sections and restores into the draft intact", async () => {
    const state = memState([
      memPage({ blocks_json: JSON.stringify(SECTION_DOC), content_json: JSON.stringify({ html: "<section>x</section>" }) }),
    ]);
    const { app, env } = buildMemApp(state);
    // Publish a block page over it so history holds the section version.
    const pub = await app.request("/page-1/publish", jsonReq("POST", { revision: 3, blocks: DRAFT_BLOCKS }), env);
    expect(pub.status).toBe(200);
    expect(state.revisions).toHaveLength(1);
    const rid = state.revisions[0].id;

    const get = await app.request(`/page-1/revisions/${rid}`, { method: "GET" }, env);
    const rev = (await get.json()) as { format: string; blocks: unknown[]; sections: unknown[] };
    expect(rev.format).toBe("sections");
    expect(rev.blocks).toEqual([]);
    expect(rev.sections).toEqual(SECTION_DOC);

    const restore = await app.request(`/page-1/revisions/${rid}/restore`, jsonReq("POST", { revision: 4 }), env);
    expect(restore.status).toBe(200);
    expect(JSON.parse(String(state.pages[0].draft_blocks_json))).toEqual(SECTION_DOC);
    // Live stayed the block page.
    expect(String(state.pages[0].blocks_json)).toContain('"heading"');
  });
});

describe("GET /section-catalog", () => {
  it("lists every section type with variants, a palette group, and its fields", async () => {
    const { app, env } = buildMemApp(memState());
    const res = await app.request("/section-catalog", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      groups: string[];
      style: Record<string, string[]>;
      types: {
        type: string;
        label: string;
        group: string;
        variants: string[];
        fields: { name: string; kind: string; [k: string]: unknown }[];
        defaults: Record<string, unknown>;
      }[];
    };
    expect(json.types).toHaveLength(33);
    expect(json.types.map((t) => t.type)).toEqual([...SECTION_TYPES]);
    expect(json.groups).toEqual(["Openers", "Content", "Membership", "Events", "Community", "Business", "Utility", "Layout"]);
    const groupOf = Object.fromEntries(json.types.map((t) => [t.type, t.group]));
    expect(groupOf).toMatchObject({
      timeline: "Content", quote: "Content",
      officers: "Membership", benefits: "Membership",
      event_spotlight: "Events",
      projects: "Community", sponsors: "Community",
      services: "Business", portfolio: "Business", process: "Business",
      documents: "Utility", donate: "Utility", newsletter_signup: "Utility", hours_location: "Utility",
    });
    expect(json.types.filter((t) => t.group === "Utility").map((t) => t.type).sort()).toEqual(["documents", "donate", "newsletter_signup", "hours_location"].sort());
    for (const t of json.types) {
      expect(json.groups).toContain(t.group);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.variants).toEqual([...SECTION_VARIANTS[t.type as keyof typeof SECTION_VARIANTS]]);
    }
    expect(json.style.bg).toEqual(["none", "tint", "brand", "dark", "image", "pattern"]);

    const byName = (type: string) => {
      const t = json.types.find((x) => x.type === type)!;
      return Object.fromEntries(t.fields.map((f) => [f.name, f]));
    };
    const hero = byName("hero");
    expect(Object.keys(hero)).toEqual(["eyebrow", "title", "subtitle", "ctaLabel", "ctaHref", "secondaryLabel", "secondaryHref", "stats"]);
    expect(hero.title).toMatchObject({ kind: "text", required: true, maxLength: 160 });
    expect(hero.subtitle).toMatchObject({ kind: "text", multiline: true });
    expect(hero.ctaHref).toMatchObject({ kind: "link" });
    expect(hero.stats).toMatchObject({ kind: "items", noun: "Number", maxItems: 6 });
    expect((hero.stats.itemFields as { name: string }[]).map((f) => f.name)).toEqual(["value", "label"]);

    expect(byName("rich_text").html).toMatchObject({ kind: "html", required: true });
    expect(byName("embed").html).toMatchObject({ kind: "text", multiline: true });
    expect(byName("events").limit).toMatchObject({ kind: "number", min: 1, max: 50, default: 6 });
    expect(byName("contact").showDetails).toMatchObject({ kind: "boolean", default: true });
    expect(byName("gallery").source).toMatchObject({ kind: "select", options: ["manual", "gallery"] });
    expect(byName("cta").kind).toMatchObject({ kind: "select", options: ["primary", "secondary"], default: "primary" });
    expect(byName("meeting_info").mapUrl).toMatchObject({ kind: "link" });
    const imageItems = byName("image").items;
    expect(imageItems.kind).toBe("items");
    const imageItemFields = Object.fromEntries(
      (imageItems.itemFields as { name: string; kind: string }[]).map((f) => [f.name, f.kind])
    );
    expect(imageItemFields).toEqual({ imageId: "image", url: "text", alt: "text", caption: "text" });
    expect(byName("spacer").height).toMatchObject({ kind: "number", min: 8, max: 160, default: 24 });
    expect(json.types.find((t) => t.type === "events")!.defaults).toEqual({ limit: 6 });

    // Phase 2 types
    expect(byName("donate").heading).toMatchObject({ kind: "text" });
    expect(byName("documents").limit).toMatchObject({ kind: "number", min: 1, max: 50, default: 10 });
    expect(byName("services").items).toMatchObject({ kind: "items", noun: "Service" });
    expect((byName("hours_location").hours.itemFields as { name: string }[]).map((f) => f.name)).toEqual(["day", "open"]);
    expect(byName("officers").items.itemFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "imageId", kind: "image" }), expect.objectContaining({ name: "email", kind: "text" })])
    );
    expect(byName("quote").quote).toMatchObject({ kind: "text", required: true });
  });

  it("the editor's starter content for every section type validates against the schema (admin.html drift guard)", () => {
    // Mirrors defaultSection() in public/admin.html: type + catalog defaults +
    // WB_SECTION_DEFAULTS + first variant + id + default style.
    const html = readFileSync(fileURLToPath(new URL("../../public/admin.html", import.meta.url)), "utf8");
    const m = html.match(/const WB_SECTION_DEFAULTS = (\{[\s\S]*?\n {4}\});/);
    expect(m, "WB_SECTION_DEFAULTS not found in admin.html").toBeTruthy();
    // Evaluates a literal object from this repo's own admin.html (not user input).
    const defaults = new Function(`return ${m![1]}`)() as Record<string, Record<string, unknown>>;
    const cat = sectionCatalog();
    // Every editor default names a real section type. The editor may lag the
    // catalog (phase-2 types land in admin.html under Task C), so a catalog
    // type without an editor entry is validated on its schema defaults alone
    // -- which means every new type's required fields must default or the
    // editor's "insert" would produce an invalid section.
    const catalogTypes = new Set(cat.map((t) => t.type));
    for (const key of Object.keys(defaults)) expect(catalogTypes.has(key as never), `admin.html default for unknown type "${key}"`).toBe(true);
    for (const t of cat) {
      const s: Record<string, unknown> = { type: t.type, ...t.defaults, ...(defaults[t.type] ?? {}) };
      if (t.type === "quote" && !defaults.quote) s.quote = "Sample quote";
      const variants = t.variants.filter((v) => v);
      if (variants.length) s.variant = variants[0];
      s.id = "s_abc123";
      s.style = { bg: "none", width: "normal", spacing: "normal", align: "left", media: "right" };
      const { sections, issues } = parseSections([s]);
      expect({ type: t.type, issues }).toEqual({ type: t.type, issues: [] });
      expect(sections).toHaveLength(1);
    }
  });
});
