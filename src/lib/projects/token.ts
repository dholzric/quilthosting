// Customer access tokens. The raw token is emailed once and NEVER stored —
// only its SHA-256 — so a database disclosure exposes no customer's quote.
// The consequence is intended: "resend link" mints a fresh token and
// invalidates the previous one, because the old one cannot be recovered.

import { sha256Hex } from "./hash";

const TOKEN_BYTES = 32;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function mintAccessToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** Alias of sha256Hex — kept so token call sites read as what they mean. */
export const hashToken = sha256Hex;
