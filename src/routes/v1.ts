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

/**
 * Idempotency-Key handling.
 *
 * Zapier and Make retry on timeout. Without this, a retried create hits the
 * duplicate-email guard, returns 409, and the Zap reports failure for a member
 * that was in fact created. Replays the original response for a matching
 * retry; 422 when the same key is reused with a different body.
 *
 * The reservation is taken atomically BEFORE the handler runs (see
 * src/lib/idempotency.ts) so two concurrent first requests cannot both
 * mutate, and it is scoped by `operation` so the same key reused across a
 * Zap's steps (e.g. create then update) does not collide.
 */
async function withIdempotency(
  c: any,
  tenantId: string,
  operation: string,
  body: unknown,
  handler: () => Promise<{ status: number; json: unknown }>
): Promise<Response> {
  const key = c.req.header("Idempotency-Key");
  if (!key) {
    const r = await handler();
    return c.json(r.json, r.status);
  }

  const idem = await import("../lib/idempotency");
  const hash = await idem.hashRequest(body);
  const outcome = await idem.reserve(c.env, tenantId, operation, key, hash);

  if (outcome.kind === "replay") return c.json(outcome.json, outcome.status);
  if (outcome.kind === "conflict") {
    return c.json(
      {
        error: "Idempotency-Key reused with a different request body",
        code: "idempotency_key_reuse",
      },
      422
    );
  }
  if (outcome.kind === "in_progress") {
    c.header("Retry-After", "2");
    return c.json(
      {
        error: "A request with this Idempotency-Key is still in progress.",
        code: "idempotency_in_progress",
      },
      409
    );
  }

  // A thrown handler must still release the reservation -- otherwise a
  // caller retrying after a transient error is 409'd as "in progress" for up
  // to RESERVATION_SECONDS even though nothing is actually running.
  let r: { status: number; json: unknown };
  try {
    r = await handler();
  } catch (e) {
    await idem.release(c.env, outcome.recordId, outcome.reservedUntil);
    throw e;
  }
  // 5xx is never cached: the caller must be able to retry a transient failure,
  // and a released reservation lets them win the slot again. Both writes are
  // fenced by the lease reserve() handed out: if this caller's reservation
  // was taken over mid-handler (it ran past RESERVATION_SECONDS), the write
  // is silently dropped rather than clobbering -- or, for release, deleting
  // -- the new owner's row. The response below is still the real result of
  // the mutation this caller ran, so it is returned regardless; it is simply
  // not cached under a slot that no longer belongs to this caller.
  if (r.status >= 500) await idem.release(c.env, outcome.recordId, outcome.reservedUntil);
  else await idem.complete(c.env, outcome.recordId, outcome.reservedUntil, r.status, r.json);
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

  return withIdempotency(c, auth.tenant.id, "POST /v1/members", body, async () => {
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
    const insertMemberStmt = c.env.DB.prepare(
      `INSERT INTO members
       (id, tenant_id, email, first_name, last_name, phone, status, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
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
    );

    const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
    const ev = prepareEvent(c.env, auth.tenant.id, "member.created", {
      member_id: id,
      email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      status,
      source: "api",
    });
    if (!ev) {
      return {
        status: 500,
        json: {
          error: "Could not record the change event; nothing was saved.",
          code: "event_prepare_failed",
        },
      };
    }
    try {
      await c.env.DB.batch([insertMemberStmt, ev.stmt]);
    } catch (e) {
      console.error("v1 member create: outbox batch failed, member NOT saved", e);
      return {
        status: 500,
        json: {
          error: "Could not record the change event; nothing was saved.",
          code: "event_prepare_failed",
        },
      };
    }
    await scheduleDispatch(c.env, c.executionCtx, ev.id);

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

  return withIdempotency(
    c,
    auth.tenant.id,
    "PATCH /v1/members/:memberId",
    { memberId, ...body },
    async () => {
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
    const updateMemberStmt = c.env.DB.prepare(
      `UPDATE members SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`
    ).bind(...params);

    // member row after the update, computed from what we're about to write
    // (not yet committed) so the event payload matches the row once it lands.
    const nextEmail = existing.email;
    const nextStatus =
      (body.status as string | undefined) ?? existing.status;

    const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
    const ev = prepareEvent(c.env, auth.tenant.id, "member.updated", {
      member_id: memberId,
      email: nextEmail,
      status: nextStatus,
      previous_status: existing.status,
      changed: fields
        .map((f) => f.split(" = ")[0])
        .filter((f) => f !== "updated_at"),
      source: "api",
    });
    if (!ev) {
      return {
        status: 500,
        json: {
          error: "Could not record the change event; nothing was saved.",
          code: "event_prepare_failed",
        },
      };
    }
    try {
      await c.env.DB.batch([updateMemberStmt, ev.stmt]);
    } catch (e) {
      console.error("v1 member update: outbox batch failed, member NOT saved", e);
      return {
        status: 500,
        json: {
          error: "Could not record the change event; nothing was saved.",
          code: "event_prepare_failed",
        },
      };
    }
    await scheduleDispatch(c.env, c.executionCtx, ev.id);

    const member = await first<{ email: string; status: string }>(
      c.env.DB.prepare(
        `SELECT id, email, first_name, last_name, phone, status, joined_at, created_at
         FROM members WHERE id = ? AND tenant_id = ?`
      ).bind(memberId, auth.tenant.id)
    );

    return { status: 200, json: { member } };
    }
  );
});

/* -------------------------------------------------------------------------
 * REST hooks (what Zapier calls on Zap on/off)
 * ---------------------------------------------------------------------- */

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

  // Default missing/empty events to ["*"] before validating -- same shared
  // rule the admin route uses, from src/lib/hookValidation.ts.
  const requested =
    Array.isArray(body.events) && body.events.length ? body.events : ["*"];
  const { validateHookInput } = await import("../lib/hookValidation");
  const countRow = await first<{ cnt: number }>(
    c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM webhook_endpoints WHERE tenant_id = ?`
    ).bind(auth.tenant.id)
  );
  const result = validateHookInput(
    { url: body.url, events: requested },
    { existingCount: countRow?.cnt ?? 0 }
  );
  if (!result.ok) {
    return c.json(
      {
        error: result.error,
        code: result.code,
        ...(result.valid ? { valid: result.valid } : {}),
      },
      result.status
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
    .bind(id, auth.tenant.id, result.url, secret, JSON.stringify(result.events), now, now)
    .run();

  // Shown once. Zapier ignores it; Make and custom consumers should verify.
  return c.json(
    { hook: { id, url: result.url, events: result.events, secret } },
    201
  );
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

/* -------------------------------------------------------------------------
 * Dev-only test harness routes -- prove idempotency reservation concurrency.
 *
 * Two separate HTTP requests to a fast local wrangler dev are not guaranteed
 * to actually overlap, so a race "proven" only over HTTP can pass without
 * ever exercising the contended path -- unfalsified, not verified. These
 * routes let scripts/verify-idempotency.mjs fire N reserve() calls with
 * Promise.all from inside a single Worker invocation instead, where the
 * interleaving at await boundaries is deterministic every run.
 *
 * Gated on c.env.ENVIRONMENT === "development" and nothing else, checked
 * before any client-controlled input (Authorization header, body) is read --
 * same shape as the X-QH-Force-Outbox-Failure gate in src/routes/members.ts.
 * In production this 404s exactly as if the route were never registered.
 * ---------------------------------------------------------------------- */

v1Routes.post("/_dev/idempotency/reserve", async (c) => {
  if (c.env.ENVIRONMENT !== "development") return c.notFound();

  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;

  const body = await c.req.json<{
    operation?: string;
    key?: string;
    requestHash?: string;
    calls?: number;
  }>();
  if (!body.operation || !body.key || !body.requestHash) {
    return c.json({ error: "operation, key, requestHash are required" }, 400);
  }
  // Bounded so a stray large value can't be used to hammer D1, even in dev.
  const calls = Math.min(Math.max(Math.trunc(body.calls ?? 1), 1), 10);

  const idem = await import("../lib/idempotency");
  const outcomes = await Promise.all(
    Array.from({ length: calls }, () =>
      idem.reserve(
        c.env,
        auth.tenant.id,
        body.operation!,
        body.key!,
        body.requestHash!
      )
    )
  );
  return c.json({ outcomes });
});

v1Routes.post("/_dev/idempotency/complete", async (c) => {
  if (c.env.ENVIRONMENT !== "development") return c.notFound();

  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;

  const body = await c.req.json<{
    recordId?: string;
    reservedUntil?: string;
    status?: number;
    json?: unknown;
  }>();
  if (
    !body.recordId ||
    !body.reservedUntil ||
    typeof body.status !== "number"
  ) {
    return c.json(
      { error: "recordId, reservedUntil, status are required" },
      400
    );
  }

  // Tenant-scoped: complete() itself is keyed only by record id (it fences
  // on reserved_until, not tenant), so confirm this API key's tenant
  // actually owns the row before touching it.
  const owned = await first<{ id: string }>(
    c.env.DB.prepare(
      `SELECT id FROM api_idempotency WHERE id = ? AND tenant_id = ?`
    ).bind(body.recordId, auth.tenant.id)
  );
  if (!owned) {
    return c.json({ error: "Reservation not found for this tenant" }, 404);
  }

  const idem = await import("../lib/idempotency");
  const won = await idem.complete(
    c.env,
    body.recordId,
    body.reservedUntil,
    body.status,
    body.json ?? null
  );
  return c.json({ won });
});
