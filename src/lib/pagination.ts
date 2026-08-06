/** Shared list pagination for large tenants (50k+ members). */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_EXPORT_BATCH = 1000;

export type PageParams = {
  limit: number;
  offset: number;
};

export function parsePageParams(
  query: { limit?: string; offset?: string; page?: string },
  defaults: { limit?: number; max?: number } = {}
): PageParams {
  const max = defaults.max ?? MAX_PAGE_SIZE;
  const def = defaults.limit ?? DEFAULT_PAGE_SIZE;
  let limit = Math.floor(Number(query.limit) || def);
  if (!Number.isFinite(limit) || limit < 1) limit = def;
  limit = Math.min(limit, max);

  let offset = Math.floor(Number(query.offset) || 0);
  if (query.page && !query.offset) {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    offset = (page - 1) * limit;
  }
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  // Cap deep offsets (prefer search over page 500 of 50)
  if (offset > 100_000) offset = 100_000;
  return { limit, offset };
}

export function pageMeta(
  total: number,
  limit: number,
  offset: number
): {
  total: number;
  limit: number;
  offset: number;
  page: number;
  total_pages: number;
  has_more: boolean;
} {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const page = Math.floor(offset / limit) + 1;
  return {
    total,
    limit,
    offset,
    page,
    total_pages: totalPages,
    has_more: offset + limit < total,
  };
}

/** Escape LIKE wildcards in user search terms. */
export function likeContains(term: string): string {
  const cleaned = term.trim().slice(0, 80).replace(/[%_\\]/g, "\\$&");
  return `%${cleaned}%`;
}

export function likePrefix(term: string): string {
  const cleaned = term.trim().slice(0, 80).replace(/[%_\\]/g, "\\$&");
  return `${cleaned}%`;
}
