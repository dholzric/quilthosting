// src/routes/reports.ts
// Mounted at /api/tenants/:tenantId/reports (see src/index.ts). Role access
// comes from the "reports" area in src/lib/permissions.ts: everyone who can
// read the tenant reads the trends; only owner/admin writes the monthly
// board-report toggle.
import { Hono } from "hono";
import { z } from "zod";
import type { Env, TenantVariables } from "../types";
import {
  parseMonths,
  reportRange,
  loadReportSummary,
  readReportSettings,
} from "../lib/reports";

export const reportRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

/**
 * GET /api/tenants/:tenantId/reports/summary?months=6|12|24
 *
 * Member growth, renewal and churn, revenue by month and by source, and event
 * attendance for a trailing window — the whole thing in ONE `DB.batch(...)`
 * (see the comment at the top of src/lib/reports.ts). This is the endpoint
 * behind the Reports screen's sparklines; it is deliberately JSON and not a
 * CSV, because "export it and open a spreadsheet" is the gap this replaces.
 */
reportRoutes.get("/summary", async (c) => {
  const tenant = c.get("tenant");
  const months = parseMonths(c.req.query("months"));
  const range = reportRange(new Date(), months);
  try {
    const summary = await loadReportSummary(c.env.DB, tenant.id, range, {
      monthlyEmail: readReportSettings(tenant.settings_json).monthly,
    });
    return c.json(summary);
  } catch (e) {
    console.error("reports summary failed", { tenantId: tenant.id, error: String(e) });
    return c.json({ error: "Could not build the report" }, 500);
  }
});

const settingsSchema = z.object({ monthly: z.boolean() });

/**
 * PATCH /api/tenants/:tenantId/reports/settings — "Email me this monthly".
 *
 * A narrow read-modify-write of `settings.reports.monthly` rather than a
 * PATCH of the whole tenant: the tenant-level PATCH replaces the entire
 * settings object, so a screen that only wants to flip one switch would race
 * every other settings writer.
 */
reportRoutes.patch("/settings", async (c) => {
  const tenant = c.get("tenant");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "monthly must be true or false",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400
    );
  }

  let settings: Record<string, unknown> = {};
  try {
    const parsedSettings = JSON.parse(tenant.settings_json || "{}");
    if (parsedSettings && typeof parsedSettings === "object" && !Array.isArray(parsedSettings)) {
      settings = parsedSettings as Record<string, unknown>;
    }
  } catch {
    /* unparsable settings: start from an empty object rather than 500 */
  }
  const existing = settings.reports;
  const reports =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  reports.monthly = parsed.data.monthly;
  settings.reports = reports;

  await c.env.DB.prepare("UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(settings), new Date().toISOString(), tenant.id)
    .run();

  return c.json({ ok: true, monthly: parsed.data.monthly });
});
