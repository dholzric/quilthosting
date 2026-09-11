// src/lib/site/cache.ts
// Rendered HTML is cached in the Cache API under a key that includes the
// page's updated_at and APP_VERSION, so publishing or deploying produces a
// new key and the stale entry simply ages out. No explicit purge needed.
//
// That is true of THIS cache, which we key ourselves. It was not true of the
// edge cache in front of the Worker, which is keyed on the real request URL
// and honoured the s-maxage we sent: a renderer fix was deployed, the Worker
// built the new HTML under a new internal key, and visitors kept getting the
// previous day's page for up to 24 hours because the URL had not changed.
// Caught by shipping three event-page fixes that were provably live behind a
// cache-busting query string and provably stale without one.
//
// So the two layers get different lifetimes: this cache keeps the long one,
// because its key already encodes everything that would make an entry wrong;
// the edge gets a short one, because nothing in its key does.

export function siteCacheKey(host: string, path: string, updatedAt: string): string {
  // Cache API keys must be URLs. The version segment carries updated_at.
  const safeVersion = encodeURIComponent(updatedAt || "0");
  return `https://site-cache.invalid/${encodeURIComponent(host)}/${safeVersion}${
    path.startsWith("/") ? path : "/" + path
  }`;
}

export async function cachedRender(args: {
  host: string;
  path: string;
  updatedAt: string;
  build: () => string | Promise<string>;
}): Promise<Response> {
  const key = new Request(siteCacheKey(args.host, args.path, args.updatedAt));
  const cache = (caches as unknown as { default: Cache }).default;

  const hit = await cache.match(key);
  if (hit) return forEdge(hit);

  const html = await args.build();
  const res = new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Stored long: this key carries updated_at and APP_VERSION, so an entry
      // under it cannot be stale — a change produces a different key.
      "Cache-Control": STORED_CACHE_CONTROL,
    },
  });
  await cache.put(key, res.clone());
  return forEdge(res);
}

/** What we store: keyed by content and build, so it can live a long time. */
export const STORED_CACHE_CONTROL = "public, max-age=60, s-maxage=86400";

/**
 * What we send: the edge keys on the URL alone, which does not change when a
 * page is edited or the renderer is deployed, so it may only hold the page
 * briefly. Serving from our own cache above means a short edge TTL costs a
 * Worker invocation, not a re-render.
 */
export const EDGE_CACHE_CONTROL = "public, max-age=60, s-maxage=60";

function forEdge(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", EDGE_CACHE_CONTROL);
  return out;
}
