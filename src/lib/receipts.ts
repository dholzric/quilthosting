import { formatMoney } from "./utils/money";

export type ReceiptData = {
  guildName: string;
  receiptId: string;
  date: string;
  type: string;
  description: string;
  amountCents: number;
  currency: string;
  status: string;
  payerName?: string | null;
  payerEmail?: string | null;
  stripeRef?: string | null;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Standalone printable receipt HTML (open in browser → Print → Save as PDF). */
export function renderReceiptHtml(data: ReceiptData): string {
  const amount = formatMoney(data.amountCents);
  const dateStr = (() => {
    try {
      return new Date(data.date).toLocaleString("en-US", {
        dateStyle: "long",
        timeStyle: "short",
      });
    } catch {
      return data.date;
    }
  })();
  const typeLabel =
    data.type === "dues"
      ? "Membership dues"
      : data.type === "event"
        ? "Event registration"
        : data.type === "donation"
          ? "Donation"
          : data.type;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt — ${esc(data.guildName)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; color: #221f1a; margin: 0; padding: 2rem; background: #faf7f2; }
    .sheet { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #e7dfd2; border-radius: 12px; padding: 2rem; }
    h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
    .sub { color: #8a847a; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .amount { font-size: 2rem; font-weight: 700; color: #b5501f; margin: 1rem 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
    th { text-align: left; color: #8a847a; font-weight: 500; padding: 0.4rem 0; width: 40%; vertical-align: top; }
    td { padding: 0.4rem 0; }
    .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; flex-wrap: wrap; }
    button, .btn { background: #b5501f; color: #fff; border: none; padding: 0.55rem 1rem; border-radius: 8px; font-weight: 600; cursor: pointer; text-decoration: none; font-size: 0.9rem; }
    button.secondary { background: #fff; color: #221f1a; border: 1px solid #d6cbb8; }
    .foot { margin-top: 2rem; font-size: 0.8rem; color: #8a847a; border-top: 1px solid #e7dfd2; padding-top: 1rem; }
    @media print {
      body { background: #fff; padding: 0; }
      .sheet { border: none; border-radius: 0; max-width: none; }
      .actions { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <h1>${esc(data.guildName)}</h1>
    <div class="sub">Payment receipt · ${esc(data.receiptId.slice(0, 8).toUpperCase())}</div>
    <div class="amount">${esc(amount)}</div>
    <table>
      <tr><th>Date</th><td>${esc(dateStr)}</td></tr>
      <tr><th>Type</th><td>${esc(typeLabel)}</td></tr>
      <tr><th>Description</th><td>${esc(data.description || "—")}</td></tr>
      <tr><th>Status</th><td>${esc(data.status)}</td></tr>
      ${data.payerName ? `<tr><th>Paid by</th><td>${esc(data.payerName)}</td></tr>` : ""}
      ${data.payerEmail ? `<tr><th>Email</th><td>${esc(data.payerEmail)}</td></tr>` : ""}
      ${data.stripeRef ? `<tr><th>Reference</th><td><code style="font-size:0.8rem">${esc(data.stripeRef)}</code></td></tr>` : ""}
    </table>
    <div class="actions">
      <button onclick="window.print()">Print / Save as PDF</button>
      <button class="secondary" onclick="window.close()">Close</button>
    </div>
    <div class="foot">
      Issued by ${esc(data.guildName)} via QuiltHosting · QuiltMap LLC<br/>
      This document is a record of payment. For questions, contact your guild treasurer.
    </div>
  </div>
</body>
</html>`;
}
