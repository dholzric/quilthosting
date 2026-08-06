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
import {
  countAudience,
  fetchAudiencePage,
  type AudienceMember,
} from "../lib/audience";
import { processBlastChunk } from "../lib/blastSend";

export const commsRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

/** Immediate sends for tiny lists; larger lists queue for chunked delivery. */
const SYNC_SEND_MAX = 75;

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

  const audienceMeta = await countAudience(c.env.DB, tenant.id, segment);
  if ("error" in audienceMeta) {
    return c.json({ error: audienceMeta.error }, audienceMeta.status as 400);
  }
  if (!audienceMeta.count) {
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
         (id, tenant_id, subject, body_html, segment, recipients, sent_count, created_at, status, send_at, layout, body_text)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'scheduled', ?, ?, ?)`
      )
        .bind(
          blastId,
          tenant.id,
          body.subject,
          rawBody,
          segment,
          audienceMeta.count,
          now,
          when.toISOString(),
          layout,
          body.body_text || null
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
      segment: audienceMeta.label,
      send_at: when.toISOString(),
      recipients: audienceMeta.count,
    });
  }

  const archiveHtml = wrapEmailLayout(layout, {
    guildName: tenant.name,
    subject: body.subject,
    bodyHtml: rawBody,
  });

  // Large audiences: queue + chunked send (supports 50k+)
  if (audienceMeta.count > SYNC_SEND_MAX) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO blasts
         (id, tenant_id, subject, body_html, segment, recipients, sent_count, created_at, status, send_at, layout, body_text, cursor_email, error_count)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'queued', null, ?, ?, null, 0)`
      )
        .bind(
          blastId,
          tenant.id,
          body.subject,
          rawBody,
          segment,
          audienceMeta.count,
          now,
          layout,
          body.body_text || null
        )
        .run();
    } catch (e) {
      console.error(e);
      return c.json(
        {
          error:
            "Queued blasts require migration 0009. Run db:migrate, or send to ≤75 members.",
        },
        503
      );
    }
    // Kick off first chunk without blocking the HTTP response long
    const kick = processBlastChunk(c.env, blastId).catch((err) =>
      console.error("blast chunk", err)
    );
    try {
      c.executionCtx.waitUntil(kick);
    } catch {
      await kick;
    }
    return c.json({
      ok: true,
      queued: true,
      blast_id: blastId,
      segment: audienceMeta.label,
      recipients: audienceMeta.count,
      message: `Sending to ${audienceMeta.count} members in the background. Progress updates on the Email page.`,
    });
  }

  // Small audience: send synchronously
  let sent = 0;
  const errors: string[] = [];
  let afterEmail: string | null = null;
  for (;;) {
    const page = await fetchAudiencePage(c.env.DB, tenant.id, segment, {
      limit: 25,
      afterEmail,
    });
    if (!page.length) break;
    const results = await Promise.all(
      page.map(async (m) => {
        const logId = generateId();
        const ctx = memberMergeCtx(m, tenant.name);
        const personalizedBody = applyMergeFields(rawBody, ctx);
        const personalizedSubject = applyMergeFields(body.subject, ctx);
        let html = wrapEmailLayout(layout, {
          guildName: tenant.name,
          subject: personalizedSubject,
          bodyHtml: personalizedBody,
        });
        const { wrapLinksForTracking } = await import("../lib/automations");
        html = wrapLinksForTracking(html, c.env.APP_URL, logId);
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
    afterEmail = page[page.length - 1].email;
    if (page.length < 25) break;
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
        audienceMeta.label,
        audienceMeta.count,
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
        audienceMeta.label,
        audienceMeta.count,
        sent,
        now
      )
      .run();
  }

  return c.json({
    ok: true,
    blast_id: blastId,
    segment: audienceMeta.label,
    layout,
    recipients: audienceMeta.count,
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
        `SELECT id, subject, segment, recipients, sent_count, created_at, body_html,
                status, send_at, error_count, cursor_email
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

// GET /api/tenants/:tenantId/emails/audience?segment=... — COUNT only (safe for 50k+)
commsRoutes.get("/audience", async (c) => {
  const tenant = c.get("tenant");
  const segment = c.req.query("segment") || "active";
  const audience = await countAudience(c.env.DB, tenant.id, segment);
  if ("error" in audience) {
    return c.json({ error: audience.error }, audience.status as 400);
  }
  return c.json({
    segment: audience.label,
    count: audience.count,
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
