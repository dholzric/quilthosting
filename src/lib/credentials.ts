// src/lib/credentials.ts
// Per-tenant third-party secrets, AES-GCM encrypted under a Worker secret.
//
// Only PayPal needs this: Stripe Connect never gives us a secret to hold, so
// tenants.stripe_account_id stays a plain column. Values are write-only from
// the API's perspective — nothing ever reads a secret back out to a client.

import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";

async function importKey(keyB64: string): Promise<CryptoKey> {
  if (!keyB64) {
    throw new Error("CREDENTIAL_KEY is not configured");
  }
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(keyB64), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error("CREDENTIAL_KEY is not valid base64");
  }
  if (raw.length !== 32) {
    throw new Error("CREDENTIAL_KEY must decode to 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  keyB64: string,
  plaintext: string
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ciphertext: new Uint8Array(buf), iv };
}

export async function decryptSecret(
  keyB64: string,
  ciphertext: Uint8Array,
  iv: Uint8Array
): Promise<string> {
  const key = await importKey(keyB64);
  // Throws on tamper or wrong key — AES-GCM is authenticated, so a failure
  // here means the data is untrustworthy, not that it needs a fallback.
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(buf);
}

export async function putCredential(
  env: Env,
  tenantId: string,
  provider: string,
  key: string,
  value: string
): Promise<void> {
  const { ciphertext, iv } = await encryptSecret(env.CREDENTIAL_KEY || "", value);
  await env.DB.prepare(
    `INSERT INTO tenant_credentials (id, tenant_id, provider, key, ciphertext, iv)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, provider, key)
     DO UPDATE SET ciphertext = excluded.ciphertext,
                   iv = excluded.iv,
                   updated_at = datetime('now')`
  )
    .bind(generateId(), tenantId, provider, key, ciphertext, iv)
    .run();
}

export async function getCredential(
  env: Env,
  tenantId: string,
  provider: string,
  key: string
): Promise<string | null> {
  const row = await first<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }>(
    env.DB.prepare(
      `SELECT ciphertext, iv FROM tenant_credentials
       WHERE tenant_id = ? AND provider = ? AND key = ?`
    ).bind(tenantId, provider, key)
  );
  if (!row) return null;
  return decryptSecret(
    env.CREDENTIAL_KEY || "",
    new Uint8Array(row.ciphertext),
    new Uint8Array(row.iv)
  );
}

export async function listCredentialStatus(
  env: Env,
  tenantId: string,
  provider: string
): Promise<{ key: string; configured: boolean; updated_at: string }[]> {
  const rows = await all<{ key: string; updated_at: string }>(
    env.DB.prepare(
      `SELECT key, updated_at FROM tenant_credentials
       WHERE tenant_id = ? AND provider = ? ORDER BY key`
    ).bind(tenantId, provider)
  );
  return rows.map((r) => ({ key: r.key, configured: true, updated_at: r.updated_at }));
}

export async function clearCredential(
  env: Env,
  tenantId: string,
  provider: string,
  key: string
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM tenant_credentials WHERE tenant_id = ? AND provider = ? AND key = ?`
  )
    .bind(tenantId, provider, key)
    .run();
}
