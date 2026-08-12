// Coverage for the public intake route added in Task 7 review round 1.
// Same fake-D1-harness idiom as src/routes/projects.test.ts: dispatch
// through the exported app with a stateful fake D1 that records every
// write, so assertions check what the route actually did rather than
// trusting it.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { publicRoutes } from "./public";
import type { Env } from "../types";

const TENANT_ID = "tenant-1";

function harness(
  opts: {
    tenantOverrides?: Record<string, unknown>;
    failInsertsBeforeSuccess?: number;
  } = {}
) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  const prepared: string[] = [];
  let counterValue = 0;
  let projectInsertAttempts = 0;
  const tenant = {
    id: TENANT_ID,
    slug: "stitchstudio",
    tenant_type: "business",
    status: "active",
    settings_json: JSON.stringify({ longarm: { edgeToEdgeCentsPer100SqIn: 3 } }),
    ...opts.tenantOverrides,
  };

  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM tenants")) return tenant;
              if (sql.includes("project_counters") && sql.includes("RETURNING")) {
                // Simulates the atomic increment-and-read RETURNING gives
                // back — a fresh value every call, never a stale read.
                counterValue += 1;
                return { next_number: counterValue };
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO projects")) {
                projectInsertAttempts++;
                const failCount = opts.failInsertsBeforeSuccess ?? 0;
                if (projectInsertAttempts <= failCount) {
                  // Verbatim text observed from the real D1 Worker binding
                  // (not the wrangler CLI, which formats differently) for a
                  // genuine UNIQUE(tenant_id, reference) collision — see the
                  // comment above the regex this is asserting against in
                  // public.ts, and task-7-report.md's review-round-2
                  // addendum for how it was captured.
                  throw new Error(
                    "D1_ERROR: UNIQUE constraint failed: projects.tenant_id, projects.reference: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"
                  );
                }
              }
              writes.push({ sql, binds });
              return { success: true };
            },
          };
        },
      };
    },
  };

  const app = new Hono<{ Bindings: Env }>();
  app.route("/", publicRoutes);
  // RESEND_API_KEY intentionally omitted: sendEmail() short-circuits with
  // success:false and no network call when it's unset, so these tests never
  // need to mock fetch.
  const env = { DB: db } as unknown as Env;
  return { app, writes, prepared, env, projectInsertAttempts: () => projectInsertAttempts };
}

function post(app: Hono<{ Bindings: Env }>, env: Env, body: unknown) {
  return app.request(
    "/stitchstudio/projects/intake",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );
}

describe("POST /public/:slug/projects/intake", () => {
  it("rejects blockCount above 500 with 400 and writes nothing", async () => {
    const { app, env, writes } = harness();
    const res = await post(app, env, {
      project_type: "tshirt_quilt",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { blockCount: 501 },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/block count/i);
    expect(writes.length).toBe(0);
  });

  it("rejects blockCount of 0 with 400 (below the 1..500 bound)", async () => {
    const { app, env, writes } = harness();
    const res = await post(app, env, {
      project_type: "tshirt_quilt",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { blockCount: 0 },
    });
    expect(res.status).toBe(400);
    expect(writes.length).toBe(0);
  });

  it("accepts blockCount at the boundaries (1 and 500)", async () => {
    const { app, env } = harness({
      tenantOverrides: {
        settings_json: JSON.stringify({ longarm: { tshirtPerBlockCents: 500 } }),
      },
    });
    for (const blockCount of [1, 500]) {
      const res = await post(app, env, {
        project_type: "tshirt_quilt",
        customer_name: "Jo",
        customer_email: "jo@example.com",
        intake: { blockCount },
      });
      expect(res.status).toBe(200);
    }
  });

  it("rejects an oversized intake payload with 400 before writing anything", async () => {
    const { app, env, writes } = harness();
    const res = await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { widthIn: 60, heightIn: 80, junk: "x".repeat(9000) },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/too large/i);
    expect(writes.length).toBe(0);
  });

  it("strips unknown intake keys to the fixed allowlist before storing", async () => {
    const { app, env, writes } = harness();
    const res = await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { widthIn: 60, heightIn: 80, notAKnownField: "should not be stored" },
    });
    expect(res.status).toBe(200);
    const insert = writes.find((w) => w.sql.includes("INSERT INTO projects"));
    expect(insert).toBeDefined();
    const storedIntakeJson = insert!.binds[7] as string; // see bind-order comment below
    expect(storedIntakeJson).not.toContain("notAKnownField");
    const stored = JSON.parse(storedIntakeJson);
    expect(stored.widthIn).toBe(60);
    expect(stored.heightIn).toBe(80);
  });

  it("lowercases the stored customer email, matching every other public write route", async () => {
    const { app, env, writes } = harness();
    const res = await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "Jo.Smith@EXAMPLE.com",
      intake: { widthIn: 60, heightIn: 80 },
    });
    expect(res.status).toBe(200);
    const insert = writes.find((w) => w.sql.includes("INSERT INTO projects"));
    // bind order: id, tenant_id, project_type, reference, customer_name,
    // customer_email, customer_phone, intake_json, ...
    expect(insert!.binds[5]).toBe("jo.smith@example.com");
  });

  it("allocates the reference via a single atomic RETURNING statement, not a two-step upsert-then-select", async () => {
    const { app, env, prepared } = harness();
    await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { widthIn: 60, heightIn: 80 },
    });
    const counterStatements = prepared.filter((sql) => sql.includes("project_counters"));
    expect(counterStatements.length).toBe(1);
    expect(counterStatements[0]).toMatch(/RETURNING\s+next_number/i);
  });

  it("retries reference allocation on a UNIQUE collision instead of surfacing an unhandled 500", async () => {
    const { app, env, projectInsertAttempts } = harness({ failInsertsBeforeSuccess: 1 });
    const res = await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { widthIn: 60, heightIn: 80 },
    });
    expect(res.status).toBe(200);
    expect(projectInsertAttempts()).toBe(2);
  });

  it("gives up after MAX_REFERENCE_ATTEMPTS and returns a clean 500, not an unhandled exception", async () => {
    const { app, env } = harness({ failInsertsBeforeSuccess: 99 });
    const res = await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { widthIn: 60, heightIn: 80 },
    });
    expect(res.status).toBe(500);
    expect((await res.json<{ error: string }>()).error).toBeTruthy();
  });

  it("does not retry on an insert failure unrelated to the reference collision", async () => {
    // A different kind of D1 failure must not be masked by the retry loop —
    // it should propagate as a real error, not be swallowed as if it were a
    // reference race.
    const writes: unknown[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("FROM tenants")) {
                  return {
                    id: TENANT_ID,
                    slug: "stitchstudio",
                    tenant_type: "business",
                    status: "active",
                    settings_json: "{}",
                  };
                }
                if (sql.includes("project_counters")) return { next_number: 1 };
                return null;
              },
              async run() {
                if (sql.includes("INSERT INTO projects")) {
                  throw new Error("D1_ERROR: disk I/O error");
                }
                writes.push(sql);
                return { success: true };
              },
            };
          },
        };
      },
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route("/", publicRoutes);
    const env = { DB: db } as unknown as Env;
    // The route re-throws (rather than swallowing/retrying) on any insert
    // failure that isn't a reference collision. Hono's default error
    // handler turns that into a 500 with no custom JSON body — distinct
    // from the route's own "Could not process your request" 500, which
    // only fires after MAX_REFERENCE_ATTEMPTS genuine collisions.
    const res = await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { widthIn: 60, heightIn: 80 },
    });
    expect(res.status).toBe(500);
    expect(writes.length).toBe(0);
  });
});
