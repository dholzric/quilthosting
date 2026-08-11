// src/routes/credentials.ts
// Admin API for tenant_credentials. Write and clear only — there is
// deliberately no endpoint that returns a stored secret.

import { Hono } from "hono";
import { z } from "zod";
import type { Env, TenantVariables } from "../types";
import { putCredential, listCredentialStatus, clearCredential } from "../lib/credentials";

export const credentialRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

const ALLOWED: Record<string, string[]> = {
  paypal: ["client_id", "client_secret"],
};

const putSchema = z.object({
  provider: z.string().min(1).max(40),
  key: z.string().min(1).max(60),
  value: z.string().min(1).max(500),
});

/** GET / — which credentials exist. Never their values. */
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
  const tenant = c.get("tenant");
  const provider = c.req.param("provider");
  const key = c.req.param("key");
  if (!ALLOWED[provider]?.includes(key)) {
    return c.json({ error: "Unknown provider or key" }, 400);
  }
  await clearCredential(c.env, tenant.id, provider, key);
  return c.json({ ok: true, provider, key, configured: false });
});
