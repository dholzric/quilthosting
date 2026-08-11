// Single read point for tenants.tenant_type. Everything that needs to know
// "is this a business?" asks here, so the guild/business split never becomes
// a scatter of inline string comparisons.

export type TenantType = "guild" | "business";

/**
 * Strict equality against the literal 'business'. Anything else — including a
 * missing column on a pre-migration row, or a differently-cased value — is a
 * guild. Defaulting to guild is the safe direction: a misread guild keeps its
 * existing behaviour, while a misread business would silently disable
 * membership limits.
 */
export function isBusiness(tenant: { tenant_type?: string | null }): boolean {
  return tenant.tenant_type === "business";
}

/**
 * A tenant is publicly launched only when it is a business AND explicitly
 * flagged. Guilds are never launched in the P0 sense — they stay behind the
 * site gate on guild.html.
 */
export function isLaunched(tenant: {
  tenant_type?: string | null;
  public_launched?: number | null;
}): boolean {
  return isBusiness(tenant) && tenant.public_launched === 1;
}
