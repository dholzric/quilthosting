/**
 * Hand-rolled HS256 JWT on WebCrypto.
 *
 * Every token carries a `purpose` claim and a random `jti`. `verifyJwt`
 * only accepts a token whose purpose matches what the caller expects
 * (default "session"), so a 15-minute magic-link token can never be used
 * as a bearer on protected APIs, and a 7-day session can never be replayed
 * through the magic-link landing to mint itself a fresh 7 days. Tokens
 * issued before the purpose claim existed have no `purpose` and are
 * rejected outright -- those users simply sign in again.
 */

export type JwtPurpose = "session" | "magic" | "receipt" | "download";

export type JwtPayload = {
  sub: string;
  email: string;
  name?: string;
  /** What this token may be used for. Checked on every verify. */
  purpose: JwtPurpose;
  /** Random per-token id (crypto.randomUUID()). Magic links are consumed by it. */
  jti: string;
  /**
   * Optional resource binding for single-purpose link tokens
   * (e.g. "receipt:<tenantId>:<paymentId>"). Callers that mint a bound token
   * must check it on the way back in; verifyJwt only carries it through.
   */
  res?: string;
  iat: number;
  exp: number;
};

export type SignJwtPayload = Omit<JwtPayload, "iat" | "exp" | "purpose" | "jti"> & {
  /** Supply a jti when the caller needs to persist it (magic links); else random. */
  jti?: string;
};

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str: string): Uint8Array {
  if (!B64URL_RE.test(str)) throw new Error("bad base64url");
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** UTF-8 safe: `btoa` alone throws on any code point above U+00FF (emoji, CJK, accents). */
function b64urlEncodeText(text: string): string {
  return bytesToB64url(new TextEncoder().encode(text));
}

function b64urlDecodeText(str: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    b64urlToBytes(str)
  );
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signJwt(
  payload: SignJwtPayload,
  secret: string,
  expiresInSeconds = 60 * 60 * 24 * 7,
  purpose: JwtPurpose = "session"
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    jti: payload.jti || crypto.randomUUID(),
    purpose,
    iat: now,
    exp: now + expiresInSeconds,
  };
  const headerB64 = b64urlEncodeText(JSON.stringify(header));
  const payloadB64 = b64urlEncodeText(JSON.stringify(fullPayload));
  const data = `${headerB64}.${payloadB64}`;
  const key = await getKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return `${data}.${bytesToB64url(new Uint8Array(signature))}`;
}

const PURPOSES: ReadonlySet<string> = new Set<JwtPurpose>([
  "session",
  "magic",
  "receipt",
  "download",
]);

/**
 * Verify signature, expiry, shape, and purpose. Returns null on ANY failure.
 * `opts.purpose` defaults to "session": a magic/receipt/download token is
 * never accepted where a session is expected, and vice versa.
 */
export async function verifyJwt(
  token: string,
  secret: string,
  opts: { purpose?: JwtPurpose } = {}
): Promise<JwtPayload | null> {
  const expectedPurpose: JwtPurpose = opts.purpose ?? "session";
  try {
    if (typeof token !== "string" || !secret) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    if (!headerB64 || !payloadB64 || !sigB64) return null;

    const header = JSON.parse(b64urlDecodeText(headerB64)) as { alg?: unknown; typ?: unknown };
    if (!header || header.alg !== "HS256") return null;

    const data = `${headerB64}.${payloadB64}`;
    const key = await getKey(secret);
    const sig = b64urlToBytes(sigB64);
    if (sig.length !== 32) return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      new TextEncoder().encode(data)
    );
    if (!valid) return null;

    const payload = JSON.parse(b64urlDecodeText(payloadB64)) as Partial<JwtPayload> | null;
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.email !== "string") return null;
    if (payload.name !== undefined && typeof payload.name !== "string") return null;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return null;
    if (typeof payload.jti !== "string" || payload.jti.length === 0) return null;
    if (typeof payload.purpose !== "string" || !PURPOSES.has(payload.purpose)) return null;
    if (payload.purpose !== expectedPurpose) return null;
    if (payload.res !== undefined && typeof payload.res !== "string") return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;

    return payload as JwtPayload;
  } catch {
    return null;
  }
}

export function extractBearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}
