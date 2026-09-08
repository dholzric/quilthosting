// serveSite's routing table (Task 8): every path a guild or business site
// answers, on a tenant host and under the platform's /g/<slug> base path,
// driven through a real Hono app against a hand-rolled fake D1 in the same
// idiom as src/routes/site.test.ts. Also covers the legacy flag, the
// members-only stack, 404s, the noindex head while unlaunched, the single
// loadSiteData batch, and the cache key.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Tenant } from "../../types";

const { serveSite, serveBusinessSite, useLegacyRenderer, resolveSiteRoute, getTenantBySlug } = await import(
  "../../routes/site"
);

// ---------------------------------------------------------------------------
// Fixtures

type PageRow = {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  content_json: string | null;
  blocks_json: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_image_file_id: string | null;
  noindex: number;
  published: number;
  is_members_only: number;
  show_in_nav: number;
  page_type: string;
  nav_label: string | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string | null;
  member_price_cents: number;
  non_member_price_cents: number;
  capacity: number | null;
  registration_open: number;
  is_public: number;
  settings_json: string | null;
};

type State = {
  tenants: Tenant[];
  pages: PageRow[];
  events: EventRow[];
  levels: { id: string; tenant_id: string; name: string; description: string | null; price_cents: number; duration_months: number }[];
  galleries: { id: string; tenant_id: string; slug: string; title: string; description: string | null; published: number; is_members_only: number }[];
  photos: { id: string; tenant_id: string; gallery_id: string; caption: string | null }[];
  redirects: { tenant_id: string; from_slug: string; to_slug: string }[];
  files: { id: string; tenant_id: string; r2_key: string; content_type: string }[];
  batchCalls: number;
  sql: string[];
};

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "tnt_guild",
    name: "River Bend Quilters",
    slug: "riverbend",
    custom_domain: null,
    tenant_type: "guild",
    public_launched: 0,
    stripe_account_id: null,
    plan: "free",
    status: "active",
    settings_json: JSON.stringify({
      profile: { description: "A guild for quilters along the river.", meeting_info: "Second Tuesday, 7 pm", location: "Grange Hall" },
    }),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePage(overrides: Partial<PageRow> = {}): PageRow {
  return {
    id: "page-about",
    tenant_id: "tnt_guild",
    slug: "about",
    title: "About us",
    content_json: null,
    blocks_json: JSON.stringify([{ type: "text", html: "<p>We meet monthly.</p>" }]),
    seo_title: null,
    seo_description: null,
    og_image_file_id: null,
    noindex: 0,
    published: 1,
    is_members_only: 0,
    show_in_nav: 1,
    page_type: "page",
    nav_label: null,
    sort_order: 0,
    deleted_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev_workshop",
    tenant_id: "tnt_guild",
    title: "Free-motion workshop",
    description: "Bring your machine.",
    location: "Grange Hall",
    start_at: "2099-10-03T17:00:00.000Z",
    end_at: "2099-10-03T20:00:00.000Z",
    member_price_cents: 0,
    non_member_price_cents: 1500,
    capacity: 20,
    registration_open: 1,
    is_public: 1,
    settings_json: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    tenants: [makeTenant()],
    pages: [
      makePage(),
      makePage({
        id: "page-post",
        slug: "spring-show-recap",
        title: "Spring show recap",
        page_type: "blog_post",
        show_in_nav: 0,
        blocks_json: JSON.stringify([{ type: "text", html: "<p>Over 200 quilts were hung this year.</p>" }]),
      }),
      makePage({ id: "page-secret", slug: "minutes", title: "Meeting minutes", is_members_only: 1, show_in_nav: 0 }),
    ],
    events: [makeEvent()],
    levels: [{ id: "lvl_1", tenant_id: "tnt_guild", name: "Individual", description: null, price_cents: 3500, duration_months: 12 }],
    galleries: [{ id: "gal_1", tenant_id: "tnt_guild", slug: "spring-show", title: "Spring show", description: null, published: 1, is_members_only: 0 }],
    photos: [{ id: "ph_1", tenant_id: "tnt_guild", gallery_id: "gal_1", caption: "Best in show" }],
    redirects: [],
    files: [],
    batchCalls: 0,
    sql: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake D1

function makeDb(state: State): D1Database {
  function exec(sql: string, binds: unknown[]): { results: unknown[] } {
    state.sql.push(sql);
    if (sql.includes("FROM tenants WHERE slug")) {
      return { results: state.tenants.filter((t) => t.slug === binds[0] && t.status === "active") };
    }
    if (sql.includes("FROM pages")) {
      const tenantId = binds[0] as string;
      let rows = state.pages.filter((p) => p.tenant_id === tenantId);
      if (sql.includes("deleted_at IS NULL")) rows = rows.filter((p) => p.deleted_at === null);
      if (sql.includes("published = 1")) rows = rows.filter((p) => p.published === 1);
      if (sql.includes("is_members_only = 0")) rows = rows.filter((p) => p.is_members_only === 0);
      if (sql.includes("coalesce(noindex, 0) = 0")) rows = rows.filter((p) => p.noindex === 0);
      if (sql.includes("coalesce(show_in_nav, 1) = 1")) rows = rows.filter((p) => p.show_in_nav === 1);
      if (sql.includes("= 'page'")) rows = rows.filter((p) => p.page_type === "page");
      if (sql.includes("= 'blog_post'")) rows = rows.filter((p) => p.page_type === "blog_post");
      if (sql.includes("max(updated_at)")) {
        return { results: [{ v: rows.map((p) => p.updated_at).sort().pop() ?? null }] };
      }
      if (sql.includes("slug = ?")) return { results: rows.filter((p) => p.slug === binds[1]).slice(0, 1) };
      return { results: rows };
    }
    if (sql.includes("FROM membership_levels")) {
      return { results: state.levels.filter((l) => l.tenant_id === binds[0]) };
    }
    if (sql.includes("FROM events")) {
      if (sql.includes("WHERE id = ?")) {
        return { results: state.events.filter((e) => e.id === binds[0] && e.tenant_id === binds[1] && e.is_public === 1) };
      }
      return { results: state.events.filter((e) => e.tenant_id === binds[0] && e.is_public === 1 && e.start_at >= new Date().toISOString()) };
    }
    // The photos-by-slug statement JOINs galleries; the galleries list only
    // references gallery_photos inside its subselects, so test the JOIN first.
    if (sql.includes("JOIN galleries g")) {
      const gallery = state.galleries.find((g) => g.slug === binds[1]);
      return { results: gallery ? state.photos.filter((p) => p.gallery_id === gallery.id) : [] };
    }
    if (sql.includes("FROM galleries")) {
      let rows = state.galleries.filter((g) => g.tenant_id === binds[0] && g.published === 1 && g.is_members_only === 0);
      if (sql.includes("slug = ?")) rows = rows.filter((g) => g.slug === binds[1]);
      return {
        results: rows.map((g) => ({
          ...g,
          photo_count: state.photos.filter((p) => p.gallery_id === g.id).length,
          cover_photo_id: state.photos.find((p) => p.gallery_id === g.id)?.id ?? null,
        })),
      };
    }
    if (sql.includes("FROM page_redirects")) {
      const r = state.redirects.find((x) => x.tenant_id === binds[0] && x.from_slug === binds[1]);
      return { results: r ? [{ to_slug: r.to_slug }] : [] };
    }
    if (sql.includes("FROM files")) {
      return { results: state.files.filter((f) => f.id === binds[0] && f.tenant_id === binds[1]) };
    }
    return { results: [] };
  }

  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            __sql: sql,
            __binds: binds,
            async first<T>(): Promise<T | null> {
              return (exec(sql, binds).results[0] as T) ?? null;
            },
            async all<T>(): Promise<D1Result<T>> {
              return { results: exec(sql, binds).results as T[] } as D1Result<T>;
            },
            async run() {
              exec(sql, binds);
              return { success: true } as D1Result;
            },
          };
        },
      };
    },
    async batch<T>(stmts: Array<{ __sql: string; __binds: unknown[] }>): Promise<D1Result<T>[]> {
      state.batchCalls++;
      return stmts.map((s) => ({ success: true, meta: {}, results: exec(s.__sql, s.__binds).results as T[] }) as D1Result<T>);
    },
  } as unknown as D1Database;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    FILES: { get: vi.fn(async () => null) } as unknown as R2Bucket,
    KV: {} as KVNamespace,
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    RESEND_API_KEY: "",
    JWT_SECRET: "test-jwt-secret",
    ENVIRONMENT: "test",
    APP_URL: "https://quilthosting.com",
  };
}

/** Tenant-host harness: serveSite(c, tenant) with no base path. */
function tenantHostApp(tenant: Tenant, state: State) {
  const env = makeEnv(makeDb(state));
  const app = new Hono<{ Bindings: Env }>();
  app.all("*", async (c) => (await serveSite(c, tenant)) ?? c.notFound());
  return { app, env };
}

/** Platform-host harness: /g/:slug and /g/:slug/* resolved by slug, base path "/g/<slug>". */
function platformApp(state: State) {
  const env = makeEnv(makeDb(state));
  const app = new Hono<{ Bindings: Env }>();
  const handler = async (c: Context<{ Bindings: Env }>) => {
    const slug = c.req.param("slug") || "";
    const tenant = await getTenantBySlug(c.env.DB, slug);
    if (!tenant) return c.text("no tenant", 404);
    return (await serveSite(c, tenant, { basePath: `/g/${slug}` })) ?? c.notFound();
  };
  app.get("/g/:slug", handler);
  app.get("/g/:slug/*", handler);
  return { app, env };
}

async function get(app: Hono<{ Bindings: Env }>, env: Env, url: string) {
  const res = await app.request(url, { redirect: "manual" }, env);
  return { res, html: await res.text() };
}

const HOST = "http://riverbend.quilthosting.com";

// cachedRender uses the Workers Cache API; a pass-through stub keeps every
// request rendering and records the keys it was asked for.
const cacheKeys: string[] = [];
const cacheStub = {
  default: {
    async match(req: Request) {
      cacheKeys.push(req.url);
      return undefined;
    },
    async put() {},
  },
};
const originalCaches = (globalThis as { caches?: unknown }).caches;
beforeAll(() => {
  (globalThis as { caches?: unknown }).caches = cacheStub;
});
afterAll(() => {
  (globalThis as { caches?: unknown }).caches = originalCaches;
});
beforeEach(() => {
  cacheKeys.length = 0;
});

// ---------------------------------------------------------------------------
// resolveSiteRoute — the pure routing table

describe("resolveSiteRoute", () => {
  it.each([
    ["/", { kind: "home" }],
    ["/membership", { kind: "membership" }],
    ["/join", { kind: "membership" }],
    ["/join-renew", { kind: "membership" }],
    ["/events", { kind: "events" }],
    ["/events/ev_1", { kind: "event", param: "ev_1" }],
    ["/calendar", { kind: "calendar" }],
    ["/galleries", { kind: "galleries" }],
    ["/photos", { kind: "galleries" }],
    ["/galleries/spring-show", { kind: "gallery", param: "spring-show" }],
    ["/blog", { kind: "blog" }],
    ["/blog/hello-world", { kind: "post", param: "hello-world" }],
    ["/about", { kind: "page", slug: "about" }],
    ["/about/", { kind: "page", slug: "about" }],
    ["/about/team", { kind: "not_found", slug: "about/team" }],
    ["/events/ev_1/extra", { kind: "not_found", slug: "events/ev_1/extra" }],
  ])("%s", (path, expected) => {
    expect(resolveSiteRoute(path)).toEqual(expected);
  });

  it("the renderer's own assets are not site routes (null lets the caller fall through to assets)", () => {
    expect(resolveSiteRoute("/qh-site.css")).toBeNull();
    expect(resolveSiteRoute("/qh-site.js")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useLegacyRenderer

describe("useLegacyRenderer", () => {
  it("is true only for settings.site.renderer === 'legacy'", () => {
    expect(useLegacyRenderer(makeTenant({ settings_json: JSON.stringify({ site: { renderer: "legacy" } }) }))).toBe(true);
    expect(useLegacyRenderer(makeTenant({ settings_json: JSON.stringify({ site: { renderer: "sections", kit: "classic" } }) }))).toBe(false);
    expect(useLegacyRenderer(makeTenant({ settings_json: "{}" }))).toBe(false);
    expect(useLegacyRenderer(makeTenant({ settings_json: "not json" }))).toBe(false);
    expect(useLegacyRenderer(makeTenant({ settings_json: JSON.stringify({ site: "legacy" }) }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tenant host

describe("serveSite on a tenant host", () => {
  it("/ with no home page renders the composed default home (hero, levels, events, blog, join band)", async () => {
    const state = makeState();
    const { app, env } = tenantHostApp(makeTenant(), state);
    const { res, html } = await get(app, env, `${HOST}/`);
    expect(res.status).toBe(200);
    expect(html).toContain("River Bend Quilters");
    expect(html).toContain("A guild for quilters along the river.");
    expect(html).toContain("Individual"); // membership level card
    expect(html).toContain("Free-motion workshop"); // event card
    expect(html).toContain("Spring show recap"); // blog teaser
    expect(html).toContain("qh-join-band");
    // Header CTA and hero CTA point at the membership page on this host.
    expect(html).toContain('href="https://riverbend.quilthosting.com/membership"');
  });

  it("/ with a stored home page renders that page's sections instead", async () => {
    const state = makeState();
    state.pages.push(makePage({ id: "page-home", slug: "home", title: "Home", blocks_json: JSON.stringify([{ type: "heading", text: "Welcome home", level: 2 }]) }));
    const { app, env } = tenantHostApp(makeTenant(), state);
    const { html } = await get(app, env, `${HOST}/`);
    expect(html).toContain("Welcome home");
    expect(html).not.toContain("qh-join-band");
  });

  it("/membership, /join and /join-renew render the membership stack", async () => {
    const state = makeState();
    const { app, env } = tenantHostApp(makeTenant(), state);
    for (const p of ["/membership", "/join", "/join-renew"]) {
      const { res, html } = await get(app, env, `${HOST}${p}`);
      expect(res.status).toBe(200);
      expect(html).toContain("<title>Membership");
      expect(html).toContain("Individual");
      expect(html).toContain("Ready to join River Bend Quilters?");
    }
  });

  it("/events lists upcoming events; /calendar renders the calendar section", async () => {
    const state = makeState();
    const { app, env } = tenantHostApp(makeTenant(), state);
    const events = await get(app, env, `${HOST}/events`);
    expect(events.res.status).toBe(200);
    expect(events.html).toContain("<title>Events");
    expect(events.html).toContain("Free-motion workshop");
    expect(events.html).toContain('href="https://riverbend.quilthosting.com/calendar"');
    const cal = await get(app, env, `${HOST}/calendar`);
    expect(cal.html).toContain("qh-events--calendar");
    expect(cal.html).toContain('data-month="2099-10"');
  });

  it("/events/:id renders the event detail with the register CTA; a past (non-upcoming) event is still found by id", async () => {
    const state = makeState();
    state.events.push(makeEvent({ id: "ev_past", title: "Last year's retreat", start_at: "2020-01-01T00:00:00.000Z", end_at: null, registration_open: 0 }));
    const { app, env } = tenantHostApp(makeTenant(), state);
    const { res, html } = await get(app, env, `${HOST}/events/ev_workshop`);
    expect(res.status).toBe(200);
    expect(html).toContain("<title>Free-motion workshop");
    expect(html).toContain("Bring your machine.");
    expect(html).toContain('id="register-ev_workshop"');
    const past = await get(app, env, `${HOST}/events/ev_past`);
    expect(past.res.status).toBe(200);
    expect(past.html).toContain("Last year&#39;s retreat");
    expect(past.html).not.toContain('id="register-ev_past"');
  });

  it("/events/:id for an unknown or non-public event is the 404 stack", async () => {
    const state = makeState();
    state.events.push(makeEvent({ id: "ev_private", is_public: 0 }));
    const { app, env } = tenantHostApp(makeTenant(), state);
    expect((await get(app, env, `${HOST}/events/nope`)).res.status).toBe(404);
    const priv = await get(app, env, `${HOST}/events/ev_private`);
    expect(priv.res.status).toBe(404);
    expect(priv.html).toContain("Page not found");
  });

  it("/galleries and /photos list galleries; /galleries/:slug renders the photos", async () => {
    const state = makeState();
    const { app, env } = tenantHostApp(makeTenant(), state);
    for (const p of ["/galleries", "/photos"]) {
      const { res, html } = await get(app, env, `${HOST}${p}`);
      expect(res.status).toBe(200);
      expect(html).toContain("<title>Galleries");
      expect(html).toContain('href="https://riverbend.quilthosting.com/galleries/spring-show"');
    }
    const one = await get(app, env, `${HOST}/galleries/spring-show`);
    expect(one.res.status).toBe(200);
    expect(one.html).toContain("<title>Spring show");
    expect(one.html).toContain("https://riverbend.quilthosting.com/img/ph_1");
    expect((await get(app, env, `${HOST}/galleries/missing`)).res.status).toBe(404);
  });

  it("/blog lists posts; /blog/:slug renders the system stack plus the post's own sections", async () => {
    const state = makeState();
    const { app, env } = tenantHostApp(makeTenant(), state);
    const index = await get(app, env, `${HOST}/blog`);
    expect(index.res.status).toBe(200);
    expect(index.html).toContain("<title>Blog");
    expect(index.html).toContain('href="https://riverbend.quilthosting.com/blog/spring-show-recap"');
    const post = await get(app, env, `${HOST}/blog/spring-show-recap`);
    expect(post.res.status).toBe(200);
    expect(post.html).toContain("<title>Spring show recap");
    expect(post.html).toContain("Over 200 quilts were hung this year.");
    // A regular page is not a post.
    expect((await get(app, env, `${HOST}/blog/about`)).res.status).toBe(404);
  });

  it("/:slug renders a published page; a members-only page renders the sign-in stack, noindex, uncached", async () => {
    const state = makeState();
    const { app, env } = tenantHostApp(makeTenant(), state);
    const about = await get(app, env, `${HOST}/about`);
    expect(about.res.status).toBe(200);
    expect(about.html).toContain("We meet monthly.");
    expect(about.html).toContain("<title>About us");

    cacheKeys.length = 0;
    const minutes = await get(app, env, `${HOST}/minutes`);
    expect(minutes.res.status).toBe(200);
    expect(minutes.html).toContain("Members only");
    expect(minutes.html).toContain("Member sign-in");
    expect(minutes.html).toContain('href="https://riverbend.quilthosting.com/portal?slug=riverbend"');
    expect(minutes.html).not.toContain("Meeting minutes");
    expect(minutes.html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(minutes.res.headers.get("cache-control")).toBe("no-store");
    expect(cacheKeys).toHaveLength(0);
  });

  it("an unknown slug 404s with the not_found stack, uncached; a renamed slug 301s via page_redirects", async () => {
    const state = makeState();
    state.redirects = [{ tenant_id: "tnt_guild", from_slug: "about-us", to_slug: "about" }];
    const { app, env } = tenantHostApp(makeTenant(), state);
    cacheKeys.length = 0;
    const missing = await get(app, env, `${HOST}/nope`);
    expect(missing.res.status).toBe(404);
    expect(missing.html).toContain("Page not found");
    expect(missing.html).toContain('href="https://riverbend.quilthosting.com/"');
    expect(cacheKeys).toHaveLength(0);
    const moved = await get(app, env, `${HOST}/about-us?x=1`);
    expect(moved.res.status).toBe(301);
    expect(moved.res.headers.get("location")).toBe("https://riverbend.quilthosting.com/about?x=1");
  });

  it("the menu lists published, non-deleted, show_in_nav pages only, with hrefs on the host", async () => {
    const state = makeState();
    state.pages.push(makePage({ id: "page-hidden", slug: "hidden", title: "Hidden", show_in_nav: 0 }));
    state.pages.push(makePage({ id: "page-gone", slug: "gone", title: "Gone", deleted_at: "2026-09-01T00:00:00.000Z" }));
    const { app, env } = tenantHostApp(makeTenant(), state);
    const { html } = await get(app, env, `${HOST}/`);
    expect(html).toContain('href="https://riverbend.quilthosting.com/about"');
    expect(html).not.toContain('href="https://riverbend.quilthosting.com/hidden"');
    expect(html).not.toContain('href="https://riverbend.quilthosting.com/gone"');
    expect(html).not.toContain('href="https://riverbend.quilthosting.com/minutes"');
  });

  it("an unlaunched tenant gets <meta name=robots noindex> in the head; a launched business does not", async () => {
    const state = makeState();
    const guild = await get(...Object.values(tenantHostApp(makeTenant(), state)) as [Hono<{ Bindings: Env }>, Env], `${HOST}/about`);
    expect(guild.html).toContain('<meta name="robots" content="noindex">');

    const biz = makeTenant({ id: "tnt_guild", tenant_type: "business", public_launched: 1 });
    const launched = await get(...Object.values(tenantHostApp(biz, state)) as [Hono<{ Bindings: Env }>, Env], `${HOST}/about`);
    expect(launched.html).not.toContain('<meta name="robots" content="noindex">');
  });

  it("loads every dynamic section's data with ONE batch", async () => {
    const state = makeState();
    const { app, env } = tenantHostApp(makeTenant(), state);
    await get(app, env, `${HOST}/`); // default home: levels + events + posts
    expect(state.batchCalls).toBe(1);
    state.batchCalls = 0;
    await get(app, env, `${HOST}/galleries/spring-show`);
    expect(state.batchCalls).toBe(1);
  });

  it("the cache key folds in tenant.updated_at so a theme change re-renders", async () => {
    const state = makeState();
    const t1 = makeTenant({ updated_at: "2026-09-01T00:00:00.000Z" });
    const a = tenantHostApp(t1, state);
    await get(a.app, a.env, `${HOST}/about`);
    const before = cacheKeys[0];
    expect(before).toBeTruthy();
    cacheKeys.length = 0;
    const t2 = makeTenant({ updated_at: "2026-09-08T00:00:00.000Z" });
    const b = tenantHostApp(t2, state);
    await get(b.app, b.env, `${HOST}/about`);
    expect(cacheKeys[0]).not.toBe(before);
  });

  it("serveBusinessSite is an alias of serveSite", async () => {
    const state = makeState();
    const env = makeEnv(makeDb(state));
    const app = new Hono<{ Bindings: Env }>();
    app.all("*", async (c) => (await serveBusinessSite(c, makeTenant())) ?? c.notFound());
    const { res, html } = await get(app, env, `${HOST}/membership`);
    expect(res.status).toBe(200);
    expect(html).toContain("<title>Membership");
  });

  it("/img/:id serves an allowlisted image scoped to the tenant; /qh-site.css falls through (null)", async () => {
    const state = makeState();
    state.files = [{ id: "f1", tenant_id: "tnt_guild", r2_key: "k1", content_type: "image/png" }];
    const env = makeEnv(makeDb(state));
    (env.FILES as unknown as { get: unknown }).get = vi.fn(async () => ({ body: "png-bytes" }));
    const app = new Hono<{ Bindings: Env }>();
    app.all("*", async (c) => (await serveSite(c, makeTenant())) ?? c.text("fell through", 404));
    const img = await app.request(`${HOST}/img/f1`, {}, env);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const css = await app.request(`${HOST}/qh-site.css`, {}, env);
    expect(await css.text()).toBe("fell through");
  });
});

// ---------------------------------------------------------------------------
// Platform host: /g/<slug>

describe("serveSite under /g/:slug on the platform host", () => {
  it("prefixes every internal link with the base path and serves images from /public/<slug>/img", async () => {
    const state = makeState();
    const { app, env } = platformApp(state);
    const home = await get(app, env, "http://quilthosting.com/g/riverbend");
    expect(home.res.status).toBe(200);
    expect(home.html).toContain('href="/g/riverbend/membership"');
    expect(home.html).toContain('href="/g/riverbend/about"');
    expect(home.html).toContain('href="/g/riverbend/"');
    expect(home.html).toContain('data-qh-base=""');
    const gallery = await get(app, env, "http://quilthosting.com/g/riverbend/galleries/spring-show");
    expect(gallery.html).toContain("/public/riverbend/img/ph_1");
    expect(gallery.html).toContain('href="/g/riverbend/galleries"');
  });

  it("routes the same table under the base path", async () => {
    const state = makeState();
    const { app, env } = platformApp(state);
    expect((await get(app, env, "http://quilthosting.com/g/riverbend/events")).html).toContain("<title>Events");
    expect((await get(app, env, "http://quilthosting.com/g/riverbend/events/ev_workshop")).html).toContain("<title>Free-motion workshop");
    expect((await get(app, env, "http://quilthosting.com/g/riverbend/about")).html).toContain("We meet monthly.");
    expect((await get(app, env, "http://quilthosting.com/g/riverbend/nope")).res.status).toBe(404);
    expect((await get(app, env, "http://quilthosting.com/g/nobody")).res.status).toBe(404);
  });

  it("a renamed slug redirects within the base path", async () => {
    const state = makeState();
    state.redirects = [{ tenant_id: "tnt_guild", from_slug: "about-us", to_slug: "about" }];
    const { app, env } = platformApp(state);
    const { res } = await get(app, env, "http://quilthosting.com/g/riverbend/about-us");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/g/riverbend/about");
  });

  it("the member sign-in link stays at the origin, never under the base path", async () => {
    const state = makeState();
    const { app, env } = platformApp(state);
    const { html } = await get(app, env, "http://quilthosting.com/g/riverbend/minutes");
    expect(html).toContain('href="/portal?slug=riverbend"');
    expect(html).not.toContain("/g/riverbend/portal");
  });
});
