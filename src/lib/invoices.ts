import { generateId } from "./utils/id";
import { first } from "./db";

export type InvoiceLineInput = {
  description: string;
  quantity?: number;
  unit_cents: number;
};

export async function nextInvoiceNumber(db: D1Database, tenantId: string): Promise<string> {
  const now = new Date().toISOString();
  // Ensure counter row
  await db
    .prepare(
      `INSERT OR IGNORE INTO invoice_counters (tenant_id, next_number) VALUES (?, 1)`
    )
    .bind(tenantId)
    .run();
  const row = await first<{ next_number: number }>(
    db.prepare(`SELECT next_number FROM invoice_counters WHERE tenant_id = ?`).bind(tenantId)
  );
  const n = row?.next_number ?? 1;
  await db
    .prepare(`UPDATE invoice_counters SET next_number = ? WHERE tenant_id = ?`)
    .bind(n + 1, tenantId)
    .run();
  const year = new Date().getFullYear();
  return `INV-${year}-${String(n).padStart(5, "0")}`;
}

export function computeLines(lines: InvoiceLineInput[]): {
  rows: Array<{
    id: string;
    description: string;
    quantity: number;
    unit_cents: number;
    amount_cents: number;
    sort_order: number;
  }>;
  subtotal: number;
} {
  const rows = lines
    .map((l, i) => {
      const qty = Math.max(0.01, Number(l.quantity) || 1);
      const unit = Math.max(0, Math.floor(Number(l.unit_cents) || 0));
      const amount = Math.round(qty * unit);
      return {
        id: generateId(),
        description: String(l.description || "Line").slice(0, 300),
        quantity: qty,
        unit_cents: unit,
        amount_cents: amount,
        sort_order: i,
      };
    })
    .filter((r) => r.description);
  const subtotal = rows.reduce((s, r) => s + r.amount_cents, 0);
  return { rows, subtotal };
}

export function invoiceHtml(opts: {
  tenantName: string;
  invoiceNumber: string;
  status: string;
  memberName?: string;
  memberEmail?: string;
  issuedAt?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  lines: Array<{
    description: string;
    quantity: number;
    unit_cents: number;
    amount_cents: number;
  }>;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}): string {
  const money = (c: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
  const lineRows = opts.lines
    .map(
      (l) =>
        `<tr>
          <td>${esc(l.description)}</td>
          <td style="text-align:right">${l.quantity}</td>
          <td style="text-align:right">${money(l.unit_cents)}</td>
          <td style="text-align:right">${money(l.amount_cents)}</td>
        </tr>`
    )
    .join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invoice ${esc(opts.invoiceNumber)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.4rem;margin:0 0 0.25rem}
  .muted{color:#666;font-size:0.9rem}
  table{width:100%;border-collapse:collapse;margin:1.25rem 0}
  th,td{padding:0.5rem 0.4rem;border-bottom:1px solid #e5e5e5;text-align:left}
  th{font-size:0.8rem;text-transform:uppercase;color:#666}
  .totals{margin-left:auto;width:240px}
  .totals div{display:flex;justify-content:space-between;padding:0.25rem 0}
  .totals .grand{font-weight:700;font-size:1.1rem;border-top:2px solid #1a1a1a;margin-top:0.35rem;padding-top:0.5rem}
  @media print{button{display:none}}
  button{margin:1rem 0.5rem 0 0;padding:0.5rem 1rem;border-radius:8px;border:1px solid #ccc;cursor:pointer;background:#fff}
  button.primary{background:#b5501f;color:#fff;border-color:#b5501f}
</style></head>
<body>
  <h1>Invoice ${esc(opts.invoiceNumber)}</h1>
  <p class="muted">${esc(opts.tenantName)} · ${esc(opts.status)}${
    opts.issuedAt ? ` · Issued ${esc(opts.issuedAt.slice(0, 10))}` : ""
  }${opts.dueDate ? ` · Due ${esc(opts.dueDate.slice(0, 10))}` : ""}</p>
  ${
    opts.memberName || opts.memberEmail
      ? `<p><strong>Bill to</strong><br>${esc(opts.memberName || "")}${
          opts.memberEmail ? `<br>${esc(opts.memberEmail)}` : ""
        }</p>`
      : ""
  }
  <table>
    <thead><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${lineRows || `<tr><td colspan="4" class="muted">No lines</td></tr>`}</tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${money(opts.subtotalCents)}</span></div>
    <div><span>Tax</span><span>${money(opts.taxCents)}</span></div>
    <div class="grand"><span>Total</span><span>${money(opts.totalCents)}</span></div>
  </div>
  ${opts.notes ? `<p class="muted" style="margin-top:1.5rem">${esc(opts.notes)}</p>` : ""}
  <button class="primary" onclick="window.print()">Print / Save PDF</button>
  <button onclick="window.close()">Close</button>
</body></html>`;
}

function esc(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { generateId };
