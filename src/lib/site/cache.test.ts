import { describe, it, expect } from "vitest";
import { siteCacheKey } from "./cache";

describe("siteCacheKey", () => {
  it("produces a valid absolute URL", () => {
    const key = siteCacheKey("example.com", "/page", "2024-01-01T00:00:00Z");
    expect(() => new Request(key)).not.toThrow();
    expect(key).toMatch(/^https:\/\//);
  });

  it("produces different keys for different updatedAt values", () => {
    const key1 = siteCacheKey("example.com", "/page", "2024-01-01T00:00:00Z");
    const key2 = siteCacheKey("example.com", "/page", "2024-01-02T00:00:00Z");
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different hosts", () => {
    const key1 = siteCacheKey("example.com", "/page", "2024-01-01T00:00:00Z");
    const key2 = siteCacheKey("other.com", "/page", "2024-01-01T00:00:00Z");
    expect(key1).not.toBe(key2);
  });

  it("normalizes paths with and without leading slash to the same key", () => {
    const key1 = siteCacheKey("example.com", "/page", "2024-01-01T00:00:00Z");
    const key2 = siteCacheKey("example.com", "page", "2024-01-01T00:00:00Z");
    expect(key1).toBe(key2);
  });

  it("encodes special characters in host and updatedAt", () => {
    // Test that special URL-breaking characters are encoded
    const keyWithSpaceInUpdatedAt = siteCacheKey("example.com", "/page", "2024-01-01 00:00:00Z");
    const keyWithQuestionMark = siteCacheKey("example.com", "/page", "2024-01-01?param=1");
    const keyWithHash = siteCacheKey("example.com", "/page", "2024-01-01#section");
    const keyWithSlash = siteCacheKey("example.com", "/page", "2024-01-01/version");
    const keyWithSpaceInHost = siteCacheKey("example .com", "/page", "2024-01-01T00:00:00Z");

    // All should be valid URLs
    expect(() => new Request(keyWithSpaceInUpdatedAt)).not.toThrow();
    expect(() => new Request(keyWithQuestionMark)).not.toThrow();
    expect(() => new Request(keyWithHash)).not.toThrow();
    expect(() => new Request(keyWithSlash)).not.toThrow();
    expect(() => new Request(keyWithSpaceInHost)).not.toThrow();

    // Each should be different (encoded differently)
    expect(keyWithSpaceInUpdatedAt).not.toBe(keyWithQuestionMark);
    expect(keyWithQuestionMark).not.toBe(keyWithHash);
  });

  it("produces different keys for empty vs populated updatedAt", () => {
    const keyEmpty = siteCacheKey("example.com", "/page", "");
    const keyPopulated = siteCacheKey("example.com", "/page", "2024-01-01T00:00:00Z");
    expect(keyEmpty).not.toBe(keyPopulated);
  });

  it("encodes empty updatedAt as '0' to prevent collisions", () => {
    const keyEmpty = siteCacheKey("example.com", "/page", "");
    // The key should contain "0" (the safe default for empty updatedAt)
    expect(keyEmpty).toContain("/0");
  });
});
