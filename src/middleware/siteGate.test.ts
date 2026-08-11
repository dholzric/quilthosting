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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Env, Tenant } from "../types";
import { isPlatformOnlyPath, PLATFORM_PATH_PREFIXES, PLATFORM_EXACT_PATHS } from "../lib/platformPaths";

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

/** The permissive per-tenant robots.txt serveBusinessSite would actually
 *  return — reproduced here only closely enough to be distinguishable from
 *  siteGate's own deny-all text, so a test can assert on the BODY and prove
 *  siteGate really called `next()` rather than just checking a 200 (which
 *  both the deny-all branch and this route return). */
function permissiveRobots(host: string) {
  return `User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", siteGate);
  app.get("/robots.txt", (c) => c.text(permissiveRobots(c.req.header("host") || "")));
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

describe("rule 4 boundary — /public/<own slug> must not match a near-miss slug", () => {
  // launchedBusiness.slug === "stitchstudio". A bare `.startsWith(\`/public/${slug}\`)`
  // without the trailing slash would wrongly match another tenant whose own
  // slug happens to start with "stitchstudio" — this is the highest-risk
  // line in the file, and until now its boundary had no test at all.
  it("GATED: /public/<ownslug>x/info (a longer slug that starts with ours)", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/public/stitchstudiox/info", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("GATED: /public/<ownslug>-other/info (a hyphenated near-miss slug)", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/public/stitchstudio-other/info", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("OPEN: /public/<ownslug> with no trailing path is still the exact-match form", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/public/stitchstudio", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
  });

  it("OPEN: /public/<ownslug>/ (trailing slash, own slug) still matches", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/public/stitchstudio/", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
  });
});

describe("decode-introduced dot-segments and double-encoding (IMPORTANT 2 fix)", () => {
  // The URL parser only collapses dot-segments present in the RAW request
  // path, before siteGate's own decodeURIComponent runs. A dot-segment that
  // only exists AFTER decoding was never seen by the URL parser and, before
  // this fix, was never re-checked either — decodeURIComponent alone turns
  // "..%2f..%2f" into "../../" without re-resolving it against anything.
  it("GATED: /x/..%2f..%2fadmin.html — decodes to a literal ../../ escape attempt", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/x/..%2f..%2fadmin.html", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("GATED: /public/<ownslug>/..%2f..%2fadmin.html — can't decode-escape out of the own-slug allow rule", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath(
      "/public/stitchstudio/..%2f..%2fadmin.html",
      "stitchstudioquilting.test"
    );
    expect(res.status).toBe(401);
  });

  it("GATED: /img/..%2fadmin — can't decode-escape out of the /img/<id> allow rule", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/img/..%2fadmin", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("GATED: /%252e%252e/admin — double-encoded, one decode pass leaves a literal %", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/%252e%252e/admin", "stitchstudioquilting.test");
    expect(res.status).toBe(401);
  });

  it("OPEN: a page slug containing a literal, already-decoded dot is unaffected", async () => {
    // Sanity check that the dot-segment rejection only fires on a segment
    // that is EXACTLY "." or "..", not on any segment merely containing a
    // dot — a real (if unusual) page slug like "v1.2-notes" must still work.
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/v1.2-notes", "stitchstudioquilting.test");
    expect(res.status).toBe(200);
  });
});

describe("robots.txt body — deny-all when gated, permissive when launched", () => {
  it("deny-all on the platform apex", async () => {
    getTenantByHostMock.mockResolvedValue(null);
    const res = await requestPath("/robots.txt", "quilthosting.com");
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("deny-all on a guild subdomain", async () => {
    getTenantByHostMock.mockResolvedValue(guildTenant);
    const res = await requestPath("/robots.txt", "somequiltguild.quilthosting.com");
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("deny-all on an unlaunched business", async () => {
    getTenantByHostMock.mockResolvedValue(unlaunchedBusiness);
    const res = await requestPath("/robots.txt", "stitchstudioquilting.test");
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("permissive (Allow: /) on a launched business — proves the request actually reached next()", async () => {
    getTenantByHostMock.mockResolvedValue(launchedBusiness);
    const res = await requestPath("/robots.txt", "stitchstudioquilting.test");
    const body = await res.text();
    expect(body).toContain("Allow: /");
    expect(body).not.toContain("Disallow: /");
  });
});

describe("PLATFORM_PATH_PREFIXES/PLATFORM_EXACT_PATHS is a superset of index.ts's two lists", () => {
  // Turns the "two lists, deliberately not unified but siteGate's must
  // still cover everything index.ts's do" argument (task-10-fix-report.md)
  // from prose into a mechanical check. Reads index.ts's actual source at
  // test time and extracts the literal strings from its two path lists —
  // NOT hand-copied here, so this can't itself silently drift from what
  // index.ts really contains. If the anchor comments below stop matching
  // (index.ts's shape changed), this test fails loudly rather than
  // silently checking nothing, which is the point.
  const indexSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../index.ts"),
    "utf8"
  );

  function extractBlock(startMarker: string, endMarker: string): string {
    const start = indexSrc.indexOf(startMarker);
    if (start === -1) {
      throw new Error(
        `siteGate.test.ts's superset check could not find the marker ${JSON.stringify(
          startMarker
        )} in src/index.ts — the file's shape changed; update this test's markers.`
      );
    }
    const end = indexSrc.indexOf(endMarker, start);
    if (end === -1) {
      throw new Error(
        `siteGate.test.ts's superset check could not find the end marker ${JSON.stringify(
          endMarker
        )} in src/index.ts — the file's shape changed; update this test's markers.`
      );
    }
    return indexSrc.slice(start, end);
  }

  function extractPaths(block: string): string[] {
    const found: string[] = [];
    for (const m of block.matchAll(/path\.startsWith\("([^"]+)"\)/g)) found.push(m[1]);
    for (const m of block.matchAll(/path === "([^"]+)"/g)) found.push(m[1]);
    return found;
  }

  const businessTenantList = extractPaths(
    extractBlock("const isPlatformPath =", "if (!isPlatformPath) {")
  );
  const guildHostList = extractPaths(
    extractBlock("// Known platform/admin paths on a tenant host", "// /g/* on custom host")
  );

  it("extraction actually found entries in both lists (sanity check on the markers)", () => {
    expect(businessTenantList.length).toBeGreaterThan(0);
    expect(guildHostList.length).toBeGreaterThan(0);
  });

  for (const literal of [...new Set([...businessTenantList, ...guildHostList])]) {
    it(`index.ts's ${JSON.stringify(literal)} is covered by isPlatformOnlyPath`, () => {
      // "Covered" means: any path index.ts would treat as matching this
      // literal (whether it used startsWith or ===) is also caught by
      // isPlatformOnlyPath. Testing the literal path itself is sufficient
      // for both an exact-match entry and a startsWith prefix entry (a
      // prefix that matches the shortest possible instance of itself
      // matches every longer instance too, since isPlatformOnlyPath's own
      // prefix checks are also startsWith).
      expect(isPlatformOnlyPath(literal)).toBe(true);
    });
  }
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
