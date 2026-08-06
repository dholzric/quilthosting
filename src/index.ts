import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { tenantMiddleware } from "./middleware/tenant";
import { verifyJwt, signJwt } from "./lib/auth";
import { requireAuth, requireTenantAccess } from "./middleware/auth";
import { siteGate } from "./middleware/siteGate";
import { runRenewalJob } from "./lib/renewals";

import { authRoutes } from "./routes/auth";
import { tenantRoutes } from "./routes/tenants";
import { levelRoutes } from "./routes/levels";
import { memberRoutes } from "./routes/members";
import { eventRoutes } from "./routes/events";
import { statsRoutes, paymentRoutes } from "./routes/stats";
import { commsRoutes } from "./routes/comms";
import { teamRoutes } from "./routes/team";
import { pageRoutes } from "./routes/pages";
import { fileRoutes } from "./routes/files";
import { publicRoutes } from "./routes/public";
import { webhookRoutes } from "./routes/webhooks";
import { portalRoutes } from "./routes/portal";

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

// Landing page for browsers; JSON status for API clients
app.get("/", (c) => {
  if (c.req.header("Accept")?.includes("text/html")) {
    // Assets serve index.html at the canonical "/" path
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({
    name: "QuiltHosting API",
    version: "0.9.0",
    status: "ok",
    environment: c.env.ENVIRONMENT,
    admin: "/admin",
    portal: "/portal",
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
  const dest = `/portal${slug ? `?slug=${encodeURIComponent(slug)}` : ""}#ptoken=${session}`;
  return c.redirect(dest);
});

// Public guild page: /g/:slug — static shell reads the slug client-side
app.get("/g/:slug", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/guild"; // canonical asset path for guild.html
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

app.route("/api/webhooks", webhookRoutes);
app.route("/api/auth", authRoutes);
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
tenantApp.route("/team", teamRoutes);
tenantApp.route("/pages", pageRoutes);
tenantApp.route("/files", fileRoutes);
app.route("/api/tenants/:tenantId", tenantApp);

app.route("/public", publicRoutes);

app.get("/__scheduled", async (c) => {
  const result = await runRenewalJob(c.env);
  console.log("Renewal job finished", result);
  return c.json({ ok: true, ...result });
});

app.post("/__scheduled", async (c) => {
  const result = await runRenewalJob(c.env);
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

export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(
      runRenewalJob(env).then((r) => {
        console.log("Cron renewal job", r);
      })
    );
  },
};
