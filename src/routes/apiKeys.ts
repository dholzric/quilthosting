import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { mintApiKey } from "../lib/apiKeys";

export const apiKeyRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

apiKeyRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT id, name, key_prefix, scopes_json, last_used_at, revoked_at, created_at
         FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

apiKeyRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{ name?: string; scopes?: string[] }>();
  const name = (body.name || "API key").trim().slice(0, 80);
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s) => ["read", "write"].includes(s))
    : ["read"];
  if (!scopes.length) scopes.push("read");
  const { id, raw, prefix, hash } = await mintApiKey();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, tenant.id, name, prefix, hash, JSON.stringify(scopes), now)
    .run();
  return c.json(
    {
      id,
      name,
      key_prefix: prefix,
      scopes,
      created_at: now,
      /** Shown once — store securely. */
      api_key: raw,
    },
    201
  );
});

apiKeyRoutes.delete("/:keyId", async (c) => {
  const tenant = c.get("tenant");
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`
  )
    .bind(now, c.req.param("keyId"), tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
