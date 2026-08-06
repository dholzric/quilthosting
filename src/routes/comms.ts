import { Hono } from "hono";
import type { Env, Member, TenantVariables } from "../types";
import { all } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { sendEmail } from "../lib/email";

export const commsRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

const SEGMENTS = ["all", "active", "pending", "lapsed"] as const;

/**
 * POST /api/tenants/:tenantId/emails
 * Send an email blast to a member segment. Logged to email_logs.
 */
commsRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    subject: string;
    body_html?: string;
    body_text?: string;
    segment?: (typeof SEGMENTS)[number];
  }>();

  if (!body.subject || (!body.body_html && !body.body_text)) {
    return c.json({ error: "subject and body are required" }, 400);
  }
  const segment = body.segment || "active";
  if (!SEGMENTS.includes(segment)) {
    return c.json({ error: "Invalid segment" }, 400);
  }

  let query = "SELECT id, email, first_name FROM members WHERE tenant_id = ?";
  const params: any[] = [tenant.id];
  if (segment !== "all") {
    query += " AND status = ?";
    params.push(segment);
  } else {
    query += " AND status != 'cancelled'";
  }
  const members = await all<Pick<Member, "id" | "email" | "first_name">>(
    c.env.DB.prepare(query).bind(...params)
  );
  if (!members.length) {
    return c.json({ error: "No members in that segment" }, 400);
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

  // Send in small chunks to stay within subrequest limits
  const CHUNK = 10;
  for (let i = 0; i < members.length; i += CHUNK) {
    const chunk = members.slice(i, i + CHUNK);
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

  // Archive so members can read it online later
  await c.env.DB.prepare(
    `INSERT INTO blasts (id, tenant_id, subject, body_html, segment, recipients, sent_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(blastId, tenant.id, body.subject, html, segment, members.length, sent, now)
    .run();

  return c.json({
    ok: true,
    blast_id: blastId,
    segment,
    recipients: members.length,
    sent,
    failed: errors.length,
    errors: errors.slice(0, 5),
  });
});

// GET /api/tenants/:tenantId/emails/blasts — past newsletters/announcements
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
