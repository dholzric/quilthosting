import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { normalizeFormFields, slugify } from "../lib/forms";

export const formRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type FormRow = {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  form_type: string;
  fields_json: string;
  is_public: number;
  published: number;
  created_at: string;
  updated_at: string;
};

formRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all<FormRow>(
      c.env.DB.prepare(
        `SELECT * FROM forms WHERE tenant_id = ? ORDER BY updated_at DESC`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

formRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    name: string;
    description?: string;
    form_type?: string;
    fields?: unknown;
    is_public?: boolean;
    published?: boolean;
    slug?: string;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const slug = slugify(body.slug || name) || generateId().slice(0, 8);
  const fields = normalizeFormFields(body.fields || []);
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO forms
     (id, tenant_id, name, slug, description, form_type, fields_json, is_public, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      name,
      slug,
      body.description?.trim() || null,
      body.form_type === "application" ? "application" : body.form_type === "general" ? "general" : "survey",
      JSON.stringify(fields),
      body.is_public === false ? 0 : 1,
      body.published === false ? 0 : 1,
      now,
      now
    )
    .run();
  const row = await first<FormRow>(
    c.env.DB.prepare(`SELECT * FROM forms WHERE id = ?`).bind(id)
  );
  return c.json(row, 201);
});

formRoutes.patch("/:formId", async (c) => {
  const tenant = c.get("tenant");
  const formId = c.req.param("formId");
  const existing = await first<FormRow>(
    c.env.DB.prepare(`SELECT * FROM forms WHERE id = ? AND tenant_id = ?`).bind(
      formId,
      tenant.id
    )
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    form_type?: string;
    fields?: unknown;
    is_public?: boolean;
    published?: boolean;
  }>();
  const fields =
    body.fields !== undefined
      ? JSON.stringify(normalizeFormFields(body.fields))
      : existing.fields_json;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE forms SET
       name = coalesce(?, name),
       description = coalesce(?, description),
       form_type = coalesce(?, form_type),
       fields_json = ?,
       is_public = coalesce(?, is_public),
       published = coalesce(?, published),
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.name?.trim() || null,
      body.description !== undefined ? body.description : null,
      body.form_type || null,
      fields,
      body.is_public !== undefined ? (body.is_public ? 1 : 0) : null,
      body.published !== undefined ? (body.published ? 1 : 0) : null,
      now,
      formId,
      tenant.id
    )
    .run();
  const row = await first<FormRow>(
    c.env.DB.prepare(`SELECT * FROM forms WHERE id = ?`).bind(formId)
  );
  return c.json(row);
});

formRoutes.delete("/:formId", async (c) => {
  const tenant = c.get("tenant");
  const res = await c.env.DB.prepare(
    `DELETE FROM forms WHERE id = ? AND tenant_id = ?`
  )
    .bind(c.req.param("formId"), tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

formRoutes.get("/:formId/responses", async (c) => {
  const tenant = c.get("tenant");
  const formId = c.req.param("formId");
  const form = await first(
    c.env.DB.prepare(`SELECT id FROM forms WHERE id = ? AND tenant_id = ?`).bind(
      formId,
      tenant.id
    )
  );
  if (!form) return c.json({ error: "Not found" }, 404);
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, email, name, answers_json, member_id, created_at
       FROM form_responses WHERE form_id = ? ORDER BY created_at DESC LIMIT 500`
    ).bind(formId)
  );
  return c.json(rows);
});
