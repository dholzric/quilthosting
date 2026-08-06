import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import { sendEmail } from "./email";
import {
  applyMergeFields,
  bodyToHtml,
  wrapEmailLayout,
  type EmailLayout,
  type MergeContext,
} from "./email/merge";

type ScheduledRow = {
  id: string;
  tenant_id: string;
  subject: string;
  body_html: string;
  segment: string;
  layout: string;
};

type AudienceMember = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  level_name: string | null;
  end_date: string | null;
};

/** Resolve audience using same segment keys as comms (duplicated lightly to avoid circular imports). */
async function resolveAudience(
  db: D1Database,
  tenantId: string,
  segment: string
): Promise<AudienceMember[]> {
  if (segment.startsWith("group:")) {
    // segment stored as group:Name for archive — prefer group id stored as group:<uuid>
    const key = segment.slice("group:".length);
    const byId = await first<{ id: string }>(
      db
        .prepare(
          "SELECT id FROM member_groups WHERE tenant_id = ? AND id = ?"
        )
        .bind(tenantId, key)
    );
    const groupId =
      byId?.id ||
      (
        await first<{ id: string }>(
          db
            .prepare(
              "SELECT id FROM member_groups WHERE tenant_id = ? AND name = ?"
            )
            .bind(tenantId, key)
        )
      )?.id;
    if (!groupId) return [];
    return all(
      db
        .prepare(
          `SELECT m.id, m.email, m.first_name, m.last_name, null as level_name, null as end_date
           FROM member_group_members mgm
           JOIN members m ON m.id = mgm.member_id
           WHERE mgm.group_id = ? AND mgm.tenant_id = ? AND m.status != 'cancelled'`
        )
        .bind(groupId, tenantId)
    );
  }
  if (segment.startsWith("level:")) {
    const key = segment.slice("level:".length);
    const level =
      (await first<{ id: string }>(
        db
          .prepare(
            "SELECT id FROM membership_levels WHERE tenant_id = ? AND id = ?"
          )
          .bind(tenantId, key)
      )) ||
      (await first<{ id: string }>(
        db
          .prepare(
            "SELECT id FROM membership_levels WHERE tenant_id = ? AND name = ?"
          )
          .bind(tenantId, key)
      ));
    if (!level) return [];
    return all(
      db
        .prepare(
          `SELECT DISTINCT m.id, m.email, m.first_name, m.last_name,
                  l.name as level_name, ms.end_date
           FROM memberships ms
           JOIN members m ON m.id = ms.member_id
           JOIN membership_levels l ON l.id = ms.level_id
           WHERE ms.tenant_id = ? AND ms.level_id = ? AND ms.status = 'active'
             AND m.status != 'cancelled'`
        )
        .bind(tenantId, level.id)
    );
  }
  let q = `SELECT m.id, m.email, m.first_name, m.last_name, null as level_name, null as end_date
           FROM members m WHERE m.tenant_id = ?`;
  const params: string[] = [tenantId];
  if (segment !== "all") {
    q += " AND m.status = ?";
    params.push(segment);
  } else {
    q += " AND m.status != 'cancelled'";
  }
  return all(db.prepare(q).bind(...params));
}

/**
 * Send due scheduled blasts (status=scheduled, send_at <= now).
 */
export async function runScheduledBlasts(env: Env): Promise<{
  sent_blasts: number;
  emails: number;
  errors: string[];
}> {
  const result = { sent_blasts: 0, emails: 0, errors: [] as string[] };
  const now = new Date().toISOString();

  let rows: ScheduledRow[] = [];
  try {
    rows = await all<ScheduledRow>(
      env.DB.prepare(
        `SELECT id, tenant_id, subject, body_html, segment, layout
         FROM blasts
         WHERE status = 'scheduled' AND send_at IS NOT NULL AND send_at <= ?
         ORDER BY send_at ASC
         LIMIT 20`
      ).bind(now)
    );
  } catch (e) {
    // migration not applied yet
    result.errors.push(`scheduled query: ${String(e)}`);
    return result;
  }

  for (const blast of rows) {
    try {
      // Claim the row so concurrent cron doesn't double-send
      const claim = await env.DB.prepare(
        `UPDATE blasts SET status = 'sending' WHERE id = ? AND status = 'scheduled'`
      )
        .bind(blast.id)
        .run();
      if (!claim.meta.changes) continue;

      const tenant = await first<{ name: string }>(
        env.DB.prepare("SELECT name FROM tenants WHERE id = ?").bind(
          blast.tenant_id
        )
      );
      if (!tenant) continue;

      const members = await resolveAudience(
        env.DB,
        blast.tenant_id,
        blast.segment
      );
      // body_html for scheduled rows stores the inner content (pre-layout)
      // Prefer re-wrapping with layout
      const layout = (blast.layout || "plain") as EmailLayout;
      const inner = blast.body_html || "";
      let sent = 0;

      const CHUNK = 10;
      for (let i = 0; i < members.length; i += CHUNK) {
        const chunk = members.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(async (m) => {
            const ctx: MergeContext = {
              first_name: m.first_name,
              last_name: m.last_name,
              email: m.email,
              guild_name: tenant.name,
              level_name: m.level_name,
              end_date: m.end_date,
            };
            const subject = applyMergeFields(blast.subject, ctx);
            const bodyHtml = applyMergeFields(inner, ctx);
            const html = wrapEmailLayout(layout, {
              guildName: tenant.name,
              subject,
              bodyHtml,
            });
            const res = await sendEmail(env, {
              to: m.email,
              subject,
              html,
            });
            if (res.success) {
              sent++;
              result.emails++;
            }
            try {
              await env.DB.prepare(
                `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
                 VALUES (?, ?, ?, ?, 'blast', ?, ?, ?)`
              )
                .bind(
                  generateId(),
                  blast.tenant_id,
                  m.id,
                  m.email,
                  res.id || null,
                  res.success ? "sent" : "failed",
                  now
                )
                .run();
            } catch {}
          })
        );
      }

      await env.DB.prepare(
        `UPDATE blasts SET status = 'sent', recipients = ?, sent_count = ?,
          body_html = ?
         WHERE id = ?`
      )
        .bind(
          members.length,
          sent,
          wrapEmailLayout(layout, {
            guildName: tenant.name,
            subject: blast.subject,
            bodyHtml: inner,
          }),
          blast.id
        )
        .run();
      result.sent_blasts++;
    } catch (e) {
      result.errors.push(`blast ${blast.id}: ${String(e)}`);
      try {
        await env.DB.prepare(
          `UPDATE blasts SET status = 'scheduled' WHERE id = ? AND status = 'sending'`
        )
          .bind(blast.id)
          .run();
      } catch {}
    }
  }

  return result;
}

export { bodyToHtml };
