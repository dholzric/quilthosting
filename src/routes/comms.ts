import { Hono } from "hono";
import type { Env, Member, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { sendEmail } from "../lib/email";

export const commsRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

const STATUS_SEGMENTS = ["all", "active", "pending", "lapsed"] as const;

type Audience = {
  label: string;
  members: Pick<Member, "id" | "email" | "first_name">[];
};

async function resolveAudience(
  db: D1Database,
  tenantId: string,
  segment: string
): Promise<Audience | { error: string; status: number }> {
  // group:<uuid>
  if (segment.startsWith("group:")) {
    const groupId = segment.slice("group:".length);
    const group = await first<{ id: string; name: string }>(
      db
        .prepare(
          "SELECT id, name FROM member_groups WHERE id = ? AND tenant_id = ?"
        )
        .bind(groupId, tenantId)
    );
    if (!group) return { error: "Group not found", status: 404 };

    const members = await all<Pick<Member, "id" | "email" | "first_name">>(
      db
        .prepare(
          `SELECT m.id, m.email, m.first_name
           FROM member_group_members mgm
           JOIN members m ON m.id = mgm.member_id
           WHERE mgm.group_id = ? AND mgm.tenant_id = ?
             AND m.status != 'cancelled'
           ORDER BY m.email`
        )
        .bind(groupId, tenantId)
    );
    return { label: `group:${group.name}`, members };
  }

  if (!(STATUS_SEGMENTS as readonly string[]).includes(segment)) {
    return { error: "Invalid segment", status: 400 };
  }

  let query = "SELECT id, email, first_name FROM members WHERE tenant_id = ?";
  const params: string[] = [tenantId];
  if (segment !== "all") {
    query += " AND status = ?";
    params.push(segment);
  } else {
    query += " AND status != 'cancelled'";
  }
  const members = await all<Pick<Member, "id" | "email" | "first_name">>(
    db.prepare(query).bind(...params)
  );
  return { label: segment, members };
}

/**
 * POST /api/tenants/:tenantId/emails
 * Send an email blast to a status segment or group.
 * segment: active | pending | lapsed | all | group:<groupId>
 */
commsRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    subject: string;
    body_html?: string;
    body_text?: string;
    segment?: string;
    group_id?: string;
  }>();

  if (!body.subject || (!body.body_html && !body.body_text)) {
    return c.json({ error: "subject and body are required" }, 400);
  }

  let segment = body.segment || "active";
  if (body.group_id) segment = `group:${body.group_id}`;

  const audience = await resolveAudience(c.env.DB, tenant.id, segment);
  if ("error" in audience) {
    return c.json({ error: audience.error }, audience.status as 400);
  }
  if (!audience.members.length) {
    return c.json({ error: "No members in that audience" }, 400);
  }

  const html =
    body.body_html ||
    `<div style="font-family:system-ui,sans-serif;line-height:1.6;max-width:600px">${(body.body_text || "")
      .split("\n")
      .map((p) => `<p>${p}</p>`)
      .join("")}</div>`;

  const now = new Date().toISOString();
  const blastId = generateId();
  let sent = 0;
  const errors: string[] = [];

  const CHUNK = 10;
  for (let i = 0; i < audience.members.length; i += CHUNK) {
    const chunk = audience.members.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (m) => {
        const res = await sendEmail(c.env, {
          to: m.email,
          subject: body.subject,
          html,
          text: body.body_text,
        });
        return { m, res };
      })
    );
    const logInserts = results.map(({ m, res }) => {
      if (res.success) sent++;
      else errors.push(`${m.email}: ${res.error}`);
      return c.env.DB.prepare(
        `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
         VALUES (?, ?, ?, ?, 'blast', ?, ?, ?)`
      ).bind(
        generateId(),
        tenant.id,
        m.id,
        m.email,
        res.id || null,
        res.success ? "sent" : "failed",
        now
      );
    });
    await c.env.DB.batch(logInserts);
  }

  await c.env.DB.prepare(
    `INSERT INTO blasts (id, tenant_id, subject, body_html, segment, recipients, sent_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      blastId,
      tenant.id,
      body.subject,
      html,
      audience.label,
      audience.members.length,
      sent,
      now
    )
    .run();

  return c.json({
    ok: true,
    blast_id: blastId,
    segment: audience.label,
    recipients: audience.members.length,
    sent,
    failed: errors.length,
    errors: errors.slice(0, 5),
  });
});

// GET /api/tenants/:tenantId/emails/blasts
commsRoutes.get("/blasts", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, subject, segment, recipients, sent_count, created_at, body_html
       FROM blasts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`
    ).bind(tenant.id)
  );
  return c.json(rows);
});

// GET /api/tenants/:tenantId/emails — recent email log
commsRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all(
    c.env.DB.prepare(
      `SELECT e.id, e.to_email, e.template, e.status, e.created_at,
              m.first_name, m.last_name
       FROM email_logs e
       LEFT JOIN members m ON m.id = e.member_id
       WHERE e.tenant_id = ?
       ORDER BY e.created_at DESC LIMIT 200`
    ).bind(tenant.id)
  );
  return c.json(rows);
});

// Preview audience size without sending
// GET /api/tenants/:tenantId/emails/audience?segment=active|group:<id>
commsRoutes.get("/audience", async (c) => {
  const tenant = c.get("tenant");
  const segment = c.req.query("segment") || "active";
  const audience = await resolveAudience(c.env.DB, tenant.id, segment);
  if ("error" in audience) {
    return c.json({ error: audience.error }, audience.status as 400);
  }
  return c.json({
    segment: audience.label,
    count: audience.members.length,
  });
});
