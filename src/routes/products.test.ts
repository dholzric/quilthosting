// src/routes/products.test.ts
//
// Ease-layer phase 3, Task B: the Store price box is dollars, so price_cents
// on the wire must be whole cents. The route used to Math.floor whatever
// arrived, which turned a mis-converted $25.00 into $0.25 silently; it now
// answers 400 with a field error.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";
import { productRoutes } from "./products";

const TENANT_ID = "tenant-1";

function harness() {
  const product = {
    id: "prod-1",
    tenant_id: TENANT_ID,
    name: "Block of the month kit",
    description: null,
    price_cents: 2500,
    inventory: null,
    is_active: 1,
    sort_order: 0,
    sku: null,
    taxable: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const runs: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              return sql.includes("FROM products") ? product : null;
            },
            async all() {
              return { results: [product] };
            },
            async run() {
              runs.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, name: "Guild" } as Tenant);
    await next();
  });
  app.route("/", productRoutes);
  const env = { DB: db } as unknown as Env;
  const post = (body: unknown) =>
    app.request(
      "/",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  const patch = (body: unknown) =>
    app.request(
      "/prod-1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  const inserts = () => runs.filter((r) => r.sql.includes("INSERT INTO products"));
  const updates = () => runs.filter((r) => r.sql.includes("UPDATE products SET"));
  return { post, patch, runs, inserts, updates };
}

describe("POST /products — price validation", () => {
  it("stores whole cents", async () => {
    const h = harness();
    const res = await h.post({ name: "Kit", price_cents: 2500 });
    expect(res.status).toBe(201);
    expect(h.inserts()[0].binds[4]).toBe(2500);
  });

  it("still defaults a missing price to free", async () => {
    const h = harness();
    expect((await h.post({ name: "Freebie" })).status).toBe(201);
    expect(h.inserts()[0].binds[4]).toBe(0);
  });

  it("rejects a float price instead of flooring it", async () => {
    const h = harness();
    const res = await h.post({ name: "Kit", price_cents: 2500.5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string; message: string }[] };
    expect(body.issues).toEqual([
      { path: "price_cents", message: "price_cents must be a whole number of cents" },
    ]);
    expect(h.inserts().length).toBe(0);
  });

  it("rejects a negative price and a numeric string", async () => {
    const h = harness();
    expect((await h.post({ name: "Kit", price_cents: -1 })).status).toBe(400);
    expect((await h.post({ name: "Kit", price_cents: "2500" })).status).toBe(400);
    expect(h.inserts().length).toBe(0);
  });

  it("keeps the existing name error", async () => {
    const h = harness();
    const res = await h.post({ name: "  " });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("name is required");
  });
});

describe("PATCH /products/:id — price validation", () => {
  it("stores whole cents", async () => {
    const h = harness();
    expect((await h.patch({ price_cents: 999 })).status).toBe(200);
    expect(h.updates()[0].binds[2]).toBe(999);
  });

  it("leaves the price alone when it is omitted", async () => {
    const h = harness();
    expect((await h.patch({ is_active: false })).status).toBe(200);
    expect(h.updates()[0].binds[2]).toBe(2500);
  });

  it("rejects a float or negative price", async () => {
    const h = harness();
    expect((await h.patch({ price_cents: 12.34 })).status).toBe(400);
    expect((await h.patch({ price_cents: -3 })).status).toBe(400);
    expect(h.updates().length).toBe(0);
  });
});
