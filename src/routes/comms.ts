import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { sendEmail, trackingPixelHtml } from "../lib/email";
import {
  applyMergeFields,
  bodyToHtml,
  wrapEmailLayout,
  type EmailLayout,
  type MergeContext,
} from "../lib/email/merge";

export const commsRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

const STATUS_SEGMENTS = ["all", "active", "pending", "lapsed"] as const;

type AudienceMember = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  level_name: string | null;
  end_date: string | null;
};

type Audience = {
  label: string;
  members: AudienceMember[];
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

    const members = await all<AudienceMember>(
      db
        .prepare(
          `SELECT m.id, m.email, m.first_name, m.last_name,
                  (SELECT l.name FROM memberships ms
                   JOIN membership_levels l ON l.id = ms.level_id
                   WHERE ms.member_id = m.id AND ms.tenant_id = m.tenant_id
                   ORDER BY CASE ms.status WHEN 'active' THEN 0 ELSE 1 END, ms.created_at DESC
                   LIMIT 1) as level_name,
                  (SELECT ms.end_date FROM memberships ms
                   WHERE ms.member_id = m.id AND ms.tenant_id = m.tenant_id
                   ORDER BY CASE ms.status WHEN 'active' THEN 0 ELSE 1 END, ms.created_at DESC
                   LIMIT 1) as end_date
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

  // level:<uuid> — active members currently on this membership level
  if (segment.startsWith("level:")) {
    const levelId = segment.slice("level:".length);
    const level = await first<{ id: string; name: string }>(
      db
        .prepare(
          "SELECT id, name FROM membership_levels WHERE id = ? AND tenant_id = ?"
        )
        .bind(levelId, tenantId)
    );
    if (!level) return { error: "Level not found", status: 404 };

    const members = await all<AudienceMember>(
      db
        .prepare(
          `SELECT DISTINCT m.id, m.email, m.first_name, m.last_name,
                  l.name as level_name, ms.end_date
           FROM memberships ms
           JOIN members m ON m.id = ms.member_id
           JOIN membership_levels l ON l.id = ms.level_id
           WHERE ms.tenant_id = ? AND ms.level_id = ? AND ms.status = 'active'
             AND m.status != 'cancelled'
           ORDER BY m.email`
        )
        .bind(tenantId, levelId)
    );
    return { label: `level:${level.name}`, members };
  }

  if (!(STATUS_SEGMENTS as readonly string[]).includes(segment)) {
    return { error: "Invalid segment", status: 400 };
  }

  let query = `
    SELECT m.id, m.email, m.first_name, m.last_name,
           (SELECT l.name FROM memberships ms
            JOIN membership_levels l ON l.id = ms.level_id
            WHERE ms.member_id = m.id AND ms.tenant_id = m.tenant_id
            ORDER BY CASE ms.status WHEN 'active' THEN 0 ELSE 1 END, ms.created_at DESC
            LIMIT 1) as level_name,
           (SELECT ms.end_date FROM memberships ms
            WHERE ms.member_id = m.id AND ms.tenant_id = m.tenant_id
            ORDER BY CASE ms.status WHEN 'active' THEN 0 ELSE 1 END, ms.created_at DESC
            LIMIT 1) as end_date
    FROM members m
    WHERE m.tenant_id = ?`;
  const params: string[] = [tenantId];
  if (segment !== "all") {
    query += " AND m.status = ?";
    params.push(segment);
  } else {
    query += " AND m.status != 'cancelled'";
  }
  query += " ORDER BY m.email";

  const members = await all<AudienceMember>(
    db.prepare(query).bind(...params)
  );
  return { label: segment, members };
}

function memberMergeCtx(
  m: AudienceMember,
  guildName: string
): MergeContext {
  return {
    first_name: m.first_name,
    last_name: m.last_name,
    email: m.email,
    guild_name: guildName,
    level_name: m.level_name,
    end_date: m.end_date,
  };
}

/**
 * POST /api/tenants/:tenantId/emails
 * segment: active | pending | lapsed | all | group:<id> | level:<id>
 * layout: plain | newsletter | announcement
 * send_at: ISO datetime — schedule instead of send now
 * Merge fields: {{first_name}} {{last_name}} {{email}} {{guild_name}} {{level_name}} {{end_date}}
 */
commsRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    subject: string;
    body_html?: string;
    body_text?: string;
    segment?: string;
    group_id?: string;
    level_id?: string;
    layout?: EmailLayout;
    send_at?: string;
  }>();

  if (!body.subject || (!body.body_html && !body.body_text)) {
    return c.json({ error: "subject and body are required" }, 400);
  }

  let segment = body.segment || "active";
  if (body.group_id) segment = `group:${body.group_id}`;
  if (body.level_id) segment = `level:${body.level_id}`;

  const layout: EmailLayout =
    body.layout === "newsletter" || body.layout === "announcement"
      ? body.layout
      : "plain";

  const audience = await resolveAudience(c.env.DB, tenant.id, segment);
  if ("error" in audience) {
    return c.json({ error: audience.error }, audience.status as 400);
  }
  if (!audience.members.length) {
    return c.json({ error: "No members in that audience" }, 400);
  }

  const rawBody = bodyToHtml(body.body_html, body.body_text);
  const now = new Date().toISOString();
  const blastId = generateId();

  // Schedule for later
  if (body.send_at) {
    const when = new Date(body.send_at);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() - 60_000) {
      return c.json({ error: "send_at must be a future datetime" }, 400);
    }
    try {
      await c.env.DB.prepare(
        `INSERT INTO blasts
         (id, tenant_id, subject, body_html, segment, recipients, sent_count, created_at, status, send_at, layout)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'scheduled', ?, ?)`
      )
        .bind(
          blastId,
          tenant.id,
          body.subject,
          rawBody,
          segment,
          audience.members.length,
          now,
          when.toISOString(),
          layout
        )
        .run();
    } catch (e) {
      console.error(e);
      return c.json(
        { error: "Scheduling requires migration 0005 — run db:migrate" },
        503
      );
    }
    return c.json({
      ok: true,
      scheduled: true,
      blast_id: blastId,
      segment: audience.label,
      send_at: when.toISOString(),
      recipients: audience.members.length,
    });
  }

  const archiveHtml = wrapEmailLayout(layout, {
    guildName: tenant.name,
    subject: body.subject,
    bodyHtml: rawBody,
  });

  let sent = 0;
  const errors: string[] = [];

  const CHUNK = 10;
  for (let i = 0; i < audience.members.length; i += CHUNK) {
    const chunk = audience.members.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (m) => {
        const logId = generateId();
        const ctx = memberMergeCtx(m, tenant.name);
        const personalizedBody = applyMergeFields(rawBody, ctx);
        const personalizedSubject = applyMergeFields(body.subject, ctx);
        let html = wrapEmailLayout(layout, {
          guildName: tenant.name,
          subject: personalizedSubject,
          bodyHtml: personalizedBody,
        });
        // Append open-tracking pixel
        html += trackingPixelHtml(c.env.APP_URL, logId);
        const text = body.body_text
          ? applyMergeFields(body.body_text, ctx)
          : undefined;
        const res = await sendEmail(c.env, {
          to: m.email,
          subject: personalizedSubject,
          html,
          text,
        });
        return { m, res, logId };
      })
    );
    const logInserts = results.map(({ m, res, logId }) => {
      if (res.success) sent++;
      else errors.push(`${m.email}: ${res.error}`);
      return c.env.DB.prepare(
        `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
         VALUES (?, ?, ?, ?, 'blast', ?, ?, ?)`
      ).bind(
        logId,
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

  try {
    await c.env.DB.prepare(
      `INSERT INTO blasts
       (id, tenant_id, subject, body_html, segment, recipients, sent_count, created_at, status, send_at, layout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', null, ?)`
    )
      .bind(
        blastId,
        tenant.id,
        body.subject,
        archiveHtml,
        audience.label,
        audience.members.length,
        sent,
        now,
        layout
      )
      .run();
  } catch {
    // Pre-migration schema
    await c.env.DB.prepare(
      `INSERT INTO blasts (id, tenant_id, subject, body_html, segment, recipients, sent_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        blastId,
        tenant.id,
        body.subject,
        archiveHtml,
        audience.label,
        audience.members.length,
        sent,
        now
      )
      .run();
  }

  return c.json({
    ok: true,
    blast_id: blastId,
    segment: audience.label,
    layout,
    recipients: audience.members.length,
    sent,
    failed: errors.length,
    errors: errors.slice(0, 5),
  });
});

// GET /api/tenants/:tenantId/emails/blasts
commsRoutes.get("/blasts", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT id, subject, segment, recipients, sent_count, created_at, body_html,
                status, send_at, layout
         FROM blasts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT id, subject, segment, recipients, sent_count, created_at, body_html
         FROM blasts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`
      ).bind(tenant.id)
    );
    return c.json(rows);
  }
});

// DELETE scheduled blast
commsRoutes.delete("/blasts/:blastId", async (c) => {
  const tenant = c.get("tenant");
  const blastId = c.req.param("blastId");
  const res = await c.env.DB.prepare(
    `DELETE FROM blasts WHERE id = ? AND tenant_id = ? AND status = 'scheduled'`
  )
    .bind(blastId, tenant.id)
    .run();
  if (!res.meta.changes) {
    return c.json({ error: "Scheduled blast not found" }, 404);
  }
  return c.json({ ok: true });
});

// GET /api/tenants/:tenantId/emails — recent email log
commsRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT e.id, e.to_email, e.template, e.status, e.created_at,
                e.opened_at, e.open_count,
                m.first_name, m.last_name
         FROM email_logs e
         LEFT JOIN members m ON m.id = e.member_id
         WHERE e.tenant_id = ?
         ORDER BY e.created_at DESC LIMIT 200`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
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
  }
});

// GET /api/tenants/:tenantId/emails/audience?segment=...
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

// GET /api/tenants/:tenantId/emails/merge-fields — docs for admin UI
commsRoutes.get("/merge-fields", (c) => {
  return c.json({
    fields: [
      { key: "first_name", sample: "Jane", note: "Falls back to “there”" },
      { key: "last_name", sample: "Doe" },
      { key: "email", sample: "jane@example.com" },
      { key: "guild_name", sample: "Prairie Star Quilt Guild" },
      { key: "level_name", sample: "Individual" },
      { key: "end_date", sample: "December 31, 2026", note: "Current membership end" },
    ],
    syntax: "{{first_name}} or {first_name}",
    layouts: ["plain", "newsletter", "announcement"],
  });
});
