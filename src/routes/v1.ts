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

/* -------------------------------------------------------------------------
 * Writes (v0.27.0)
 * ---------------------------------------------------------------------- */

/** 403 unless the key carries the scope. The legacy "write" scope grants all. */
function requireScope(
  c: any,
  auth: { scopes: string[] },
  scope: string
): Response | null {
  if (auth.scopes.includes(scope) || auth.scopes.includes("write")) return null;
  return c.json(
    {
      error: `This API key lacks the "${scope}" scope.`,
      code: "insufficient_scope",
      required: scope,
    },
    403
  );
}

async function hashRequest(body: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(body ?? null));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Idempotency-Key handling.
 *
 * Zapier and Make retry on timeout. Without this, a retried create hits the
 * duplicate-email guard, returns 409, and the Zap reports failure for a member
 * that was in fact created. Replays the original response for a matching
 * retry; 422 when the same key is reused with a different body.
 */
async function withIdempotency(
  c: any,
  tenantId: string,
  body: unknown,
  handler: () => Promise<{ status: number; json: unknown }>
): Promise<Response> {
  const key = c.req.header("Idempotency-Key");
  if (!key) {
    const r = await handler();
    return c.json(r.json, r.status);
  }
  const hash = await hashRequest(body);
  const prior = await first<{
    request_hash: string;
    response_status: number;
    response_json: string;
  }>(
    c.env.DB.prepare(
      `SELECT request_hash, response_status, response_json FROM api_idempotency
       WHERE tenant_id = ? AND idempotency_key = ?`
    ).bind(tenantId, key)
  );
  if (prior) {
    if (prior.request_hash !== hash) {
      return c.json(
        {
          error: "Idempotency-Key reused with a different request body",
          code: "idempotency_key_reuse",
        },
        422
      );
    }
    return c.json(JSON.parse(prior.response_json), prior.response_status);
  }
  const r = await handler();
  // Never cache a 5xx: the caller must be able to retry a transient failure.
  if (r.status < 500) {
    const { generateId } = await import("../lib/utils/id");
    try {
      await c.env.DB.prepare(
        `INSERT INTO api_idempotency
         (id, tenant_id, idempotency_key, request_hash, response_status, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          generateId(),
          tenantId,
          key,
          hash,
          r.status,
          JSON.stringify(r.json),
          new Date().toISOString()
        )
        .run();
    } catch {
      /* unique-index race: a concurrent attempt already stored it */
    }
  }
  return c.json(r.json, r.status);
}

v1Routes.post("/members", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "members:write");
  if (denied) return denied;

  const body = await c.req.json<{
    email?: string;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    status?: string;
  }>();

  return withIdempotency(c, auth.tenant.id, body, async () => {
    if (!body.email) {
      return {
        status: 400,
        json: { error: "email is required", code: "missing_field" },
      };
    }
    const email = body.email.toLowerCase().trim();

    const { MEMBER_STATUSES } = await import("./members");
    const status = body.status ?? "pending";
    if (!MEMBER_STATUSES.includes(status)) {
      return {
        status: 400,
        json: {
          error: "Invalid status",
          code: "invalid_status",
          valid: MEMBER_STATUSES,
        },
      };
    }

    const existing = await first<{ id: string }>(
      c.env.DB.prepare(
        "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
      ).bind(auth.tenant.id, email)
    );
    if (existing) {
      return {
        status: 409,
        json: {
          error: "Member with this email already exists",
          code: "duplicate_email",
          member_id: existing.id,
        },
      };
    }

    if (status === "active") {
      const { assertCanActivateMember } = await import("../lib/plans");
      try {
        await assertCanActivateMember(c.env.DB, auth.tenant, null);
      } catch (e: any) {
        return {
          status: e.status || 402,
          json: { error: e.message, code: e.code || "plan_limit" },
        };
      }
    }

    const { generateId } = await import("../lib/utils/id");
    const id = generateId();
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO members
       (id, tenant_id, email, first_name, last_name, phone, status, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        auth.tenant.id,
        email,
        body.first_name ?? null,
        body.last_name ?? null,
        body.phone ?? null,
        status,
        now,
        now,
        now
      )
      .run();

    const { enqueueEvent } = await import("../lib/webhookOutbox");
    await enqueueEvent(c.env, c.executionCtx, auth.tenant.id, "member.created", {
      member_id: id,
      email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      status,
      source: "api",
    });

    const member = await first(
      c.env.DB.prepare(
        `SELECT id, email, first_name, last_name, phone, status, joined_at, created_at
         FROM members WHERE id = ?`
      ).bind(id)
    );
    return { status: 201, json: { member } };
  });
});

/**
 * email is deliberately immutable here. Admin PATCH allows changing it, but
 * changing the identity key from an integration is a footgun with no merge
 * story: a mistyped Zap would silently split a member history in two.
 */
v1Routes.patch("/members/:memberId", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "members:write");
  if (denied) return denied;

  const memberId = c.req.param("memberId");
  const body = await c.req.json<{
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    status?: string;
  }>();

  return withIdempotency(c, auth.tenant.id, { memberId, ...body }, async () => {
    const existing = await first<{ id: string; email: string; status: string }>(
      c.env.DB.prepare(
        "SELECT id, email, status FROM members WHERE id = ? AND tenant_id = ?"
      ).bind(memberId, auth.tenant.id)
    );
    if (!existing) {
      return {
        status: 404,
        json: { error: "Member not found", code: "not_found" },
      };
    }

    const { MEMBER_STATUSES } = await import("./members");
    if (body.status !== undefined && !MEMBER_STATUSES.includes(body.status)) {
      return {
        status: 400,
        json: {
          error: "Invalid status",
          code: "invalid_status",
          valid: MEMBER_STATUSES,
        },
      };
    }

    if (body.status === "active" && existing.status !== "active") {
      const { assertCanActivateMember } = await import("../lib/plans");
      try {
        await assertCanActivateMember(c.env.DB, auth.tenant, memberId);
      } catch (e: any) {
        return {
          status: e.status || 402,
          json: { error: e.message, code: e.code || "plan_limit" },
        };
      }
    }

    const fields: string[] = [];
    const params: any[] = [];
    for (const key of ["first_name", "last_name", "phone", "status"] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (!fields.length) {
      return {
        status: 400,
        json: { error: "No fields to update", code: "no_fields" },
      };
    }

    fields.push("updated_at = ?");
    params.push(new Date().toISOString(), memberId, auth.tenant.id);
    await c.env.DB.prepare(
      `UPDATE members SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`
    )
      .bind(...params)
      .run();

    const member = await first<{ email: string; status: string }>(
      c.env.DB.prepare(
        `SELECT id, email, first_name, last_name, phone, status, joined_at, created_at
         FROM members WHERE id = ?`
      ).bind(memberId)
    );

    const { enqueueEvent } = await import("../lib/webhookOutbox");
    await enqueueEvent(c.env, c.executionCtx, auth.tenant.id, "member.updated", {
      member_id: memberId,
      email: member?.email ?? existing.email,
      status: member?.status ?? existing.status,
      previous_status: existing.status,
      changed: fields
        .map((f) => f.split(" = ")[0])
        .filter((f) => f !== "updated_at"),
      source: "api",
    });

    return { status: 200, json: { member } };
  });
});

/* -------------------------------------------------------------------------
 * REST hooks (what Zapier calls on Zap on/off)
 * ---------------------------------------------------------------------- */

const MAX_HOOKS_PER_TENANT = 25;

v1Routes.get("/hooks", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, url, events_json, is_active, disabled_reason, created_at
       FROM webhook_endpoints WHERE tenant_id = ?
       ORDER BY created_at DESC LIMIT 100`
    ).bind(auth.tenant.id)
  );
  // Secrets are shown once at creation and never returned again.
  return c.json({
    hooks: rows.map((r: any) => ({
      id: r.id,
      url: r.url,
      events: JSON.parse(r.events_json || '["*"]'),
      is_active: !!r.is_active,
      disabled_reason: r.disabled_reason,
      created_at: r.created_at,
    })),
  });
});

v1Routes.post("/hooks", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "hooks:write");
  if (denied) return denied;

  const body = await c.req.json<{ url?: string; events?: string[] }>();
  if (!body.url) {
    return c.json({ error: "url is required", code: "missing_field" }, 400);
  }

  const { validateHookUrl } = await import("../lib/webhookOutbox");
  const urlError = validateHookUrl(body.url);
  if (urlError) {
    return c.json({ error: urlError, code: "invalid_hook_url" }, 400);
  }

  // Reject unknown names outright; never silently filter a typo.
  const { WEBHOOK_SUBSCRIBE_OPTIONS } = await import("../lib/webhookEvents");
  const requested =
    Array.isArray(body.events) && body.events.length ? body.events : ["*"];
  const unknown = requested.filter(
    (e) => !WEBHOOK_SUBSCRIBE_OPTIONS.includes(e)
  );
  if (unknown.length) {
    return c.json(
      {
        error: `Unknown event(s): ${unknown.join(", ")}`,
        code: "unknown_event",
        valid: WEBHOOK_SUBSCRIBE_OPTIONS,
      },
      400
    );
  }

  const countRow = await first<{ cnt: number }>(
    c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM webhook_endpoints WHERE tenant_id = ?`
    ).bind(auth.tenant.id)
  );
  if ((countRow?.cnt ?? 0) >= MAX_HOOKS_PER_TENANT) {
    return c.json(
      {
        error: `Limit of ${MAX_HOOKS_PER_TENANT} hooks reached`,
        code: "hook_limit",
      },
      429
    );
  }

  const { generateId } = await import("../lib/utils/id");
  const id = generateId();
  const now = new Date().toISOString();
  // Parity with the admin route, which generates a secret rather than leaving
  // API-created hooks unsigned.
  const secret = generateId().replace(/-/g, "");
  await c.env.DB.prepare(
    `INSERT INTO webhook_endpoints
     (id, tenant_id, url, secret, events_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(id, auth.tenant.id, body.url, secret, JSON.stringify(requested), now, now)
    .run();

  // Shown once. Zapier ignores it; Make and custom consumers should verify.
  return c.json({ hook: { id, url: body.url, events: requested, secret } }, 201);
});

v1Routes.delete("/hooks/:hookId", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "hooks:write");
  if (denied) return denied;

  const hookId = c.req.param("hookId");
  const existing = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM webhook_endpoints WHERE id = ? AND tenant_id = ?"
    ).bind(hookId, auth.tenant.id)
  );
  if (!existing) {
    return c.json({ error: "Hook not found", code: "not_found" }, 404);
  }

  await c.env.DB.prepare(
    "DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?"
  )
    .bind(hookId, auth.tenant.id)
    .run();
  return c.json({ deleted: true });
});
