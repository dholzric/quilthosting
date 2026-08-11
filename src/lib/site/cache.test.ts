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

  it("encodes special characters in host and updatedAt to prevent key injection", () => {
    // Defends against: unencoded special characters that would break the cache key or allow
    // path traversal. A ? or # would truncate the key at query/fragment boundaries (aliasing
    // distinct pages). A / in the host could escape the host segment. A space would fail URL
    // parsing. All must be percent-encoded.

    // Test: host with / (path traversal attack)
    const keyWithSlashInHost = siteCacheKey("evil.com/../other", "/page", "2024-01-01T00:00:00Z");
    expect(keyWithSlashInHost).not.toContain("evil.com/../other");
    expect(keyWithSlashInHost).toContain("%2F"); // / is encoded as %2F
    expect(() => new Request(keyWithSlashInHost)).not.toThrow();

    // Test: host with space
    const keyWithSpaceInHost = siteCacheKey("example .com", "/page", "2024-01-01T00:00:00Z");
    expect(keyWithSpaceInHost).not.toContain(" ");
    expect(keyWithSpaceInHost).toContain("%20"); // space is encoded as %20
    expect(() => new Request(keyWithSpaceInHost)).not.toThrow();

    // Test: updatedAt with ? (query parameter injection, would truncate key)
    const keyWithQuestionMark = siteCacheKey("example.com", "/page", "2024-01-01?param=1");
    expect(keyWithQuestionMark).not.toContain("?");
    expect(keyWithQuestionMark).toContain("%3F"); // ? is encoded as %3F
    expect(() => new Request(keyWithQuestionMark)).not.toThrow();

    // Test: updatedAt with # (fragment injection, would truncate key)
    const keyWithHash = siteCacheKey("example.com", "/page", "2024-01-01#section");
    expect(keyWithHash).not.toContain("#");
    expect(keyWithHash).toContain("%23"); // # is encoded as %23
    expect(() => new Request(keyWithHash)).not.toThrow();

    // Test: updatedAt with / (could escape the version segment)
    const keyWithSlashInUpdatedAt = siteCacheKey("example.com", "/page", "2024-01-01/version");
    expect(keyWithSlashInUpdatedAt).not.toContain("2024-01-01/version");
    expect(keyWithSlashInUpdatedAt).toContain("%2F");
    expect(() => new Request(keyWithSlashInUpdatedAt)).not.toThrow();
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

  it("maintains injectivity: different (host, updatedAt) pairs that could alias do not collide", () => {
    // Defends against: delimiter/encoding gaps that would cause two different (host, updatedAt)
    // pairs to concatenate to the same key. The scheme is injective iff path is the only
    // unencoded segment and always appears last.
    // Example pair: host='a', updatedAt='b/c' vs host='a/b', updatedAt='c'
    // Raw concat without encoding: a + b/c + c == a/b + c + c (collision!)
    // With encoding: a + %2Fb%2Fc + /c != a%2Fb + %23c + /c (no collision, as required)

    const key1 = siteCacheKey("a", "/c", "b/d");
    const key2 = siteCacheKey("a/b", "/c", "d");
    expect(key1).not.toBe(key2);

    const key3 = siteCacheKey("tenant1.com", "/page", "2024-01-01");
    const key4 = siteCacheKey("tenant1.com/tenant2.com", "/page", "2024-01-01");
    expect(key3).not.toBe(key4);

    const key5 = siteCacheKey("host", "/path", "version");
    const key6 = siteCacheKey("host", "/pa", "thversion");
    expect(key5).not.toBe(key6);
  });
});
