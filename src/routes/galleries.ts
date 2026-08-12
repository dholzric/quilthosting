import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { ALLOWED_IMAGE_TYPES } from "./site";

export const galleryRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables & TenantVariables;
}>();

const PHOTO_MAX = 10 * 1024 * 1024; // 10 MB per photo

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

type GalleryRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  event_id: string | null;
  is_members_only: number;
  published: number;
  sort_order: number;
  created_at: string;
};

// GET /api/tenants/:tenantId/galleries
galleryRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all<GalleryRow & { photo_count: number }>(
    c.env.DB.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM gallery_photos p WHERE p.gallery_id = g.id) photo_count
       FROM galleries g WHERE g.tenant_id = ?
       ORDER BY g.sort_order, g.created_at DESC`
    ).bind(tenant.id)
  );
  return c.json(rows);
});

// POST /api/tenants/:tenantId/galleries
galleryRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    title: string;
    description?: string;
    event_id?: string;
    is_members_only?: boolean;
    published?: boolean;
    sort_order?: number;
  }>();
  if (!body.title) return c.json({ error: "title is required" }, 400);
  const slug = slugify(body.title);
  if (!slug) return c.json({ error: "title must contain letters or numbers" }, 400);
  const dupe = await first(
    c.env.DB.prepare("SELECT id FROM galleries WHERE tenant_id = ? AND slug = ?").bind(
      tenant.id,
      slug
    )
  );
  if (dupe) return c.json({ error: "A gallery with that title already exists" }, 409);
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO galleries
     (id, tenant_id, slug, title, description, event_id, is_members_only, published, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, tenant.id, slug, body.title, body.description ?? null, body.event_id ?? null,
      body.is_members_only ? 1 : 0, body.published === false ? 0 : 1,
      body.sort_order ?? 0, now, now
    )
    .run();
  const gallery = await first<GalleryRow>(
    c.env.DB.prepare("SELECT * FROM galleries WHERE id = ?").bind(id)
  );
  return c.json(gallery, 201);
});

// PATCH /api/tenants/:tenantId/galleries/:galleryId
galleryRoutes.patch("/:galleryId", async (c) => {
  const tenant = c.get("tenant");
  const galleryId = c.req.param("galleryId");
  const existing = await first<GalleryRow>(
    c.env.DB.prepare("SELECT * FROM galleries WHERE id = ? AND tenant_id = ?").bind(
      galleryId,
      tenant.id
    )
  );
  if (!existing) return c.json({ error: "Gallery not found" }, 404);
  const body = await c.req.json<{
    title?: string;
    description?: string;
    is_members_only?: boolean;
    published?: boolean;
    sort_order?: number;
  }>();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE galleries SET
       title = coalesce(?, title),
       description = coalesce(?, description),
       is_members_only = coalesce(?, is_members_only),
       published = coalesce(?, published),
       sort_order = coalesce(?, sort_order),
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.title ?? null,
      body.description ?? null,
      body.is_members_only !== undefined ? (body.is_members_only ? 1 : 0) : null,
      body.published !== undefined ? (body.published ? 1 : 0) : null,
      body.sort_order ?? null,
      now,
      galleryId,
      tenant.id
    )
    .run();
  const gallery = await first<GalleryRow>(
    c.env.DB.prepare("SELECT * FROM galleries WHERE id = ?").bind(galleryId)
  );
  return c.json(gallery);
});

// DELETE /api/tenants/:tenantId/galleries/:galleryId (also clears R2 objects)
galleryRoutes.delete("/:galleryId", async (c) => {
  const tenant = c.get("tenant");
  const galleryId = c.req.param("galleryId");
  const photos = await all<{ id: string; file_id: string; r2_key: string }>(
    c.env.DB.prepare(
      `SELECT p.id, p.file_id, f.r2_key FROM gallery_photos p
       JOIN files f ON f.id = p.file_id
       WHERE p.gallery_id = ? AND p.tenant_id = ?`
    ).bind(galleryId, tenant.id)
  );
  for (const ph of photos) {
    try {
      await c.env.FILES.delete(ph.r2_key);
    } catch {
      /* best effort */
    }
  }
  if (photos.length) {
    const stmts = photos.map((ph) =>
      c.env.DB.prepare("DELETE FROM files WHERE id = ? AND tenant_id = ?").bind(
        ph.file_id,
        tenant.id
      )
    );
    for (let i = 0; i < stmts.length; i += 25) await c.env.DB.batch(stmts.slice(i, i + 25));
  }
  const res = await c.env.DB.prepare(
    "DELETE FROM galleries WHERE id = ? AND tenant_id = ?"
  )
    .bind(galleryId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Gallery not found" }, 404);
  return c.json({ ok: true, photos_deleted: photos.length });
});

// GET photos in a gallery
galleryRoutes.get("/:galleryId/photos", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, caption, credit, sort_order, created_at FROM gallery_photos
       WHERE tenant_id = ? AND gallery_id = ? ORDER BY sort_order, created_at`
    ).bind(tenant.id, c.req.param("galleryId"))
  );
  return c.json(rows);
});

// POST /api/tenants/:tenantId/galleries/:galleryId/photos?filename=&caption=
galleryRoutes.post("/:galleryId/photos", async (c) => {
  const tenant = c.get("tenant");
  const user = c.get("user");
  const galleryId = c.req.param("galleryId");
  const gallery = await first<{ id: string }>(
    c.env.DB.prepare("SELECT id FROM galleries WHERE id = ? AND tenant_id = ?").bind(
      galleryId,
      tenant.id
    )
  );
  if (!gallery) return c.json({ error: "Gallery not found" }, 404);

  const contentType = c.req.header("Content-Type") || "";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "Photos must be images (JPEG, PNG, WebP)" }, 400);
  }
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) return c.json({ error: "Empty file" }, 400);
  if (bytes.byteLength > PHOTO_MAX) {
    return c.json({ error: "Photos must be under 10 MB" }, 413);
  }

  const filename = (c.req.query("filename") || "photo.jpg").replace(/[\\/]/g, "_").trim();
  const fileId = generateId();
  const key = `${tenant.id}/${fileId}/${filename}`;
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType } });
  const now = new Date().toISOString();
  const photoId = generateId();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(fileId, tenant.id, key, filename, contentType, bytes.byteLength, user.id, now),
    c.env.DB.prepare(
      `INSERT INTO gallery_photos (id, tenant_id, gallery_id, file_id, caption, credit, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      photoId, tenant.id, galleryId, fileId,
      c.req.query("caption") || null, c.req.query("credit") || null,
      Number(c.req.query("sort_order")) || 0, now
    ),
  ]);
  return c.json({ ok: true, id: photoId, size: bytes.byteLength }, 201);
});

// DELETE a photo
galleryRoutes.delete("/:galleryId/photos/:photoId", async (c) => {
  const tenant = c.get("tenant");
  const row = await first<{ file_id: string; r2_key: string }>(
    c.env.DB.prepare(
      `SELECT p.file_id, f.r2_key FROM gallery_photos p JOIN files f ON f.id = p.file_id
       WHERE p.id = ? AND p.tenant_id = ? AND p.gallery_id = ?`
    ).bind(c.req.param("photoId"), tenant.id, c.req.param("galleryId"))
  );
  if (!row) return c.json({ error: "Photo not found" }, 404);
  try {
    await c.env.FILES.delete(row.r2_key);
  } catch {
    /* best effort */
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM gallery_photos WHERE id = ?").bind(c.req.param("photoId")),
    c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(row.file_id),
  ]);
  return c.json({ ok: true });
});

/** Admin/member photo bytes (works for members-only galleries too). */
galleryRoutes.get("/:galleryId/photos/:photoId/raw", async (c) => {
  const tenant = c.get("tenant");
  const row = await first<{ r2_key: string; content_type: string | null }>(
    c.env.DB.prepare(
      `SELECT f.r2_key, f.content_type FROM gallery_photos p JOIN files f ON f.id = p.file_id
       WHERE p.id = ? AND p.tenant_id = ?`
    ).bind(c.req.param("photoId"), tenant.id)
  );
  if (!row) return c.json({ error: "Photo not found" }, 404);
  // Same reasoning as site.ts's /img/:fileId: this route serves from the
  // shared `files` table, which now also holds content anonymous members of
  // the public uploaded (the P1 longarm project intake). Echoing back
  // whatever content_type was recorded at upload time would let a stored
  // non-image type execute as same-origin content; allowlist real raster
  // image types and 404 on anything else, and set nosniff as a
  // belt-and-suspenders against the browser guessing a different
  // interpretation of the (already-allowlisted) body.
  const contentType = row.content_type || "";
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    return c.json({ error: "Photo not found" }, 404);
  }
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "Photo data missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
