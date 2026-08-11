// PLATFORM_EXACT_PATHS was originally hand-derived by eyeballing `ls
// public/` — and missed "/privacy.html" and "/terms.html" (round 2 review
// caught both live and reachable, unauthenticated, on a launched tenant's
// custom domain). A hand-maintained list rots exactly like the two-list
// problem this module exists to avoid. This test replaces "someone
// remembers to re-check `ls public/`" with a mechanical check: read the
// actual `public/` directory at test time, and fail if any top-level entry
// in it isn't covered by `isPlatformOnlyPath` — except the tenant site's
// own rendered assets, which must NOT be swept up into the reserved set.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isPlatformOnlyPath, PLATFORM_PATH_PREFIXES, PLATFORM_EXACT_PATHS } from "./platformPaths";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_DIR = path.join(REPO_ROOT, "public");

/** The launched tenant site's own assets — must stay reachable, never reserved. */
const TENANT_SITE_ASSETS = new Set(["/qh-site.css", "/qh-site.js"]);

describe("isPlatformOnlyPath vs. the real public/ directory", () => {
  const entries = readdirSync(PUBLIC_DIR);

  it("public/ is not empty (sanity check that the directory scan actually ran)", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    const urlPath = `/${entry}`;
    if (TENANT_SITE_ASSETS.has(urlPath)) {
      it(`${urlPath} is the tenant site's own asset — NOT platform-only`, () => {
        expect(isPlatformOnlyPath(urlPath)).toBe(false);
      });
      continue;
    }
    it(`${urlPath} (top-level entry in public/) is platform-only`, () => {
      expect(isPlatformOnlyPath(urlPath)).toBe(true);
    });
  }
});

describe("isPlatformOnlyPath — sanity checks independent of the directory scan", () => {
  it("does not reserve the tenant site's own assets", () => {
    expect(isPlatformOnlyPath("/qh-site.css")).toBe(false);
    expect(isPlatformOnlyPath("/qh-site.js")).toBe(false);
  });

  it("PLATFORM_EXACT_PATHS carries both the extensionless and .html legal-page paths", () => {
    // The specific round-2 finding: /privacy and /terms were reserved, but
    // their .html twins (the actual files in public/) were not.
    expect(PLATFORM_EXACT_PATHS.has("/privacy")).toBe(true);
    expect(PLATFORM_EXACT_PATHS.has("/privacy.html")).toBe(true);
    expect(PLATFORM_EXACT_PATHS.has("/terms")).toBe(true);
    expect(PLATFORM_EXACT_PATHS.has("/terms.html")).toBe(true);
  });

  it("PLATFORM_PATH_PREFIXES is non-empty and every prefix starts with /", () => {
    expect(PLATFORM_PATH_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of PLATFORM_PATH_PREFIXES) {
      expect(prefix.startsWith("/")).toBe(true);
    }
  });
});
