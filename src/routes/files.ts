import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

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
  const contentType = c.req.header("Content-Type") || "application/octet-stream";
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
 * POST /api/tenants/:tenantId/files/logo — upload guild logo (image/*, raw body)
 * Registered before /:fileId so "logo" is not treated as a file id.
 */
fileRoutes.post("/logo", async (c) => {
  const tenant = c.get("tenant");
  const user = c.get("user");
  const contentType = c.req.header("Content-Type") || "";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "Logo must be an image (PNG, JPEG, WebP, or SVG)" }, 400);
  }
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) return c.json({ error: "Empty file" }, 400);
  if (bytes.byteLength > LOGO_MAX) {
    return c.json({ error: "Logo must be under 2 MB" }, 413);
  }

  const settings = parseSettings(tenant.settings_json);
  const oldId = settings.profile?.logo_file_id as string | undefined;

  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
      ? "webp"
      : contentType.includes("svg")
        ? "svg"
        : contentType.includes("gif")
          ? "gif"
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
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
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
