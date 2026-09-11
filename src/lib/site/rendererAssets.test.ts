// src/lib/site/rendererAssets.test.ts
//
// A rendered page pulls a handful of files from public/ — the stylesheet, the
// island bundle, and whatever the islands load lazily. On a tenant host the
// site router sees the whole origin, so any of those it does not recognise as
// "not a site route" comes back as the site's own 404 PAGE. The browser then
// refuses to execute HTML as script:
//
//   Refused to execute script from '…/qh-cal.js' because its MIME type
//   ('text/html') is not executable
//
// That is what happened to the calendar: qh-site.js loads /qh-cal.js lazily,
// the first time a calendar section is on the page, so it worked on the
// platform host (assets are served directly there) and 404'd on every tenant
// subdomain and custom domain.
//
// This test reads the real files and fails if the site references something
// the router does not let through.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RENDERER_ASSETS, isRendererAsset, resolveSiteRoute } from "../../routes/site";
import { KITS } from "./kits";
import { kitAssetUrl } from "./kitAssets";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Root-relative .js/.css paths a file asks the browser to fetch. */
function referencedAssets(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/["'`](\/[a-z0-9._-]+\.(?:js|css))["'`]/gi)) out.add(m[1]);
  return [...out];
}

describe("every file a rendered page fetches is served, not routed", () => {
  const sources: [string, string][] = [
    ["public/qh-site.js", read("public/qh-site.js")],
    ["public/qh-signature.js", read("public/qh-signature.js")],
    ["public/qh-cal.js", read("public/qh-cal.js")],
    ["src/lib/site/render.ts", read("src/lib/site/render.ts")],
  ];

  it.each(sources)("%s references nothing the site router would swallow", (name, src) => {
    const missing = referencedAssets(src).filter((a) => !RENDERER_ASSETS.has(a));
    expect(missing, `${name} loads ${missing.join(", ")} — add to RENDERER_ASSETS`).toEqual([]);
  });

  it("resolveSiteRoute hands each one back to the asset binding", () => {
    for (const asset of RENDERER_ASSETS) {
      expect(resolveSiteRoute(asset), asset).toBeNull();
    }
  });

  // The same bug, one class wider: a kit that ships its own artwork renders
  // <img src="/kit-assets/<kit>/<file>">. Those are images, not scripts, so
  // the browser shows a broken picture instead of a console error — quieter,
  // and it lands on the hero of a brand-new guild's home page.
  it("hands every kit's bundled artwork to the asset binding", () => {
    const refs = KITS.flatMap((kit) =>
      (kit.imagery ?? [])
        .map((im) => (typeof im.src === "string" && im.src.startsWith("public/kit-assets/")
          ? `kit-asset:${im.src.slice("public/kit-assets/".length)}`
          : null))
        .filter((r): r is string => r !== null)
    );
    expect(refs.length, "no kit ships bundled artwork — did the kits change?").toBeGreaterThan(0);
    for (const ref of refs) {
      // Every width the renderer can ask for, since 480/960 rewrite the name.
      for (const w of [480, 960, 1600, 2400]) {
        const url = kitAssetUrl(ref, w);
        expect(url, ref).not.toBeNull();
        expect(resolveSiteRoute(url!), `${url} — the tenant host would 404 it`).toBeNull();
      }
    }
  });

  it("does not hand the asset binding anything outside a kit directory", () => {
    for (const path of [
      "/kit-assets/../../etc/passwd",
      "/kit-assets/weekend-house/../../secret.webp",
      "/kit-assets/weekend-house",
      "/kit-assets/weekend-house/nested/hero.webp",
      "/kit-assets/weekend-house/hero.svg",
    ]) {
      expect(isRendererAsset(path), path).toBe(false);
    }
  });

  it("still routes ordinary pages, including ones that look like files", () => {
    expect(resolveSiteRoute("/")).toEqual({ kind: "home" });
    expect(resolveSiteRoute("/about")).toEqual({ kind: "page", slug: "about" });
    // Not ours: a page a guild happened to name this way is still a page.
    expect(resolveSiteRoute("/qh-other.js")).not.toBeNull();
  });
});
