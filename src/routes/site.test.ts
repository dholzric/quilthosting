// The customer quote page and the e-signature ceremony (Task 10). Exercises
// serveBusinessSite's /quote/<token> and /quote/<token>/sign branch through
// a real Hono app, against a hand-rolled fake D1 that enforces the same
// invariants the real schema does: a project is found by (access_token_hash,
// tenant_id), and agreement_signatures has a UNIQUE(project_id) -- modeled
// here as a Map keyed by project_id, with the fake INSERT's
// "ON CONFLICT(project_id) DO NOTHING RETURNING id" returning null exactly
// when SQLite would have skipped the insert.
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant, Project, ProjectLine, AgreementSignature } from "../types";
import { sha256Hex } from "../lib/projects/hash";
import { hashToken, mintAccessToken } from "../lib/projects/token";

const { serveBusinessSite } = await import("./site");

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "tenant-a",
    name: "Stitch Studio",
    slug: "stitchstudio",
    custom_domain: null,
    tenant_type: "business",
    public_launched: 1,
    stripe_account_id: null,
    plan: "free",
    status: "active",
    settings_json: JSON.stringify({
      longarm: { agreementTitle: "Service Agreement", agreementBody: "Standard terms." },
      business: { email: "owner@stitchstudio.test" },
    }),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    tenant_id: "tenant-a",
    project_type: "longarm",
    status: "estimated",
    reference: "Q-1001",
    customer_name: "Jane Customer",
    customer_email: "jane@example.com",
    customer_phone: null,
    member_id: null,
    intake_json: "{}",
    estimate_notes: null,
    subtotal_cents: 5000,
    total_cents: 5000,
    due_date: null,
    access_token_hash: "",
    token_expires_at: null,
    estimated_at: "2026-08-01T00:00:00.000Z",
    signed_at: null,
    completed_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

type State = {
  projects: Map<string, Project>;
  lines: Map<string, ProjectLine[]>;
  signatures: Map<string, AgreementSignature>;
  updateCalls: number;
};

function makeState(project?: Project, lines: ProjectLine[] = []): State {
  const projects = new Map<string, Project>();
  if (project) {
    projects.set(project.id, project);
  }
  const linesMap = new Map<string, ProjectLine[]>();
  if (project) linesMap.set(project.id, lines);
  return { projects, lines: linesMap, signatures: new Map(), updateCalls: 0 };
}

/** A fake D1 that enforces the same shapes/uniqueness the real schema does. */
function makeDb(state: State): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes("FROM projects WHERE access_token_hash")) {
                const [tokenHash, tenantId] = binds as [string, string];
                for (const p of state.projects.values()) {
                  if (p.access_token_hash === tokenHash && p.tenant_id === tenantId) {
                    return p as unknown as T;
                  }
                }
                return null;
              }
              if (sql.includes("FROM agreement_signatures WHERE project_id")) {
                const [projectId, tenantId] = binds as [string, string];
                const sig = state.signatures.get(projectId);
                return sig && sig.tenant_id === tenantId ? (sig as unknown as T) : null;
              }
              if (sql.includes("INSERT INTO agreement_signatures")) {
                const [
                  id,
                  tenantId,
                  projectId,
                  signerName,
                  signerEmail,
                  consentText,
                  agreementTitle,
                  agreementText,
                  agreementSha256,
                  signingTokenHash,
                  signerIp,
                  signerUa,
                  signedAt,
                ] = binds as string[];
                // ON CONFLICT(project_id) DO NOTHING: a row already present
                // for this project_id means the real UNIQUE index would have
                // silently skipped this insert, so RETURNING yields no row.
                if (state.signatures.has(projectId)) return null;
                const row: AgreementSignature = {
                  id,
                  tenant_id: tenantId,
                  project_id: projectId,
                  signer_name: signerName,
                  signer_email: signerEmail,
                  consent_text: consentText,
                  agreement_title: agreementTitle,
                  agreement_text: agreementText,
                  agreement_sha256: agreementSha256,
                  signing_token_hash: signingTokenHash,
                  signer_ip: signerIp,
                  signer_user_agent: signerUa,
                  signed_at: signedAt,
                };
                state.signatures.set(projectId, row);
                return row as unknown as T;
              }
              return null;
            },
            async all<T>(): Promise<D1Result<T>> {
              if (sql.includes("FROM project_lines")) {
                const projectId = binds[0] as string;
                return { results: (state.lines.get(projectId) ?? []) as unknown as T[] } as D1Result<T>;
              }
              return { results: [] } as unknown as D1Result<T>;
            },
            async run() {
              if (sql.includes("UPDATE projects SET status = 'signed'")) {
                const [signedAt, updatedAt, projectId, tenantId] = binds as string[];
                const p = state.projects.get(projectId);
                if (p && p.tenant_id === tenantId) {
                  p.status = "signed";
                  p.signed_at = signedAt;
                  p.updated_at = updatedAt;
                  state.updateCalls++;
                }
              }
              return { success: true } as D1Result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    FILES: {} as R2Bucket,
    KV: {} as KVNamespace,
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    RESEND_API_KEY: "",
    JWT_SECRET: "test-jwt-secret",
    ENVIRONMENT: "test",
    APP_URL: "https://quilthosting.com",
    ...overrides,
  };
}

// serveBusinessSite takes the resolved tenant as a plain argument, not
// through Hono's context variables, so the harness just closes over it.
function harness(tenant: Tenant, state: State) {
  const env = makeEnv(makeDb(state));
  const app = new Hono<{ Bindings: Env }>();
  app.all("*", async (c) => {
    const res = await serveBusinessSite(c, tenant);
    return res ?? c.notFound();
  });
  return { app, env };
}

describe("GET /quote/:token — unknown vs. expired tokens are indistinguishable", () => {
  it("an unknown token returns 404 with the invalid-link page", async () => {
    const tenant = makeTenant();
    const state = makeState(); // no project at all
    const { app, env } = harness(tenant, state);
    const res = await app.request("http://stitchstudioquilting.test/quote/totallyUnknownToken12345", {}, env);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("This link is no longer valid");
  });

  it("an expired token returns the SAME status, headers, and body as an unknown token", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({
      access_token_hash: tokenHash,
      token_expires_at: "2020-01-01T00:00:00.000Z", // long expired
    });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);

    const unknownRes = await app.request(
      "http://stitchstudioquilting.test/quote/totallyUnknownToken12345",
      {},
      env
    );
    const expiredRes = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}`, {}, env);

    expect(expiredRes.status).toBe(unknownRes.status);
    expect(await expiredRes.text()).toBe(await unknownRes.text());
    expect(expiredRes.headers.get("Referrer-Policy")).toBe(unknownRes.headers.get("Referrer-Policy"));
    expect(expiredRes.headers.get("X-Robots-Tag")).toBe(unknownRes.headers.get("X-Robots-Tag"));
  });

  it("a valid token for a DIFFERENT tenant's host is treated as invalid, not found-but-wrong-tenant", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ tenant_id: "tenant-a", access_token_hash: tokenHash });
    const state = makeState(project);
    // Resolved tenant is tenant-b (a different host), not the project's own
    // tenant-a -- exercises the tenant_id scoping in the SELECT.
    const otherTenant = makeTenant({ id: "tenant-b", slug: "othershop" });
    const { app, env } = harness(otherTenant, state);
    const res = await app.request(`http://othershop.test/quote/${rawToken}`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link is no longer valid");
  });
});

describe("GET /quote/:token — valid token", () => {
  it("renders the quote/sign page with Referrer-Policy: no-referrer and no-store caching", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project, [
      { id: "line-1", project_id: project.id, kind: "service", description: "Edge to edge quilting", quantity: 1, unit_cents: 5000, amount_cents: 5000, sort_order: 0 },
    ]);
    const { app, env } = harness(tenant, state);
    const res = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("Sign agreement");
    expect(body).toContain("Edge to edge quilting");
  });

  it("renders the signed copy (not the sign form) once a signature exists", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash, status: "signed" });
    const tenant = makeTenant();
    const state = makeState(project);
    state.signatures.set(project.id, {
      id: "sig-1",
      tenant_id: tenant.id,
      project_id: project.id,
      signer_name: "Jane Customer",
      signer_email: project.customer_email,
      consent_text: "I have read this agreement and I agree to be bound by it.",
      agreement_title: "Service Agreement",
      agreement_text: "Service Agreement\n\nStandard terms.",
      agreement_sha256: "deadbeef",
      signing_token_hash: tokenHash,
      signer_ip: null,
      signer_user_agent: null,
      signed_at: "2026-08-05T00:00:00.000Z",
    });
    const { app, env } = harness(tenant, state);
    const res = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}`, {}, env);
    const body = await res.text();
    expect(body).toContain("Signed agreement");
    expect(body).not.toContain("Sign agreement");
  });

  it("GET on the /sign URL is 405, not a silent render of the quote page", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}/sign`, {}, env);
    expect(res.status).toBe(405);
  });
});

describe("POST /quote/:token/sign — validation", () => {
  it("rejects a missing signer name", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent: true }) },
      env
    );
    expect(res.status).toBe(400);
    expect(state.signatures.size).toBe(0);
  });

  it("rejects missing consent even with a valid name", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signer_name: "Jane" }) },
      env
    );
    expect(res.status).toBe(400);
    expect(state.signatures.size).toBe(0);
  });

  it("refuses to sign a project whose status makes 'signed' an illegal transition", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    // "submitted" has no legal transition straight to "signed" (status.ts).
    const project = makeProject({ access_token_hash: tokenHash, status: "submitted" });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signer_name: "Jane", consent: true }) },
      env
    );
    expect(res.status).toBe(409);
    expect(state.signatures.size).toBe(0);
  });
});

describe("POST /quote/:token/sign — idempotency and the fourth check-then-act race", () => {
  it("a second sequential POST after a successful sign returns already_signed and creates no second row", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const body = JSON.stringify({ signer_name: "Jane Customer", consent: true });

    const first = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      env
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(state.signatures.size).toBe(1);
    expect(state.updateCalls).toBe(1);

    const second = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      env
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, already_signed: true });
    // No second row, no second status transition.
    expect(state.signatures.size).toBe(1);
    expect(state.updateCalls).toBe(1);
  });

  it("two concurrent POSTs racing past the pre-check both land, but only ONE signature row and ONE status transition result", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const body = JSON.stringify({ signer_name: "Jane Customer", consent: true });
    const post = () =>
      app.request(
        `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
        env
      );

    const [resA, resB] = await Promise.all([post(), post()]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const [jsonA, jsonB] = await Promise.all([resA.json(), resB.json()]);
    // Exactly one of the two is the winner (plain {ok:true}); the other lost
    // either the pre-check or the INSERT's ON CONFLICT DO NOTHING, and both
    // outcomes are reported identically as already_signed.
    const already = [jsonA, jsonB].filter((j) => (j as { already_signed?: boolean }).already_signed).length;
    expect(already).toBe(1);
    // The database-level guarantee: never more than one row, never more than
    // one status transition, regardless of how the two requests interleaved.
    expect(state.signatures.size).toBe(1);
    expect(state.updateCalls).toBe(1);
  });

  it("the stored agreement_sha256 is provably the hash of the stored agreement_text on a real signed row", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: "Jane Customer", consent: true }),
      },
      env
    );
    expect(res.status).toBe(200);
    const row = state.signatures.get(project.id);
    expect(row).toBeTruthy();
    // Recomputed from the row's OWN stored agreement_text -- not from a
    // second, independently-built snapshot string -- so this actually pins
    // the relationship the report calls out: agreement_sha256 IS the hash of
    // agreement_text as persisted, not merely "computed the same way once".
    expect(await sha256Hex(row!.agreement_text)).toBe(row!.agreement_sha256);
  });
});

describe("POST /quote/:token/sign — customer-supplied signer_name never reaches HTML/email unescaped", () => {
  it("a <script>-bearing signer name is stored raw but escaped in the rendered signed copy", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const evilName = '<script>alert(1)</script>';

    const signRes = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: evilName, consent: true }),
      },
      env
    );
    expect(signRes.status).toBe(200);

    const row = state.signatures.get(project.id);
    // Stored raw -- escaping is a rendering-time concern, not a storage-time
    // one, matching how the rest of the record (a legal artifact) is kept.
    expect(row!.signer_name).toBe(evilName);

    const viewRes = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}`, {}, env);
    const html = await viewRes.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
