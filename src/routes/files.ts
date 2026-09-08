import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { sniffImageType } from "../lib/projects/imageSniff";

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
};

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
const LOGO_MAX = 2 * 1024 * 1024; // 2 MB

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
      `SELECT id, filename, content_type, size, created_at
       FROM files WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`
    ).bind(tenant.id)
  );
  return c.json(rows);
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

  const profile = { ...(settings.profile || {}), logo_file_id: id };
  settings.profile = profile;
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

/** DELETE /api/tenants/:tenantId/files/logo */
fileRoutes.delete("/logo", async (c) => {
  const tenant = c.get("tenant");
  const settings = parseSettings(tenant.settings_json);
  const profile = { ...(settings.profile || {}) };
  const oldId = profile.logo_file_id as string | undefined;
  delete profile.logo_file_id;
  settings.profile = profile;
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
