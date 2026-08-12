// Human-facing project code — the thing Linda says on the phone. Sequential
// per tenant, allocated from project_counters (NOT invoice_counters: an
// estimate that is never accepted must not consume an invoice number).

/**
 * Build a reference like "SSQ-0042". Prefix comes from the owner's setting
 * when present, otherwise the first three alphanumerics of the tenant slug,
 * otherwise "QP".
 */
export function buildReference(
  prefix: string | undefined,
  tenantSlug: string,
  n: number
): string {
  const fromSetting = (prefix || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const fromSlug = (tenantSlug || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const code = (fromSetting || fromSlug.slice(0, 3) || "QP").slice(0, 6);
  return `${code}-${String(n).padStart(4, "0")}`;
}
