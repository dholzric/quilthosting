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
      // Move due scheduled blasts onto the queued pipeline (chunked, scale-safe)
      const claim = await env.DB.prepare(
        `UPDATE blasts SET status = 'queued', cursor_email = null, sent_count = 0
         WHERE id = ? AND status = 'scheduled'`
      )
        .bind(blast.id)
        .run();
      if (!claim.meta.changes) continue;
      result.sent_blasts++;
      // Delivery continues via processQueuedBlasts / processBlastChunk
    } catch (e) {
      result.errors.push(`blast ${blast.id}: ${String(e)}`);
    }
  }

  return result;
}

export { bodyToHtml };
