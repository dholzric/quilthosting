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
import { Hono } from "hono";
import { pageRoutes, KNOWN_BLOCK_TYPES, RESERVED_SLUGS } from "./pages";
import { parseBlocks, BUSINESS_BLOCK_TYPES, GUILD_ONLY_BLOCK_TYPES } from "../lib/blocks";
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
    const { app, env, writes } = buildApp({ existingPage });
    const res = await app.request("/page-1", jsonReq("PATCH", { slug: "New Slug" }), env);
    expect(res.status).toBe(200);
    expect(boundColumns(writes[0]).get("slug")).toBe("new-slug");
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.previous_slug).toBe("old-slug");
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
    // Only the provided column and the timestamp are written.
    expect([...cols.keys()]).toEqual(["title", "updated_at"]);
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
