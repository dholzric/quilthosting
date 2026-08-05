import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { tenantMiddleware } from "./middleware/tenant";
import { runRenewalJob } from "./lib/renewals";

import { authRoutes } from "./routes/auth";
import { tenantRoutes } from "./routes/tenants";
import { levelRoutes } from "./routes/levels";
import { memberRoutes } from "./routes/members";
import { eventRoutes } from "./routes/events";
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

app.get("/", (c) => {
  return c.json({
    name: "QuiltHosting API",
    version: "0.2.0",
    status: "ok",
    environment: c.env.ENVIRONMENT,
    admin: "/admin",
    portal: "/portal",
  });
});

app.get("/admin", (c) => {
  return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>QuiltHosting Admin</title>
<style>body{font-family:system-ui;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.6}
code{background:#f4f0eb;padding:0.15em 0.4em;border-radius:4px}
a{color:#c45c26}</style></head><body>
<h1>QuiltHosting Admin</h1>
<p>Open <code>public/admin.html</code> in your browser for the full admin UI.</p>
<p>API: <a href="/">/</a> · Portal: open <code>public/portal.html?slug=YOUR_SLUG</code></p>
</body></html>`);
});

app.get("/portal", (c) => {
  return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Member Portal</title>
<style>body{font-family:system-ui;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.6}
code{background:#f4f0eb;padding:0.15em 0.4em;border-radius:4px}
a{color:#c45c26}</style></head><body>
<h1>Member Portal</h1>
<p>Open <code>public/portal.html?slug=YOUR_GUILD_SLUG</code> in your browser.</p>
</body></html>`);
});

app.route("/api/webhooks", webhookRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/tenants", tenantRoutes);
app.route("/api/portal", portalRoutes);

const tenantApp = new Hono<{ Bindings: Env }>();
tenantApp.use("*", tenantMiddleware);
tenantApp.route("/levels", levelRoutes);
tenantApp.route("/members", memberRoutes);
tenantApp.route("/events", eventRoutes);
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
