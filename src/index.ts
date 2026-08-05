import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { tenantMiddleware } from "./middleware/tenant";
import { siteGate } from "./middleware/siteGate";
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

app.use("*", siteGate);

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
