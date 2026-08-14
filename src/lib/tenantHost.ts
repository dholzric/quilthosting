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
 * Ensure a plain proxied DNS record exists for a hostname in our own zone.
 *
 * WHY NOT A WORKERS CUSTOM DOMAIN: `wrangler deploy` reconciles Workers custom
 * domains against the `[[routes]]` declared in wrangler.toml and DELETES any it
 * does not find there -- removing the DNS record with them. Since tenant
 * subdomains are created at runtime they can never appear in that file, so
 * every deploy silently took down every tenant's subdomain. Observed in
 * production on 2026-08-13: a subdomain attached via the Workers domains API
 * vanished after the next two unrelated deploys.
 *
 * A plain DNS record is not part of that reconciliation, and routing still
 * works because wrangler.toml already declares a zone-wide route (the
 * wildcard `pattern` with `zone_name = "quilthosting.com"`) covering every
 * hostname in the zone. AAAA to the 100:: discard prefix is the conventional
 * placeholder for a proxied-only record -- Cloudflare answers with its own
 * edge addresses and the origin address is never used.
 */
export async function ensureZoneDnsRecord(
  env: Env,
  hostname: string
): Promise<CfDomainResult> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    return { ok: false, hostname, error: "CLOUDFLARE_API_TOKEN not configured on Worker" };
  }
  const zoneId = saasZoneId(env);
  const host = normalizeHost(hostname);
  try {
    const listRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const list = (await listRes.json()) as {
      success?: boolean;
      result?: { id: string; name: string }[];
    };
    const existing = (list.result || []).find(
      (r) => r.name.toLowerCase() === host.toLowerCase()
    );
    if (existing) return { ok: true, hostname: host, id: existing.id };

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "AAAA",
          name: host,
          content: "100::",
          proxied: true,
          ttl: 1,
          comment: "Tenant subdomain (plain DNS so deploys cannot remove it)",
        }),
      }
    );
    const data = (await res.json()) as {
      success: boolean;
      result?: { id: string };
      errors?: { message: string }[];
    };
    if (!data.success) {
      return {
        ok: false,
        hostname: host,
        error: data.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`,
      };
    }
    return { ok: true, hostname: host, id: data.result?.id };
  } catch (e) {
    return {
      ok: false,
      hostname: host,
      error: e instanceof Error ? e.message : "CF API error",
    };
  }
}

/**
 * Ensure the free platform subdomain {slug}.{appHost} resolves to the Worker.
 * Uses a plain zone DNS record, NOT a Workers custom domain -- see
 * ensureZoneDnsRecord for why that distinction is load-bearing.
 */
export async function ensurePlatformSubdomain(
  env: Env,
  slug: string
): Promise<CfDomainResult> {
  const host = `${slug}.${appHostname(env.APP_URL)}`;
  return ensureZoneDnsRecord(env, host);
}

/** CNAME target guilds point at (Cloudflare for SaaS). */
export function saasCnameTarget(env: Env): string {
  return env.SAAS_CNAME_TARGET || `customers.${appHostname(env.APP_URL)}`;
}

function saasZoneId(env: Env): string {
  return env.CLOUDFLARE_ZONE_ID || "c6fd07d190feb5b47b3d9ea76e786fdd";
}

export type SaasHostnameStatus = {
  ok: boolean;
  hostname: string;
  id?: string;
  status?: string;
  ssl_status?: string;
  error?: string;
  validation_errors?: string[];
};

/**
 * Create (or return existing) Cloudflare for SaaS custom hostname.
 * Customer CNAMEs their domain → customers.quilthosting.com
 */
export async function createSaasCustomHostname(
  env: Env,
  hostname: string
): Promise<SaasHostnameStatus> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    return { ok: false, hostname, error: "CLOUDFLARE_API_TOKEN not configured" };
  }
  const zoneId = saasZoneId(env);
  const host = normalizeHost(hostname);
  try {
    // Already exists?
    const existing = await findSaasCustomHostname(env, host);
    if (existing.ok && existing.id) return existing;

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hostname: host,
          ssl: {
            method: "http",
            type: "dv",
            settings: {
              min_tls_version: "1.2",
              http2: "on",
              tls_1_3: "on",
            },
          },
        }),
      }
    );
    const data = (await res.json()) as {
      success: boolean;
      result?: {
        id: string;
        hostname: string;
        status: string;
        ssl?: { status: string };
      };
      errors?: { message: string; code?: number }[];
    };
    if (!data.success) {
      // 1406 / duplicate — re-fetch
      const msg = data.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      if (/already exists|duplicate/i.test(msg)) {
        return findSaasCustomHostname(env, host);
      }
      return { ok: false, hostname: host, error: msg };
    }
    return {
      ok: true,
      hostname: host,
      id: data.result?.id,
      status: data.result?.status,
      ssl_status: data.result?.ssl?.status,
    };
  } catch (e) {
    return {
      ok: false,
      hostname: host,
      error: e instanceof Error ? e.message : "CF SaaS error",
    };
  }
}

export async function findSaasCustomHostname(
  env: Env,
  hostname: string
): Promise<SaasHostnameStatus> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    return { ok: false, hostname, error: "CLOUDFLARE_API_TOKEN not configured" };
  }
  const zoneId = saasZoneId(env);
  const host = normalizeHost(hostname);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(host)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = (await res.json()) as {
      success: boolean;
      result?: {
        id: string;
        hostname: string;
        status: string;
        ssl?: { status: string; validation_errors?: { message: string }[] };
      }[];
    };
    const row = (data.result || []).find(
      (r) => r.hostname.toLowerCase() === host
    );
    if (!row) return { ok: false, hostname: host, error: "Not found" };
    return {
      ok: true,
      hostname: host,
      id: row.id,
      status: row.status,
      ssl_status: row.ssl?.status,
      validation_errors: row.ssl?.validation_errors?.map((v) => v.message),
    };
  } catch (e) {
    return {
      ok: false,
      hostname: host,
      error: e instanceof Error ? e.message : "lookup failed",
    };
  }
}

export async function deleteSaasCustomHostname(
  env: Env,
  hostname: string
): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) return;
  const found = await findSaasCustomHostname(env, hostname);
  if (!found.id) return;
  const zoneId = saasZoneId(env);
  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames/${found.id}`,
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
 * Provision apex + www SaaS hostnames for a guild domain.
 * Prefer www; also create apex (guilds may use CF CNAME flattening).
 */
export async function provisionSaasDomain(
  env: Env,
  apexDomain: string
): Promise<{ www: SaasHostnameStatus; apex: SaasHostnameStatus }> {
  const apex = stripWww(apexDomain);
  const www = `www.${apex}`;
  const [wwwRes, apexRes] = await Promise.all([
    createSaasCustomHostname(env, www),
    createSaasCustomHostname(env, apex),
  ]);
  return { www: wwwRes, apex: apexRes };
}

export async function deprovisionSaasDomain(
  env: Env,
  apexDomain: string
): Promise<void> {
  const apex = stripWww(apexDomain);
  await Promise.all([
    deleteSaasCustomHostname(env, apex),
    deleteSaasCustomHostname(env, `www.${apex}`),
  ]);
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
  const freeSub = `${slug}.${platform}`;
  const cnameTarget = saasCnameTarget(env);
  const apex = stripWww(domain);
  return {
    summary:
      "Point your domain at QuiltHosting with a CNAME. SSL is issued automatically via Cloudflare for SaaS (first 100 hostnames free).",
    cname_target: cnameTarget,
    recommended: [
      {
        type: "CNAME",
        name: "www",
        value: cnameTarget,
        note: `Recommended. Point www.${apex} → ${cnameTarget}`,
      },
      {
        type: "CNAME or ALIAS",
        name: "@",
        value: cnameTarget,
        note: `Apex ${apex} needs CNAME flattening (Cloudflare DNS) or ALIAS/ANAME at your DNS host. Or redirect apex → www.`,
      },
    ],
    free_subdomain: `https://${freeSub}`,
    path_url: `${env.APP_URL.replace(/\/$/, "")}/g/${slug}`,
  };
}
