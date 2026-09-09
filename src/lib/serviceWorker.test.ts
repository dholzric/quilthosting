// src/lib/serviceWorker.test.ts
//
// public/sw.js decides, per request, between network-first and cache-first.
// Getting a page into the cache-first branch pins whatever version was cached
// first: the site keeps serving the old design at the URL the visitor opened
// before, while a link they had never followed comes fresh off the network.
// That shipped — a tenant site on the platform host (/g/<slug>) matched none
// of the shell paths and was cached as if it were a stylesheet.
//
// The classifier is plain JS in a static file, so these tests read the real
// source, evaluate the `isHtml` expression against representative requests,
// and assert every navigation lands on the network.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SW = readFileSync(path.join(REPO_ROOT, "public/sw.js"), "utf8");

/** The `const isHtml = …;` expression, evaluated against one request. */
function isHtml(pathname: string, mode: string, accept: string): boolean {
  const m = /const isHtml =([\s\S]*?);\n/.exec(SW);
  if (!m) throw new Error("isHtml expression not found in sw.js");
  const req = { mode, headers: { get: (k: string) => (k.toLowerCase() === "accept" ? accept : null) } };
  return new Function("req", "url", `return (${m[1]});`)(req, new URL("https://quilthosting.com" + pathname));
}

const NAV = { mode: "navigate", accept: "text/html,application/xhtml+xml" };
const ASSET = { mode: "no-cors", accept: "text/css,*/*;q=0.1" };

describe("public/sw.js request classification", () => {
  it.each([
    ["/", "the platform home"],
    ["/admin", "the admin shell"],
    ["/portal", "the member portal"],
    ["/docs/", "the docs"],
    ["/g/stitchstudio", "a tenant site home on the platform host"],
    ["/g/stitchstudio/about", "a tenant site page on the platform host"],
    ["/about", "a tenant site page on a tenant host"],
    ["/events/abc123", "a system page"],
  ])("%s is network-first (%s)", (pathname) => {
    expect(isHtml(pathname, NAV.mode, NAV.accept)).toBe(true);
  });

  it("static assets stay cache-first", () => {
    for (const p of ["/qh-site.css", "/qh-site.js", "/icon.svg", "/qh.css"]) {
      expect(isHtml(p, ASSET.mode, ASSET.accept), p).toBe(false);
    }
  });

  it("bumping the classifier without bumping the cache leaves stale pages behind", () => {
    // activate() deletes every cache whose key is not CACHE, so the version
    // string is what evicts pages cached under the old rules.
    expect(SW).toMatch(/const CACHE = "qh-v(\d+)(\.\d+)?";/);
    expect(SW).toContain("keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))");
  });
});
