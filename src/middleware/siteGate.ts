import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

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

function loginPage(error?: string): string {
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
<input type="password" name="password" placeholder="Access password" autofocus>
<button type="submit">Enter</button>
<div class="strip"><span style="background:#b5501f"></span><span style="background:#d9a441"></span><span style="background:#5f7d64"></span><span style="background:#5b7ea3"></span><span style="background:#8c5a74"></span></div>
</form></body></html>`;
}

export const siteGate = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const path = new URL(c.req.url).pathname;

    if (path.startsWith("/api/webhooks/")) return next();
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
      if (form.get("password") === c.env.SITE_ACCESS_PASSWORD) {
        c.header(
          "Set-Cookie",
          `${COOKIE_NAME}=${expected}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`
        );
        return c.redirect("/admin");
      }
      return c.html(loginPage("Wrong password."), 401);
    }

    if (getCookie(c.req.header("Cookie"), COOKIE_NAME) === expected) {
      return next();
    }

    // Browsers get the login form; API clients get JSON
    if (c.req.header("Accept")?.includes("text/html")) {
      return c.html(loginPage(), 401);
    }
    return c.json({ error: "Site access required" }, 401);
  }
);
