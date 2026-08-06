import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import {
  computeLines,
  invoiceHtml,
  nextInvoiceNumber,
  type InvoiceLineInput,
} from "../lib/invoices";

export const invoiceRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type InvoiceRow = {
  id: string;
  tenant_id: string;
  member_id: string | null;
  invoice_number: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  due_date: string | null;
  issued_at: string | null;
  paid_at: string | null;
  notes: string | null;
  payment_id: string | null;
  created_at: string;
  updated_at: string;
};

invoiceRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all<InvoiceRow & { member_email?: string; member_name?: string }>(
      c.env.DB.prepare(
        `SELECT i.*, m.email as member_email,
                (coalesce(m.first_name,'') || ' ' || coalesce(m.last_name,'')) as member_name
         FROM invoices i
         LEFT JOIN members m ON m.id = i.member_id
         WHERE i.tenant_id = ?
         ORDER BY i.created_at DESC LIMIT 200`
      ).bind(tenant.id)
    );
    // Envelope + bare array both accepted by admin asList()
    return c.json({ invoices: rows, total: rows.length });
  } catch {
    return c.json({ invoices: [], total: 0 });
  }
});

invoiceRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    member_id?: string;
    lines: InvoiceLineInput[];
    tax_cents?: number;
    due_date?: string;
    notes?: string;
    status?: "draft" | "sent" | "paid";
    issue?: boolean;
  }>();
  if (!Array.isArray(body.lines) || !body.lines.length) {
    return c.json({ error: "At least one line item is required" }, 400);
  }
  const { rows, subtotal } = computeLines(body.lines);
  if (!rows.length) return c.json({ error: "Invalid line items" }, 400);
  const tax = Math.max(0, Math.floor(Number(body.tax_cents) || 0));
  const total = subtotal + tax;
  const id = generateId();
  const now = new Date().toISOString();
  const number = await nextInvoiceNumber(c.env.DB, tenant.id);
  const status = body.status || (body.issue ? "sent" : "draft");
  const issuedAt = status !== "draft" ? now : null;

  await c.env.DB.prepare(
    `INSERT INTO invoices
     (id, tenant_id, member_id, invoice_number, status, currency,
      subtotal_cents, tax_cents, total_cents, due_date, issued_at, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      body.member_id || null,
      number,
      status,
      subtotal,
      tax,
      total,
      body.due_date || null,
      issuedAt,
      body.notes?.trim() || null,
      now,
      now
    )
    .run();

  for (const line of rows) {
    await c.env.DB.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, description, quantity, unit_cents, amount_cents, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        line.id,
        id,
        line.description,
        line.quantity,
        line.unit_cents,
        line.amount_cents,
        line.sort_order
      )
      .run();
  }

  const inv = await first<InvoiceRow>(
    c.env.DB.prepare(`SELECT * FROM invoices WHERE id = ?`).bind(id)
  );
  return c.json({ ...inv, lines: rows }, 201);
});

invoiceRoutes.get("/:invoiceId", async (c) => {
  const tenant = c.get("tenant");
  const inv = await first<InvoiceRow>(
    c.env.DB.prepare(
      `SELECT * FROM invoices WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("invoiceId"), tenant.id)
  );
  if (!inv) return c.json({ error: "Not found" }, 404);
  const lines = await all(
    c.env.DB.prepare(
      `SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order`
    ).bind(inv.id)
  );
  return c.json({ ...inv, lines });
});

invoiceRoutes.patch("/:invoiceId", async (c) => {
  const tenant = c.get("tenant");
  const inv = await first<InvoiceRow>(
    c.env.DB.prepare(
      `SELECT * FROM invoices WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("invoiceId"), tenant.id)
  );
  if (!inv) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    status?: string;
    notes?: string;
    due_date?: string | null;
    tax_cents?: number;
    lines?: InvoiceLineInput[];
  }>();
  const now = new Date().toISOString();
  let subtotal = inv.subtotal_cents;
  let tax = inv.tax_cents;
  let total = inv.total_cents;

  if (Array.isArray(body.lines)) {
    const { rows, subtotal: s } = computeLines(body.lines);
    subtotal = s;
    tax = body.tax_cents !== undefined ? Math.max(0, Math.floor(body.tax_cents)) : tax;
    total = subtotal + tax;
    await c.env.DB.prepare(`DELETE FROM invoice_lines WHERE invoice_id = ?`)
      .bind(inv.id)
      .run();
    for (const line of rows) {
      await c.env.DB.prepare(
        `INSERT INTO invoice_lines (id, invoice_id, description, quantity, unit_cents, amount_cents, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          line.id,
          inv.id,
          line.description,
          line.quantity,
          line.unit_cents,
          line.amount_cents,
          line.sort_order
        )
        .run();
    }
  } else if (body.tax_cents !== undefined) {
    tax = Math.max(0, Math.floor(body.tax_cents));
    total = subtotal + tax;
  }

  let status = body.status || inv.status;
  let issuedAt = inv.issued_at;
  let paidAt = inv.paid_at;
  if (status === "sent" && !issuedAt) issuedAt = now;
  if (status === "paid" && !paidAt) paidAt = now;

  await c.env.DB.prepare(
    `UPDATE invoices SET
       status = ?, notes = coalesce(?, notes), due_date = coalesce(?, due_date),
       subtotal_cents = ?, tax_cents = ?, total_cents = ?,
       issued_at = ?, paid_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      status,
      body.notes !== undefined ? body.notes : null,
      body.due_date !== undefined ? body.due_date : null,
      subtotal,
      tax,
      total,
      issuedAt,
      paidAt,
      now,
      inv.id
    )
    .run();

  const updated = await first<InvoiceRow>(
    c.env.DB.prepare(`SELECT * FROM invoices WHERE id = ?`).bind(inv.id)
  );
  const lines = await all(
    c.env.DB.prepare(
      `SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order`
    ).bind(inv.id)
  );
  return c.json({ ...updated, lines });
});

invoiceRoutes.get("/:invoiceId/print", async (c) => {
  const tenant = c.get("tenant");
  const inv = await first<InvoiceRow>(
    c.env.DB.prepare(
      `SELECT * FROM invoices WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("invoiceId"), tenant.id)
  );
  if (!inv) return c.json({ error: "Not found" }, 404);
  const lines = await all<{
    description: string;
    quantity: number;
    unit_cents: number;
    amount_cents: number;
  }>(
    c.env.DB.prepare(
      `SELECT description, quantity, unit_cents, amount_cents FROM invoice_lines
       WHERE invoice_id = ? ORDER BY sort_order`
    ).bind(inv.id)
  );
  let memberName = "";
  let memberEmail = "";
  if (inv.member_id) {
    const m = await first<{
      first_name: string | null;
      last_name: string | null;
      email: string;
    }>(
      c.env.DB.prepare(
        `SELECT first_name, last_name, email FROM members WHERE id = ?`
      ).bind(inv.member_id)
    );
    if (m) {
      memberName = [m.first_name, m.last_name].filter(Boolean).join(" ");
      memberEmail = m.email;
    }
  }
  const html = invoiceHtml({
    tenantName: tenant.name,
    invoiceNumber: inv.invoice_number,
    status: inv.status,
    memberName,
    memberEmail,
    issuedAt: inv.issued_at,
    dueDate: inv.due_date,
    notes: inv.notes,
    lines,
    subtotalCents: inv.subtotal_cents,
    taxCents: inv.tax_cents,
    totalCents: inv.total_cents,
  });
  return c.html(html);
});

invoiceRoutes.delete("/:invoiceId", async (c) => {
  const tenant = c.get("tenant");
  const inv = await first<InvoiceRow>(
    c.env.DB.prepare(
      `SELECT * FROM invoices WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("invoiceId"), tenant.id)
  );
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (inv.status === "paid") {
    return c.json({ error: "Cannot delete a paid invoice" }, 400);
  }
  await c.env.DB.prepare(`DELETE FROM invoice_lines WHERE invoice_id = ?`)
    .bind(inv.id)
    .run();
  await c.env.DB.prepare(`DELETE FROM invoices WHERE id = ?`).bind(inv.id).run();
  return c.json({ ok: true });
});
