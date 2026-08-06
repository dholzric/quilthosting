/**
 * Chunked email audience resolution for large guilds.
 * Never loads 50k rows for a count; iterates with keyset on email.
 */
import { all, first } from "./db";

export type AudienceMember = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  level_name: string | null;
  end_date: string | null;
};

const STATUS_SEGMENTS = ["all", "active", "pending", "lapsed"] as const;

export async function countAudience(
  db: D1Database,
  tenantId: string,
  segment: string
): Promise<{ count: number; label: string } | { error: string; status: number }> {
  if (segment.startsWith("group:")) {
    const groupId = segment.slice("group:".length);
    const group = await first<{ id: string; name: string }>(
      db
        .prepare("SELECT id, name FROM member_groups WHERE id = ? AND tenant_id = ?")
        .bind(groupId, tenantId)
    );
    if (!group) return { error: "Group not found", status: 404 };
    const row = await first<{ cnt: number }>(
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM member_group_members mgm
           JOIN members m ON m.id = mgm.member_id
           WHERE mgm.group_id = ? AND mgm.tenant_id = ? AND m.status != 'cancelled'`
        )
        .bind(groupId, tenantId)
    );
    return { count: row?.cnt ?? 0, label: `group:${group.name}` };
  }

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
    const row = await first<{ cnt: number }>(
      db
        .prepare(
          `SELECT COUNT(DISTINCT m.id) as cnt
           FROM memberships ms
           JOIN members m ON m.id = ms.member_id
           WHERE ms.tenant_id = ? AND ms.level_id = ? AND ms.status = 'active'
             AND m.status != 'cancelled'`
        )
        .bind(tenantId, levelId)
    );
    return { count: row?.cnt ?? 0, label: `level:${level.name}` };
  }

  if (!(STATUS_SEGMENTS as readonly string[]).includes(segment)) {
    return { error: "Invalid segment", status: 400 };
  }

  let sql = `SELECT COUNT(*) as cnt FROM members m WHERE m.tenant_id = ?`;
  const params: string[] = [tenantId];
  if (segment !== "all") {
    sql += ` AND m.status = ?`;
    params.push(segment);
  } else {
    sql += ` AND m.status != 'cancelled'`;
  }
  const row = await first<{ cnt: number }>(db.prepare(sql).bind(...params));
  return { count: row?.cnt ?? 0, label: segment };
}

/**
 * Fetch one page of audience members ordered by email.
 * afterEmail: exclusive lower bound for keyset pagination.
 */
export async function fetchAudiencePage(
  db: D1Database,
  tenantId: string,
  segment: string,
  opts: { limit: number; afterEmail?: string | null }
): Promise<AudienceMember[]> {
  const limit = Math.min(Math.max(1, opts.limit), 500);
  const after = opts.afterEmail || "";

  if (segment.startsWith("group:")) {
    const groupId = segment.slice("group:".length);
    return all<AudienceMember>(
      db
        .prepare(
          `SELECT m.id, m.email, m.first_name, m.last_name,
                  null as level_name, null as end_date
           FROM member_group_members mgm
           JOIN members m ON m.id = mgm.member_id
           WHERE mgm.group_id = ? AND mgm.tenant_id = ?
             AND m.status != 'cancelled'
             AND (? = '' OR m.email > ?)
           ORDER BY m.email
           LIMIT ?`
        )
        .bind(groupId, tenantId, after, after, limit)
    );
  }

  if (segment.startsWith("level:")) {
    const levelId = segment.slice("level:".length);
    return all<AudienceMember>(
      db
        .prepare(
          `SELECT m.id, m.email, m.first_name, m.last_name,
                  l.name as level_name, ms.end_date
           FROM memberships ms
           JOIN members m ON m.id = ms.member_id
           JOIN membership_levels l ON l.id = ms.level_id
           WHERE ms.tenant_id = ? AND ms.level_id = ? AND ms.status = 'active'
             AND m.status != 'cancelled'
             AND (? = '' OR m.email > ?)
           ORDER BY m.email
           LIMIT ?`
        )
        .bind(tenantId, levelId, after, after, limit)
    );
  }

  let sql = `
    SELECT m.id, m.email, m.first_name, m.last_name,
           null as level_name, null as end_date
    FROM members m
    WHERE m.tenant_id = ?`;
  const params: (string | number)[] = [tenantId];
  if (segment !== "all" && (STATUS_SEGMENTS as readonly string[]).includes(segment)) {
    sql += ` AND m.status = ?`;
    params.push(segment);
  } else {
    sql += ` AND m.status != 'cancelled'`;
  }
  sql += ` AND (? = '' OR m.email > ?) ORDER BY m.email LIMIT ?`;
  params.push(after, after, limit);
  return all<AudienceMember>(db.prepare(sql).bind(...params));
}
