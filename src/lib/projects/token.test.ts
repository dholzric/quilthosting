import { describe, it, expect } from "vitest";
import { mintAccessToken, hashToken } from "./token";

describe("access tokens", () => {
  it("mints a URL-safe token with no padding", () => {
    const t = mintAccessToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).not.toContain("=");
  });

  it("mints at least 32 bytes of entropy", () => {
    // base64url of 32 bytes is 43 chars.
    expect(mintAccessToken().length).toBeGreaterThanOrEqual(43);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintAccessToken()));
    expect(seen.size).toBe(500);
  });

  it("hashes to lowercase hex SHA-256", async () => {
    // Known vector: SHA-256("abc")
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is deterministic and differs per token", async () => {
    const a = mintAccessToken();
    expect(await hashToken(a)).toBe(await hashToken(a));
    expect(await hashToken(a)).not.toBe(await hashToken(mintAccessToken()));
  });
});
