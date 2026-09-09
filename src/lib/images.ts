// src/lib/images.ts
// Stored image variants, focal points, and the one function that serves a
// tenant image (site.ts's /img/:fileId and public.ts's /public/:slug/img/
// :fileId both delegate here so the two routes can never drift apart).
//
// Variants are produced in the browser (canvas -> WebP + JPEG at
// 480/960/1600/2400) and uploaded through POST /files/:fileId/variants,
// which re-validates every part's magic bytes before it lands in R2 under
// `${r2_key}/w<w>.<ext>` and records `[{ w, format, key, bytes }]` in
// files.variants_json. Nothing here trusts a client-declared type.

import type { Env } from "../types";

/**
 * The only content types any image route may echo back. Excludes
 * image/svg+xml on purpose: SVG is active content (inline <script>, event
 * handlers) and would reopen stored XSS on the tenant's first-party origin
 * even though its MIME type looks image-y. Re-exported by routes/site.ts for
 * the routes that were written against that import.
 */
export const ALLOWED_IMAGE_TYPES: Set<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export type ImageFormat = "webp" | "jpeg";
export type ImageVariant = { w: number; format: ImageFormat; key: string; bytes: number };

/**
 * The widths the editor produces; a variant upload may only carry these.
 *
 * 240 is here for the small slots — a header logo sits in a 44 px-tall box
 * and an officer's photo in a thumbnail, and 480 was four times more pixels
 * than either needs. It is the width every page pays for, so it is the one
 * worth having.
 */
export const VARIANT_WIDTHS = [240, 480, 960, 1600, 2400] as const;

/**
 * The width to request for a site logo. The header renders it 44 px tall, so
 * 240 covers a wide wordmark at 2x and is the smallest stored variant. A file
 * with no variant this small serves the next one up, and a file with none at
 * all serves the original — which is exactly the case this width exists to
 * stop being the norm.
 */
export const LOGO_WIDTH = 240;

/** `url` with `w=<width>`, keeping any query it already carries. */
export function withWidth(url: string, width: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}w=${width}`;
}

/** Maximum width/height the server records for an original (guards the columns against junk). */
export const MAX_IMAGE_DIMENSION = 12000;

const CONTENT_TYPE_FOR: Record<ImageFormat, string> = { webp: "image/webp", jpeg: "image/jpeg" };
/** Extension used in the R2 key for each format (`w960.jpg`, `w960.webp`). */
export const EXT_FOR: Record<ImageFormat, string> = { webp: "webp", jpeg: "jpg" };

/** "jpg" and "jpeg" both mean JPEG; anything else is not a variant format. */
export function normalizeFormat(raw: unknown): ImageFormat | undefined {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "webp") return "webp";
  if (s === "jpeg" || s === "jpg") return "jpeg";
  return undefined;
}

/** files.variants_json -> variants. Malformed JSON and malformed entries are dropped, never thrown. */
export function parseVariants(json: string | null | undefined): ImageVariant[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ImageVariant[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const format = normalizeFormat(v.format);
    if (!format) continue;
    if (typeof v.w !== "number" || !Number.isInteger(v.w) || v.w <= 0) continue;
    if (typeof v.key !== "string" || !v.key) continue;
    if (typeof v.bytes !== "number" || !Number.isFinite(v.bytes) || v.bytes < 0) continue;
    out.push({ w: v.w, format, key: v.key, bytes: v.bytes });
  }
  return out;
}

function acceptsWebp(accept: string | undefined): boolean {
  return !!accept && /(^|[\s,])image\/webp\s*(;|,|$)/i.test(accept);
}

/**
 * Choose the stored variant to serve.
 *  - Format: the explicit `wantFormat` if any variant has it; else WebP when
 *    the Accept header lists image/webp; else JPEG. If the preferred format
 *    has no variants at all, the other format is used.
 *  - Width: the smallest stored `w >= wantW`; if none is that large (or no
 *    width was asked for), the largest stored width.
 * Returns null only when `variants` is empty.
 */
export function pickVariant(
  variants: ImageVariant[],
  wantW?: number,
  wantFormat?: ImageFormat,
  accept?: string
): ImageVariant | null {
  if (!variants.length) return null;
  const explicit = normalizeFormat(wantFormat);
  const preferred: ImageFormat = explicit ?? (acceptsWebp(accept) ? "webp" : "jpeg");
  let pool = variants.filter((v) => v.format === preferred);
  if (!pool.length) pool = variants.filter((v) => v.format === (preferred === "webp" ? "jpeg" : "webp"));
  if (!pool.length) return null;
  const sorted = [...pool].sort((a, b) => a.w - b.w);
  const want = typeof wantW === "number" && Number.isFinite(wantW) && wantW > 0 ? wantW : undefined;
  if (want !== undefined) {
    const atLeast = sorted.find((v) => v.w >= want);
    if (atLeast) return atLeast;
  }
  return sorted[sorted.length - 1];
}

/** `srcset` attribute value: one candidate per distinct positive width, ascending. */
export function srcsetFor(urlFor: (w: number) => string, widths: number[]): string {
  const ws = [...new Set(widths.filter((w) => Number.isFinite(w) && w > 0))].sort((a, b) => a - b);
  return ws.map((w) => `${urlFor(w)} ${w}w`).join(", ");
}

export type ImageSizeKind = "hero" | "split" | "grid" | "single";

/** `sizes` hint per layout: full-bleed, half of the row, a third of the row, or one content column. */
export function sizesFor(kind: ImageSizeKind): string {
  switch (kind) {
    case "hero":
      return "100vw";
    case "split":
      return "(max-width: 720px) 100vw, 50vw";
    case "grid":
      return "(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 33vw";
    case "single":
    default:
      return "(max-width: 1100px) 100vw, 1100px";
  }
}

export type Focal = [number, number];

function isUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** files.focal_json -> [x, y] in 0..1, or undefined when absent/malformed. */
export function parseFocal(json: string | null | undefined): Focal | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
  const [x, y] = parsed;
  return isUnit(x) && isUnit(y) ? [x, y] : undefined;
}

/** CSS `object-position` for a focal point; centred when none is set. Input is clamped. */
export function focalToObjectPosition(focal?: Focal): string {
  if (!focal) return "50% 50%";
  const pct = (n: number) => `${Math.round(Math.min(1, Math.max(0, Number(n) || 0)) * 100)}%`;
  return `${pct(focal[0])} ${pct(focal[1])}`;
}

// ---------------------------------------------------------------------------
// serveImage
// ---------------------------------------------------------------------------

/** The columns every image route selects: `SELECT id, tenant_id, r2_key, content_type, variants_json, width, height FROM files …`. */
export type ImageRow = {
  id: string;
  tenant_id: string;
  r2_key: string;
  content_type: string | null;
  variants_json: string | null;
  width: number | null;
  height: number | null;
};

export const IMAGE_ROW_COLUMNS = "id, tenant_id, r2_key, content_type, variants_json, width, height";

const IMMUTABLE = "public, max-age=31536000, immutable";

function parseWantW(url: URL): number | undefined {
  const raw = url.searchParams.get("w");
  if (raw === null) return undefined;
  if (!/^\d{1,5}$/.test(raw.trim())) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

/**
 * Serve a tenant image row. Picks a stored variant per `?w=` / `?f=` (format
 * negotiated from `Accept` when `?f` is absent -> `Vary: Accept`), streams it
 * from R2, and falls back to the original when the file has no variants or
 * the chosen variant object is gone. The original is only ever served with
 * its stored raster type; a row whose content_type is outside
 * ALLOWED_IMAGE_TYPES is treated as missing. Returns null when nothing can
 * be served -- the caller decides how to 404.
 *
 * Every route that hands back a `files` row as an image must go through
 * here; the caller's only jobs are the tenant-scoped SELECT and the 404.
 */
export async function serveImage(
  env: Pick<Env, "FILES">,
  row: ImageRow,
  url: URL,
  acceptHeader: string | undefined
): Promise<Response | null> {
  const originalType = row.content_type || "";
  if (!ALLOWED_IMAGE_TYPES.has(originalType)) return null;

  const variants = parseVariants(row.variants_json);
  if (variants.length) {
    const wantW = parseWantW(url);
    const wantFormat = normalizeFormat(url.searchParams.get("f"));
    const pick = pickVariant(variants, wantW, wantFormat, acceptHeader);
    if (pick) {
      const obj = await env.FILES.get(pick.key);
      if (obj) {
        const headers: Record<string, string> = {
          "Content-Type": CONTENT_TYPE_FOR[pick.format],
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": IMMUTABLE,
        };
        // Only when the format came from Accept does the response depend on it.
        if (!wantFormat) headers.Vary = "Accept";
        return new Response(obj.body, { headers });
      }
    }
  }

  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return null;
  return new Response(obj.body, {
    headers: {
      "Content-Type": originalType,
      // Belt-and-suspenders alongside the allowlist: the browser may not
      // sniff the body into a different interpretation.
      "X-Content-Type-Options": "nosniff",
      // File ids are immutable -- a replaced image gets a new id, so this can
      // be cached forever without a purge.
      "Cache-Control": IMMUTABLE,
    },
  });
}
