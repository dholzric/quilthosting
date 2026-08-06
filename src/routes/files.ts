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

// GET /api/tenants/:tenantId/files/:fileId/download
fileRoutes.get("/:fileId/download", async (c) => {
  const tenant = c.get("tenant");
  const fileId = c.req.param("fileId");
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
