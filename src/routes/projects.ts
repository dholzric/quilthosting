// Owner admin API for longarm projects: list/view/edit, replace estimate
// lines, and resend the customer's access link. The status machine is
// enforced here via assertTransition — an illegal transition is a 409
// conflict with current state, not a 500. Every query touching `projects`
// is scoped `WHERE tenant_id = ?`; this is the only thing standing between
// tenants (see src/routes/projects.test.ts's tenant-scoping test).
//
// POST /:projectId/send-estimate is NOT implemented here despite being
// listed in the Task 6 brief's "Produces" line — the brief's own Step 3
// (and its trailing note) says the email helper and customer-record
// matching rule live in Task 7, and Step 3's reference implementation does
// not include it. Deferred accordingly.

import { Hono } from "hono";
import type { Env, Project, ProjectLine, TenantVariables, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { assertTransition } from "../lib/projects/status";
import { mintAccessToken, hashToken } from "../lib/projects/token";
import type { ProjectStatus } from "../lib/projects/types";

export const projectRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

/** Same guard as src/routes/domain.ts:23 — owner|admin|platform, not any role. */
async function requireOwnerAdmin(c: {
  get: (k: "tenantRole") => string;
}): Promise<Response | null> {
  const role = c.get("tenantRole");
  if (!["owner", "admin", "platform"].includes(role)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

// GET /api/tenants/:tenantId/projects?status=&type=
projectRoutes.get("/", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const status = c.req.query("status");
  const type = c.req.query("type");
  let sql = `SELECT * FROM projects WHERE tenant_id = ?`;
  const binds: string[] = [tenant.id];
  if (status) { sql += ` AND status = ?`; binds.push(status); }
  if (type) { sql += ` AND project_type = ?`; binds.push(type); }
  sql += ` ORDER BY created_at DESC LIMIT 500`;
  const rows = await all<Project>(c.env.DB.prepare(sql).bind(...binds));
  return c.json(rows);
});

// GET /api/tenants/:tenantId/projects/:projectId
projectRoutes.get("/:projectId", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(
      `SELECT * FROM projects WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);
  const lines = await all<ProjectLine>(
    c.env.DB.prepare(
      `SELECT * FROM project_lines WHERE project_id = ? ORDER BY sort_order`
    ).bind(project.id)
  );
  // access_token_hash is never returned to the browser: it is the lookup key
  // for the customer's link, and the admin UI has no use for it.
  const { access_token_hash: _omit, ...safe } = project;
  return c.json({ project: safe, lines });
});

// PATCH /api/tenants/:tenantId/projects/:projectId
projectRoutes.patch("/:projectId", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(
      `SELECT * FROM projects WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);

  type PatchBody = {
    status?: ProjectStatus;
    estimate_notes?: string;
    due_date?: string | null;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string | null;
  };
  const body = await c.req.json<PatchBody>().catch(() => ({}) as PatchBody);

  if (body.status && body.status !== project.status) {
    try {
      assertTransition(project.status as ProjectStatus, body.status);
    } catch (err) {
      // 409, not 500: an illegal transition is a conflict with current state,
      // not a server fault.
      return c.json({ error: (err as Error).message }, 409);
    }
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE projects SET
       status = coalesce(?, status),
       estimate_notes = coalesce(?, estimate_notes),
       due_date = coalesce(?, due_date),
       customer_name = coalesce(?, customer_name),
       customer_email = coalesce(?, customer_email),
       customer_phone = coalesce(?, customer_phone),
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.status ?? null,
      body.estimate_notes ?? null,
      body.due_date ?? null,
      body.customer_name ?? null,
      body.customer_email ?? null,
      body.customer_phone ?? null,
      body.status ?? "",
      now,
      now,
      project.id,
      tenant.id
    )
    .run();

  return c.json({ ok: true });
});

// PUT /api/tenants/:tenantId/projects/:projectId/lines — replace all lines
projectRoutes.put("/:projectId/lines", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(
      `SELECT * FROM projects WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json<{
    lines?: {
      kind?: string;
      description?: string;
      quantity?: number;
      unit_cents?: number;
      amount_cents?: number;
    }[];
  }>().catch(() => ({ lines: [] }));

  const lines = (body.lines || []).slice(0, 100).map((l, i) => ({
    id: generateId(),
    kind: ["service", "addon", "discount"].includes(String(l.kind)) ? String(l.kind) : "service",
    description: String(l.description || "").slice(0, 300),
    quantity: Number.isFinite(l.quantity) ? Number(l.quantity) : 1,
    unitCents: Math.round(Number(l.unit_cents) || 0),
    amountCents: Math.round(Number(l.amount_cents) || 0),
    sortOrder: i,
  }));

  // Totals are recomputed from the lines. A client-supplied total is never
  // trusted — it is the number the customer will be asked to agree to.
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);

  await c.env.DB.prepare(`DELETE FROM project_lines WHERE project_id = ?`)
    .bind(project.id)
    .run();
  for (const l of lines) {
    await c.env.DB.prepare(
      `INSERT INTO project_lines
         (id, project_id, kind, description, quantity, unit_cents, amount_cents, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(l.id, project.id, l.kind, l.description, l.quantity, l.unitCents, l.amountCents, l.sortOrder)
      .run();
  }
  await c.env.DB.prepare(
    `UPDATE projects SET subtotal_cents = ?, total_cents = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(subtotalCents, subtotalCents, new Date().toISOString(), project.id, tenant.id)
    .run();

  return c.json({ ok: true, subtotal_cents: subtotalCents, total_cents: subtotalCents });
});

// POST /:projectId/resend-link — mints a FRESH token; the old one dies.
projectRoutes.post("/:projectId/resend-link", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(`SELECT * FROM projects WHERE id = ? AND tenant_id = ?`)
      .bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);

  const token = mintAccessToken();
  const tokenHash = await hashToken(token);
  const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  await c.env.DB.prepare(
    `UPDATE projects SET access_token_hash = ?, token_expires_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(tokenHash, expires, new Date().toISOString(), project.id, tenant.id)
    .run();

  return c.json({ ok: true, token });
});
