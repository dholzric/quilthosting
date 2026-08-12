// src/lib/site/cache.ts
// Rendered HTML is cached in the Cache API under a key that includes the
// page's updated_at, so publishing produces a new key and the stale entry
// simply ages out. No explicit purge needed.

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
  if (hit) return hit;

  const html = await args.build();
  const res = new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Short browser TTL, long edge TTL. The key changes on publish, so a
      // long edge TTL never serves stale content after an edit.
      "Cache-Control": "public, max-age=60, s-maxage=86400",
    },
  });
  await cache.put(key, res.clone());
  return res;
}
