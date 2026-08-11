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

  describe("composite updatedAt (Task 14 review round 2, Fix 1)", () => {
    // src/routes/site.ts builds a single `updatedAt` string out of TWO
    // independent timestamps -- the page's own updated_at and the tenant's
    // (a settings save bumps the latter without touching the former, see
    // task-14-report.md's Fix 1). siteCacheKey itself only ever sees the
    // one already-joined string and applies a single outer
    // encodeURIComponent to it -- it has no idea two values went into it,
    // so injectivity of that join is a property of how site.ts builds the
    // string, not of siteCacheKey. This mirrors that exact construction
    // (`${encodeURIComponent(a)}:${encodeURIComponent(b)}`) so the
    // assertion tracks the real call site, not just a scheme this file
    // makes up in isolation.
    function composeVersion(pageUpdatedAt: string, tenantUpdatedAt: string): string {
      return `${encodeURIComponent(pageUpdatedAt)}:${encodeURIComponent(tenantUpdatedAt)}`;
    }

    it("two different (pageUpdatedAt, tenantUpdatedAt) pairs never produce the same cache key", () => {
      // The adversarial case this guards against: without per-component
      // encoding, a literal ":" inside one of the raw timestamps could let
      // two DIFFERENT pairs concatenate to the SAME joined string --
      // exactly the "a" + "b:c" vs "a:b" + "c" collision shape the
      // pre-existing injectivity test above proves siteCacheKey's own
      // (host, path, version) scheme avoids. Encoding each side before the
      // join is what has to close the same hole one level up, since
      // siteCacheKey can't see the seam once the two pieces are already
      // one string.
      const pairs: [string, string][] = [
        ["2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z"],
        ["2024-01-01T00:00:00Z:2024-01-02T00:00:00Z", ""], // colon-laden page value, empty tenant value
        ["2024-01-01T00:00:00Z", ":2024-01-02T00:00:00Z"], // leading colon on the tenant side
        ["a:b", "c"], // the classic "a" + ":b" + ":c" vs "a:b" + ":" + "c" shape
        ["a", "b:c"],
      ];

      const keys = pairs.map(([page, tenant]) =>
        siteCacheKey("example.com", "/page", composeVersion(page, tenant))
      );

      // Pairwise distinct: no two different (page, tenant) pairs collapse
      // to the same rendered cache key.
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          expect(keys[i]).not.toBe(keys[j]);
        }
      }

      // The specific pair the adversarial comment above calls out by name:
      // ("a:b", "c") must not collide with ("a", "b:c") even though a raw,
      // unencoded concatenation of the form `${page}:${tenant}` would
      // produce the identical string "a:b:c" for both.
      const collisionA = siteCacheKey("example.com", "/page", composeVersion("a:b", "c"));
      const collisionB = siteCacheKey("example.com", "/page", composeVersion("a", "b:c"));
      expect(collisionA).not.toBe(collisionB);
    });

    it("a literal colon in either raw timestamp is percent-encoded before the join, not passed through", () => {
      // Checked on composeVersion's own output, before siteCacheKey's
      // separate outer encodeURIComponent gets a chance to re-encode the
      // whole thing (which it does -- the ":" between the two components
      // is itself just another character to that outer pass, so by the
      // time it reaches the final key even the real separator has become
      // %3A too; that's covered by the injectivity test above, which
      // exercises the actual siteCacheKey output). What matters here is
      // that composeVersion itself never lets a colon INSIDE a raw value
      // masquerade as the separator: "a:b" must become "a%3Ab" (the
      // colon from inside the raw value encoded) joined to "c" by the
      // real ":" separator -- not a bare "a:b:c" where a reader can't
      // tell which colon was the separator.
      expect(composeVersion("a:b", "c")).toBe("a%3Ab:c");
      expect(composeVersion("a", "b:c")).toBe("a:b%3Ac");
      expect(composeVersion("a:b", "c")).not.toBe(composeVersion("a", "b:c"));
    });
  });
});
