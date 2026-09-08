/**
 * One-time magic-link tokens.
 *
 * A magic link is a JWT with purpose "magic" whose `jti` is also recorded in
 * `auth_tokens` (migration 0021). Consuming it is a single conditional
 * UPDATE that flips `used_at`, so a link that has already been used -- or
 * whose row was never written -- cannot be replayed within its 15-minute
 * signature validity. The signature check still runs first, so the table is
 * only ever consulted for tokens we actually issued.
 */
import type { Context } from "hono";
import type { Env } from "../../types";
import { signJwt, verifyJwt, type JwtPayload } from "./jwt";

export const MAGIC_LINK_TTL_SECONDS = 60 * 15;

/**
 * Sign a magic-link token and record its jti so it can be consumed exactly
 * once. Returns the raw token to embed in the emailed URL plus its jti so a
 * caller can revoke it (see revokeAuthToken) if the email never goes out.
 */
export async function issueMagicToken(
  db: D1Database,
  secret: string,
  user: { id: string; email: string; name?: string | null },
  ttlSeconds = MAGIC_LINK_TTL_SECONDS
): Promise<{ token: string; jti: string; expiresAt: string }> {
  const jti = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const token = await signJwt(
    { sub: user.id, email: user.email, name: user.name ?? undefined, jti },
    secret,
    ttlSeconds,
    "magic"
  );
  await db
    .prepare(
      `INSERT INTO auth_tokens (jti, user_id, purpose, expires_at, used_at, created_at)
       VALUES (?, ?, 'magic', ?, NULL, ?)`
    )
    .bind(jti, user.id, expiresAt, now.toISOString())
    .run();
  return { token, jti, expiresAt };
}

/** Best-effort revocation of an issued-but-undelivered token. */
export async function revokeAuthToken(db: D1Database, jti: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM auth_tokens WHERE jti = ?").bind(jti).run();
  } catch (e) {
    console.warn("auth_tokens revoke failed", e);
  }
}

/**
 * Verify a magic-link token (purpose "magic" only) and atomically mark it
 * used. Returns the payload on the first successful use, null on a bad
 * signature, wrong purpose, expiry, unknown jti, or any later reuse.
 */
export async function consumeMagicToken(
  db: D1Database,
  token: string,
  secret: string
): Promise<JwtPayload | null> {
  const payload = await verifyJwt(token, secret, { purpose: "magic" });
  if (!payload) return null;
  const nowIso = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE auth_tokens SET used_at = ?
       WHERE jti = ? AND used_at IS NULL AND expires_at > ?`
    )
    .bind(nowIso, payload.jti, nowIso)
    .run();
  if (!result?.meta || result.meta.changes !== 1) return null;
  return payload;
}

/** Delete expired rows (used or not). Call from the daily cron. */
export async function sweepAuthTokens(db: D1Database): Promise<{ deleted: number }> {
  const result = await db
    .prepare("DELETE FROM auth_tokens WHERE expires_at < ?")
    .bind(new Date().toISOString())
    .run();
  return { deleted: result?.meta?.changes ?? 0 };
}

function expiredPage(slug: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Link expired</title>
<style>body{font-family:system-ui;max-width:480px;margin:4rem auto;padding:0 1rem;text-align:center}</style></head>
<body><h2>This sign-in link has expired or was already used</h2><p>Please request a new one from the member portal.</p>
<p><a href="/portal${slug ? `?slug=${encodeURIComponent(slug)}` : ""}">Back to the portal</a></p></body></html>`;
}

/**
 * GET /auth/verify?token=...&slug=...&dest=app
 *
 * Browser landing for the emailed magic link. Consumes the one-time token,
 * mints a real session, and hands it to the portal via `#ptoken=` (the
 * fragment is never sent to a server) or to the native app via the
 * quilthosting:// URL scheme when `dest=app`.
 *
 * Mount in src/index.ts as `app.get("/auth/verify", magicLinkLanding)`.
 */
export async function magicLinkLanding(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.req.query("token") || "";
  const slug = c.req.query("slug") || "";
  const payload = token
    ? await consumeMagicToken(c.env.DB, token, c.env.JWT_SECRET)
    : null;
  if (!payload) {
    return c.html(expiredPage(slug), 401);
  }
  const session = await signJwt(
    { sub: payload.sub, email: payload.email, name: payload.name },
    c.env.JWT_SECRET
  );
  // Native app magic links come back with ?dest=app and hand off via URL scheme
  if (c.req.query("dest") === "app") {
    return c.redirect(
      `quilthosting://auth?token=${session}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}`
    );
  }
  const dest = `/portal${slug ? `?slug=${encodeURIComponent(slug)}` : ""}#ptoken=${session}`;
  return c.redirect(dest);
}
