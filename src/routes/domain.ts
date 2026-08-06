import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";
import { first } from "../lib/db";
import {
  appHostname,
  attachWorkerHostname,
  detachWorkerHostname,
  dnsInstructions,
  ensurePlatformSubdomain,
  parseCustomDomainInput,
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

/** GET /api/tenants/:tenantId/domain */
domainRoutes.get("/", async (c) => {
  const tenant = c.get("tenant") as Tenant;
  const platform = appHostname(c.env.APP_URL);
  const subdomain = `${tenant.slug}.${platform}`;
  return c.json({
    custom_domain: tenant.custom_domain || null,
    platform_subdomain: subdomain,
    platform_subdomain_url: `https://${subdomain}`,
    path_url: `${c.env.APP_URL.replace(/\/$/, "")}/g/${tenant.slug}`,
    public_base_url: tenantPublicBaseUrl(c.env, tenant),
    dns: tenant.custom_domain
      ? dnsInstructions(c.env, tenant.custom_domain, tenant.slug)
      : dnsInstructions(c.env, subdomain, tenant.slug),
  });
});

/**
 * PUT /api/tenants/:tenantId/domain
 * Body: { domain: "example.com" | "" | null }
 * Sets custom_domain, ensures platform subdomain, tries CF Workers domain attach.
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
      await detachWorkerHostname(c.env, stripWww(old));
      await detachWorkerHostname(c.env, `www.${stripWww(old)}`);
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

  // Don't allow setting the platform domain itself
  const platform = appHostname(c.env.APP_URL);
  if (parsed.domain === platform || parsed.domain.endsWith(`.${platform}`)) {
    // Allow only their own free subdomain as "custom" → store null, ensure attach
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
    ).bind(tenant.id, parsed.domain, `www.${parsed.domain}`, stripWww(parsed.domain))
  );
  if (taken) {
    return c.json({ error: "That domain is already used by another guild" }, 409);
  }

  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `UPDATE tenants SET custom_domain = ?, updated_at = ? WHERE id = ?`
    )
      .bind(parsed.domain, now, tenant.id)
      .run();
  } catch (e) {
    return c.json({ error: "Could not save domain (maybe already taken)" }, 409);
  }

  // Platform free subdomain always available
  const sub = await ensurePlatformSubdomain(c.env, tenant.slug);

  // Attach custom hostnames (apex + www) when CF zone is on this account
  const attachApex = await attachWorkerHostname(c.env, parsed.domain);
  const attachWww = await attachWorkerHostname(c.env, `www.${parsed.domain}`);

  const updated = await first<Tenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(tenant.id)
  );

  return c.json({
    ok: true,
    custom_domain: parsed.domain,
    public_base_url: tenantPublicBaseUrl(c.env, updated || tenant),
    platform_subdomain: sub,
    cloudflare: {
      apex: attachApex,
      www: attachWww,
      note: attachApex.ok || attachWww.ok
        ? "Hostname attached to Worker. DNS must resolve to Cloudflare."
        : "Saved in app. Attach failed — domain zone may not be on this Cloudflare account yet. Use free subdomain or move DNS to Cloudflare.",
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
