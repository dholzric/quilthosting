/**
 * Paginated member listing — shared by admin API and scale verification tests.
 * Never returns an unbounded full-tenant dump.
 */
import type { Member } from "../types";
import { all, first } from "./db";
import {
  likeContains,
  likePrefix,
  pageMeta,
  parsePageParams,
} from "./pagination";

export type MembersListQuery = {
  status?: string;
  q?: string;
  limit?: string;
  offset?: string;
  page?: string;
};

export type MembersListResult = {
  members: Member[];
  total: number;
  limit: number;
  offset: number;
  page: number;
  total_pages: number;
  has_more: boolean;
};

/**
 * List members for a tenant with server-side search, status filter, and pagination.
 */
export async function listMembersPage(
  db: D1Database,
  tenantId: string,
  query: MembersListQuery = {}
): Promise<MembersListResult> {
  const status = query.status;
  const search = (query.q || "").trim();
  const { limit, offset } = parsePageParams({
    limit: query.limit,
    offset: query.offset,
    page: query.page,
  });

  let where = "WHERE tenant_id = ?";
  const params: unknown[] = [tenantId];
  if (status) {
    where += " AND status = ?";
    params.push(status);
  }
  if (search) {
    if (search.includes("@") || !search.includes(" ")) {
      where +=
        " AND (email LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\')";
      const pref = likePrefix(search);
      const cont = likeContains(search);
      params.push(pref, cont, cont);
    } else {
      where +=
        " AND (email LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR (first_name || ' ' || last_name) LIKE ? ESCAPE '\\')";
      const cont = likeContains(search);
      params.push(cont, cont, cont, cont);
    }
  }

  const countRow = await first<{ cnt: number }>(
    db.prepare(`SELECT COUNT(*) as cnt FROM members ${where}`).bind(...params)
  );
  const total = countRow?.cnt ?? 0;

  const members = await all<Member>(
    db
      .prepare(
        `SELECT * FROM members ${where}
         ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, email
         LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
  );

  return {
    members,
    ...pageMeta(total, limit, offset),
  };
}
