// Single source of truth for "this path belongs to the platform, never to a
// tenant's public site." Consumed by src/middleware/siteGate.ts, which is the
// only place that currently treats this list as a security boundary.
//
// Why this needs to be comprehensive: index.ts's static-asset fallback
// (`app.notFound()` -> `c.env.ASSETS.fetch(c.req.raw)`) serves files out of
// `./public` by PATH ONLY -- it does not look at the Host header at all (see
// `[assets] directory = "./public"` in wrangler.toml). That means if
// siteGate ever lets a request through on a tenant's hostname for a path
// that happens to match a real file under `public/` (docs pages, guild.html,
// index.html, admin.html, ...), that file gets served on the tenant's own
// domain with no password check, regardless of what any *other* downstream
// routing logic (index.ts's own isPlatformPath checks) decides to do with
// it. siteGate is the only checkpoint that actually gates by host, so its
// reserved-path list has to be exhaustive on its own -- it cannot lean on
// downstream code to catch what it misses.
//
// NOT currently wired into index.ts's own isPlatformPath lists (lines
// ~94-103 and ~121-134) -- see the comment above those lists and Task 10's
// fix report for why: this list is deliberately broader (it includes "/g"
// and "/guild" as prefixes, and several exact static files that index.ts's
// lists don't have), and substituting it into index.ts's business-tenant
// branch changes what gets served for paths like "/g/*" and "/guildxyz"
// (they'd fall into the guild-app-shell catch-all at the end of that
// middleware instead of a clean 404 from serveBusinessSite). That's a
// routing regression, not a security one -- but it's a real behavior change
// on a file the P0 plan explicitly flagged as high-risk, so it was reported
// rather than pushed through. See task-10-fix-report.md.
//
// PLATFORM_EXACT_PATHS was originally hand-derived from `ls public/` and
// missed "/privacy.html" and "/terms.html" (round 2 of review caught this
// live: both files exist, both were reachable on a launched tenant's host).
// A hand-maintained list rots the same way index.ts's two lists do, so it's
// no longer trusted on its own -- platformPaths.test.ts reads the actual
// `public/` directory at test time and fails if any top-level entry in it
// isn't covered by `isPlatformOnlyPath` (except the site's own
// qh-site.css/qh-site.js). That test is what should catch the next missed
// file, not another manual audit.

/**
 * Path prefixes that are always platform surfaces. Matched with
 * `path.startsWith(prefix)` against a normalized (slash-collapsed,
 * percent-decoded, lowercased) path. A few of these use a trailing slash
 * deliberately -- "/t/" not "/t", "/g/" not "/g", "/api/" not "/api" -- so a
 * legitimate tenant page slug like "team" or "gallery" or "apiary" can't be
 * accidentally swallowed by an overly short prefix. The rest ("/admin",
 * "/portal", "/docs", "/embed", "/assets", "/guild") intentionally have no
 * trailing slash, matching the same (broader, already-accepted) convention
 * index.ts's own lists use today -- a hypothetical tenant page slug that
 * starts with one of those words gets gated too, which is the safe
 * direction to err in for a site-gate.
 */
export const PLATFORM_PATH_PREFIXES: readonly string[] = [
  "/admin",
  "/portal",
  "/docs",
  "/embed",
  "/api/",
  "/t/",
  "/public/",
  "/g/",
  "/guild",
  "/auth/",
  "/assets",
  "/__",
  "/site-access",
];

/**
 * Exact-match platform paths not already covered by a prefix above --
 * static files that live at the root of `public/` and belong to the
 * platform's own admin/portal/guild/docs surfaces, never to a business
 * tenant's site.
 */
export const PLATFORM_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/qh.css",
  "/sw.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/privacy",
  "/privacy.html",
  "/terms",
  "/terms.html",
  "/index.html",
  "/qh-admin-ext.js",
  "/qh-cal.js",
  "/qh-site-builder.js",
  "/qh-projects.js",
]);

/** True when `path` (already normalized by the caller) is platform-only. */
export function isPlatformOnlyPath(path: string): boolean {
  return (
    PLATFORM_EXACT_PATHS.has(path) ||
    PLATFORM_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}
