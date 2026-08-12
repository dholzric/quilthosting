// src/routes/pages.test.ts
// Task 13 needs the business site builder's page editor (SEO title/
// description/noindex fields, and an explicit slug -- including "leave it
// blank for the home page") to actually persist. Before this task pages.ts
// accepted none of that on write and didn't return seo_title/
// seo_description/noindex on the list GET, which would have made those
// editor fields silently no-op. This file locks in the fix.
//
// Same idiom as src/routes/credentials.test.ts: dispatch through the
// exported `pageRoutes` app with a thin stand-in for the tenantMiddleware
// context, and a keyword-routed fake D1 that records every write.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { pageRoutes } from "./pages";
import type { Env, Tenant, TenantVariables } from "../types";

const TENANT_ID = "tenant-1";

function fakeDb(opts: { dupeSlug?: string; existingPage?: Record<string, unknown> } = {}) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
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
              return { results: [] };
            },
            async run() {
              if (sql.startsWith("INSERT INTO pages") || sql.startsWith("UPDATE pages")) {
                writes.push({ sql, binds });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { db, writes };
}

function buildApp(dbOpts?: Parameters<typeof fakeDb>[0]) {
  const { db, writes } = fakeDb(dbOpts);
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, settings_json: "{}" } as Tenant);
    await next();
  });
  app.route("/", pageRoutes);
  const env = { DB: db } as unknown as Env;
  return { app, env, writes };
}

describe("POST /api/tenants/:id/pages — slug + SEO fields", () => {
  it("derives the slug from the title when slug is omitted (legacy guild page builder callers)", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "About Us" }),
      },
      env
    );
    expect(res.status).toBe(201);
    expect(writes).toHaveLength(1);
    // bind order: id, tenant.id, slug, title, ...
    expect(writes[0].binds[2]).toBe("about-us");
  });

  it("normalizes an explicit blank slug to 'home' (site.ts only ever looks up literal 'home')", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Home Page", slug: "" }),
      },
      env
    );
    expect(res.status).toBe(201);
    expect(writes[0].binds[2]).toBe("home");
  });

  it("persists seo_title, seo_description, and noindex on create", async () => {
    const { app, env, writes } = buildApp();
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Services",
          seo_title: "Longarm Quilting Services",
          seo_description: "Hand-guided quilting.",
          noindex: true,
        }),
      },
      env
    );
    expect(res.status).toBe(201);
    const binds = writes[0].binds;
    expect(binds).toContain("Longarm Quilting Services");
    expect(binds).toContain("Hand-guided quilting.");
    expect(binds).toContain(1); // noindex -> 1
  });

  it("rejects a duplicate explicit slug with 409", async () => {
    const { app, env, writes } = buildApp({ dupeSlug: "about" });
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "About Redux", slug: "about" }),
      },
      env
    );
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
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seo_description: "New description", noindex: true }),
      },
      env
    );
    expect(res.status).toBe(200);
    const binds = writes[0].binds;
    expect(binds).toContain("New description");
    expect(binds).toContain(1);
  });

  it("rejects renaming to a slug already used by another page with 409, without writing", async () => {
    const { app, env, writes } = buildApp({ existingPage, dupeSlug: "taken" });
    const res = await app.request(
      "/page-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "taken" }),
      },
      env
    );
    expect(res.status).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it("404s for a page that doesn't belong to this tenant", async () => {
    const { app, env, writes } = buildApp({ existingPage: undefined });
    const res = await app.request(
      "/page-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      },
      env
    );
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });
});
