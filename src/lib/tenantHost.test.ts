// tenantHost.ts resolves which tenant (if any) a request belongs to, purely
// from the Host header. It is one of siteGate.ts's three security-critical
// terms (alongside isLaunched and isLaunchedSitePath) -- if it ever resolved
// the platform's own apex/www to a tenant, or normalized a host incorrectly,
// the gate would open for the wrong host. It had zero test coverage before
// this file (round 2 review flagged this): siteGate.test.ts mocks
// getTenantByHost entirely, so its own gated-host assertions ("platform
// apex resolves to null") were tautologies stipulating the mock's return
// value, not verifying tenantHost.ts actually behaves that way.
import { describe, it, expect, vi } from "vitest";
import {
  normalizeHost,
  stripWww,
  appHostname,
  getTenantByHost,
  ensurePlatformSubdomain,
} from "./tenantHost";
import type { Tenant } from "../types";

describe("normalizeHost", () => {
  it("strips a port", () => {
    expect(normalizeHost("example.com:8787")).toBe("example.com");
  });

  it("lowercases", () => {
    expect(normalizeHost("Example.COM")).toBe("example.com");
    expect(normalizeHost("EXAMPLE.COM:443")).toBe("example.com");
  });

  it("strips a single trailing dot (FQDN form)", () => {
    expect(normalizeHost("example.com.")).toBe("example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHost("  example.com  ")).toBe("example.com");
  });

  it("combines port, case, trailing dot, and surrounding whitespace", () => {
    // Verified directly against the implementation rather than hand-traced
    // (an earlier draft of this test asserted the wrong value from a manual
    // trace — split(":")[0] on "  Example.COM.:8080  " keeps the leading
    // whitespace and the trailing dot together as "  Example.COM.", and
    // trim() + toLowerCase() + the trailing-dot strip all still apply
    // correctly after that split).
    expect(normalizeHost("  Example.COM.:8080  ")).toBe("example.com");
  });

  it("strips a trailing dot even when a port is also present", () => {
    expect(normalizeHost("example.com.:8080")).toBe("example.com");
  });

  it("returns empty string for empty/undefined input", () => {
    expect(normalizeHost("")).toBe("");
    expect(normalizeHost(undefined as unknown as string)).toBe("");
  });
});

describe("stripWww", () => {
  it("removes a leading www.", () => {
    expect(stripWww("www.example.com")).toBe("example.com");
  });

  it("leaves a bare apex alone", () => {
    expect(stripWww("example.com")).toBe("example.com");
  });

  it("does not strip www from the middle of a hostname", () => {
    expect(stripWww("mywww.example.com")).toBe("mywww.example.com");
  });

  it("normalizes (port, case) before stripping www", () => {
    expect(stripWww("WWW.Example.COM:8787")).toBe("example.com");
  });
});

describe("appHostname", () => {
  it("extracts and normalizes the hostname from APP_URL", () => {
    expect(appHostname("https://quilthosting.com")).toBe("quilthosting.com");
    expect(appHostname("http://localhost:8787")).toBe("localhost");
  });

  it("falls back to quilthosting.com on an unparsable APP_URL", () => {
    expect(appHostname("not a url")).toBe("quilthosting.com");
    expect(appHostname("")).toBe("quilthosting.com");
  });
});

/**
 * A fake D1Database whose `.prepare()` throws — used to assert that a code
 * path does NOT touch the database at all, not just that it returns the
 * right value. `getTenantByHost` must short-circuit to `null` for the
 * platform's own apex/www without ever calling `db.prepare(...)`.
 */
function dbThatMustNotBeQueried(): D1Database {
  return {
    prepare: vi.fn(() => {
      throw new Error("getTenantByHost queried the DB for a platform host — it must short-circuit before this");
    }),
  } as unknown as D1Database;
}

/** A fake D1Database that returns `row` from the first `.first()` call, regardless of the query. */
function dbReturning(row: unknown): D1Database {
  const stmt = {
    bind: vi.fn(function (this: unknown) {
      return this;
    }),
    first: vi.fn().mockResolvedValue(row),
  };
  return {
    prepare: vi.fn(() => stmt),
  } as unknown as D1Database;
}

const APP_URL = "https://quilthosting.com";

const customDomainTenant: Tenant = {
  id: "tnt_biz",
  name: "Stitch Studio",
  slug: "stitchstudio",
  custom_domain: "stitchstudioquilting.test",
  tenant_type: "business",
  public_launched: 1,
  stripe_account_id: null,
  plan: "free",
  status: "active",
  settings_json: "{}",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("getTenantByHost — platform hosts resolve to null WITHOUT a DB query", () => {
  it("the platform apex", async () => {
    const db = dbThatMustNotBeQueried();
    const result = await getTenantByHost(db, "quilthosting.com", APP_URL);
    expect(result).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("www. of the platform apex", async () => {
    const db = dbThatMustNotBeQueried();
    const result = await getTenantByHost(db, "www.quilthosting.com", APP_URL);
    expect(result).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("the platform apex with a port and mixed case", async () => {
    const db = dbThatMustNotBeQueried();
    const result = await getTenantByHost(db, "QuiltHosting.COM:8787", APP_URL);
    expect(result).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("an empty Host header", async () => {
    const db = dbThatMustNotBeQueried();
    const result = await getTenantByHost(db, "", APP_URL);
    expect(result).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

describe("getTenantByHost — tenant hosts DO reach the database", () => {
  it("resolves a custom domain match", async () => {
    const db = dbReturning(customDomainTenant);
    const result = await getTenantByHost(db, "stitchstudioquilting.test", APP_URL);
    expect(result).toEqual(customDomainTenant);
    expect(db.prepare).toHaveBeenCalled();
  });

  it("resolves a custom domain match with a www. prefix on the request", async () => {
    const db = dbReturning(customDomainTenant);
    const result = await getTenantByHost(db, "www.stitchstudioquilting.test", APP_URL);
    expect(result).toEqual(customDomainTenant);
  });

  it("falls through to a {slug}.{platform} subdomain lookup when no custom-domain row matches", async () => {
    // First .first() call (custom_domain lookup) returns null, second
    // (slug lookup) returns the tenant.
    const stmt = {
      bind: vi.fn(function (this: unknown) {
        return this;
      }),
      first: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(customDomainTenant),
    };
    const db = { prepare: vi.fn(() => stmt) } as unknown as D1Database;
    const result = await getTenantByHost(db, "stitchstudio.quilthosting.com", APP_URL);
    expect(result).toEqual(customDomainTenant);
  });

  it("does not treat 'api' as a tenant slug, even if the custom-domain lookup finds nothing", async () => {
    // "api.quilthosting.com" is NOT caught by the early platform apex/www
    // short-circuit (only the bare apex and "www." are) — the custom_domain
    // query still runs once. What must NOT happen is a second query
    // treating "api" as a candidate slug. Verified directly rather than
    // assumed: an earlier draft of this test wrongly expected zero queries
    // here and failed when run.
    const stmt = {
      bind: vi.fn(function (this: unknown) {
        return this;
      }),
      first: vi.fn().mockResolvedValue(null), // no custom_domain row matches "api.quilthosting.com"
    };
    const prepare = vi.fn(() => stmt);
    const db = { prepare } as unknown as D1Database;
    const result = await getTenantByHost(db, "api.quilthosting.com", APP_URL);
    expect(result).toBeNull();
    // Exactly one query (the custom_domain lookup) — the slug-lookup query
    // must be skipped because "api" is excluded by name, not because it
    // failed to match.
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not treat 'www' as a tenant slug either (same carve-out, different guard)", async () => {
    // "www.quilthosting.com" IS caught by the early short-circuit (it's an
    // explicit `host === \`www.\${platform}\`` check), so this one really
    // does skip the DB entirely — unlike "api" above.
    const db = dbThatMustNotBeQueried();
    const result = await getTenantByHost(db, "www.quilthosting.com", APP_URL);
    expect(result).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

describe("ensurePlatformSubdomain uses zone DNS, not a Workers custom domain", () => {
  // Regression guard for a production incident on 2026-08-13: the subdomain was
  // attached via the Workers domains API, and the next `wrangler deploy`
  // reconciled custom domains against wrangler.toml and deleted it -- taking the
  // DNS record with it. Runtime-created tenant subdomains can never appear in
  // that file, so this must never go back to the workers/domains endpoint.
  function fetchSpy(urls: string[]) {
    return async (url: string | URL, init?: RequestInit) => {
      urls.push(`${init?.method || "GET"} ${String(url)}`);
      return new Response(
        JSON.stringify({ success: true, result: String(url).includes("dns_records") && (init?.method || "GET") === "GET" ? [] : { id: "rec1" } }),
        { headers: { "Content-Type": "application/json" } }
      );
    };
  }

  it("creates a proxied zone DNS record and never calls workers/domains", async () => {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy(urls) as unknown as typeof fetch;
    try {
      const res = await ensurePlatformSubdomain(
        { CLOUDFLARE_API_TOKEN: "t", APP_URL: "https://quilthosting.com" } as never,
        "stitchstudio"
      );
      expect(res.ok).toBe(true);
      expect(res.hostname).toBe("stitchstudio.quilthosting.com");
    } finally {
      globalThis.fetch = original;
    }
    expect(urls.some((u) => u.includes("/dns_records"))).toBe(true);
    expect(urls.some((u) => u.includes("workers/domains"))).toBe(false);
  });

  it("reports a clear error rather than throwing when no token is configured", async () => {
    const res = await ensurePlatformSubdomain(
      { APP_URL: "https://quilthosting.com" } as never,
      "stitchstudio"
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("CLOUDFLARE_API_TOKEN");
  });
});
