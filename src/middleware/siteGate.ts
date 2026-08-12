import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { extractBearer, verifyJwt } from "../lib/auth";
import { getTenantByHost } from "../lib/tenantHost";
import { isLaunched } from "../lib/tenantType";
import { isPlatformOnlyPath } from "../lib/platformPaths";

/**
 * Private-beta gate: the whole site requires a shared password
 * (SITE_ACCESS_PASSWORD secret) before anything is served.
 *
 * Uses a signed HttpOnly cookie instead of HTTP Basic auth so the
 * admin/portal pages can keep using Authorization: Bearer for the API.
 *
 * Exempt: /api/webhooks/*, /t/o/* (open pixels), /robots.txt, OPTIONS.
 * Stealth by default: requires SITE_ACCESS_PASSWORD in production.
 * Open only when ENVIRONMENT=development and password is unset.
 */

const COOKIE_NAME = "qh_site";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function gateToken(env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`site-gate:${env.SITE_ACCESS_PASSWORD}`)
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  // Only same-origin relative paths (block //evil.com and external URLs)
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.startsWith("/site-access")) return "/";
  return raw.slice(0, 500);
}

/**
 * Normalize a path before it is matched against the launched-site allowlist
 * or the platform-reserved-prefix list. Obfuscation tricks that all evade a
 * naive `path.startsWith(...)` / `path === ...` check unless this runs
 * first: repeated slashes ("//admin"), percent-encoding ("/%61dmin"), case
 * ("/Admin", "/ADMIN"), and dot-segments introduced BY decoding
 * ("/x/..%2f..%2fadmin.html", "/img/..%2fadmin").
 *
 * Dot-segments already present in the raw request path ("/./admin",
 * "/foo/../admin") are NOT handled here -- the WHATWG URL parser that
 * produced `c.req.url` already collapsed those before siteGate ever saw the
 * path (verified directly in siteGate.test.ts, "dot-segments are
 * pre-collapsed by the URL parser"). But that collapse runs once, before
 * this function's `decodeURIComponent` call -- a dot-segment that only
 * exists AFTER decoding was never seen by the URL parser and is not
 * collapsed by anything. siteGate is the only host-based checkpoint in this
 * app (see ../lib/platformPaths.ts's header comment) and cannot assume
 * `ASSETS.fetch` or any other downstream code will also normalize this, so
 * any ".", ".." segment surviving decode fails closed here rather than
 * being re-resolved and matched leniently.
 *
 * Also rejects (fails closed on) a decoded result that still contains a
 * literal "%" -- e.g. "%252e" decodes in one pass to "%2e", not ".". That
 * covers double-encoding without a second `decodeURIComponent` pass, which
 * would itself be a bypass ("%252f" -> "%2f" -> a second decode would turn
 * it into "/", reintroducing exactly the slash-collapse this function is
 * supposed to close).
 *
 * Returns `null` on any of the above instead of throwing or silently
 * matching -- the caller must treat `null` as "does not match anything on
 * the allowlist," i.e. fail closed, never as "matches everything."
 */
function normalizePathForGate(rawPath: string): string | null {
  let path = rawPath.replace(/\/{2,}/g, "/");
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  // Decoding can introduce new "//" (e.g. "%2F%2F"); collapse once more.
  path = path.replace(/\/{2,}/g, "/");
  const lower = path.toLowerCase();
  // A leftover "%" after one decode pass means double-encoding (or some
  // other percent-sign-producing input) -- refuse it rather than decode
  // again.
  if (lower.includes("%")) return null;
  // A "." or ".." path segment that decoding just produced was never
  // collapsed by the URL parser. Reject it outright rather than try to
  // resolve it ourselves.
  if (lower.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return lower;
}

/**
 * Task 14's tenant image route shape: `/img/<opaque id>`. Matched against
 * the already-lowercased normalized path, so this only ever tests a
 * lowercase charset -- NOT a fail-closed narrowing. `/img/ABC` normalizes
 * to `/img/abc`, which DOES match, and the gate opens for it. Whether that
 * is correct depends on whether Task 14's actual image ids are
 * case-sensitive: if they are, an uppercase-vs-lowercase id collision would
 * let this rule match an id string that isn't the exact one requested. Not
 * a problem today (this route doesn't exist yet), but Task 14 needs to
 * either make ids case-insensitive-safe or add real case-sensitive matching
 * here when it lands -- don't copy this regex assuming lowercasing already
 * makes it conservative.
 */
const TENANT_IMAGE_PATH_RE = /^\/img\/[a-z0-9_-]{1,64}$/;

/**
 * Allowlist for a launched business tenant's own hostname: everything a
 * launched site actually serves, and nothing else. This is the inverse of a
 * denylist on purpose -- a route added to the platform in the future is
 * gated by default here unless someone deliberately extends this function,
 * rather than silently exposed because nobody remembered to add it to a
 * blocklist. See `../lib/platformPaths.ts` for why the reserved-prefix set
 * has to be exhaustive on its own.
 */
export function isLaunchedSitePath(rawPath: string, tenantSlug: string): boolean {
  const path = normalizePathForGate(rawPath);
  if (path === null) return false; // malformed escape: fail closed

  // 1. robots.txt / sitemap.xml — serveBusinessSite's own permissive versions.
  if (path === "/robots.txt" || path === "/sitemap.xml") return true;

  // 2. The renderer's own static assets.
  if (path === "/qh-site.css" || path === "/qh-site.js") return true;

  // 3. Tenant image route (Task 14).
  if (TENANT_IMAGE_PATH_RE.test(path)) return true;

  // 4. /public/<this tenant's own slug>/... — qh-site.js hydrates events,
  //    store, and the contact form against these. Scoped to the resolved,
  //    launched tenant's own slug ONLY: another tenant's slug here must fall
  //    through to the reserved-prefix check below and stay gated, or a
  //    launched host would become an open read (and unauthenticated write:
  //    /join, /donate, /cart/checkout) proxy for every OTHER tenant too.
  //    A trailing "/" on the comparison prefix is load-bearing: without it,
  //    "/public/<slug>x/..." or "/public/<slug>-other/..." (some OTHER
  //    tenant whose slug happens to start with this one's) would pass a bare
  //    `.startsWith(`/public/${slug}`)` check. Covered by
  //    siteGate.test.ts's "rule 4 boundary" cases.
  //
  //    Depends on `tenantSlug` (and every stored `tenants.slug`) already
  //    being lowercase -- `.toLowerCase()` here only normalizes the
  //    REQUEST path, not what it's compared against being wrong-cased in
  //    the first place. Slugs are forced to `[a-z0-9-]` at creation
  //    (src/routes/tenants.ts:55, `body.slug.toLowerCase().replace(...)`);
  //    if that ever changes, this comparison needs to lowercase `slug` too
  //    (it already does, defensively) AND something would need to stop a
  //    mixed-case slug from colliding with another tenant's lowercased one.
  const slug = (tenantSlug || "").toLowerCase();
  if (slug && (path === `/public/${slug}` || path.startsWith(`/public/${slug}/`))) {
    return true;
  }

  // 5. The site's own pages: "/" and any slug that isn't a reserved
  //    platform prefix (checked last, after the more specific allow rules
  //    above so "/public/<own-slug>/..." doesn't get caught by the general
  //    "/public/" reservation).
  if (path === "/") return true;
  return !isPlatformOnlyPath(path);
}

function loginPage(error?: string, returnTo?: string): string {
  const next = safeReturnPath(returnTo);
  const nextAttr = next
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Private preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600&display=swap">
<style>
body{font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#faf7f2;color:#221f1a}
form{background:#fff;padding:2.25rem 2.25rem 1.75rem;border-radius:16px;border:1px solid #e7dfd2;box-shadow:0 2px 4px rgba(34,31,26,.05),0 16px 48px -12px rgba(34,31,26,.18);width:320px;box-sizing:border-box}
h1{font-family:Fraunces,Georgia,serif;font-size:1.35rem;margin:0 0 .25rem;letter-spacing:-.01em}
h1 .t{color:#b5501f}
p.sub{color:#8a847a;font-size:.85rem;margin:0 0 1.1rem}
input,button{width:100%;padding:.65rem .8rem;margin-top:.5rem;box-sizing:border-box;border-radius:8px;border:1px solid #d6cbb8;font-size:.95rem;font-family:inherit}
input:focus{outline:none;border-color:#b5501f;box-shadow:0 0 0 3px #f7e8de}
button{background:#b5501f;color:#fff;border:none;cursor:pointer;font-weight:600}
button:hover{background:#9a431a}
p.err{color:#b3261e;font-size:.85rem;margin:.5rem 0 0}
.strip{display:flex;height:5px;border-radius:3px;overflow:hidden;margin-top:1.4rem}
.strip span{flex:1}
</style></head><body>
<form method="POST" action="/site-access">
<h1><span class="t">✦</span> QuiltHosting</h1>
<p class="sub">Private preview — enter the access password.</p>
${error ? `<p class="err">${error}</p>` : ""}
<input type="hidden" name="return_to" value="${nextAttr}">
<input type="password" name="password" placeholder="Access password" autofocus>
<button type="submit">Enter</button>
<div class="strip"><span style="background:#b5501f"></span><span style="background:#d9a441"></span><span style="background:#5f7d64"></span><span style="background:#5b7ea3"></span><span style="background:#8c5a74"></span></div>
</form></body></html>`;
}

export const siteGate = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const path = new URL(c.req.url).pathname;

    if (path.startsWith("/api/webhooks/")) return next();

    // Per-tenant launch: a launched business tenant's own hostname serves its
    // public site without the gate, while the platform stays in stealth.
    //
    // Two invariants, both load-bearing:
    //   1. The exemption keys off the RESOLVED TENANT, never off a path. No
    //      path prefix may open the gate on a platform host — the tenant is
    //      always resolved from the Host header FIRST, and the path is only
    //      ever checked against that specific resolved (and launched)
    //      tenant's allowlist, never in isolation.
    //   2. isLaunchedSitePath is an ALLOWLIST, not a denylist: only the exact
    //      surface a launched site actually serves (robots.txt, sitemap.xml,
    //      its own qh-site.css/js, /img/<id>, /public/<its own slug>/..., and
    //      its own pages) opens the gate. /admin, /portal, /docs, /public/
    //      <another tenant's slug>, and every other platform route fall
    //      through to the password gate below — including on a launched
    //      tenant's own custom domain — because they are simply absent from
    //      the allowlist, not because of a separate denylist that has to be
    //      kept in sync with every new platform route.
    const gateHost = c.req.header("host") || "";
    if (gateHost) {
      try {
        const hostTenant = await getTenantByHost(c.env.DB, gateHost, c.env.APP_URL);
        if (
          hostTenant &&
          isLaunched(hostTenant) &&
          isLaunchedSitePath(path, hostTenant.slug)
        ) {
          return next();
        }
      } catch {
        // A DB failure must not open the gate. Fall through to the password.
      }
    }

    // Native apps can't hold the gate cookie. A valid session JWT is itself
    // proof of access — the gate hides the product from the public, it is not
    // a second authentication layer for users who are already signed in.
    const bearer = extractBearer(c.req.header("Authorization"));
    if (bearer && (await verifyJwt(bearer, c.env.JWT_SECRET))) return next();

    // Auth endpoints must stay reachable so an app can obtain that token in
    // the first place (they expose no guild content and are rate limited).
    if (path.startsWith("/api/auth/")) return next();
    if (path.startsWith("/t/o/")) return next(); // open-tracking pixels
    if (path.startsWith("/t/c/")) return next(); // click-tracking redirects
    if (path.startsWith("/api/v1/")) return next(); // public API keys (own auth)
    // Cloudflare for SaaS / ACME certificate + hostname ownership challenges
    if (path.startsWith("/.well-known/")) return next();
    if (c.req.method === "OPTIONS") return next();
    // Always deny crawlers while the product is in stealth / private preview
    if (path === "/robots.txt") {
      return c.text("User-agent: *\nDisallow: /\n");
    }

    if (!c.env.SITE_ACCESS_PASSWORD) {
      // Local dev only without a password; production must set the secret
      if (c.env.ENVIRONMENT === "development") return next();
      return c.text("Site access is not configured", 503);
    }

    const expected = await gateToken(c.env);

    if (c.req.method === "POST" && path === "/site-access") {
      const form = await c.req.formData();
      const returnTo = safeReturnPath(String(form.get("return_to") || "/"));
      if (form.get("password") === c.env.SITE_ACCESS_PASSWORD) {
        c.header(
          "Set-Cookie",
          `${COOKIE_NAME}=${expected}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`
        );
        return c.redirect(returnTo || "/admin");
      }
      return c.html(loginPage("Wrong password.", returnTo), 401);
    }

    if (getCookie(c.req.header("Cookie"), COOKIE_NAME) === expected) {
      return next();
    }

    // Browsers get the login form; API clients get JSON
    if (c.req.header("Accept")?.includes("text/html")) {
      const returnTo = path + (new URL(c.req.url).search || "");
      return c.html(loginPage(undefined, returnTo), 401);
    }
    return c.json({ error: "Site access required" }, 401);
  }
);
