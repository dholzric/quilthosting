// src/routes/invoices.test.ts
//
// Ease-layer phase 3, Task B: the admin now types dollars, so the wire format
// is the only place a bad number can arrive. These tests pin that the route
// rejects floats and negatives with a field error instead of silently
// flooring them (a $35.00 line arriving as 3500.4 used to become $35.00, and
// 0.35 used to become $0.00), and that valid payloads still behave exactly as
// before.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";
import { invoiceRoutes } from "./invoices";

const TENANT_ID = "tenant-1";

type Recorded = { sql: string; binds: unknown[] };

function harness() {
  const invoice = {
    id: "inv-1",
    tenant_id: TENANT_ID,
    member_id: null,
    invoice_number: "INV-2026-00001",
    status: "draft",
    currency: "usd",
    subtotal_cents: 7500,
    tax_cents: 0,
    total_cents: 7500,
    due_date: null,
    issued_at: null,
    paid_at: null,
    notes: null,
    payment_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const runs: Recorded[] = [];
  const db = {
    prepare(sql: string) {
      const exec = (binds: unknown[]) => ({
        async first() {
          if (sql.includes("FROM invoice_counters")) return { next_number: 1 };
          if (sql.includes("FROM invoices")) return invoice;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          runs.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
        },
      });
      return {
        bind(...binds: unknown[]) {
          return exec(binds);
        },
        ...exec([]),
      };
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, name: "Guild" } as Tenant);
    await next();
  });
  app.route("/", invoiceRoutes);
  const env = { DB: db } as unknown as Env;
  const post = (body: unknown) =>
    app.request(
      "/",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  const patch = (body: unknown) =>
    app.request(
      "/inv-1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  const inserted = () => runs.filter((r) => r.sql.startsWith("INSERT INTO invoices"));
  const insertedLines = () => runs.filter((r) => r.sql.includes("INSERT INTO invoice_lines"));
  const updated = () => runs.filter((r) => r.sql.startsWith("UPDATE invoices SET"));
  return { post, patch, runs, inserted, insertedLines, updated };
}

const LINE = { description: "Annual booth fee", quantity: 1, unit_cents: 7500 };

describe("POST /invoices — money validation", () => {
  it("accepts whole cents and stores subtotal + tax + total", async () => {
    const h = harness();
    const res = await h.post({ lines: [LINE, { description: "Table", quantity: 2, unit_cents: 1500 }], tax_cents: 250 });
    expect(res.status).toBe(201);
    const binds = h.inserted()[0].binds;
    // currency is a literal in the SQL, so binds 5/6/7 are subtotal/tax/total.
    expect(binds[5]).toBe(10500);
    expect(binds[6]).toBe(250);
    expect(binds[7]).toBe(10750);
    expect(h.insertedLines().length).toBe(2);
  });

  it("rejects a float unit price with a field error instead of flooring it", async () => {
    const h = harness();
    const res = await h.post({ lines: [{ ...LINE, unit_cents: 3500.4 }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string; message: string }[] };
    expect(body.error).toMatch(/unit_cents/);
    expect(body.issues).toEqual([
      { path: "lines.0.unit_cents", message: "unit_cents must be a whole number of cents" },
    ]);
    expect(h.inserted().length).toBe(0);
  });

  it("rejects a negative unit price and a negative tax", async () => {
    const h = harness();
    expect((await h.post({ lines: [{ ...LINE, unit_cents: -1 }] })).status).toBe(400);
    const res = await h.post({ lines: [LINE], tax_cents: -5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues[0].path).toBe("tax_cents");
    expect(h.inserted().length).toBe(0);
  });

  it("rejects a float tax and a non-numeric amount", async () => {
    const h = harness();
    expect((await h.post({ lines: [LINE], tax_cents: 2.5 })).status).toBe(400);
    expect((await h.post({ lines: [LINE], tax_cents: "250" })).status).toBe(400);
    expect((await h.post({ lines: [{ ...LINE, unit_cents: "7500" }] })).status).toBe(400);
    expect(h.inserted().length).toBe(0);
  });

  it("rejects a zero or negative quantity", async () => {
    const h = harness();
    expect((await h.post({ lines: [{ ...LINE, quantity: 0 }] })).status).toBe(400);
    expect((await h.post({ lines: [{ ...LINE, quantity: -2 }] })).status).toBe(400);
    expect(h.inserted().length).toBe(0);
  });

  it("keeps the existing empty-lines error", async () => {
    const h = harness();
    const res = await h.post({ lines: [] });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("At least one line item is required");
    const res2 = await h.post({});
    expect(res2.status).toBe(400);
    expect((await res2.json() as { error: string }).error).toBe("At least one line item is required");
  });

  it("still allows a free line (0 cents) and an omitted quantity", async () => {
    const h = harness();
    const res = await h.post({ lines: [{ description: "Comped booth", unit_cents: 0 }] });
    expect(res.status).toBe(201);
    expect(h.inserted()[0].binds[5]).toBe(0);
  });
});

describe("PATCH /invoices/:id — money validation", () => {
  it("accepts whole cents and recomputes the total", async () => {
    const h = harness();
    const res = await h.patch({ lines: [{ description: "Booth", quantity: 1, unit_cents: 5000 }], tax_cents: 100 });
    expect(res.status).toBe(200);
    const binds = h.updated()[0].binds;
    expect(binds).toContain(5000);
    expect(binds).toContain(100);
    expect(binds).toContain(5100);
  });

  it("rejects a float tax without touching the invoice", async () => {
    const h = harness();
    const res = await h.patch({ tax_cents: 12.5 });
    expect(res.status).toBe(400);
    expect((await res.json() as { issues: { path: string }[] }).issues[0].path).toBe("tax_cents");
    expect(h.updated().length).toBe(0);
  });

  it("rejects a float unit price without deleting the existing lines", async () => {
    const h = harness();
    const res = await h.patch({ lines: [{ description: "Booth", unit_cents: 0.5 }] });
    expect(res.status).toBe(400);
    expect(h.runs.filter((r) => r.sql.includes("DELETE FROM invoice_lines")).length).toBe(0);
  });

  it("leaves status-only patches alone", async () => {
    const h = harness();
    const res = await h.patch({ status: "paid" });
    expect(res.status).toBe(200);
    expect(h.updated().length).toBe(1);
  });
});
