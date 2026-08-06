import type { Env, Tenant } from "../types";
import { first } from "./db";

/** Strip port, lowercase, trailing dot. */
export function normalizeHost(host: string): string {
  return (host || "")
    .split(":")[0]
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

/** Remove leading www. */
export function stripWww(host: string): string {
  const h = normalizeHost(host);
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** Hostname from APP_URL (e.g. quilthosting.com). */
export function appHostname(appUrl: string): string {
  try {
    return normalizeHost(new URL(appUrl).hostname);
  } catch {
    return "quilthosting.com";
  }
}

/**
 * Resolve tenant from Host header:
 * 1) custom_domain match (with/without www)
 * 2) {slug}.{appHost} subdomain
 */
export async function getTenantByHost(
  db: D1Database,
  hostHeader: string,
  appUrl: string
): Promise<Tenant | null> {
  const host = normalizeHost(hostHeader);
  if (!host) return null;
  const apex = stripWww(host);
  const platform = appHostname(appUrl);

  // Platform apex / www → not a tenant host
  if (apex === platform || host === platform || host === `www.${platform}`) {
    return null;
  }

  // Custom domain: store either apex or www form; match both
  const byDomain = await first<Tenant>(
    db
      .prepare(
        `SELECT * FROM tenants
         WHERE status = 'active'
           AND custom_domain IS NOT NULL
           AND custom_domain != ''
           AND (
             lower(custom_domain) = ?
             OR lower(custom_domain) = ?
             OR lower(custom_domain) = ?
             OR lower(custom_domain) = ?
           )
         LIMIT 1`
      )
      .bind(host, apex, `www.${apex}`, stripWww(host))
  );
  if (byDomain) return byDomain;

  // Subdomain: slug.quilthosting.com
  if (host.endsWith(`.${platform}`)) {
    const slug = host.slice(0, -(platform.length + 1));
    if (slug && !slug.includes(".") && slug !== "www" && slug !== "api") {
      return first<Tenant>(
        db
          .prepare(
            `SELECT * FROM tenants WHERE slug = ? AND status = 'active'`
          )
          .bind(slug)
      );
    }
  }

  return null;
}

/** Validate and normalize a user-supplied custom domain. */
export function parseCustomDomainInput(raw: string): {
  ok: true;
  domain: string;
} | { ok: false; error: string } {
  let s = (raw || "").trim().toLowerCase();
  if (!s) return { ok: false, error: "Domain is required" };
  s = s.replace(/^https?:\/\//, "");
  s = s.split("/")[0];
  s = s.split(":")[0];
  s = s.replace(/\.$/, "");
  if (s.startsWith("www.")) s = s.slice(4);
  if (s.length < 3 || s.length > 253) {
    return { ok: false, error: "Invalid domain length" };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    return { ok: false, error: "Invalid domain format" };
  }
  // Block platform domain itself
  return { ok: true, domain: s };
}

export type CfDomainResult = {
  ok: boolean;
  hostname: string;
  id?: string;
  error?: string;
};

/**
 * Attach a hostname to this Worker via Cloudflare Workers Custom Domains.
 * Works when the zone is already on the same Cloudflare account.
 * Does not require SSL for SaaS.
 */
export async function attachWorkerHostname(
  env: Env,
  hostname: string
): Promise<CfDomainResult> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "fc9a445b7af4421e2d0c2fd202885f97";
  if (!token) {
    return {
      ok: false,
      hostname,
      error: "CLOUDFLARE_API_TOKEN not configured on Worker",
    };
  }
  const service = env.CLOUDFLARE_WORKER_NAME || "quilthosting";
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hostname,
          service,
          environment: "production",
        }),
      }
    );
    const data = (await res.json()) as {
      success: boolean;
      result?: { id: string; hostname: string };
      errors?: { message: string }[];
    };
    if (!data.success) {
      return {
        ok: false,
        hostname,
        error: data.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`,
      };
    }
    return { ok: true, hostname, id: data.result?.id };
  } catch (e) {
    return {
      ok: false,
      hostname,
      error: e instanceof Error ? e.message : "CF API error",
    };
  }
}

/** Detach worker custom domain (best-effort). */
export async function detachWorkerHostname(
  env: Env,
  hostname: string
): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "fc9a445b7af4421e2d0c2fd202885f97";
  if (!token) return;
  try {
    const listRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const list = (await listRes.json()) as {
      result?: { id: string; hostname: string }[];
    };
    const row = (list.result || []).find(
      (r) => r.hostname.toLowerCase() === hostname.toLowerCase()
    );
    if (!row) return;
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains/${row.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  } catch {
    /* ignore */
  }
}

/**
 * Ensure the free platform subdomain {slug}.{appHost} is attached to the Worker.
 */
export async function ensurePlatformSubdomain(
  env: Env,
  slug: string
): Promise<CfDomainResult> {
  const host = `${slug}.${appHostname(env.APP_URL)}`;
  return attachWorkerHostname(env, host);
}

/** Preferred public base URL for a tenant (custom domain > platform subdomain > APP_URL path). */
export function tenantPublicBaseUrl(env: Env, tenant: Tenant, requestHost?: string): string {
  const platform = appHostname(env.APP_URL);
  if (requestHost) {
    const h = normalizeHost(requestHost);
    const apex = stripWww(h);
    if (
      tenant.custom_domain &&
      (h === normalizeHost(tenant.custom_domain) ||
        apex === stripWww(tenant.custom_domain) ||
        h === `www.${stripWww(tenant.custom_domain)}`)
    ) {
      return `https://${h}`;
    }
    if (h === `${tenant.slug}.${platform}`) {
      return `https://${h}`;
    }
  }
  if (tenant.custom_domain) {
    return `https://${stripWww(tenant.custom_domain)}`;
  }
  return `https://${tenant.slug}.${platform}`;
}

export function dnsInstructions(env: Env, domain: string, slug: string) {
  const platform = appHostname(env.APP_URL);
  const target = `${slug}.${platform}`;
  return {
    summary:
      "Point your domain at QuiltHosting, then we attach SSL via Cloudflare Workers custom domains (zone must be on the same Cloudflare account, or use the free subdomain).",
    recommended: [
      {
        type: "CNAME",
        name: domain.startsWith("www.") ? "www" : "@ or www",
        value: target,
        note: `CNAME to ${target}. Apex domains need CNAME flattening (Cloudflare DNS) or an ALIAS record.`,
      },
    ],
    free_subdomain: `https://${target}`,
    path_url: `${env.APP_URL.replace(/\/$/, "")}/g/${slug}`,
  };
}
