// src/routes/credentials.ts
// Admin API for tenant_credentials. Write and clear only — there is
// deliberately no endpoint that returns a stored secret.

import { Hono } from "hono";
import { z } from "zod";
import type { Env, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";
import { putCredential, listCredentialStatus, clearCredential } from "../lib/credentials";

export const credentialRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables & TenantVariables & { tenantRole: string };
}>();

const ALLOWED: Record<string, string[]> = {
  paypal: ["client_id", "client_secret"],
};

const putSchema = z.object({
  provider: z.string().min(1).max(40),
  key: z.string().min(1).max(60),
  value: z.string().min(1).max(500),
});

// Matches src/routes/domain.ts's requireOwnerAdmin exactly (shape and
// response), not src/routes/billing.ts's differently-shaped version (sync
// boolean, excludes the "platform" role). Payment credentials are at least
// as sensitive as the custom-domain writes domain.ts gates this way, and
// platform admins already have standing access to tenant billing/domain
// admin, so excluding them here would be an inconsistent carve-out, not a
// safety win. Exported (unlike domain.ts's private copy) so it can be unit
// tested directly without standing up a full Hono + D1 request — this repo's
// vitest config is pure-unit tests only.
export async function requireOwnerAdmin(c: {
  get: (k: "tenantRole") => string;
}): Promise<Response | null> {
  const role = c.get("tenantRole");
  if (!["owner", "admin", "platform"].includes(role)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/**
 * GET / — which credentials exist. Never their values.
 *
 * Deliberately left on requireTenantAccess (no requireOwnerAdmin gate):
 * listing which keys are configured leaks no secret material, only a
 * boolean + timestamp per key, and read-only visibility into "is PayPal
 * set up yet" is reasonable for any tenant staff role, same as billing.ts's
 * and domain.ts's own GET / status endpoints (neither gates their summary
 * reads with requireOwnerAdmin either — only their mutating routes do).
 */
credentialRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const provider = c.req.query("provider") || "paypal";
  if (!ALLOWED[provider]) return c.json({ error: "Unknown provider" }, 400);
  const stored = await listCredentialStatus(c.env, tenant.id, provider);
  const byKey = new Map(stored.map((s) => [s.key, s]));
  return c.json({
    provider,
    credentials: ALLOWED[provider].map((key) => ({
      key,
      configured: byKey.has(key),
      updated_at: byKey.get(key)?.updated_at ?? null,
    })),
  });
});

credentialRoutes.put("/", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant");
  const parsed = putSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const { provider, key, value } = parsed.data;
  if (!ALLOWED[provider]?.includes(key)) {
    return c.json({ error: "Unknown provider or key" }, 400);
  }
  if (!c.env.CREDENTIAL_KEY) {
    // Fail loudly. Storing plaintext, or silently accepting and dropping the
    // value, would both be worse than a 503.
    return c.json({ error: "Credential storage is not configured" }, 503);
  }
  await putCredential(c.env, tenant.id, provider, key, value);
  return c.json({ ok: true, provider, key, configured: true });
});

credentialRoutes.delete("/:provider/:key", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant");
  const provider = c.req.param("provider");
  const key = c.req.param("key");
  if (!ALLOWED[provider]?.includes(key)) {
    return c.json({ error: "Unknown provider or key" }, 400);
  }
  await clearCredential(c.env, tenant.id, provider, key);
  return c.json({ ok: true, provider, key, configured: false });
});
