// Owner admin API for longarm projects: list/view/edit, replace estimate
// lines, resend the customer's access link, and send the reviewed estimate.
// The status machine is enforced here via assertTransition — an illegal
// transition is a 409 conflict with current state, not a 500. Every query
// touching `projects` is scoped `WHERE tenant_id = ?`; this is the only
// thing standing between tenants (see src/routes/projects.test.ts's
// tenant-scoping test).
//
// POST /:projectId/send-estimate (Task 7) is where a customer record is
// created or matched — NOT at intake. An anonymous public form that writes
// to the Customers list is a spam amplifier; this step is human-reviewed,
// so junk never reaches it.

import { Hono } from "hono";
import type { Env, Project, ProjectLine, TenantVariables, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { assertTransition } from "../lib/projects/status";
import { mintAccessToken, hashToken } from "../lib/projects/token";
import type { ProjectStatus } from "../lib/projects/types";
import { sendEmail } from "../lib/email";
import { tenantPublicBaseUrl } from "../lib/tenantHost";

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

/**
 * access_token_hash and token_expires_at are never returned to the browser:
 * the hash is the lookup key for the customer's link, and the admin UI has
 * no use for either. Shared by the list and detail routes so this can't
 * drift between them again (the list route previously leaked both via
 * `SELECT *`).
 */
function sanitizeProject(project: Project): Omit<Project, "access_token_hash" | "token_expires_at"> {
  const { access_token_hash: _hash, token_expires_at: _expires, ...safe } = project;
  return safe;
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
  return c.json(rows.map(sanitizeProject));
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
  return c.json({ project: sanitizeProject(project), lines });
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

  // due_date and customer_phone are the only nullable columns here. The
  // PatchBody type promises `string | null` for both, meaning "send null to
  // clear it" — but coalesce(?, col) cannot tell a bound null apart from
  // "field omitted," so it silently keeps the old value either way. Resolve
  // the intended value in JS instead: an explicitly-present key (even when
  // its value is null) clears the column; an omitted key leaves it alone.
  const dueDate = "due_date" in body ? (body.due_date ?? null) : project.due_date;
  const customerPhone = "customer_phone" in body ? (body.customer_phone ?? null) : project.customer_phone;

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE projects SET
       status = coalesce(?, status),
       estimate_notes = coalesce(?, estimate_notes),
       due_date = ?,
       customer_name = coalesce(?, customer_name),
       customer_email = coalesce(?, customer_email),
       customer_phone = ?,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.status ?? null,
      body.estimate_notes ?? null,
      dueDate,
      body.customer_name ?? null,
      body.customer_email ?? null,
      customerPhone,
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

  type LinesBody = {
    lines?: {
      kind?: string;
      description?: string;
      quantity?: number;
      unit_cents?: number;
      amount_cents?: number;
    }[];
  };
  // A missing, empty, or unparseable body must be REJECTED, not silently
  // treated as "replace with zero lines" — that used to wipe every existing
  // line and zero out the total a customer is about to be asked to sign,
  // while reporting 200 {ok:true}. A body that legitimately parses to
  // `{ lines: [] }` is different: that's an explicit "clear all lines" and
  // must still succeed below.
  let body: LinesBody;
  try {
    body = await c.req.json<LinesBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

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

  // DELETE + N INSERTs + the totals UPDATE run as one D1 batch (same idiom
  // as tenants.ts / galleries.ts / members.ts) so the rewrite is atomic: an
  // interruption can no longer leave project_lines partially rewritten, or
  // projects.total_cents out of sync with the rows actually stored.
  const now = new Date().toISOString();
  const stmts = [
    c.env.DB.prepare(`DELETE FROM project_lines WHERE project_id = ?`).bind(project.id),
    ...lines.map((l) =>
      c.env.DB.prepare(
        `INSERT INTO project_lines
           (id, project_id, kind, description, quantity, unit_cents, amount_cents, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(l.id, project.id, l.kind, l.description, l.quantity, l.unitCents, l.amountCents, l.sortOrder)
    ),
    c.env.DB.prepare(
      `UPDATE projects SET subtotal_cents = ?, total_cents = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).bind(subtotalCents, subtotalCents, now, project.id, tenant.id),
  ];
  await c.env.DB.batch(stmts);

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

// POST /:projectId/send-estimate
// This is where a customer record is created or matched — NOT at intake. An
// anonymous public form that writes to the Customers list is a spam
// amplifier; this step is human-reviewed, so junk never reaches it.
projectRoutes.post("/:projectId/send-estimate", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(`SELECT * FROM projects WHERE id = ? AND tenant_id = ?`)
      .bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);

  try {
    assertTransition(project.status as ProjectStatus, "estimated");
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }

  // Find-or-create must be a single atomic statement, not a check-then-act
  // SELECT-then-INSERT: two concurrent send-estimate calls for different
  // projects sharing one customer email under this tenant could otherwise
  // both miss the SELECT and both INSERT, and the loser would hit
  // idx_members_tenant_email as an unhandled exception — the same shape of
  // race the reference counter had (see the intake handler in public.ts).
  // ON CONFLICT(tenant_id, email) matches that unique index's column list
  // exactly (verified against `CREATE UNIQUE INDEX idx_members_tenant_email
  // ON members(tenant_id, email)` in migrations/0001_initial.sql — SQLite
  // matches an ON CONFLICT target by column list, not index name).
  //
  // Normalized to lowercase here the same way /join and the intake handler
  // do: the index is case-SENSITIVE (SQLite's default TEXT collation), so
  // matching on the exact stored casing is what makes ON CONFLICT actually
  // catch an existing customer instead of silently inserting a
  // case-variant duplicate row beside them. This also preserves the
  // case-insensitive-in-effect matching the previous `lower(email) =
  // lower(?)` SELECT provided.
  const customerEmail = project.customer_email.trim().toLowerCase();
  const candidateMemberId = generateId();
  const memberRow = await first<{ id: string }>(
    c.env.DB.prepare(
      `INSERT INTO members (id, tenant_id, email, first_name, status, joined_at)
       VALUES (?, ?, ?, ?, 'active', datetime('now'))
       ON CONFLICT(tenant_id, email) DO UPDATE SET email = email
       RETURNING id`
    ).bind(candidateMemberId, tenant.id, customerEmail, project.customer_name)
  );
  const memberId = memberRow?.id ?? candidateMemberId;
  // SQLite's RETURNING gives no "was this an insert or a no-op update" flag.
  // The returned id equaling the UUID we just generated IS that signal: the
  // ON CONFLICT branch always returns some PRE-EXISTING row's id, which
  // cannot coincide with a freshly generated UUID (the same collision-proof
  // assumption every id in this codebase already relies on).
  const wasNewMember = memberId === candidateMemberId;

  if (wasNewMember) {
    // Fire the same event every other member-creation path fires (/join,
    // /forms/:slug) so a customer created here is not invisible to every
    // webhook/Zapier consumer the platform has. Same event name, same
    // payload shape (schema-validated by prepareEvent), same
    // scheduleDispatch call as /join. NOT wrapped in the same single
    // db.batch() as the member row above, unlike /join: /join already
    // knows pre-write, from its own prior plain SELECT, that it is on the
    // "creating a new member" branch, so it can decide up front to include
    // the event statement in that batch. Here the ON CONFLICT upsert is
    // what makes the member write itself race-free, and it only reveals
    // new-vs-existing AFTER running — by which point the write has already
    // committed. Firing unconditionally regardless of wasNewMember was
    // rejected: it would emit a false member.created every time an
    // existing customer gets a second project estimated, which is worse
    // than the gap it would close.
    const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
    const ev = prepareEvent(c.env, tenant.id, "member.created", {
      source: "admin",
      member_id: memberId,
      email: customerEmail,
      first_name: project.customer_name,
      last_name: null,
      status: "active",
    });
    if (!ev) {
      console.error("send-estimate: member.created payload failed schema validation", { memberId });
    } else {
      try {
        await ev.stmt.run();
        await scheduleDispatch(c.env, c.executionCtx, ev.id);
      } catch (e) {
        // The member row is already committed at this point (find-or-create
        // ran and returned above) — matches the documented risk of
        // webhookOutbox's non-atomic fallback path: log and continue rather
        // than fail the request, since send-estimate must still be able to
        // send the estimate even if the outbox write hiccups.
        console.error("send-estimate: member.created outbox write failed", e);
      }
    }
  }

  const token = mintAccessToken();
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  await c.env.DB.prepare(
    `UPDATE projects SET status = 'estimated', member_id = ?, access_token_hash = ?,
       token_expires_at = ?, estimated_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  ).bind(memberId, tokenHash, expires, now, now, project.id, tenant.id).run();

  const baseUrl = tenantPublicBaseUrl(c.env, tenant);
  await sendEmail(c.env, {
    to: project.customer_email,
    subject: `Your quilting estimate — ${project.reference}`,
    html: `<p>Your estimate for ${project.reference} is ready.</p>
           <p><a href="${baseUrl}/quote/${token}">View and sign your estimate</a></p>`,
  }).catch(() => undefined);

  return c.json({ ok: true });
});
