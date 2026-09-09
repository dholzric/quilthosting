import { z } from "zod";

/** Format cents as USD string */
export function formatMoney(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** Convert dollars to cents safely */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/* ——— Human units at the UI boundary ———
 *
 * Every admin input and read-out is dollars or a percentage; the wire format
 * and the database stay integer cents and basis points. The conversion lives
 * here and in exactly one mirrored block in public/admin.html (search for
 * "MONEY (client mirror"); src/lib/utils/money.test.ts runs one accept/reject
 * table through both so they cannot drift.
 *
 * dollarsToCents accepts "35", "35.5", "$35.50", "1,200" and " 35 ".
 */

// Rejects: "" (empty), text that is not a number, negative amounts, more than
// two decimal places, and anything over $100,000.00 (10000000 cents).

/** Largest amount an admin may type, in cents ($100,000.00). */
export const MAX_CENTS = 10_000_000;
/** Largest sales-tax rate, in basis points (25.00%). */
export const MAX_TAX_BPS = 2500;
/** Largest value any *_cents wire field may carry (matches levels.ts). */
export const MAX_MONEY_CENTS = 100_000_000;

/** Two decimal places at most, no sign, no exponent. */
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** Numbers reach the same string path as typed input, so one rule set applies. */
function numberToText(n: number): string | null {
  if (!Number.isFinite(n)) return null;
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Dollars (as typed) to whole cents, or null when the text is not a valid
 * amount. A null is a field error the caller must show; never a silent 0.
 */
export function dollarsToCents(input: string | number): number | null {
  const text =
    typeof input === "number" ? numberToText(input) : String(input).replace(/[\s,$]/g, "");
  if (text === null || !DECIMAL_RE.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CENTS) return null;
  return cents;
}

/** Whole cents to a plain input value: "35.00". No currency symbol. */
export function centsToDollars(cents: number): string {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return "0.00";
  return (Math.round(n) / 100).toFixed(2);
}

/**
 * A tax percentage (as typed, 0–25) to basis points, or null when the text is
 * not a valid rate. Same rules as dollarsToCents plus the 25% ceiling.
 */
export function percentToBps(p: string | number): number | null {
  const text = typeof p === "number" ? numberToText(p) : String(p).replace(/[\s,%]/g, "");
  if (text === null || !DECIMAL_RE.test(text)) return null;
  const bps = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > MAX_TAX_BPS) return null;
  return bps;
}

/** Basis points to a plain input value: 725 -> "7.25", 700 -> "7". */
export function bpsToPercent(bps: number): string {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return "0";
  return String(Math.round(n) / 100);
}

/* ——— Wire-format guards ———
 * Money crosses the wire as integer cents and basis points. These reject a
 * float (rather than truncating it) with a field error, so a UI that forgets
 * to convert fails loudly instead of charging $0.35 for a $35 ticket.
 */

/** Zod schema for a *_cents request field. */
export function centsField(name: string) {
  return z
    .number({ invalid_type_error: `${name} must be a whole number of cents` })
    .int(`${name} must be a whole number of cents`)
    .min(0, `${name} cannot be negative`)
    .max(MAX_MONEY_CENTS, `${name} is too large`);
}

/** Zod schema for a basis-points request field (0–2500). */
export function bpsField(name: string) {
  return z
    .number({ invalid_type_error: `${name} must be a whole number of basis points` })
    .int(`${name} must be a whole number of basis points`)
    .min(0, `${name} cannot be negative`)
    .max(MAX_TAX_BPS, `${name} cannot be more than ${MAX_TAX_BPS} (25%)`);
}
