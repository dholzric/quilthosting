/**
 * Public REST API (v1) for Zapier / integrations.
 * Auth: Authorization: Bearer qh_...
 */
import { Hono } from "hono";
import type { Env, Tenant } from "../types";
import { all, first } from "../lib/db";
import { extractApiKey, hashApiKey } from "../lib/apiKeys";

export const v1Routes = new Hono<{ Bindings: Env }>();

type ApiKeyRow = {
  id: string;
  tenant_id: string;
  key_hash: string;
  scopes_json: string;
  revoked_at: string | null;
};

async function requireApiKey(
  c: any
): Promise<{ tenant: Tenant; scopes: string[] } | Response> {
  const raw = extractApiKey(
    c.req.header("Authorization"),
    c.req.query("api_key")
  );
  if (!raw) {
    return c.json({ error: "Missing API key. Use Authorization: Bearer qh_…" }, 401);
  }
  const prefix = raw.slice(0, 12);
  const hash = await hashApiKey(raw);
  let keys: ApiKeyRow[] = [];
  try {
    keys = await all<ApiKeyRow>(
      c.env.DB.prepare(
        `SELECT id, tenant_id, key_hash, scopes_json, revoked_at
         FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL`
      ).bind(prefix)
    );
  } catch {
    return c.json({ error: "API keys not available" }, 503);
  }
  const match = keys.find((k) => k.key_hash === hash);
  if (!match) return c.json({ error: "Invalid API key" }, 401);

  await c.env.DB.prepare(
    `UPDATE api_keys SET last_used_at = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), match.id)
    .run();

  const tenant = await first<Tenant>(
    c.env.DB.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(match.tenant_id)
  );
  if (!tenant || tenant.status === "archived") {
    return c.json({ error: "Tenant inactive" }, 403);
  }
  let scopes: string[] = ["read"];
  try {
    scopes = JSON.parse(match.scopes_json || '["read"]');
  } catch {}
  return { tenant, scopes };
}

function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}

v1Routes.get("/me", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  return c.json({
    tenant: {
      id: auth.tenant.id,
      name: auth.tenant.name,
      slug: auth.tenant.slug,
      plan: auth.tenant.plan,
    },
    scopes: auth.scopes,
  });
});

v1Routes.get("/members", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const status = c.req.query("status");
  const { parsePageParams, pageMeta } = await import("../lib/pagination");
  const { limit, offset } = parsePageParams(
    {
      limit: c.req.query("limit") || undefined,
      offset: c.req.query("offset") || undefined,
      page: c.req.query("page") || undefined,
    },
    { limit: 100, max: 500 }
  );
  let where = `WHERE tenant_id = ?`;
  const binds: (string | number)[] = [auth.tenant.id];
  if (status) {
    where += ` AND status = ?`;
    binds.push(status);
  }
  const countRow = await first<{ cnt: number }>(
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM members ${where}`).bind(
      ...binds
    )
  );
  const total = countRow?.cnt ?? 0;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, email, first_name, last_name, phone, status, joined_at, created_at
       FROM members ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset)
  );
  return c.json({ members: rows, ...pageMeta(total, limit, offset) });
});

v1Routes.get("/events", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, title, description, location, start_at, end_at, capacity,
              member_price_cents, non_member_price_cents, registration_open
       FROM events WHERE tenant_id = ?
       ORDER BY start_at DESC LIMIT 200`
    ).bind(auth.tenant.id)
  );
  return c.json({ events: rows });
});

v1Routes.get("/payments", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, member_id, type, amount_cents, currency, status, description, created_at
       FROM payments WHERE tenant_id = ?
       ORDER BY created_at DESC LIMIT 200`
    ).bind(auth.tenant.id)
  );
  return c.json({ payments: rows });
});

v1Routes.get("/levels", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, name, description, price_cents, duration_months, renewal_type, status
       FROM membership_levels WHERE tenant_id = ? AND status = 'active'
       ORDER BY sort_order, name`
    ).bind(auth.tenant.id)
  );
  return c.json({ levels: rows });
});
