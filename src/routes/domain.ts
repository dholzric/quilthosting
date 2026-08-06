import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";
import { first } from "../lib/db";
import {
  appHostname,
  deprovisionSaasDomain,
  dnsInstructions,
  ensurePlatformSubdomain,
  findSaasCustomHostname,
  parseCustomDomainInput,
  provisionSaasDomain,
  saasCnameTarget,
  stripWww,
  tenantPublicBaseUrl,
} from "../lib/tenantHost";
import type { AuthVariables } from "../middleware/auth";

export const domainRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables & TenantVariables & { tenantRole: string };
}>();

async function requireOwnerAdmin(c: {
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

async function saasStatusForDomain(env: Env, domain: string | null) {
  if (!domain) return null;
  const apex = stripWww(domain);
  const [www, apexSt] = await Promise.all([
    findSaasCustomHostname(env, `www.${apex}`),
    findSaasCustomHostname(env, apex),
  ]);
  return { www, apex: apexSt };
}

/** GET /api/tenants/:tenantId/domain */
domainRoutes.get("/", async (c) => {
  const tenant = c.get("tenant") as Tenant;
  const platform = appHostname(c.env.APP_URL);
  const subdomain = `${tenant.slug}.${platform}`;
  const saas = await saasStatusForDomain(c.env, tenant.custom_domain);
  return c.json({
    custom_domain: tenant.custom_domain || null,
    platform_subdomain: subdomain,
    platform_subdomain_url: `https://${subdomain}`,
    path_url: `${c.env.APP_URL.replace(/\/$/, "")}/g/${tenant.slug}`,
    public_base_url: tenantPublicBaseUrl(c.env, tenant),
    cname_target: saasCnameTarget(c.env),
    saas,
    dns: tenant.custom_domain
      ? dnsInstructions(c.env, tenant.custom_domain, tenant.slug)
      : dnsInstructions(c.env, subdomain, tenant.slug),
  });
});

/**
 * PUT /api/tenants/:tenantId/domain
 * Body: { domain: "example.com" | "" | null }
 * Sets custom_domain, ensures free subdomain, provisions Cloudflare for SaaS hostnames.
 */
domainRoutes.put("/", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const body = (await c.req
    .json<{ domain?: string | null }>()
    .catch(() => ({ domain: null as string | null }))) as {
    domain?: string | null;
  };
  const raw = body.domain;

  // Clear custom domain
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    const old = tenant.custom_domain;
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE tenants SET custom_domain = NULL, updated_at = ? WHERE id = ?`
    )
      .bind(now, tenant.id)
      .run();
    if (old) {
      await deprovisionSaasDomain(c.env, old);
    }
    const sub = await ensurePlatformSubdomain(c.env, tenant.slug);
    const updated = await first<Tenant>(
      c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(tenant.id)
    );
    return c.json({
      ok: true,
      custom_domain: null,
      platform_subdomain: sub,
      tenant: updated,
    });
  }

  const parsed = parseCustomDomainInput(String(raw));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const platform = appHostname(c.env.APP_URL);
  if (parsed.domain === platform || parsed.domain.endsWith(`.${platform}`)) {
    if (parsed.domain === `${tenant.slug}.${platform}`) {
      await c.env.DB.prepare(
        `UPDATE tenants SET custom_domain = NULL, updated_at = ? WHERE id = ?`
      )
        .bind(new Date().toISOString(), tenant.id)
        .run();
      const sub = await ensurePlatformSubdomain(c.env, tenant.slug);
      return c.json({
        ok: true,
        custom_domain: null,
        note: "Using free platform subdomain",
        platform_subdomain: sub,
      });
    }
    return c.json(
      {
        error: `Use a domain you own, or your free subdomain ${tenant.slug}.${platform}`,
      },
      400
    );
  }

  const taken = await first<{ id: string; slug: string }>(
    c.env.DB.prepare(
      `SELECT id, slug FROM tenants
       WHERE id != ?
         AND custom_domain IS NOT NULL
         AND (
           lower(custom_domain) = ?
           OR lower(custom_domain) = ?
           OR lower(custom_domain) = ?
         )`
    ).bind(
      tenant.id,
      parsed.domain,
      `www.${parsed.domain}`,
      stripWww(parsed.domain)
    )
  );
  if (taken) {
    return c.json({ error: "That domain is already used by another guild" }, 409);
  }

  // Remove old SaaS hostnames if domain changed
  if (tenant.custom_domain && stripWww(tenant.custom_domain) !== parsed.domain) {
    await deprovisionSaasDomain(c.env, tenant.custom_domain);
  }

  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `UPDATE tenants SET custom_domain = ?, updated_at = ? WHERE id = ?`
    )
      .bind(parsed.domain, now, tenant.id)
      .run();
  } catch {
    return c.json({ error: "Could not save domain (maybe already taken)" }, 409);
  }

  const sub = await ensurePlatformSubdomain(c.env, tenant.slug);
  const saas = await provisionSaasDomain(c.env, parsed.domain);

  const updated = await first<Tenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(tenant.id)
  );

  const anyOk = saas.www.ok || saas.apex.ok;
  return c.json({
    ok: true,
    custom_domain: parsed.domain,
    public_base_url: tenantPublicBaseUrl(c.env, updated || tenant),
    platform_subdomain: sub,
    cname_target: saasCnameTarget(c.env),
    saas,
    cloudflare: {
      saas,
      note: anyOk
        ? `SaaS hostnames created. Point DNS CNAME to ${saasCnameTarget(c.env)}. Status becomes active after DNS + certificate validation.`
        : `Saved in app. SaaS provision failed: ${saas.www.error || saas.apex.error || "unknown"}. Free subdomain still works.`,
    },
    dns: dnsInstructions(c.env, parsed.domain, tenant.slug),
    tenant: updated,
  });
});

/** POST /api/tenants/:tenantId/domain/ensure-subdomain — attach slug.quilthosting.com */
domainRoutes.post("/ensure-subdomain", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const result = await ensurePlatformSubdomain(c.env, tenant.slug);
  return c.json({
    ok: result.ok,
    hostname: result.hostname,
    url: `https://${result.hostname}`,
    error: result.error || null,
    id: result.id || null,
  });
});

/** POST /api/tenants/:tenantId/domain/refresh-saas — re-check / re-provision SaaS status */
domainRoutes.post("/refresh-saas", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  if (!tenant.custom_domain) {
    return c.json({ error: "No custom domain set" }, 400);
  }
  const saas = await provisionSaasDomain(c.env, tenant.custom_domain);
  return c.json({
    ok: saas.www.ok || saas.apex.ok,
    saas,
    cname_target: saasCnameTarget(c.env),
    dns: dnsInstructions(c.env, tenant.custom_domain, tenant.slug),
  });
});
