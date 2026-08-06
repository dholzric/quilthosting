import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

export const productRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

export type Product = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  inventory: number | null;
  is_active: number;
  sort_order: number;
  sku?: string | null;
  taxable?: number;
  created_at: string;
  updated_at: string;
};

// GET /api/tenants/:tenantId/products
productRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all<Product>(
    c.env.DB.prepare(
      `SELECT * FROM products WHERE tenant_id = ?
       ORDER BY sort_order, name`
    ).bind(tenant.id)
  );
  return c.json(rows);
});

// POST /api/tenants/:tenantId/products
productRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    name: string;
    description?: string;
    price_cents?: number;
    inventory?: number | null;
    is_active?: boolean;
    sort_order?: number;
    sku?: string;
    taxable?: boolean;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const price = Math.max(0, Math.floor(Number(body.price_cents) || 0));
  const inventory =
    body.inventory === null || body.inventory === undefined
      ? null
      : Math.max(0, Math.floor(Number(body.inventory)));
  const id = generateId();
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO products
       (id, tenant_id, name, description, price_cents, inventory, is_active, sort_order, sku, taxable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenant.id,
        name,
        body.description?.trim() || null,
        price,
        inventory,
        body.is_active === false ? 0 : 1,
        body.sort_order ?? 0,
        body.sku?.trim() || null,
        body.taxable === false ? 0 : 1,
        now,
        now
      )
      .run();
  } catch {
    await c.env.DB.prepare(
      `INSERT INTO products
       (id, tenant_id, name, description, price_cents, inventory, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenant.id,
        name,
        body.description?.trim() || null,
        price,
        inventory,
        body.is_active === false ? 0 : 1,
        body.sort_order ?? 0,
        now,
        now
      )
      .run();
  }
  const row = await first<Product>(
    c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id)
  );
  return c.json(row, 201);
});

// PATCH /api/tenants/:tenantId/products/:productId
productRoutes.patch("/:productId", async (c) => {
  const tenant = c.get("tenant");
  const productId = c.req.param("productId");
  const existing = await first<Product>(
    c.env.DB.prepare(
      "SELECT * FROM products WHERE id = ? AND tenant_id = ?"
    ).bind(productId, tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    price_cents?: number;
    inventory?: number | null;
    is_active?: boolean;
    sort_order?: number;
    sku?: string | null;
    taxable?: boolean;
  }>();
  const now = new Date().toISOString();
  const name =
    body.name !== undefined ? body.name.trim() : existing.name;
  if (!name) return c.json({ error: "name cannot be empty" }, 400);
  const price =
    body.price_cents !== undefined
      ? Math.max(0, Math.floor(Number(body.price_cents)))
      : existing.price_cents;
  let inventory = existing.inventory;
  if (body.inventory !== undefined) {
    inventory =
      body.inventory === null
        ? null
        : Math.max(0, Math.floor(Number(body.inventory)));
  }
  try {
    await c.env.DB.prepare(
      `UPDATE products SET
         name = ?, description = ?, price_cents = ?, inventory = ?,
         is_active = ?, sort_order = ?, sku = coalesce(?, sku), taxable = coalesce(?, taxable), updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    )
      .bind(
        name,
        body.description !== undefined
          ? body.description?.trim() || null
          : existing.description,
        price,
        inventory,
        body.is_active !== undefined
          ? body.is_active
            ? 1
            : 0
          : existing.is_active,
        body.sort_order ?? existing.sort_order,
        body.sku !== undefined ? body.sku?.trim() || null : null,
        body.taxable !== undefined ? (body.taxable ? 1 : 0) : null,
        now,
        productId,
        tenant.id
      )
      .run();
  } catch {
    await c.env.DB.prepare(
      `UPDATE products SET
         name = ?, description = ?, price_cents = ?, inventory = ?,
         is_active = ?, sort_order = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    )
      .bind(
        name,
        body.description !== undefined
          ? body.description?.trim() || null
          : existing.description,
        price,
        inventory,
        body.is_active !== undefined
          ? body.is_active
            ? 1
            : 0
          : existing.is_active,
        body.sort_order ?? existing.sort_order,
        now,
        productId,
        tenant.id
      )
      .run();
  }
  const row = await first<Product>(
    c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(productId)
  );
  return c.json(row);
});

// DELETE /api/tenants/:tenantId/products/:productId — soft deactivate
productRoutes.delete("/:productId", async (c) => {
  const tenant = c.get("tenant");
  const productId = c.req.param("productId");
  const res = await c.env.DB.prepare(
    `UPDATE products SET is_active = 0, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(new Date().toISOString(), productId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
