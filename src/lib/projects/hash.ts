// The single SHA-256 implementation for P1. Both the access-token hash and
// the agreement fingerprint use it. They were briefly specced as separate
// byte-identical copies on the theory that hashing a secret and hashing a
// document might one day diverge; that was speculative, and duplicated
// crypto is a poor thing to speculate with.

/** UTF-8 text to lowercase hex SHA-256. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
