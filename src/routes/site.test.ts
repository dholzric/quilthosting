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
  // Test-only hook for the Important #4 race: when set, the FIRST read of a
  // project by access_token_hash returns a plain snapshot (what the request
  // "saw" at read time) and then immediately flips the LIVE row's status to
  // this value -- simulating a concurrent owner action (cancel/decline)
  // landing between this request's read and its eventual guarded UPDATE.
  raceStatusFlipTo?: string;
  raceStatusFlipApplied?: boolean;
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

/**
 * A fake D1 that enforces the same shapes/uniqueness the real schema does,
 * including real `.batch()` semantics: each statement in a batch executes
 * against the SAME live state, in order, exactly like signQuote's
 * [INSERT ... ON CONFLICT DO NOTHING RETURNING id, UPDATE ... AND status =
 * 'estimated'] pair is meant to. `execStatement` is the single place that
 * knows how to run a (sql, binds) pair; `.first()/.all()/.run()` and
 * `.batch()` are all thin wrappers over it so there is exactly one
 * implementation of "what each statement does" to keep in sync with
 * src/routes/site.ts.
 */
function makeDb(state: State): D1Database {
  function execStatement(sql: string, binds: unknown[]): { results: unknown[] } {
    if (sql.includes("FROM projects WHERE access_token_hash")) {
      const [tokenHash, tenantId] = binds as [string, string];
      for (const p of state.projects.values()) {
        if (p.access_token_hash === tokenHash && p.tenant_id === tenantId) {
          const snapshot = { ...p };
          if (state.raceStatusFlipTo && !state.raceStatusFlipApplied) {
            p.status = state.raceStatusFlipTo;
            state.raceStatusFlipApplied = true;
          }
          return { results: [snapshot] };
        }
      }
      return { results: [] };
    }
    if (sql.includes("FROM project_lines")) {
      const projectId = binds[0] as string;
      return { results: state.lines.get(projectId) ?? [] };
    }
    if (sql.includes("FROM agreement_signatures WHERE project_id")) {
      const [projectId, tenantId] = binds as [string, string];
      const sig = state.signatures.get(projectId);
      return { results: sig && sig.tenant_id === tenantId ? [sig] : [] };
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
      // ON CONFLICT(project_id) DO NOTHING: a row already present for this
      // project_id means the real UNIQUE index would have silently skipped
      // this insert, so RETURNING yields no row.
      if (state.signatures.has(projectId)) return { results: [] };
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
      return { results: [row] };
    }
    if (sql.startsWith("UPDATE projects SET status = ?")) {
      // Shape produced by statusWrite.ts's buildGuardedStatusUpdate (final
      // review, F1): `UPDATE projects SET status = ?, updated_at = ?,
      // signed_at = ? WHERE id = ? AND tenant_id = ? AND status = ?`. The
      // status guard is no longer a literal "AND status = 'estimated'" in
      // the SQL text -- it's the bound `fromStatus` value at the end of
      // `binds`. Deriving `statusOk` from that ACTUAL bound value (not a
      // guard this mock imposes unconditionally) is what keeps this
      // exercising the real query site.ts sent: if production ever bound
      // the wrong fromStatus, this mock would stop requiring the right one
      // too, so Important #4 / F1's regression test below genuinely tests
      // site.ts's own logic rather than passing regardless of what it sent.
      const [toStatus, updatedAt, signedAt, projectId, tenantId, fromStatus] = binds as string[];
      const p = state.projects.get(projectId);
      const statusOk = p?.status === fromStatus;
      if (p && p.tenant_id === tenantId && statusOk) {
        p.status = toStatus;
        p.signed_at = signedAt;
        p.updated_at = updatedAt;
        state.updateCalls++;
        return { results: [{ id: projectId }] };
      }
      return { results: [] };
    }
    return { results: [] };
  }

  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            __sql: sql,
            __binds: binds,
            async first<T>(): Promise<T | null> {
              const { results } = execStatement(sql, binds);
              return (results[0] as T) ?? null;
            },
            async all<T>(): Promise<D1Result<T>> {
              const { results } = execStatement(sql, binds);
              return { results: results as T[] } as D1Result<T>;
            },
            async run() {
              execStatement(sql, binds);
              return { success: true } as D1Result;
            },
          };
        },
      };
    },
    async batch<T>(stmts: Array<{ __sql: string; __binds: unknown[] }>): Promise<D1Result<T>[]> {
      return stmts.map((s) => {
        const { results } = execStatement(s.__sql, s.__binds);
        return { success: true, meta: {}, results: results as T[] } as D1Result<T>;
      });
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

/**
 * Pulls the agreement_sha256 hidden-field value straight out of the
 * rendered quote page HTML -- exactly what a real browser's sign form would
 * submit back. Deliberately does NOT recompute the hash independently in
 * the test (e.g. by re-calling buildAgreementSnapshot here): the whole
 * point of the coordinator's finding is that the value posted back must be
 * what was actually rendered, so the test fixture reads it the same way the
 * client does.
 */
async function getRenderedAgreementHash(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  rawToken: string
): Promise<string> {
  const res = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}`, {}, env);
  const html = await res.text();
  const m = html.match(/name="agreement_sha256" value="([0-9a-f]+)"/);
  if (!m) throw new Error("agreement_sha256 hidden field not found in rendered quote page");
  return m[1];
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
    // Asserting equality between the two responses alone would pass even if
    // BOTH sides were null/missing headers (Minor #1) -- pin the literal
    // values on at least one side so a regression that silently drops the
    // header on both paths is still caught.
    expect(expiredRes.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(expiredRes.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("a token that expired AFTER the project was signed still shows the signed copy, not the invalid-link page (Important #3)", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({
      access_token_hash: tokenHash,
      status: "signed",
      token_expires_at: "2020-01-01T00:00:00.000Z", // long expired
    });
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
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Signed agreement");
    expect(body).not.toContain("This link is no longer valid");
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
    // The hidden field the sign form posts back so signQuote can verify the
    // customer is signing the text that was actually rendered.
    expect(body).toMatch(/name="agreement_sha256" value="[0-9a-f]{64}"/);
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

  it("a cancelled project shows a terminal-state page, not a fillable sign form (Minor #2)", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash, status: "cancelled" });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("Sign agreement");
    expect(body).not.toContain('name="signer_name"');
    expect(body).toContain("cancelled");
    // No raw internal transition-machine vocabulary leaked to the customer.
    expect(body).not.toContain("Illegal transition");
  });

  it("a blank agreement body refuses to render the signing form (Minor #3)", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant({
      settings_json: JSON.stringify({
        longarm: { agreementTitle: "Service Agreement", agreementBody: "   " }, // blank/whitespace-only
        business: { email: "owner@stitchstudio.test" },
      }),
    });
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("Sign agreement");
    expect(body).not.toContain('name="signer_name"');
    expect(body).toContain("has not finished setting up a service agreement");
  });

  it("a fractional total_cents renders the cannot-sign page instead of 500ing (F8)", async () => {
    // Reachable in practice: the admin UI rounds rate inputs before saving,
    // but PATCH /api/tenants/:id does not, so a fractional minimumCents
    // written straight through the API produces a fractional amount_cents
    // at intake -- money()/assertIntCents() inside buildAgreementSnapshot
    // then throw a TypeError that neither call site in site.ts used to
    // catch, 500ing the one page an anonymous token holder has no way to
    // route around.
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash, total_cents: 100.5 });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(`http://stitchstudioquilting.test/quote/${rawToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("Sign agreement");
    expect(body).not.toContain('name="signer_name"');
    expect(body).toContain("pricing configuration issue");
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

  it("refuses to sign a project whose status makes 'signed' an illegal transition, WITHOUT leaking the raw transition string", async () => {
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
    const json = (await res.json()) as { error?: string };
    // Minor #2: assertTransition()'s own Error("Illegal transition: a -> b")
    // must never reach an anonymous token holder.
    expect(json.error).not.toContain("Illegal transition");
    expect(json.error).not.toContain("->");
  });

  it("refuses to sign when the agreement body is blank (Minor #3)", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant({
      settings_json: JSON.stringify({
        longarm: { agreementTitle: "Service Agreement", agreementBody: "" },
        business: { email: "owner@stitchstudio.test" },
      }),
    });
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No agreement_sha256 could ever be valid here anyway (the GET page
        // itself refuses to render a form with a hash), but this pins the
        // POST-side refusal independently of what the GET does.
        body: JSON.stringify({ signer_name: "Jane", consent: true, agreement_sha256: "irrelevant" }),
      },
      env
    );
    expect(res.status).toBe(409);
    expect(state.signatures.size).toBe(0);
  });

  it("a fractional total_cents is refused with 409, not a 500 (F8)", async () => {
    // Same underlying defect as the GET-side F8 test above, pinned
    // independently on the POST path: an attacker (or a stale page load
    // from before a bad rate was entered) could hit /sign directly even
    // though the GET page itself would refuse to render a form. The
    // submitted agreement_sha256 is irrelevant here -- the snapshot build
    // throws before the hash comparison is ever reached.
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash, total_cents: 100.5 });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: "Jane", consent: true, agreement_sha256: "irrelevant" }),
      },
      env
    );
    expect(res.status).toBe(409);
    expect(state.signatures.size).toBe(0);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toMatch(/pricing configuration issue/i);
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
    const agreement_sha256 = await getRenderedAgreementHash(app, env, rawToken);
    const body = JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256 });

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
    const agreement_sha256 = await getRenderedAgreementHash(app, env, rawToken);
    const body = JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256 });
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

  it("a status change landing between the read and the write is NOT silently overwritten back to 'signed' (Important #4, the fifth check-then-act race)", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const agreement_sha256 = await getRenderedAgreementHash(app, env, rawToken);

    // Simulates an owner cancelling the project through the admin API in
    // the window between this request's read of `project.status` (used by
    // assertTransition, which therefore still sees 'estimated' and lets the
    // request proceed) and the guarded UPDATE that runs moments later. See
    // makeDb's `raceStatusFlipTo` hook: it flips the LIVE row the instant
    // the project is read for this POST.
    state.raceStatusFlipTo = "cancelled";

    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256 }),
      },
      env
    );
    // The signing customer still gets a normal success response -- their
    // signature IS real and IS recorded (the INSERT has no status
    // dependency). What must NOT happen is the UPDATE clobbering the
    // concurrent cancellation.
    expect(res.status).toBe(200);
    expect(state.signatures.size).toBe(1);
    // The authoritative assertion: status stayed 'cancelled'. The naive,
    // unguarded `UPDATE projects SET status = 'signed' WHERE id = ? AND
    // tenant_id = ?` (no status predicate) would have silently reverted
    // this back to 'signed'.
    expect(state.projects.get(project.id)!.status).toBe("cancelled");
    expect(state.updateCalls).toBe(0);
  });

  it("the stored agreement_sha256 is provably the hash of the stored agreement_text on a real signed row", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const agreement_sha256 = await getRenderedAgreementHash(app, env, rawToken);
    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256 }),
      },
      env
    );
    expect(res.status).toBe(200);
    const row = state.signatures.get(project.id);
    expect(row).toBeTruthy();
    // Recomputed from the row's OWN stored agreement_text -- not from a
    // second, independently-built snapshot string, and not from the value
    // this test happened to submit -- so this actually pins the
    // relationship: agreement_sha256 IS the hash of agreement_text as
    // persisted, read back from the (fake) database, not merely "computed
    // the same way once".
    expect(await sha256Hex(row!.agreement_text)).toBe(row!.agreement_sha256);
  });
});

describe("POST /quote/:token/sign — the customer can only sign the text they actually saw", () => {
  it("happy path: signs when the submitted hash matches the rendered snapshot", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    const agreement_sha256 = await getRenderedAgreementHash(app, env, rawToken);

    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256 }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.signatures.size).toBe(1);
  });

  it("a STALE hash (the shop edited the agreement after the page was rendered) is rejected with 409 and writes no row", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project);
    const { app, env } = harness(tenant, state);
    // The hash of what was actually rendered a moment ago -- but the value
    // sent below is deliberately a DIFFERENT (well-formed, but wrong) hash,
    // simulating a client that loaded the page before an edit and is now
    // posting a hash that no longer matches live settings.
    const staleHash = "0".repeat(64);
    expect(staleHash).not.toBe(await getRenderedAgreementHash(app, env, rawToken));

    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256: staleHash }),
      },
      env
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toMatch(/reload/i);
    // The authoritative assertion: no row was written, not merely "some
    // error status came back".
    expect(state.signatures.size).toBe(0);
    // And the project status must not have moved either.
    expect(state.projects.get(project.id)!.status).toBe("estimated");
  });

  it("a line-item change between render and sign is rejected even though the TOTAL is unchanged (Important #1)", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash, total_cents: 8000 });
    const tenant = makeTenant();
    const state = makeState(project, [
      { id: "line-1", project_id: project.id, kind: "service", description: "Edge to edge quilting", quantity: 1, unit_cents: 8000, amount_cents: 8000, sort_order: 0 },
    ]);
    const { app, env } = harness(tenant, state);
    const agreement_sha256 = await getRenderedAgreementHash(app, env, rawToken);

    // The shop re-itemises between render and sign: same total (8000), but
    // now split across two different line items with a different rush
    // charge/discount structure -- exactly the attack the coordinator
    // described. Only the lines changed; title/body/total did not.
    state.lines.set(project.id, [
      { id: "line-2", project_id: project.id, kind: "service", description: "Custom quilting", quantity: 1, unit_cents: 8500, amount_cents: 8500, sort_order: 0 },
      { id: "line-3", project_id: project.id, kind: "discount", description: "Adjustment", quantity: 1, unit_cents: -500, amount_cents: -500, sort_order: 1 },
    ]);

    const res = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256 }),
      },
      env
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toMatch(/reload/i);
    expect(state.signatures.size).toBe(0);
    expect(state.projects.get(project.id)!.status).toBe("estimated");
  });

  it("a MISSING agreement_sha256 field is rejected with 409 (fail closed), and writes no row", async () => {
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
        // No agreement_sha256 at all -- must NOT be treated as "no opinion,
        // sign whatever is live".
        body: JSON.stringify({ signer_name: "Jane Customer", consent: true }),
      },
      env
    );
    expect(res.status).toBe(409);
    expect(state.signatures.size).toBe(0);
  });

  it("a non-string agreement_sha256 (malformed payload) is also rejected, not coerced", async () => {
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
        body: JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256: 12345 }),
      },
      env
    );
    expect(res.status).toBe(409);
    expect(state.signatures.size).toBe(0);
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
    const agreement_sha256 = await getRenderedAgreementHash(app, env, rawToken);

    const signRes = await app.request(
      `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer_name: evilName, consent: true, agreement_sha256 }),
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

describe("POST /quote/:token/sign — the customer's own permanent copy (Important #3)", () => {
  it("the confirmation email includes the full agreement text (with line items) and the fingerprint", async () => {
    const rawToken = mintAccessToken();
    const tokenHash = await hashToken(rawToken);
    const project = makeProject({ access_token_hash: tokenHash });
    const tenant = makeTenant();
    const state = makeState(project, [
      { id: "line-1", project_id: project.id, kind: "service", description: "Edge to edge quilting", quantity: 1, unit_cents: 5000, amount_cents: 5000, sort_order: 0 },
    ]);
    const { app, env } = harness(tenant, state);
    env.RESEND_API_KEY = "re_test";

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let res: Response;
    try {
      const agreement_sha256 = await getRenderedAgreementHash(app, env, rawToken);
      res = await app.request(
        `http://stitchstudioquilting.test/quote/${rawToken}/sign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signer_name: "Jane Customer", consent: true, agreement_sha256 }),
        },
        env
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(res!.status).toBe(200);
    const row = state.signatures.get(project.id);
    expect(row).toBeTruthy();

    const calls = fetchMock.mock.calls as unknown as [string, { body: string }][];
    const customerCall = calls.find((call) => {
      const parsed = JSON.parse(call[1].body) as { to: string[] };
      return Array.isArray(parsed.to) && parsed.to.includes(project.customer_email);
    });
    expect(customerCall).toBeTruthy();
    const emailBody = JSON.parse(customerCall![1].body) as { html: string };
    // The frozen document itself -- which, per Important #1's fix, already
    // contains the line items -- not just a one-line "you signed" notice.
    expect(emailBody.html).toContain("Edge to edge quilting");
    expect(emailBody.html).toContain("Line items:");
    // The fingerprint, matching what actually got persisted.
    expect(emailBody.html).toContain(row!.agreement_sha256);
  });
});
