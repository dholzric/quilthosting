// src/lib/pageDrafts.ts
// Shared helpers for the draft -> preview -> publish workflow (migration
// 0025): row shape + serialisation for the admin API, revision snapshots,
// slug-rename redirects, and the redirect lookups the public readers
// (public.ts, site.ts) consult when a slug is not found.

import { parseBlocks, type PageBlock } from "./blocks";

/** Full `pages` row after migration 0025. */
export type PageRecord = {
  id: string;
  tenant_id?: string;
  slug: string;
  title: string;
  content_json: string | null;
  blocks_json: string | null;
  page_type?: string | null;
  show_in_nav?: number | null;
  nav_label?: string | null;
  is_members_only: number;
  published: number;
  sort_order: number;
  seo_title?: string | null;
  seo_description?: string | null;
  og_image_file_id?: string | null;
  noindex?: number | null;
  draft_blocks_json?: string | null;
  draft_title?: string | null;
  draft_updated_at?: string | null;
  revision?: number | null;
  published_at?: string | null;
  deleted_at?: string | null;
  created_at?: string;
  updated_at: string;
};

export type PageRevisionRecord = {
  id: string;
  tenant_id: string;
  page_id: string;
  kind: "publish" | "restore" | "pre_restore" | string;
  title: string;
  blocks_json: string | null;
  content_json: string | null;
  created_by: string | null;
  created_at: string;
};

/** Newest N revisions kept per page; older ones are pruned on every snapshot. */
export const MAX_PAGE_REVISIONS = 50;

/** Parse a stored blocks_json column; malformed/NULL -> []. */
export function blocksFromJson(json: string | null | undefined): PageBlock[] {
  if (!json) return [];
  try {
    return parseBlocks(JSON.parse(json));
  } catch {
    return [];
  }
}

/**
 * Blocks to seed a draft from a revision. A revision written before the
 * block editor existed carries only content_json HTML; rather than
 * restoring an empty draft (which would publish as a blank page), wrap that
 * HTML in a single sanitised `html` block so nothing is lost.
 */
export function revisionBlocks(rev: {
  blocks_json: string | null;
  content_json: string | null;
}): PageBlock[] {
  const blocks = blocksFromJson(rev.blocks_json);
  if (blocks.length) return blocks;
  try {
    const html = String(JSON.parse(rev.content_json || "{}").html || "");
    if (!html.trim()) return [];
    return parseBlocks([{ type: "html", html }]);
  } catch {
    return [];
  }
}

/** Numeric revision with a safe default for rows read before 0025 ran. */
export function revisionOf(row: { revision?: number | null }): number {
  const n = Number(row.revision);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Admin API shape for a page row: every column, plus `has_draft` and the
 * parsed `blocks` / `draft_blocks` arrays (draft_blocks only when a draft
 * exists). Raw *_json columns are kept so older clients keep working.
 */
export function serializePage(row: PageRecord): Record<string, unknown> {
  const hasDraft = row.draft_blocks_json != null;
  return {
    ...row,
    revision: revisionOf(row),
    has_draft: hasDraft ? 1 : 0,
    blocks: blocksFromJson(row.blocks_json),
    draft_blocks: hasDraft ? blocksFromJson(row.draft_blocks_json) : null,
  };
}

/**
 * Statements that record a slug rename so the old URL keeps resolving:
 *   - old -> new (upsert; a second rename of the same page overwrites)
 *   - any redirect that pointed AT the old slug now points at the new one
 *     (no chains: a -> b -> c collapses to a -> c, b -> c)
 *   - a redirect FROM the new slug is dropped (the slug is a real page again)
 */
export function slugRedirectStatements(
  db: D1Database,
  tenantId: string,
  fromSlug: string,
  toSlug: string,
  now: string
): D1PreparedStatement[] {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return [];
  return [
    db
      .prepare(
        `DELETE FROM page_redirects WHERE tenant_id = ? AND from_slug = ?`
      )
      .bind(tenantId, toSlug),
    db
      .prepare(
        `UPDATE page_redirects SET to_slug = ? WHERE tenant_id = ? AND to_slug = ?`
      )
      .bind(toSlug, tenantId, fromSlug),
    db
      .prepare(
        `INSERT INTO page_redirects (tenant_id, from_slug, to_slug, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, from_slug) DO UPDATE SET to_slug = excluded.to_slug, created_at = excluded.created_at`
      )
      .bind(tenantId, fromSlug, toSlug, now),
  ];
}

/** Where a missing slug now lives, or null. */
export async function findRedirect(
  db: D1Database,
  tenantId: string,
  fromSlug: string
): Promise<string | null> {
  if (!fromSlug) return null;
  const row = await db
    .prepare(`SELECT to_slug FROM page_redirects WHERE tenant_id = ? AND from_slug = ?`)
    .bind(tenantId, fromSlug)
    .first<{ to_slug: string }>();
  return row?.to_slug ?? null;
}

/** `{ from: to }` for every redirect a tenant has (guild JSON consumers). */
export async function listRedirects(
  db: D1Database,
  tenantId: string
): Promise<Record<string, string>> {
  const res = await db
    .prepare(`SELECT from_slug, to_slug FROM page_redirects WHERE tenant_id = ?`)
    .bind(tenantId)
    .all<{ from_slug: string; to_slug: string }>();
  const out: Record<string, string> = {};
  for (const r of res.results ?? []) out[r.from_slug] = r.to_slug;
  return out;
}

/**
 * Snapshot of a page's CURRENT live content into page_revisions. The insert
 * is conditional on the page still being at `expectedRevision`, so when it
 * rides in the same batch as a compare-and-swap UPDATE on the page row,
 * a lost race leaves no orphan snapshot behind (both statements no-op).
 */
export function revisionSnapshotStatement(
  db: D1Database,
  args: {
    id: string;
    tenantId: string;
    page: PageRecord;
    kind: "publish" | "restore" | "pre_restore";
    createdBy: string | null;
    now: string;
    expectedRevision: number;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO page_revisions
         (id, tenant_id, page_id, kind, title, blocks_json, content_json, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM pages WHERE id = ? AND tenant_id = ? AND revision = ?)`
    )
    .bind(
      args.id,
      args.tenantId,
      args.page.id,
      args.kind,
      args.page.title,
      args.page.blocks_json ?? null,
      args.page.content_json ?? null,
      args.createdBy,
      args.now,
      args.page.id,
      args.tenantId,
      args.expectedRevision
    );
}

/** Keep only the newest MAX_PAGE_REVISIONS rows for a page. */
export function pruneRevisionsStatement(
  db: D1Database,
  tenantId: string,
  pageId: string
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM page_revisions
       WHERE tenant_id = ? AND page_id = ?
         AND id NOT IN (
           SELECT id FROM page_revisions WHERE page_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ${MAX_PAGE_REVISIONS}
         )`
    )
    .bind(tenantId, pageId, pageId);
}
