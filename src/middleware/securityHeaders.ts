import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

/**
 * Baseline security headers for every response, including static assets
 * served through the Worker (`run_worker_first`).
 *
 * - nosniff everywhere: uploaded files and tenant content must never be
 *   sniffed into a different (active) type.
 * - Frame protection: DENY unless the handler already declared a
 *   `frame-ancestors` policy (the /embed/* widgets set `frame-ancestors *`
 *   on purpose so guilds can iframe them into WordPress).
 * - HSTS only on HTTPS requests so local dev over http is unaffected.
 *
 * A script-restricting CSP is deliberately NOT set yet: admin.html,
 * portal.html and guild.html are single-file pages with large inline
 * scripts and would need nonces first. Tracked as a follow-up.
 */
export const securityHeaders = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    await next();
    const res = c.res;
    // Responses from ASSETS.fetch / fetch() carry immutable headers.
    const headers = new Headers(res.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(self)"
    );
    const csp = headers.get("Content-Security-Policy") || "";
    if (!/frame-ancestors/i.test(csp)) {
      if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "DENY");
      headers.set(
        "Content-Security-Policy",
        csp ? `${csp}; frame-ancestors 'self'` : "frame-ancestors 'self'"
      );
    }
    if (new URL(c.req.url).protocol === "https:") {
      headers.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains"
      );
    }
    c.res = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
);
