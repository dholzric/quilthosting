/**
 * One-click unsubscribe (RFC 8058) + a tiny confirmation page.
 *
 *   GET  /u/:token  -> plain HTML page with a POST form (mail clients that
 *                      prefetch links must never opt someone out on GET).
 *   POST /u/:token  -> marks members.email_opt_out_at for the tenant+email
 *                      in the token and inserts an `unsubscribe` suppression.
 *                      Also the target of the List-Unsubscribe-Post one-click
 *                      form post (body `List-Unsubscribe=One-Click`).
 *
 * No auth: the HMAC token (see lib/suppression.ts) is the credential. Must be
 * exempt from the site gate (see src/middleware/siteGate.ts). Never loads
 * external assets — must render inside stripped-down mail-client browsers.
 */
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { first } from "../lib/db";
import { optOutMember, suppress, verifyUnsubscribeToken } from "../lib/suppression";

export const unsubscribeRoutes = new Hono<{ Bindings: Env }>();

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(opts: { title: string; body: string }): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(opts.title)}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#faf7f2;color:#221f1a;margin:0;padding:32px 16px}
main{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e7dfd2;border-radius:12px;padding:28px}
h1{font-size:1.3rem;margin:0 0 .5rem}
p{line-height:1.55;margin:.5rem 0}
.muted{color:#8a847a;font-size:.9rem}
button{background:#b5501f;color:#fff;border:0;border-radius:8px;padding:.7rem 1.2rem;font-size:1rem;font-weight:600;cursor:pointer;margin-top:1rem}
</style></head><body><main>${opts.body}</main></body></html>`;
}

async function tenantName(db: D1Database, tenantId: string): Promise<string | null> {
  try {
    const t = await first<{ name: string }>(
      db.prepare(`SELECT name FROM tenants WHERE id = ?`).bind(tenantId)
    );
    return t?.name ?? null;
  } catch {
    return null;
  }
}

function invalid(c: Context<{ Bindings: Env }>) {
  return c.html(
    page({
      title: "Link not valid",
      body: `<h1>This unsubscribe link isn't valid</h1>
<p>The link may have been altered. You can still unsubscribe by replying to the email you received and asking to be removed.</p>`,
    }),
    400
  );
}

unsubscribeRoutes.get("/:token", async (c) => {
  const parsed = await verifyUnsubscribeToken(c.env.JWT_SECRET, c.req.param("token"));
  if (!parsed) return invalid(c);
  const name = (await tenantName(c.env.DB, parsed.tenantId)) || "this guild";
  return c.html(
    page({
      title: "Unsubscribe",
      body: `<h1>Unsubscribe from ${esc(name)} emails?</h1>
<p><strong>${esc(parsed.email)}</strong> will stop receiving newsletters and announcements from ${esc(name)}.</p>
<p class="muted">You'll still get receipts, sign-in links and membership notices tied to your account.</p>
<form method="POST" action="">
  <input type="hidden" name="confirm" value="1">
  <button type="submit">Unsubscribe</button>
</form>`,
    })
  );
});

unsubscribeRoutes.post("/:token", async (c) => {
  const parsed = await verifyUnsubscribeToken(c.env.JWT_SECRET, c.req.param("token"));
  if (!parsed) return invalid(c);

  // Body is either the RFC 8058 `List-Unsubscribe=One-Click` form or our own
  // confirm form; either way, this POST is the consent. Read + discard.
  try {
    await c.req.text();
  } catch {
    /* ignore */
  }

  const ua = c.req.header("user-agent") || "";
  let ok = true;
  try {
    await optOutMember(c.env.DB, parsed.tenantId, parsed.email);
    await suppress(c.env.DB, {
      tenantId: parsed.tenantId,
      email: parsed.email,
      reason: "unsubscribe",
      scope: "marketing",
      source: `unsubscribe:${ua.slice(0, 120)}`,
    });
  } catch (e) {
    console.error("unsubscribe write failed", e);
    ok = false;
  }

  if (!ok) {
    return c.html(
      page({
        title: "Something went wrong",
        body: `<h1>We couldn't process that</h1><p>Please try the link again in a few minutes.</p>`,
      }),
      500
    );
  }

  const name = (await tenantName(c.env.DB, parsed.tenantId)) || "this guild";
  return c.html(
    page({
      title: "Unsubscribed",
      body: `<h1>You're unsubscribed</h1>
<p><strong>${esc(parsed.email)}</strong> won't receive newsletters or announcements from ${esc(name)} any more.</p>
<p class="muted">Changed your mind? Sign in to the member portal and update your email preferences, or ask a guild administrator.</p>`,
    })
  );
});
