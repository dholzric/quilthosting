// Same idiom as src/routes/pages.test.ts and credentials.test.ts: dispatch
// through the exported app with a thin stand-in for tenantMiddleware, and a
// keyword-routed fake D1 that records every write.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { projectRoutes } from "./projects";
import type { Env, Tenant, TenantVariables } from "../types";

const TENANT_ID = "tenant-1";

function harness(
  opts: {
    project?: Record<string, unknown>;
    role?: string;
    // Simulates an ALREADY-EXISTING members row for this tenant+email: the
    // fake ON CONFLICT branch returns this id instead of echoing back the
    // candidate id the route generated, exactly like the real
    // `INSERT ... ON CONFLICT(tenant_id, email) DO UPDATE ... RETURNING id`
    // does when a row already exists.
    existingMemberId?: string;
  } = {}
) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  // Every statement the routes prepare, in order. The tenant-scoping test
  // below asserts against this rather than trusting the routes.
  const prepared: string[] = [];
  let batchCalls = 0;
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM projects")) return opts.project ?? null;
              if (sql.includes("INSERT INTO members")) {
                // Real behavior: ON CONFLICT returns the EXISTING row's id;
                // no conflict returns the freshly-inserted row's id, which
                // is exactly the candidate id bound as the first parameter.
                if (opts.existingMemberId) return { id: opts.existingMemberId };
                return { id: binds[0] };
              }
              return null;
            },
            async all() {
              // GET / (the list route) SELECTs FROM projects too; return the
              // fixture row so list-route tests (e.g. the token-leak
              // regression below) have something real to inspect instead of
              // vacuously passing over an empty array.
              if (sql.includes("FROM projects")) return { results: opts.project ? [opts.project] : [] };
              return { results: [] };
            },
            async run() {
              writes.push({ sql, binds });
              return { success: true };
            },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { writes.push({ sql, binds: [] }); return { success: true }; },
      };
    },
    // PUT /:projectId/lines rewrites project_lines + the projects totals row
    // as one D1 batch so the rewrite is atomic (Finding 4). Each statement
    // in the batch was already produced by prepare(...).bind(...) above, so
    // running it here still records into `writes`/`prepared` exactly as a
    // standalone .run() would.
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      batchCalls++;
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables & { tenantRole: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, slug: "stitchstudio", settings_json: "{}" } as Tenant);
    c.set("tenantRole", opts.role ?? "owner");
    await next();
  });
  app.route("/", projectRoutes);
  return { app, writes, prepared, env: { DB: db } as unknown as Env, batchCalls: () => batchCalls };
}

describe("projects admin API", () => {
  it("refuses a non-owner role", async () => {
    const { app, env } = harness({ role: "member", project: { id: "p1", status: "submitted" } });
    const res = await app.request("/p1", { method: "PATCH", body: JSON.stringify({ status: "estimated" }) }, env);
    expect(res.status).toBe(403);
  });

  it("rejects an illegal status transition with 409, not 500", async () => {
    const { app, env } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed" }) },
      env
    );
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain("submitted -> completed");
  });

  it("accepts a legal transition", async () => {
    const { app, env, writes } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "signed", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "in_progress" }) },
      env
    );
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.sql.includes("UPDATE projects"))).toBe(true);
  });

  it("scopes EVERY statement touching projects to the tenant", async () => {
    // The Global Constraints require `WHERE tenant_id = ?` on every query;
    // this asserts it against the SQL the routes actually prepare, rather
    // than trusting that they do. `prepared` is populated by the harness
    // above — see the `prepare(sql)` hook, which records each statement.
    //
    // Fix round 1, finding 5: this used to call only GET /p1 and GET /,
    // so PATCH, PUT .../lines, and POST .../resend-link never contributed
    // any SQL to `prepared` — the test would have kept passing even if one
    // of those three dropped `tenant_id = ?` entirely. It now drives all
    // five routes before asserting.
    const { app, env, prepared } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    await app.request("/p1", {}, env);
    await app.request("/", {}, env);
    await app.request(
      "/p1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estimate_notes: "hi" }) },
      env
    );
    await app.request(
      "/p1/lines",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines: [] }) },
      env
    );
    await app.request("/p1/resend-link", { method: "POST" }, env);

    const projectStatements = prepared.filter((sql) => /\bprojects\b/.test(sql));
    expect(projectStatements.length).toBeGreaterThan(0);
    for (const sql of projectStatements) {
      expect(sql).toMatch(/tenant_id\s*=\s*\?/);
    }
  });

  it("never returns access_token_hash or token_expires_at from the list route", async () => {
    // Finding 1: GET / did `SELECT *` and returned every row verbatim,
    // leaking the customer access-link token hash on the endpoint the admin
    // dashboard hits constantly. GET /:projectId already stripped it.
    const { app, env } = harness({
      project: {
        id: "p1",
        tenant_id: TENANT_ID,
        status: "submitted",
        reference: "X-0001",
        access_token_hash: "super-secret-hash",
        token_expires_at: "2026-12-01T00:00:00.000Z",
      },
    });
    const res = await app.request("/", {}, env);
    const rows = await res.json<Record<string, unknown>[]>();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("access_token_hash");
      expect(row).not.toHaveProperty("token_expires_at");
    }
  });

  it("recomputes totals from the saved lines rather than trusting the client", async () => {
    const { app, env, writes } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1/lines",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [
            { kind: "service", description: "Quilting", quantity: 1, unit_cents: 10000, amount_cents: 10000 },
            { kind: "addon", description: "Thread", quantity: 1, unit_cents: 1200, amount_cents: 1200 },
          ],
          // A client claiming the total is $1 must not be believed.
          total_cents: 100,
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const update = writes.find((w) => w.sql.includes("UPDATE projects SET subtotal_cents"));
    expect(update).toBeDefined();
    expect(update!.binds).toContain(11200);
  });

  it("rewrites project_lines and the totals row as a single atomic batch", async () => {
    // Finding 4: DELETE, N INSERTs, and the totals UPDATE used to be
    // independent round trips; an interruption could leave project_lines
    // partially rewritten or total_cents out of sync with the stored rows.
    const { app, env, batchCalls } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1/lines",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [{ kind: "service", description: "Quilting", quantity: 1, unit_cents: 5000, amount_cents: 5000 }],
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    // One batch call carrying the DELETE + INSERT + UPDATE, not three
    // separate .run() round trips.
    expect(batchCalls()).toBe(1);
  });

  it("rejects an unparseable body on PUT .../lines with 400 instead of wiping the lines", async () => {
    // Finding 2: a missing/empty/unparseable body used to fall through to
    // "replace with zero lines" and return 200 {ok:true}, deleting every
    // existing line and zeroing the total a customer is about to sign.
    const { app, env, writes } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1/lines",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: "not json" },
      env
    );
    expect(res.status).toBe(400);
    // Nothing should have been deleted, inserted, or zeroed out.
    expect(writes.some((w) => w.sql.includes("project_lines") || w.sql.includes("UPDATE projects SET subtotal_cents"))).toBe(false);
  });

  it("still clears all lines when the body legitimately contains an empty lines array", async () => {
    // The other half of Finding 2: rejecting bad input must not regress the
    // legitimate case of deliberately clearing every line.
    const { app, env, writes } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1/lines",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines: [] }) },
      env
    );
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.sql.startsWith("DELETE FROM project_lines"))).toBe(true);
    const update = writes.find((w) => w.sql.includes("UPDATE projects SET subtotal_cents"));
    expect(update!.binds).toContain(0);
  });

  it("clears due_date/customer_phone on an explicit null, but leaves them alone when omitted", async () => {
    // Finding 3: PatchBody types both as `string | null`, promising that
    // null clears the column, but coalesce(?, col) can't tell "explicit
    // null" apart from "omitted" — both used to just keep the old value.
    const { app, env, writes } = harness({
      project: {
        id: "p1",
        tenant_id: TENANT_ID,
        status: "submitted",
        reference: "X-0001",
        due_date: "2026-09-01",
        customer_phone: "555-0100",
      },
    });

    // Explicit null clears both.
    const clearRes = await app.request(
      "/p1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ due_date: null, customer_phone: null }),
      },
      env
    );
    expect(clearRes.status).toBe(200);
    const clearUpdate = writes[writes.length - 1];
    // bind order: status, estimate_notes, due_date, customer_name,
    // customer_email, customer_phone, status(for completed_at), now, now, id, tenant_id
    expect(clearUpdate.binds[2]).toBeNull();
    expect(clearUpdate.binds[5]).toBeNull();

    // Omitting the keys entirely leaves the existing values untouched.
    const keepRes = await app.request(
      "/p1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_notes: "no change to due_date/phone" }),
      },
      env
    );
    expect(keepRes.status).toBe(200);
    const keepUpdate = writes[writes.length - 1];
    expect(keepUpdate.binds[2]).toBe("2026-09-01");
    expect(keepUpdate.binds[5]).toBe("555-0100");
  });

  describe("POST /:projectId/send-estimate", () => {
    // Review round 2, Findings 2 & 3: the member find-or-create must be a
    // single atomic ON CONFLICT(tenant_id, email) upsert (not a racy
    // SELECT-then-INSERT), and must fire member.created — but ONLY when a
    // member row was genuinely created, not on every call.

    it("creates a new member via the atomic upsert and fires member.created", async () => {
      const { app, env, writes } = harness({
        project: {
          id: "p1",
          tenant_id: TENANT_ID,
          status: "submitted",
          reference: "X-0001",
          customer_email: "new@example.com",
          customer_name: "New Customer",
        },
        // No existingMemberId: the fake ON CONFLICT branch echoes back the
        // candidate id, simulating a genuine first-time insert.
      });
      const res = await app.request("/p1/send-estimate", { method: "POST" }, env);
      expect(res.status).toBe(200);

      // The member upsert itself runs via .first() (it's a RETURNING
      // statement, not a plain .run()), so it won't appear in `writes` —
      // asserted separately below via `prepared`.
      const outboxWrite = writes.find((w) => w.sql.includes("INSERT INTO webhook_outbox"));
      expect(outboxWrite).toBeDefined();
      expect(outboxWrite!.binds[2]).toBe("member.created");
      const payload = JSON.parse(outboxWrite!.binds[4] as string);
      expect(payload).toMatchObject({
        source: "admin",
        email: "new@example.com",
        first_name: "New Customer",
        last_name: null,
        status: "active",
      });

      const projectUpdate = writes.find((w) => w.sql.includes("UPDATE projects SET status = 'estimated'"));
      expect(projectUpdate).toBeDefined();
      // member_id bound onto the project update must be the SAME id the
      // event payload references — the candidate id the upsert echoed back.
      expect(projectUpdate!.binds[0]).toBe(payload.member_id);
    });

    it("matches an existing member via ON CONFLICT and does NOT fire member.created", async () => {
      const { app, env, writes } = harness({
        project: {
          id: "p1",
          tenant_id: TENANT_ID,
          status: "submitted",
          reference: "X-0001",
          customer_email: "returning@example.com",
          customer_name: "Returning Customer",
        },
        existingMemberId: "existing-member-99",
      });
      const res = await app.request("/p1/send-estimate", { method: "POST" }, env);
      expect(res.status).toBe(200);

      expect(writes.some((w) => w.sql.includes("INSERT INTO webhook_outbox"))).toBe(false);

      const projectUpdate = writes.find((w) => w.sql.includes("UPDATE projects SET status = 'estimated'"));
      expect(projectUpdate).toBeDefined();
      // Must reuse the EXISTING member's id, not the candidate id the route
      // generated and discarded when the upsert reported a conflict.
      expect(projectUpdate!.binds[0]).toBe("existing-member-99");
    });

    it("targets the member upsert's ON CONFLICT at (tenant_id, email), matching idx_members_tenant_email", async () => {
      const { app, env, prepared } = harness({
        project: {
          id: "p1",
          tenant_id: TENANT_ID,
          status: "submitted",
          reference: "X-0001",
          customer_email: "a@example.com",
          customer_name: "A",
        },
      });
      await app.request("/p1/send-estimate", { method: "POST" }, env);
      const memberStatements = prepared.filter((sql) => sql.includes("INSERT INTO members"));
      expect(memberStatements.length).toBe(1);
      expect(memberStatements[0]).toMatch(/ON CONFLICT\(tenant_id,\s*email\)/i);
      expect(memberStatements[0]).toMatch(/RETURNING\s+id/i);
    });

    it("rejects an illegal transition before touching the member table", async () => {
      const { app, env, writes } = harness({
        project: {
          id: "p1",
          tenant_id: TENANT_ID,
          status: "completed",
          reference: "X-0001",
          customer_email: "a@example.com",
          customer_name: "A",
        },
      });
      const res = await app.request("/p1/send-estimate", { method: "POST" }, env);
      expect(res.status).toBe(409);
      expect(writes.length).toBe(0);
    });
  });
});
