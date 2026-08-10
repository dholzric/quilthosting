import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { APP_VERSION } from "./version";
import { tenantMiddleware } from "./middleware/tenant";
import { verifyJwt, signJwt } from "./lib/auth";
import { requireAuth, requireTenantAccess } from "./middleware/auth";
import { siteGate } from "./middleware/siteGate";
import { runRenewalJob } from "./lib/renewals";
import { runEventReminderJob } from "./lib/eventReminders";
import { runScheduledBlasts } from "./lib/scheduledBlasts";
import { authRoutes } from "./routes/auth";
import { tenantRoutes } from "./routes/tenants";
import { levelRoutes } from "./routes/levels";
import { memberRoutes } from "./routes/members";
import { eventRoutes } from "./routes/events";
import { statsRoutes, paymentRoutes } from "./routes/stats";
import { commsRoutes } from "./routes/comms";
import { teamRoutes } from "./routes/team";
import { pageRoutes } from "./routes/pages";
import { galleryRoutes } from "./routes/galleries";
import { fileRoutes } from "./routes/files";
import { publicRoutes } from "./routes/public";
import { webhookRoutes } from "./routes/webhooks";
import { portalRoutes } from "./routes/portal";
import { billingRoutes } from "./routes/billing";
import { groupRoutes } from "./routes/groups";
import { productRoutes } from "./routes/products";
import { formRoutes } from "./routes/forms";
import { invoiceRoutes } from "./routes/invoices";
import { automationRoutes } from "./routes/automations";
import { forumAdminRoutes } from "./routes/forums";
import { apiKeyRoutes } from "./routes/apiKeys";
import { smsRoutes } from "./routes/sms";
import { chapterRoutes } from "./routes/chapters";
import { v1Routes } from "./routes/v1";
import { outboundWebhookRoutes } from "./routes/outboundWebhooks";
import { qboRoutes } from "./routes/qbo";
import { platformRoutes } from "./routes/platform";
import { domainRoutes } from "./routes/domain";
import { runAutomationJob } from "./lib/automations";
import { processQueuedBlasts } from "./lib/blastSend";
import { generateId } from "./lib/utils/id";
import { getTenantByHost } from "./lib/tenantHost";
import { handleWebhookQueue } from "./consumers/webhookConsumer";
import { sweepOutbox } from "./lib/webhookOutbox";
import { sweepExpired } from "./lib/idempotency";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Tenant-Slug"],
    credentials: true,
  })
);

app.use("*", siteGate);

/**
 * Custom domain / guild subdomain HTML routing.
 * When Host is a tenant host (custom_domain or {slug}.quilthosting.com):
 *   /  → public guild site
 *   /portal → member portal (slug via query if needed)
 * Must run before the platform landing "/" handler.
 */
app.use("*", async (c, next) => {
  const host = c.req.header("host") || "";
  const path = new URL(c.req.url).pathname;
  // Skip API and static tooling
  if (
    path.startsWith("/api/") ||
    path.startsWith("/public/") ||
    path.startsWith("/t/") ||
    path.startsWith("/__") ||
    path.startsWith("/auth/") ||
    path.startsWith("/site-access")
  ) {
    return next();
  }
  const tenant = await getTenantByHost(c.env.DB, host, c.env.APP_URL);
  if (!tenant) return next();

  // Portal: ensure slug query so portal.js finds the tenant
  if (path === "/portal" || path === "/portal.html") {
    const url = new URL(c.req.url);
    if (!url.searchParams.get("slug")) {
      url.searchParams.set("slug", tenant.slug);
      return c.redirect(url.pathname + url.search + url.hash, 302);
    }
    return next();
  }
  // Known platform/admin paths on a tenant host → leave alone
  if (
    path.startsWith("/admin") ||
    path.startsWith("/docs") ||
    path.startsWith("/embed") ||
    path === "/privacy" ||
    path === "/terms" ||
    path === "/qh.css" ||
    path === "/guild" ||
    path === "/guild.html" ||
    path === "/sw.js" ||
    path === "/manifest.webmanifest" ||
    path === "/icon.svg" ||
    path.startsWith("/assets")
  ) {
    return next();
  }
  // /g/* on custom host → strip and use site-root paths
  if (path.startsWith("/g/")) {
    return c.redirect("/" + path.split("/").slice(3).join("/"), 302);
  }
  // Any other path on a tenant host is the public guild multi-page site
  {
    const url = new URL(c.req.url);
    url.pathname = "/guild";
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  }
});

// Landing page for browsers on the platform host; JSON status for API clients
app.get("/", (c) => {
  if (c.req.header("Accept")?.includes("text/html")) {
    // Assets serve index.html at the canonical "/" path
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({
    name: "QuiltHosting API",
    version: APP_VERSION,
    status: "ok",
    environment: c.env.ENVIRONMENT,
    admin: "/admin",
    portal: "/portal",
    api: "/api/v1",
  });
});

// Magic-link landing: exchange the short-lived emailed token for a
// session and hand it to the portal via the URL hash.
app.get("/auth/verify", async (c) => {
  const token = c.req.query("token") || "";
  const slug = c.req.query("slug") || "";
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.html(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Link expired</title>
<style>body{font-family:system-ui;max-width:480px;margin:4rem auto;padding:0 1rem;text-align:center}</style></head>
<body><h2>This sign-in link has expired</h2><p>Please request a new one from the member portal.</p>
<p><a href="/portal${slug ? `?slug=${encodeURIComponent(slug)}` : ""}">Back to the portal</a></p></body></html>`,
      401
    );
  }
  const session = await signJwt(
    { sub: payload.sub, email: payload.email, name: payload.name },
    c.env.JWT_SECRET
  );
  // Native app magic links come back with ?dest=app and hand off via URL scheme
  if (c.req.query("dest") === "app") {
    return c.redirect(
      `quilthosting://auth?token=${session}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}`
    );
  }
  const dest = `/portal${slug ? `?slug=${encodeURIComponent(slug)}` : ""}#ptoken=${session}`;
  return c.redirect(dest);
});

// Public guild multi-page site: /g/:slug and /g/:slug/:pageSlug…
app.get("/g/:slug", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/guild";
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});
app.get("/g/:slug/*", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/guild";
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

// Embeddable widgets for WordPress / external sites (allow framing)
app.get("/embed/:slug/join", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/embed.html";
  url.searchParams.set("type", "join");
  url.searchParams.set("slug", c.req.param("slug"));
  const res = c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  return res.then((r) => {
    const headers = new Headers(r.headers);
    headers.delete("X-Frame-Options");
    headers.set("Content-Security-Policy", "frame-ancestors *");
    return new Response(r.body, { status: r.status, headers });
  });
});
app.get("/embed/:slug/events", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/embed.html";
  url.searchParams.set("type", "events");
  url.searchParams.set("slug", c.req.param("slug"));
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw)).then((r) => {
    const headers = new Headers(r.headers);
    headers.delete("X-Frame-Options");
    headers.set("Content-Security-Policy", "frame-ancestors *");
    return new Response(r.body, { status: r.status, headers });
  });
});
app.get("/embed/:slug/store", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/embed.html";
  url.searchParams.set("type", "store");
  url.searchParams.set("slug", c.req.param("slug"));
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw)).then((r) => {
    const headers = new Headers(r.headers);
    headers.delete("X-Frame-Options");
    headers.set("Content-Security-Policy", "frame-ancestors *");
    return new Response(r.body, { status: r.status, headers });
  });
});

app.get("/api/version", (c) => c.json({ version: APP_VERSION }));
app.route("/api/webhooks", webhookRoutes);

// Email open tracking pixel (1×1 GIF) — exempt from site gate via path check below
const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0)
);
app.get("/t/o/:logId", async (c) => {
  let logId = c.req.param("logId") || "";
  if (logId.endsWith(".gif")) logId = logId.slice(0, -4);
  if (logId && logId.length < 80) {
    try {
      const now = new Date().toISOString();
      await c.env.DB.prepare(
        `UPDATE email_logs SET
           open_count = coalesce(open_count, 0) + 1,
           opened_at = coalesce(opened_at, ?)
         WHERE id = ?`
      )
        .bind(now, logId)
        .run();
    } catch {
      /* pre-migration or missing row */
    }
  }
  return new Response(PIXEL_GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
});

// Email click tracking redirect
app.get("/t/c/:logId", async (c) => {
  const logId = c.req.param("logId") || "";
  const dest = c.req.query("u") || "";
  let safeUrl = "/";
  try {
    const u = new URL(dest);
    if (u.protocol === "http:" || u.protocol === "https:") safeUrl = u.toString();
  } catch {
    /* ignore */
  }
  if (logId && logId.length < 80) {
    try {
      const now = new Date().toISOString();
      await c.env.DB.prepare(
        `UPDATE email_logs SET
           click_count = coalesce(click_count, 0) + 1,
           clicked_at = coalesce(clicked_at, ?)
         WHERE id = ?`
      )
        .bind(now, logId)
        .run();
      await c.env.DB.prepare(
        `INSERT INTO email_clicks (id, email_log_id, url, clicked_at)
         VALUES (?, ?, ?, ?)`
      )
        .bind(generateId(), logId, safeUrl.slice(0, 2000), now)
        .run();
    } catch {
      /* pre-migration */
    }
  }
  return c.redirect(safeUrl, 302);
});

app.route("/api/v1", v1Routes);
app.route("/api/auth", authRoutes);
app.route("/api/platform", platformRoutes);
app.route("/api/tenants", tenantRoutes);
app.route("/api/portal", portalRoutes);

const tenantApp = new Hono<{ Bindings: Env }>();
tenantApp.use("*", requireAuth);
tenantApp.use("*", tenantMiddleware);
tenantApp.use("*", requireTenantAccess);
tenantApp.route("/levels", levelRoutes);
tenantApp.route("/members", memberRoutes);
tenantApp.route("/events", eventRoutes);
tenantApp.route("/stats", statsRoutes);
tenantApp.route("/payments", paymentRoutes);
tenantApp.route("/emails", commsRoutes);
tenantApp.route("/groups", groupRoutes);
tenantApp.route("/team", teamRoutes);
tenantApp.route("/pages", pageRoutes);
tenantApp.route("/files", fileRoutes);
tenantApp.route("/products", productRoutes);
tenantApp.route("/billing", billingRoutes);
tenantApp.route("/forms", formRoutes);
tenantApp.route("/invoices", invoiceRoutes);
tenantApp.route("/automations", automationRoutes);
tenantApp.route("/forum", forumAdminRoutes);
tenantApp.route("/api-keys", apiKeyRoutes);
tenantApp.route("/sms", smsRoutes);
tenantApp.route("/chapters", chapterRoutes);
tenantApp.route("/webhooks", outboundWebhookRoutes);
tenantApp.route("/qbo", qboRoutes);
tenantApp.route("/domain", domainRoutes);
tenantApp.route("/galleries", galleryRoutes);
app.route("/api/tenants/:tenantId", tenantApp);

app.route("/public", publicRoutes);

/** Manual trigger for the daily renewal job. Requires Authorization: Bearer <JWT_SECRET>
 *  or the same value as X-Cron-Secret. Cron trigger does not hit this route. */
function authorizeScheduled(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const secret = c.env.JWT_SECRET;
  if (!secret) return false;
  const bearer = c.req.header("Authorization");
  if (bearer === `Bearer ${secret}`) return true;
  if (c.req.header("X-Cron-Secret") === secret) return true;
  return false;
}

async function runDailyJobs(env: Env) {
  const renewals = await runRenewalJob(env);
  const events = await runEventReminderJob(env);
  const blasts = await runScheduledBlasts(env);
  const automations = await runAutomationJob(env);
  // Drain large queued email blasts (may need multiple cron ticks for 50k)
  const queuedBlasts = await processQueuedBlasts(env);
  // Extra drain passes for big lists within one scheduled invocation
  let extra = 0;
  for (let i = 0; i < 20; i++) {
    const r = await processQueuedBlasts(env);
    extra += r.emails;
    if (r.emails === 0) break;
  }
  // Belongs on the daily cadence, not the one-minute outbox sweep below --
  // idempotency records are retained for RETENTION_HOURS (24h), so a daily
  // pass is more than frequent enough to bound PII retention. sweepExpired
  // is capped at `limit` (500) deletions per call, so a single call is a
  // hard ceiling of 500/day regardless of how many rows are actually
  // expired -- any tenant issuing more than 500 keyed writes/day would
  // accumulate PII-bearing rows forever. Drain in a loop until a pass
  // deletes fewer than the limit (i.e. nothing expired is left), same idiom
  // as the queued-blast extra-passes loop above, with an iteration cap so a
  // pathological backlog cannot spin the cron invocation forever.
  const IDEM_SWEEP_BATCH = 500;
  let idemDeleted = 0;
  for (let i = 0; i < 50; i++) {
    const r = await sweepExpired(env, IDEM_SWEEP_BATCH);
    idemDeleted += r.deleted;
    if (r.deleted < IDEM_SWEEP_BATCH) break;
  }
  const idempotency = { deleted: idemDeleted };
  return {
    renewals,
    events,
    blasts,
    automations,
    queuedBlasts: {
      ...queuedBlasts,
      extra_emails: extra,
    },
    idempotency,
  };
}

app.get("/__scheduled", async (c) => {
  if (!authorizeScheduled(c)) return c.json({ error: "Unauthorized" }, 401);
  const result = await runDailyJobs(c.env);
  console.log("Daily jobs finished", result);
  return c.json({ ok: true, ...result });
});

app.post("/__scheduled", async (c) => {
  if (!authorizeScheduled(c)) return c.json({ error: "Unauthorized" }, 401);
  const result = await runDailyJobs(c.env);
  return c.json({ ok: true, ...result });
});

// With run_worker_first, static assets (admin/portal UIs) are served
// through the Worker so the site gate applies to them too.
app.notFound((c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ error: "Not found" }, 404);
});

/** Cron expression for the outbox sweeper — must match wrangler.toml exactly. */
const SWEEP_CRON = "* * * * *";

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ outboxId: string }>, env: Env) {
    await handleWebhookQueue(batch, env);
  },
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ) {
    // Two schedules share this handler. Branch on the expression so the daily
    // job never runs on the one-minute sweep tick.
    if (event.cron === SWEEP_CRON) {
      ctx.waitUntil(
        sweepOutbox(env).then((r) => {
          if (r.swept) console.log("outbox sweep", r);
        })
      );
      return;
    }
    ctx.waitUntil(
      runDailyJobs(env).then((r) => {
        console.log("Cron daily jobs", r);
      })
    );
  },
};
