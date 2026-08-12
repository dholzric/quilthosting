// src/lib/credentials.test.ts
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./credentials";

// 32 random bytes, base64. Test-only value, never used anywhere real.
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", async () => {
    const { ciphertext, iv } = await encryptSecret(KEY, "sk_paypal_example");
    expect(await decryptSecret(KEY, ciphertext, iv)).toBe("sk_paypal_example");
  });

  it("produces a different iv and ciphertext each time", async () => {
    const a = await encryptSecret(KEY, "same");
    const b = await encryptSecret(KEY, "same");
    expect(Buffer.from(a.iv).toString("hex")).not.toBe(Buffer.from(b.iv).toString("hex"));
    expect(Buffer.from(a.ciphertext).toString("hex")).not.toBe(
      Buffer.from(b.ciphertext).toString("hex"),
    );
  });

  it("fails to decrypt under the wrong key", async () => {
    const { ciphertext, iv } = await encryptSecret(KEY, "secret");
    const wrong = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
    await expect(decryptSecret(wrong, ciphertext, iv)).rejects.toThrow();
  });

  it("fails loudly when the key is missing", async () => {
    await expect(encryptSecret("", "x")).rejects.toThrow(/CREDENTIAL_KEY/);
  });

  it("fails loudly when the key is the wrong length", async () => {
    const short = Buffer.from(new Uint8Array(16).fill(1)).toString("base64");
    await expect(encryptSecret(short, "x")).rejects.toThrow(/32 bytes/);
  });

  it("rejects tampered ciphertext rather than returning garbage", async () => {
    const { ciphertext, iv } = await encryptSecret(KEY, "secret");
    ciphertext[0] ^= 0xff;
    await expect(decryptSecret(KEY, ciphertext, iv)).rejects.toThrow();
  });
});
