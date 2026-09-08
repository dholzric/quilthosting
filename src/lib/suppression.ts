/**
 * Email permission: suppression list + member opt-out + unsubscribe tokens.
 *
 * Two layers, checked together by isSuppressed():
 *   - email_suppressions rows (address-level). tenant_id NULL = platform
 *     wide (hard bounces / complaints with no known tenant). scope 'all'
 *     blocks every kind of mail; 'marketing' blocks blasts/automations only.
 *   - members.email_opt_out_at (member-level marketing opt-out for one guild).
 *
 * "transactional" mail (receipts, magic links, renewal notices) is only
 * blocked by scope='all' suppressions; "marketing" mail is blocked by any of
 * the above.
 *
 * Unsubscribe tokens are HMAC-SHA256(secret, `${tenantId}:${email}`) and
 * carry no expiry on purpose: RFC 8058 one-click links in old newsletters
 * must keep working.
 */
import { first } from "./db";
import { generateId } from "./utils/id";

export type SuppressionKind = "marketing" | "transactional";
export type SuppressionReason = "bounce" | "complaint" | "unsubscribe" | "manual";
export type SuppressionScope = "marketing" | "all";

export type SuppressionCheck = {
  suppressed: boolean;
  /** Why, when suppressed: `${reason}` from the list or "opt_out". */
  reason?: string;
};

export function normalizeEmail(email: string): string {
  return (email || "").trim().toLowerCase();
}

/**
 * Is this address blocked for `kind` mail from `tenantId`?
 * tenantId may be null for platform mail (only global rows apply then).
 */
export async function isSuppressed(
  db: D1Database,
  tenantId: string | null,
  email: string,
  kind: SuppressionKind
): Promise<SuppressionCheck> {
  const addr = normalizeEmail(email);
  if (!addr) return { suppressed: true, reason: "invalid_email" };

  const scopes = kind === "marketing" ? ["all", "marketing"] : ["all"];
  const scopeSql = scopes.map(() => "?").join(", ");
  const row = await first<{ reason: string; scope: string; tenant_id: string | null }>(
    db
      .prepare(
        `SELECT reason, scope, tenant_id FROM email_suppressions
         WHERE email = ? AND scope IN (${scopeSql})
           AND (tenant_id IS NULL OR tenant_id = ?)
         ORDER BY CASE scope WHEN 'all' THEN 0 ELSE 1 END
         LIMIT 1`
      )
      .bind(addr, ...scopes, tenantId ?? "")
  );
  if (row) return { suppressed: true, reason: row.reason };

  if (kind === "marketing" && tenantId) {
    const member = await first<{ email_opt_out_at: string | null }>(
      db
        .prepare(
          `SELECT email_opt_out_at FROM members WHERE tenant_id = ? AND email = ? LIMIT 1`
        )
        .bind(tenantId, addr)
    );
    if (member?.email_opt_out_at) return { suppressed: true, reason: "opt_out" };
  }

  return { suppressed: false };
}

/** Insert a suppression row; idempotent on (tenant, email, scope). */
export async function suppress(
  db: D1Database,
  opts: {
    tenantId: string | null;
    email: string;
    reason: SuppressionReason;
    scope?: SuppressionScope;
    source?: string | null;
  }
): Promise<{ inserted: boolean }> {
  const addr = normalizeEmail(opts.email);
  if (!addr) return { inserted: false };
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO email_suppressions (id, tenant_id, email, reason, scope, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      generateId(),
      opts.tenantId,
      addr,
      opts.reason,
      opts.scope || "marketing",
      opts.source ?? null,
      new Date().toISOString()
    )
    .run();
  return { inserted: (res.meta?.changes ?? 0) > 0 };
}

/** Mark a member opted out of marketing mail for one tenant (idempotent). */
export async function optOutMember(
  db: D1Database,
  tenantId: string,
  email: string
): Promise<{ changes: number }> {
  const addr = normalizeEmail(email);
  const res = await db
    .prepare(
      `UPDATE members SET email_opt_out_at = ?, updated_at = ?
       WHERE tenant_id = ? AND email = ? AND email_opt_out_at IS NULL`
    )
    .bind(new Date().toISOString(), new Date().toISOString(), tenantId, addr)
    .run();
  return { changes: res.meta?.changes ?? 0 };
}

/**
 * A member re-subscribing from the portal: remove this tenant's
 * reason='unsubscribe' rows for the address so marketing mail flows again.
 * Bounce / complaint (and admin 'manual') rows are deliberately left alone —
 * only the provider or an admin may lift those.
 */
export async function clearUnsubscribe(
  db: D1Database,
  tenantId: string,
  email: string
): Promise<{ changes: number }> {
  const addr = normalizeEmail(email);
  if (!addr || !tenantId) return { changes: 0 };
  const res = await db
    .prepare(
      `DELETE FROM email_suppressions
       WHERE tenant_id = ? AND email = ? AND reason = 'unsubscribe'`
    )
    .bind(tenantId, addr)
    .run();
  return { changes: res.meta?.changes ?? 0 };
}

/* ------------------------------------------------------------------ */
/* Unsubscribe tokens                                                  */
/* ------------------------------------------------------------------ */

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Token = base64url(`${tenantId}:${email}`) + "." + base64url(HMAC).
 * The payload is carried in the token so the unsubscribe endpoint needs no
 * lookup table and no expiry.
 */
export async function unsubscribeToken(
  secret: string,
  tenantId: string,
  email: string
): Promise<string> {
  const payload = `${tenantId}:${normalizeEmail(email)}`;
  const sig = await hmac(secret, payload);
  return `${b64url(new TextEncoder().encode(payload))}.${b64url(sig)}`;
}

export async function verifyUnsubscribeToken(
  secret: string,
  token: string
): Promise<{ tenantId: string; email: string } | null> {
  if (!secret || !token || token.length > 1024) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadBytes = b64urlDecode(token.slice(0, dot));
  const sigBytes = b64urlDecode(token.slice(dot + 1));
  if (!payloadBytes || !sigBytes) return null;
  const payload = new TextDecoder().decode(payloadBytes);
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(expected, sigBytes)) return null;
  const sep = payload.indexOf(":");
  if (sep <= 0) return null;
  const tenantId = payload.slice(0, sep);
  const email = payload.slice(sep + 1);
  if (!tenantId || !email.includes("@")) return null;
  return { tenantId, email };
}

/** Absolute one-click unsubscribe URL for a recipient. */
export async function unsubscribeUrl(
  appUrl: string,
  secret: string,
  tenantId: string,
  email: string
): Promise<string> {
  const base = (appUrl || "").replace(/\/$/, "");
  return `${base}/u/${await unsubscribeToken(secret, tenantId, email)}`;
}
