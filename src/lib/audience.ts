/**
 * Chunked email audience resolution for large guilds.
 * Never loads 50k rows for a count; iterates with keyset on email.
 *
 * Marketing permission is applied at selection time: members with
 * email_opt_out_at set, or whose address is on the suppression list (tenant
 * or platform-wide, any scope), are excluded unless `includeOptedOut` is
 * passed (admin counts only — never for sending). countAudience reports the
 * excluded number as `opted_out` so the admin UI can show
 * "142 recipients (6 opted out)".
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

export type AudienceOptions = {
  /** Count/select members even if opted out or suppressed. Admin display only. */
  includeOptedOut?: boolean;
};

export type AudienceCount = {
  /** Sendable recipients (or everyone, when includeOptedOut). */
  count: number;
  label: string;
  /** Members in the segment excluded by opt-out / suppression. */
  opted_out: number;
};

const STATUS_SEGMENTS = ["all", "active", "pending", "lapsed"] as const;

/**
 * SQL predicate (on alias `m`) that keeps only members we may send marketing
 * mail to. Suppression rows are matched by exact lowercase email; members'
 * emails are lowercased on write (routes/members.ts).
 */
export const MARKETING_ELIGIBLE_SQL = `m.email_opt_out_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM email_suppressions s
    WHERE s.email = m.email AND (s.tenant_id IS NULL OR s.tenant_id = m.tenant_id)
  )`;

type SegmentQuery = {
  /** FROM ... JOIN ... WHERE <tenant/status predicates> — without the eligibility filter. */
  fromWhere: string;
  params: (string | number)[];
  /** Selected level/end-date columns (level segments carry real values). */
  extraSelect: string;
  label: string;
};

async function resolveSegment(
  db: D1Database,
  tenantId: string,
  segment: string
): Promise<SegmentQuery | { error: string; status: number }> {
  if (segment.startsWith("group:")) {
    const groupId = segment.slice("group:".length);
    const group = await first<{ id: string; name: string }>(
      db
        .prepare("SELECT id, name FROM member_groups WHERE id = ? AND tenant_id = ?")
        .bind(groupId, tenantId)
    );
    if (!group) return { error: "Group not found", status: 404 };
    return {
      fromWhere: `FROM member_group_members mgm
           JOIN members m ON m.id = mgm.member_id
           WHERE mgm.group_id = ? AND mgm.tenant_id = ? AND m.status != 'cancelled'`,
      params: [groupId, tenantId],
      extraSelect: "null as level_name, null as end_date",
      label: `group:${group.name}`,
    };
  }

  if (segment.startsWith("level:")) {
    const levelId = segment.slice("level:".length);
    const level = await first<{ id: string; name: string }>(
      db
        .prepare("SELECT id, name FROM membership_levels WHERE id = ? AND tenant_id = ?")
        .bind(levelId, tenantId)
    );
    if (!level) return { error: "Level not found", status: 404 };
    return {
      fromWhere: `FROM memberships ms
           JOIN members m ON m.id = ms.member_id
           JOIN membership_levels l ON l.id = ms.level_id
           WHERE ms.tenant_id = ? AND ms.level_id = ? AND ms.status = 'active'
             AND m.status != 'cancelled'`,
      params: [tenantId, levelId],
      extraSelect: "l.name as level_name, ms.end_date",
      label: `level:${level.name}`,
    };
  }

  if (!(STATUS_SEGMENTS as readonly string[]).includes(segment)) {
    return { error: "Invalid segment", status: 400 };
  }
  let where = `FROM members m WHERE m.tenant_id = ?`;
  const params: (string | number)[] = [tenantId];
  if (segment !== "all") {
    where += ` AND m.status = ?`;
    params.push(segment);
  } else {
    where += ` AND m.status != 'cancelled'`;
  }
  return {
    fromWhere: where,
    params,
    extraSelect: "null as level_name, null as end_date",
    label: segment,
  };
}

function countSql(q: SegmentQuery, eligibleOnly: boolean): string {
  const distinct = q.fromWhere.includes("JOIN") ? "COUNT(DISTINCT m.id)" : "COUNT(*)";
  return `SELECT ${distinct} as cnt ${q.fromWhere}${eligibleOnly ? ` AND ${MARKETING_ELIGIBLE_SQL}` : ""}`;
}

export async function countAudience(
  db: D1Database,
  tenantId: string,
  segment: string,
  opts: AudienceOptions = {}
): Promise<AudienceCount | { error: string; status: number }> {
  const q = await resolveSegment(db, tenantId, segment);
  if ("error" in q) return q;

  const total =
    (await first<{ cnt: number }>(db.prepare(countSql(q, false)).bind(...q.params)))?.cnt ?? 0;
  let eligible = total;
  try {
    eligible =
      (await first<{ cnt: number }>(db.prepare(countSql(q, true)).bind(...q.params)))?.cnt ??
      0;
  } catch (e) {
    // Pre-migration schema (no email_opt_out_at / email_suppressions yet).
    console.warn("audience eligibility count failed", e);
  }
  const optedOut = Math.max(0, total - eligible);
  return {
    count: opts.includeOptedOut ? total : eligible,
    label: q.label,
    opted_out: optedOut,
  };
}

/**
 * Fetch one page of audience members ordered by email.
 * afterEmail: exclusive lower bound for keyset pagination.
 * Opted-out / suppressed members are excluded unless includeOptedOut.
 */
export async function fetchAudiencePage(
  db: D1Database,
  tenantId: string,
  segment: string,
  opts: { limit: number; afterEmail?: string | null } & AudienceOptions
): Promise<AudienceMember[]> {
  const limit = Math.min(Math.max(1, opts.limit), 500);
  const after = opts.afterEmail || "";

  const q = await resolveSegment(db, tenantId, segment);
  if ("error" in q) {
    // Historic behaviour for unknown status segments was "all non-cancelled";
    // unknown group/level ids returned nothing. Keep that.
    if (segment.startsWith("group:") || segment.startsWith("level:")) return [];
    return fetchAudiencePage(db, tenantId, "all", opts);
  }

  const distinct = q.fromWhere.includes("JOIN") ? "DISTINCT " : "";
  const sql = `SELECT ${distinct}m.id, m.email, m.first_name, m.last_name, ${q.extraSelect}
    ${q.fromWhere}
    ${opts.includeOptedOut ? "" : `AND ${MARKETING_ELIGIBLE_SQL}`}
    AND (? = '' OR m.email > ?)
    ORDER BY m.email
    LIMIT ?`;
  return all<AudienceMember>(db.prepare(sql).bind(...q.params, after, after, limit));
}
