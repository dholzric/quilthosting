// siteGate.ts is the sole checkpoint that gates the whole product by host —
// nothing downstream (index.ts's own routing lists) provides host-based
// access control, only routing (see ../lib/platformPaths.ts's header
// comment). Live verification against `wrangler dev` is blocked by a
// `[[routes]]`-driven host-coercion bug in the local dev server (it always
// presents `c.req.header("host")` as the configured custom_domain route,
// regardless of what a client's Host header actually says — see Task 10's
// report). None of that applies here: this test drives the middleware
// directly through a real Hono app with a stubbed `getTenantByHost`, so a
// synthetic `Host` header is honored exactly as it would be in production.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant } from "../types";

const getTenantByHostMock = vi.fn();
vi.mock("../lib/tenantHost", () => ({
  getTenantByHost: (...args: unknown[]) => getTenantByHostMock(...args),
}));

// Imported after the mock so siteGate picks up the mocked module.
const { siteGate } = await import("./siteGate");

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    FILES: {} as R2Bucket,
    KV: {} as KVNamespace,
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    RESEND_API_KEY: "re_test",
    JWT_SECRET: "test-jwt-secret-not-real",
    ENVIRONMENT: "production",
    APP_URL: "https://quilthosting.com",
    SITE_ACCESS_PASSWORD: "correct-horse-battery-staple",
    ...overrides,
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", siteGate);
  app.all("*", (c) => c.text("OK"));
  return app;
}

async function requestPath(
  path: string,
  host: string,
  init: RequestInit = {}
): Promise<Response> {
  const app = makeApp();
  const env = makeEnv();
  return app.request(
    `http://placeholder${path}`,
    { ...init, headers: { Host: host, ...(init.headers as Record<string, string> | undefined) } },
    env
  );
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
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
    ...overrides,
  };
}

const launchedBusiness: Tenant = makeTenant();

const unlaunchedBusiness: Tenant = makeTenant({ public_launched: 0 });

const guildTenant: Tenant = makeTenant({
  id: "tnt_guild",
  name: "Some Quilt Guild",
  slug: "somequiltguild",
  custom_domain: null,
  tenant_type: "guild",
  public_launched: 0,
});

beforeEach(() => {
  getTenantByHostMock.mockReset();
});

describe("siteGate — gated hosts (must stay 401/403, never open)", () => {
  it("platform apex: getTenantByHost resolves null, password required", async () => {
    getTenantByHostMock.mockResolvedValue(null);
    const res = await requestPath("/", "quilthosting.com");
    expect(res.status).toBe(401);
  });

  it("www.quilthosting.com: also resolves null, password required", async () => {
    getTenantByHostMock.mockResolvedValue(null);
    const res = await requestPath("/", "www.quilthosting.com");
    expect(res.status).toBe(401);
  });

  it("workers.dev host: resolves null, password required", async () => {
    getTenantByHostMock.mockResolvedValue(null);
    const res = await requestPath("/", "quilthosting.dholzric.workers.dev");
    expect(res.status).toBe(401);
  });

  it("guild subdomain: tenant resolves but is never 'launched' (not a business)", async () => {
    getTenantByHostMock.mockResolvedValue(guildTenant);
    const res = await requestPath("/", "somequiltguild.quilthosting.com");
    expect(res.status).toBe(401);
    expect(getTenantByHostMock).toHaveBeenCalled();
  });

  it("unlaunched business: tenant resolves, isLaunched is false", async () => {
    getTenantByHostMock.mockResolvedValue(unlaunchedBusiness);
    const res = await requestPath("/", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("a getTenantByHost that throws must fail closed, not open", async () => {
    getTenantByHostMock.mockRejectedValue(new Error("D1 is down"));
    const res = await requestPath("/", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /admin: platform surface stays gated on its own domain", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/admin", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /portal: also stays gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/portal", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /docs/getting-started.html: docs stay platform-only", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/docs/getting-started.html", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /public/othertenant/info: cannot read another tenant's data", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/public/othertenant/info", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /public/othertenant/join (write): cannot write to another tenant either", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/public/othertenant/join", "stitchstudioquilting.test", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("launched business at //admin: repeated-slash obfuscation still gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("//admin", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /%61dmin: percent-encoded obfuscation still gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/%61dmin", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /Admin: case obfuscation still gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/Admin", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /ADMIN: also gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/ADMIN", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at a malformed percent-escape: fails closed, not open", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    // "%" with no following hex digits is not valid percent-encoding.
    const res = await requestPath("/%zz", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /__scheduled: platform cron trigger stays gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/__scheduled", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /index.html: platform's own static shell stays gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/index.html", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /guild.html: the guild product's shell stays gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/guild.html", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /g/someguild: guild multi-page routing stays gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/g/someguild", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("launched business at /embed/otherslug/join: embed widgets stay gated", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/embed/otherslug/join", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });
});

describe("siteGate — a launched business's own site (must open)", () => {
  it("opens at /", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("opens at a page slug, e.g. /about", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/about", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
  });

  it("opens at /robots.txt (the permissive per-tenant version downstream)", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/robots.txt", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
  });

  it("opens at /sitemap.xml", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/sitemap.xml", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
  });

  it("opens at /qh-site.css and /qh-site.js", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const css = await requestPath("/qh-site.css", "stitchstudioquilting.test");
    const js = await requestPath("/qh-site.js", "stitchstudioquilting.test");
    expect(css.status).toBe(200);
    expect(js.status).toBe(200);
  });

  it("opens at /img/<id> (Task 14's route shape)", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/img/abc123_-XYZ", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
  });

  it("opens at /public/<own slug>/events — qh-site.js hydrates against this", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/public/stitchstudio/events", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
  });

  it("opens at /public/<own slug>/forms/contact (POST) — the contact-form endpoint", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/public/stitchstudio/forms/contact", "stitchstudioquilting.test", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});

describe("path normalization — verifying the assumptions it depends on", () => {
  it("dot-segments are pre-collapsed by the URL parser before siteGate sees them", () => {
    // siteGate reads `new URL(c.req.url).pathname`. Confirm — don't assume —
    // that the URL parser itself removes "/./" and "/x/../" segments per the
    // WHATWG URL spec, so siteGate's own normalization doesn't need to.
    expect(new URL("http://example.com/./admin").pathname).toBe("/admin");
    expect(new URL("http://example.com/foo/../admin").pathname).toBe("/admin");
    expect(new URL("http://example.com/foo/../../admin").pathname).toBe("/admin");
  });

  it("end to end: a request built with a dot-segment path stays gated on a launched host", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    // The Request/URL constructor collapses this to "/admin" before Hono
    // (and siteGate) ever see a pathname.
    const res = await requestPath("/foo/../admin", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });
});
