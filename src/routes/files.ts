import { Hono } from "hono";
import { z } from "zod";
import type { Env, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { sniffImageType } from "../lib/projects/imageSniff";
import {
  ALLOWED_IMAGE_TYPES,
  EXT_FOR,
  MAX_IMAGE_DIMENSION,
  VARIANT_WIDTHS,
  normalizeFormat,
  parseFocal,
  parseVariants,
  type ImageFormat,
  type ImageVariant,
} from "../lib/images";

export const fileRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables & TenantVariables;
}>();

type FileRow = {
  id: string;
  r2_key: string;
  filename: string;
  content_type: string | null;
  size: number | null;
  created_at: string;
  width?: number | null;
  height?: number | null;
  variants_json?: string | null;
  focal_json?: string | null;
  alt?: string | null;
};

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
const LOGO_MAX = 2 * 1024 * 1024; // 2 MB
const VARIANT_PART_MAX = 6 * 1024 * 1024; // 6 MB per variant
const VARIANTS_TOTAL_MAX = 25 * 1024 * 1024; // 25 MB per upload
const VARIANT_PARTS_MAX = VARIANT_WIDTHS.length * 2; // every width in both formats

function parseSettings(json: string | null | undefined): Record<string, any> {
  try {
    return JSON.parse(json || "{}") || {};
  } catch {
    return {};
  }
}

/**
 * Content types a browser will execute or render as active same-origin
 * content if served inline: HTML, any flavour of XML (XSLT `<?xml-stylesheet?>`
 * runs script; SVG is XML), script MIME types, and Flash. The generic document
 * upload accepts any type, so these are normalised to `application/octet-stream`
 * AT UPLOAD TIME -- then no serving route can ever hand them back with an
 * active Content-Type, regardless of whether that route sets
 * Content-Disposition. Cheaper and more robust than trusting every reader.
 */
// "xml" is matched as a subtype (`/xml`, `+xml`) rather than a substring so
// Office types like application/vnd.openxmlformats-... keep their real type.
const ACTIVE_CONTENT_TYPE_RE = /html|\/xml|\+xml|svg|javascript|ecmascript|vbscript|jscript|shockwave|x-httpd|php/i;

export function normalizeStoredContentType(declared: string | null | undefined): string {
  const ct = String(declared || "").trim();
  if (!ct) return "application/octet-stream";
  if (ACTIVE_CONTENT_TYPE_RE.test(ct)) return "application/octet-stream";
  // Drop parameters like "; charset=utf-8" so the stored type is canonical,
  // and cap the length so a hostile header can't bloat the row.
  return ct.split(";")[0].trim().toLowerCase().slice(0, 100) || "application/octet-stream";
}

const LOGO_ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Canonicalise the declared image type (browsers and tools disagree on jpg/jpeg, x-png, etc.). */
function canonicalImageType(declared: string): string {
  const base = declared.split(";")[0].trim().toLowerCase();
  if (base === "image/jpg" || base === "image/pjpeg") return "image/jpeg";
  if (base === "image/x-png") return "image/png";
  return base;
}

/** Cheap belt-and-suspenders: does the leading window of bytes look like markup? */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 1024))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<script");
}

// GET /api/tenants/:tenantId/files
fileRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all<FileRow>(
    c.env.DB.prepare(
      `SELECT id, filename, content_type, size, created_at, width, height, variants_json, focal_json, alt
       FROM files WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`
    ).bind(tenant.id)
  );
  return c.json(
    rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      content_type: r.content_type,
      size: r.size,
      created_at: r.created_at,
      width: r.width ?? null,
      height: r.height ?? null,
      focal: parseFocal(r.focal_json) ?? null,
      alt: r.alt ?? null,
      has_variants: parseVariants(r.variants_json).length > 0,
    }))
  );
});

// POST /api/tenants/:tenantId/files — raw body upload, ?filename= required
fileRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const user = c.get("user");
  const filename = (c.req.query("filename") || "").replace(/[\\/]/g, "_").trim();
  if (!filename) return c.json({ error: "filename query param is required" }, 400);
  // Active content types (HTML/XML/SVG/script) are stored as octet-stream so
  // no serving route can ever render them inline as same-origin content.
  const contentType = normalizeStoredContentType(c.req.header("Content-Type"));
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) return c.json({ error: "Empty file" }, 400);
  if (bytes.byteLength > MAX_SIZE) return c.json({ error: "File too large (25 MB max)" }, 413);

  const id = generateId();
  const key = `${tenant.id}/${id}/${filename}`;
  await c.env.FILES.put(key, bytes, {
    httpMetadata: { contentType },
  });
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, tenant.id, key, filename, contentType, bytes.byteLength, user.id, now)
    .run();
  return c.json({ id, filename, size: bytes.byteLength, created_at: now }, 201);
});

/**
 * POST /api/tenants/:tenantId/files/logo — upload guild logo (raster image, raw body)
 * Registered before /:fileId so "logo" is not treated as a file id.
 *
 * The logo is served INLINE by GET /public/:slug/logo, so it must be a real
 * raster image: SVG is active content (inline <script>, onload handlers) and
 * is rejected outright, and the declared Content-Type must be backed by the
 * file's magic bytes -- the stored content_type is the sniffed one, never the
 * client's header.
 */
fileRoutes.post("/logo", async (c) => {
  const tenant = c.get("tenant");
  const user = c.get("user");
  const declared = c.req.header("Content-Type") || "";
  const declaredLower = declared.toLowerCase();
  if (!declaredLower.startsWith("image/")) {
    return c.json({ error: "Logo must be an image (PNG, JPEG, GIF, or WebP)" }, 400);
  }
  if (declaredLower.includes("svg") || declaredLower.includes("xml")) {
    return c.json({ error: "SVG logos are not supported; upload a PNG, JPEG, GIF, or WebP" }, 415);
  }
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) return c.json({ error: "Empty file" }, 400);
  if (bytes.byteLength > LOGO_MAX) {
    return c.json({ error: "Logo must be under 2 MB" }, 413);
  }
  const view = new Uint8Array(bytes);
  if (looksLikeMarkup(view)) {
    return c.json({ error: "SVG logos are not supported; upload a PNG, JPEG, GIF, or WebP" }, 415);
  }
  const sniffed = sniffImageType(view);
  if (!sniffed || !LOGO_ALLOWED_TYPES.has(sniffed)) {
    return c.json({ error: "Logo must be a PNG, JPEG, GIF, or WebP image" }, 415);
  }
  if (canonicalImageType(declared) !== sniffed) {
    return c.json(
      { error: `Declared type ${canonicalImageType(declared)} does not match the file contents (${sniffed})` },
      415
    );
  }
  const contentType = sniffed;

  const settings = parseSettings(tenant.settings_json);
  const oldId = settings.profile?.logo_file_id as string | undefined;

  const ext = contentType === "image/png"
    ? "png"
    : contentType === "image/webp"
      ? "webp"
      : contentType === "image/gif"
        ? "gif"
        : contentType === "image/avif"
          ? "avif"
          : "jpg";
  const id = generateId();
  const filename = `logo.${ext}`;
  const key = `${tenant.id}/${id}/${filename}`;
  await c.env.FILES.put(key, bytes, {
    httpMetadata: { contentType },
  });
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, tenant.id, key, filename, contentType, bytes.byteLength, user.id, now)
    .run();

  // BOTH keys, the same way PATCH /api/tenants/:id does: the settings screen
  // and onboarding.ts read settings.profile.logo_file_id, while the site
  // renderer (routes/site.ts) and the site builder read
  // settings.assets.logo_file_id. Writing only `profile` here is why a logo
  // uploaded from Settings -> Public profile never appeared on the site.
  settings.profile = { ...(settings.profile || {}), logo_file_id: id };
  settings.assets = { ...(isRecord(settings.assets) ? settings.assets : {}), logo_file_id: id };
  await c.env.DB.prepare(
    `UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(JSON.stringify(settings), now, tenant.id)
    .run();

  // Best-effort cleanup of previous logo file
  if (oldId && oldId !== id) {
    try {
      const row = await first<FileRow>(
        c.env.DB.prepare(
          "SELECT * FROM files WHERE id = ? AND tenant_id = ?"
        ).bind(oldId, tenant.id)
      );
      if (row) {
        await c.env.FILES.delete(row.r2_key);
        await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(oldId).run();
      }
    } catch {
      /* ignore */
    }
  }

  return c.json(
    {
      ok: true,
      logo_file_id: id,
      logo_url: `/public/${tenant.slug}/logo`,
      size: bytes.byteLength,
    },
    201
  );
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** DELETE /api/tenants/:tenantId/files/logo */
fileRoutes.delete("/logo", async (c) => {
  const tenant = c.get("tenant");
  const settings = parseSettings(tenant.settings_json);
  const profile = { ...(settings.profile || {}) };
  const assets = { ...(isRecord(settings.assets) ? settings.assets : {}) };
  const oldId = (profile.logo_file_id || assets.logo_file_id) as string | undefined;
  // Clear both keys, or the renderer keeps showing a logo the owner removed.
  delete profile.logo_file_id;
  delete assets.logo_file_id;
  settings.profile = profile;
  settings.assets = assets;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(JSON.stringify(settings), now, tenant.id)
    .run();
  if (oldId) {
    const row = await first<FileRow>(
      c.env.DB.prepare(
        "SELECT * FROM files WHERE id = ? AND tenant_id = ?"
      ).bind(oldId, tenant.id)
    );
    if (row) {
      await c.env.FILES.delete(row.r2_key);
      await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(oldId).run();
    }
  }
  return c.json({ ok: true });
});

// GET /api/tenants/:tenantId/files/:fileId/download
fileRoutes.get("/:fileId/download", async (c) => {
  const tenant = c.get("tenant");
  const fileId = c.req.param("fileId");
  if (fileId === "logo") return c.json({ error: "Use GET /public/:slug/logo" }, 400);
  const row = await first<FileRow>(
    c.env.DB.prepare(
      "SELECT * FROM files WHERE id = ? AND tenant_id = ?"
    ).bind(fileId, tenant.id)
  );
  if (!row) return c.json({ error: "File not found" }, 404);
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "File data missing" }, 404);
  return new Response(obj.body, {
    headers: {
      // Re-normalise on the way out too: rows stored before upload-time
      // normalisation existed may still carry text/html or image/svg+xml.
      "Content-Type": normalizeStoredContentType(row.content_type),
      "Content-Disposition": `attachment; filename="${row.filename.replace(/["\r\n]/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// Part names the variants upload accepts: w<width>.<ext> for the canonical
// widths, in WebP or JPEG. Anything else is a 400 -- the server never
// invents a width or a format from a client's file name.
const VARIANT_PART_RE = /^w(\d{3,4})\.(webp|jpg)$/;
const SNIFFED_FOR: Record<ImageFormat, string> = { webp: "image/webp", jpeg: "image/jpeg" };

/** Positive integer <= MAX_IMAGE_DIMENSION from a header, else undefined. */
function parseDimension(raw: string | undefined): number | undefined {
  const s = (raw || "").trim();
  if (!/^\d{1,5}$/.test(s)) return undefined;
  const n = Number(s);
  return n > 0 && n <= MAX_IMAGE_DIMENSION ? n : undefined;
}

/**
 * POST /api/tenants/:tenantId/files/:fileId/variants — store browser-made
 * responsive variants of an already-uploaded raster image.
 *
 * Multipart body, parts named `w480.webp`, `w480.jpg`, `w960.webp`, …
 * `w2400.jpg` (up to 8). Every part is re-validated from its BYTES with
 * sniffImageType and must match the format its name declares -- the
 * client's Content-Type and file name are never trusted. Nothing is written
 * to R2 until every part has passed, so a bad part means nothing is stored.
 * Variants land at `${r2_key}/w<w>.<ext>`; `variants_json` is merged by
 * (w, format) so a second batch keeps the first; `width`/`height` of the
 * original are recorded from `X-Image-Width`/`X-Image-Height` only when
 * both are positive integers <= 12000.
 */
fileRoutes.post("/:fileId/variants", async (c) => {
  const tenant = c.get("tenant");
  const fileId = c.req.param("fileId");
  if (fileId === "logo") return c.json({ error: "Not found" }, 404);
  const row = await first<FileRow>(
    c.env.DB.prepare(
      "SELECT id, r2_key, filename, content_type, size, created_at, width, height, variants_json FROM files WHERE id = ? AND tenant_id = ?"
    ).bind(fileId, tenant.id)
  );
  if (!row) return c.json({ error: "File not found" }, 404);
  if (!ALLOWED_IMAGE_TYPES.has(row.content_type || "")) {
    return c.json({ error: "Variants can only be added to a PNG, JPEG, GIF, WebP, or AVIF image" }, 415);
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Expected a multipart/form-data body" }, 400);

  const incoming: { w: number; format: ImageFormat; bytes: ArrayBuffer }[] = [];
  let total = 0;
  for (const [name, value] of form.entries()) {
    const m = VARIANT_PART_RE.exec(name);
    if (!m) return c.json({ error: `Unexpected part "${name.slice(0, 40)}"; expected w<width>.webp or w<width>.jpg` }, 400);
    const w = Number(m[1]);
    if (!(VARIANT_WIDTHS as readonly number[]).includes(w)) {
      return c.json({ error: `Unsupported variant width ${w}; expected one of ${VARIANT_WIDTHS.join(", ")}` }, 400);
    }
    const format = normalizeFormat(m[2])!;
    if (typeof value === "string") return c.json({ error: `Part "${name}" must be a file` }, 400);
    if (incoming.length >= VARIANT_PARTS_MAX) return c.json({ error: `At most ${VARIANT_PARTS_MAX} variants per upload` }, 400);
    if (value.size > VARIANT_PART_MAX) return c.json({ error: `Variant ${name} is too large (6 MB max)` }, 413);
    total += value.size;
    if (total > VARIANTS_TOTAL_MAX) return c.json({ error: "Variants total too large (25 MB max)" }, 413);
    const bytes = await value.arrayBuffer();
    if (!bytes.byteLength) return c.json({ error: `Variant ${name} is empty` }, 400);
    const sniffed = sniffImageType(new Uint8Array(bytes));
    if (sniffed !== SNIFFED_FOR[format]) {
      return c.json(
        { error: `Variant ${name} does not contain ${SNIFFED_FOR[format]} data${sniffed ? ` (found ${sniffed})` : ""}` },
        415
      );
    }
    incoming.push({ w, format, bytes });
  }
  if (!incoming.length) return c.json({ error: "No variants in the body" }, 400);

  // Every part validated -- now write. Variants are keyed by (w, format);
  // a re-upload of the same slot replaces it.
  const merged = new Map<string, ImageVariant>();
  for (const v of parseVariants(row.variants_json)) merged.set(`${v.w}.${v.format}`, v);
  for (const v of incoming) {
    const key = `${row.r2_key}/w${v.w}.${EXT_FOR[v.format]}`;
    await c.env.FILES.put(key, v.bytes, { httpMetadata: { contentType: SNIFFED_FOR[v.format] } });
    merged.set(`${v.w}.${v.format}`, { w: v.w, format: v.format, key, bytes: v.bytes.byteLength });
  }
  const variants = [...merged.values()].sort((a, b) => a.w - b.w || a.format.localeCompare(b.format));

  const width = parseDimension(c.req.header("X-Image-Width"));
  const height = parseDimension(c.req.header("X-Image-Height"));
  const sets = ["variants_json = ?"];
  const binds: unknown[] = [JSON.stringify(variants)];
  if (width !== undefined && height !== undefined) {
    sets.push("width = ?", "height = ?");
    binds.push(width, height);
  }
  await c.env.DB.prepare(`UPDATE files SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
    .bind(...binds, fileId, tenant.id)
    .run();

  return c.json({
    id: fileId,
    variants,
    width: width !== undefined && height !== undefined ? width : (row.width ?? null),
    height: width !== undefined && height !== undefined ? height : (row.height ?? null),
  });
});

const unit = z.number().min(0).max(1);
const patchFileSchema = z
  .object({
    focal: z.tuple([unit, unit]).nullable().optional(),
    alt: z.string().max(200).nullable().optional(),
  })
  .strict()
  .refine((b) => b.focal !== undefined || b.alt !== undefined, { message: "Provide focal and/or alt" });

/**
 * PATCH /api/tenants/:tenantId/files/:fileId — focal point (`[x, y]` in
 * 0..1, stored as focal_json) and/or alt text (<= 200 chars). `null` clears
 * either. Only the fields present are written.
 */
fileRoutes.patch("/:fileId", async (c) => {
  const tenant = c.get("tenant");
  const fileId = c.req.param("fileId");
  if (fileId === "logo") return c.json({ error: "Use POST /files/logo" }, 400);
  const raw = await c.req.json().catch(() => null);
  const parsed = patchFileSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const row = await first<FileRow>(
    c.env.DB.prepare("SELECT id, focal_json, alt FROM files WHERE id = ? AND tenant_id = ?").bind(fileId, tenant.id)
  );
  if (!row) return c.json({ error: "File not found" }, 404);

  const sets: string[] = [];
  const binds: unknown[] = [];
  let focal = parseFocal(row.focal_json) ?? null;
  let alt = row.alt ?? null;
  if (body.focal !== undefined) {
    focal = body.focal;
    sets.push("focal_json = ?");
    binds.push(focal ? JSON.stringify(focal) : null);
  }
  if (body.alt !== undefined) {
    alt = body.alt === null ? null : body.alt.trim() || null;
    sets.push("alt = ?");
    binds.push(alt);
  }
  await c.env.DB.prepare(`UPDATE files SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
    .bind(...binds, fileId, tenant.id)
    .run();
  return c.json({ ok: true, id: fileId, focal, alt });
});

// DELETE /api/tenants/:tenantId/files/:fileId
fileRoutes.delete("/:fileId", async (c) => {
  const tenant = c.get("tenant");
  const fileId = c.req.param("fileId");
  if (fileId === "logo") {
    // Should not hit if /logo registered first; safety net
    return c.json({ error: "Use DELETE /files/logo" }, 400);
  }
  const row = await first<FileRow>(
    c.env.DB.prepare(
      "SELECT * FROM files WHERE id = ? AND tenant_id = ?"
    ).bind(fileId, tenant.id)
  );
  if (!row) return c.json({ error: "File not found" }, 404);
  await c.env.FILES.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(fileId).run();
  return c.json({ ok: true });
});
