// src/lib/site/data.test.ts
// Task 6 of docs/superpowers/plans/2026-09-08-site-foundation-phase1.md.
// `needsFor` derives the set of dynamic-data needs from a section stack;
// `loadSiteData` satisfies them with ONE env.DB.batch (D1 serialises
// per-request queries, so one round trip is the perf rule from 115cd50).
// Fake D1 records every statement handed to batch and answers by SQL
// keyword, same idiom as src/routes/pages.test.ts.
import { describe, it, expect } from "vitest";
import { needsFor, loadSiteData, type DataNeed, type SiteData } from "./data";
import { DEFAULT_STYLE, type Section } from "./sections/schema";
import type { Env, Tenant } from "../../types";

const TENANT_ID = "tenant-1";

function tenant(settings: Record<string, unknown> = {}): Tenant {
  return {
    id: TENANT_ID,
    name: "Stitch Guild",
    slug: "stitchguild",
    custom_domain: null,
    tenant_type: "guild",
    public_launched: 0,
    stripe_account_id: null,
    plan: "free",
    status: "active",
    settings_json: JSON.stringify(settings),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

type Prepared = { sql: string; binds: unknown[] };

/**
 * Keyword-routed fake D1. `rows` maps a SQL substring to the result rows
 * that statement should produce; `batch` records what it was handed and
 * fails loudly if any code path tries `.all()`/`.first()` outside a batch.
 */
function fakeDb(rows: Record<string, unknown[] | unknown> = {}) {
  const batches: Prepared[][] = [];
  let directCalls = 0;
  function resultsFor(sql: string): unknown[] {
    const flat = sql.replace(/\s+/g, " ");
    for (const [needle, value] of Object.entries(rows)) {
      if (flat.includes(needle)) return Array.isArray(value) ? value : [value];
    }
    return [];
  }
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          const stmt = {
            sql,
            binds,
            async all() {
              directCalls++;
              return { results: resultsFor(sql) };
            },
            async first() {
              directCalls++;
              return resultsFor(sql)[0] ?? null;
            },
            async run() {
              directCalls++;
              return { success: true };
            },
          };
          return stmt;
        },
      };
    },
    async batch(stmts: Prepared[]) {
      batches.push(stmts.map((s) => ({ sql: s.sql, binds: s.binds })));
      return stmts.map((s) => ({ results: resultsFor(s.sql), success: true }));
    },
  };
  const env = { DB: db } as unknown as Env;
  return { env, batches, directCalls: () => directCalls };
}

const sec = (partial: Record<string, unknown>): Section =>
  ({ id: "s", style: { ...DEFAULT_STYLE }, ...partial }) as unknown as Section;

describe("needsFor", () => {
  it("returns an empty set for a stack with no dynamic sections", () => {
    const needs = needsFor([
      sec({ type: "hero", variant: "minimal", title: "Hi" }),
      sec({ type: "rich_text", variant: "prose", html: "<p>x</p>" }),
      sec({ type: "divider" }),
    ]);
    expect(needs.size).toBe(0);
  });

  it("maps each dynamic section type to its need", () => {
    const needs = needsFor([
      sec({ type: "events", variant: "cards", limit: 3 }),
      sec({ type: "membership_levels", variant: "cards" }),
      sec({ type: "store_teaser", limit: 4 }),
      sec({ type: "blog_teaser", limit: 3 }),
      sec({ type: "meeting_info", when: "2nd Tuesday", where: "Library" }),
    ]);
    expect([...needs].sort()).toEqual<DataNeed[]>(["events", "levels", "posts", "products", "profile"]);
  });

  it("gallery with source 'gallery' needs the single gallery when a slug is set, else the galleries list", () => {
    expect([...needsFor([sec({ type: "gallery", variant: "grid", source: "gallery", gallerySlug: "show-2026", items: [] })])]).toEqual([
      "gallery",
    ]);
    expect([...needsFor([sec({ type: "gallery", variant: "grid", source: "gallery", items: [] })])]).toEqual(["galleries"]);
  });

  it("manual galleries need nothing", () => {
    expect(needsFor([sec({ type: "gallery", variant: "grid", source: "manual", items: [] })]).size).toBe(0);
  });

  it("dedupes repeated section types", () => {
    const needs = needsFor([
      sec({ type: "events", variant: "cards", limit: 3 }),
      sec({ type: "events", variant: "list", limit: 10 }),
    ]);
    expect([...needs]).toEqual(["events"]);
  });
});

describe("loadSiteData", () => {
  it("makes no DB call when there are no needs", async () => {
    const { env, batches, directCalls } = fakeDb();
    const data = await loadSiteData(env, tenant(), new Set());
    expect(data).toEqual({});
    expect(batches).toEqual([]);
    expect(directCalls()).toBe(0);
  });

  it("profile comes from settings_json.profile with no query", async () => {
    const { env, batches } = fakeDb();
    const data = await loadSiteData(
      env,
      tenant({
        profile: {
          description: "A guild",
          meeting_info: "2nd Tuesday, 7pm",
          location: "Springfield, IL",
          website: "https://example.org",
          contact_email: "hello@example.org",
          donations_enabled: false,
          directory_public: true,
          logo_file_id: "f-logo",
        },
      }),
      new Set<DataNeed>(["profile"])
    );
    expect(batches).toEqual([]);
    expect(data.profile).toEqual({
      description: "A guild",
      meeting_info: "2nd Tuesday, 7pm",
      location: "Springfield, IL",
      website: "https://example.org",
      email: "hello@example.org",
      donations_enabled: false,
      directory_public: true,
    });
  });

  it("profile tolerates junk settings_json and missing fields", async () => {
    const { env } = fakeDb();
    const t = tenant();
    t.settings_json = "not json";
    const data = await loadSiteData(env, t, new Set<DataNeed>(["profile"]));
    expect(data.profile).toEqual({ donations_enabled: true, directory_public: false });
  });

  it("issues exactly one batch with one statement per need, tenant-scoped", async () => {
    const { env, batches } = fakeDb();
    await loadSiteData(env, tenant(), new Set<DataNeed>(["levels", "events", "products", "posts", "galleries", "profile"]));
    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch).toHaveLength(5);
    expect(batch.map((s) => s.sql.replace(/\s+/g, " "))).toEqual([
      expect.stringContaining("FROM membership_levels"),
      expect.stringContaining("FROM events"),
      expect.stringContaining("FROM products"),
      expect.stringContaining("FROM pages"),
      expect.stringContaining("FROM galleries g"),
    ]);
    for (const s of batch) expect(s.binds[0]).toBe(TENANT_ID);
  });

  it("events are upcoming, public, ordered by start_at, with the limit from opts (default 12)", async () => {
    const { env, batches } = fakeDb();
    await loadSiteData(env, tenant(), new Set<DataNeed>(["events"]));
    const sql = batches[0][0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("is_public = 1");
    expect(sql).toContain("start_at >= datetime('now')");
    expect(sql).toContain("ORDER BY start_at ASC");
    expect(batches[0][0].binds).toEqual([TENANT_ID, 12]);

    const second = fakeDb();
    await loadSiteData(second.env, tenant(), new Set<DataNeed>(["events"]), { limit: 3 });
    expect(second.batches[0][0].binds).toEqual([TENANT_ID, 3]);
  });

  it("maps levels to the SiteLevel shape (renewal_type falls back to the schema default)", async () => {
    const { env } = fakeDb({
      "FROM membership_levels": [
        {
          id: "lvl-1",
          name: "Individual",
          description: "One person",
          price_cents: 4000,
          duration_months: 12,
          benefits_json: "[]",
          sort_order: 0,
        },
      ],
    });
    const data = await loadSiteData(env, tenant(), new Set<DataNeed>(["levels"]));
    expect(data.levels).toEqual<SiteData["levels"]>([
      { id: "lvl-1", name: "Individual", description: "One person", price_cents: 4000, duration_months: 12, renewal_type: "manual" },
    ]);
  });

  it("maps events to the SiteEvent shape and drops settings_json", async () => {
    const { env } = fakeDb({
      "FROM events": [
        {
          id: "ev-1",
          title: "Guild meeting",
          description: null,
          location: "Library",
          start_at: "2026-09-12T14:00:00.000Z",
          end_at: null,
          member_price_cents: 0,
          non_member_price_cents: 500,
          capacity: 40,
          registration_open: 1,
          settings_json: '{"questions":[]}',
        },
      ],
    });
    const data = await loadSiteData(env, tenant(), new Set<DataNeed>(["events"]));
    expect(data.events).toEqual<SiteData["events"]>([
      {
        id: "ev-1",
        title: "Guild meeting",
        start_at: "2026-09-12T14:00:00.000Z",
        end_at: null,
        location: "Library",
        description: null,
        member_price_cents: 0,
        non_member_price_cents: 500,
        registration_open: 1,
        capacity: 40,
      },
    ]);
    expect((data.events![0] as Record<string, unknown>).settings_json).toBeUndefined();
  });

  it("maps products: inventory -> stock, image_file_id is null (no such column yet)", async () => {
    const { env } = fakeDb({
      "FROM products": [{ id: "p-1", name: "Guild pin", description: "Enamel", price_cents: 800, inventory: 5 }],
    });
    const data = await loadSiteData(env, tenant(), new Set<DataNeed>(["products"]));
    expect(data.products).toEqual<SiteData["products"]>([
      { id: "p-1", name: "Guild pin", price_cents: 800, description: "Enamel", image_file_id: null, stock: 5 },
    ]);
  });

  it("maps blog posts: published_at = created_at, excerpt is plain text from the blocks", async () => {
    const { env } = fakeDb({
      "FROM pages": [
        {
          slug: "retreat-recap",
          title: "Retreat recap",
          content_json: "{}",
          blocks_json: JSON.stringify([
            { type: "heading", text: "Retreat recap", level: 2 },
            { type: "text", html: "<p>Twenty members <b>spent</b> the weekend  quilting.</p><p>Second paragraph.</p>" },
          ]),
          updated_at: "2026-09-02T00:00:00.000Z",
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
    const data = await loadSiteData(env, tenant(), new Set<DataNeed>(["posts"]));
    expect(data.posts).toHaveLength(1);
    const post = data.posts![0];
    expect(post.slug).toBe("retreat-recap");
    expect(post.title).toBe("Retreat recap");
    expect(post.published_at).toBe("2026-09-01T00:00:00.000Z");
    expect(post.excerpt).not.toMatch(/<[^>]+>/);
    expect(post.excerpt).toContain("Twenty members spent the weekend quilting.");
  });

  it("truncates long excerpts", async () => {
    const long = "word ".repeat(200).trim();
    const { env } = fakeDb({
      "FROM pages": [
        { slug: "p", title: "P", content_json: "{}", blocks_json: JSON.stringify([{ type: "text", html: `<p>${long}</p>` }]), updated_at: "x", created_at: "y" },
      ],
    });
    const data = await loadSiteData(env, tenant(), new Set<DataNeed>(["posts"]));
    expect(data.posts![0].excerpt.length).toBeLessThanOrEqual(240);
    expect(data.posts![0].excerpt.endsWith("…")).toBe(true);
  });

  it("maps galleries: photo_count -> count", async () => {
    const { env } = fakeDb({
      "FROM galleries g": [
        { id: "g-1", slug: "show-2026", title: "Quilt Show 2026", description: null, photo_count: 12, cover_photo_id: "ph-1" },
      ],
    });
    const data = await loadSiteData(env, tenant(), new Set<DataNeed>(["galleries"]));
    expect(data.galleries).toEqual<SiteData["galleries"]>([{ slug: "show-2026", title: "Quilt Show 2026", cover_photo_id: "ph-1", count: 12 }]);
  });

  it("gallery need issues two statements (row + photos) keyed by opts.gallerySlug, in the same batch", async () => {
    const { env, batches } = fakeDb({
      "FROM galleries WHERE": { id: "g-1", slug: "show-2026", title: "Quilt Show 2026", description: "Our annual show" },
      "FROM gallery_photos": [
        { id: "ph-1", caption: "Best in show", credit: "J. Doe" },
        { id: "ph-2", caption: null, credit: null },
      ],
    });
    const data = await loadSiteData(env, tenant(), new Set<DataNeed>(["gallery"]), { gallerySlug: "show-2026" });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][0].sql).toContain("FROM galleries");
    expect(batches[0][0].binds).toEqual([TENANT_ID, "show-2026"]);
    expect(batches[0][1].sql).toContain("FROM gallery_photos");
    expect(batches[0][1].binds).toEqual([TENANT_ID, "show-2026"]);
    expect(data.gallery).toEqual<SiteData["gallery"]>({
      slug: "show-2026",
      title: "Quilt Show 2026",
      description: "Our annual show",
      photos: [
        { id: "ph-1", caption: "Best in show" },
        { id: "ph-2", caption: null },
      ],
    });
  });

  it("gallery need without a slug, or with an unknown slug, leaves data.gallery undefined", async () => {
    const noSlug = fakeDb();
    const a = await loadSiteData(noSlug.env, tenant(), new Set<DataNeed>(["gallery"]));
    expect(a.gallery).toBeUndefined();
    expect(noSlug.batches).toEqual([]);

    const missing = fakeDb();
    const b = await loadSiteData(missing.env, tenant(), new Set<DataNeed>(["gallery"]), { gallerySlug: "nope" });
    expect(b.gallery).toBeUndefined();
    expect(missing.batches).toHaveLength(1);
  });

  it("only requested keys are present on the result", async () => {
    const { env } = fakeDb();
    const data = await loadSiteData(env, tenant(), new Set<DataNeed>(["levels"]));
    expect(Object.keys(data)).toEqual(["levels"]);
    expect(data.levels).toEqual([]);
  });
});
