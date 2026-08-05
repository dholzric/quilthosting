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
