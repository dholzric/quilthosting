import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

/**
 * Private-beta gate: the whole site requires a shared password
 * (SITE_ACCESS_PASSWORD secret) before anything is served.
 *
 * Uses a signed HttpOnly cookie instead of HTTP Basic auth so the
 * admin/portal pages can keep using Authorization: Bearer for the API.
 *
 * Exempt: /api/webhooks/* (Stripe must reach it; it verifies its own
 * signatures), /robots.txt, and CORS preflights. Fails closed in
 * production when the secret is missing.
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
<title>Private</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#faf8f5}
form{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.1);width:280px}
input,button{width:100%;padding:.6rem;margin-top:.5rem;box-sizing:border-box;border-radius:6px;border:1px solid #ccc}
button{background:#c45c26;color:#fff;border:none;cursor:pointer}
p.err{color:#b00;font-size:.85rem}</style></head><body>
<form method="POST" action="/site-access">
<strong>This site is private.</strong>
${error ? `<p class="err">${error}</p>` : ""}
<input type="password" name="password" placeholder="Access password" autofocus>
<button type="submit">Enter</button>
</form></body></html>`;
}

export const siteGate = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const path = new URL(c.req.url).pathname;

    if (path.startsWith("/api/webhooks/")) return next();
    if (c.req.method === "OPTIONS") return next();
    if (path === "/robots.txt") {
      return c.text("User-agent: *\nDisallow: /\n");
    }

    if (!c.env.SITE_ACCESS_PASSWORD) {
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
