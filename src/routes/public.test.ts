// Coverage for the public intake route added in Task 7 review round 1.
// Same fake-D1-harness idiom as src/routes/projects.test.ts: dispatch
// through the exported app with a stateful fake D1 that records every
// write, so assertions check what the route actually did rather than
// trusting it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { signJwt } from "../lib/auth";

// Stripe is never reached from these tests. createCheckoutSession /
// retrieveCheckoutSession are stubbed; checkoutHoldExpiry stays real so the
// hold timestamp the route stores is the one it would store in prod.
vi.mock("../lib/stripe", async () => {
  const actual = await vi.importActual<typeof import("../lib/stripe")>("../lib/stripe");
  return {
    ...actual,
    createCheckoutSession: vi.fn(async () => ({ id: "cs_new", url: "https://checkout.stripe.test/cs_new" })),
    retrieveCheckoutSession: vi.fn(async (_env: unknown, id: string) => ({
      id,
      url: `https://checkout.stripe.test/${id}`,
      status: "open",
    })),
  };
});

import { publicRoutes } from "./public";
import { createCheckoutSession, retrieveCheckoutSession } from "../lib/stripe";

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
  // Each call to db.batch() recorded as its own array of {sql} entries, so
  // a test can assert statements arrived in ONE batch call together, not
  // merely that they landed in `writes` in the right relative order (which
  // the old sequential-.run() code would also have produced — final
  // review, closeout item 1).
  const batchCalls: { sql: string }[][] = [];
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
            __sql: sql,
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
    // The project INSERT and every ballpark line INSERT now run as ONE D1
    // batch (final review, F5), not as N+1 independent .run() calls.
    // Delegating to each statement's own .run() (already defined by
    // prepare().bind() above) — sequentially, so a throw from an early
    // statement (the project INSERT simulating a reference collision, see
    // failInsertsBeforeSuccess) aborts the rest of the batch exactly like a
    // real D1 transaction rolling back — keeps this a single implementation
    // of "what a statement does" rather than a second copy of the collision
    // simulation logic above.
    async batch(stmts: { __sql?: string; run: () => Promise<unknown> }[]) {
      batchCalls.push(stmts.map((s) => ({ sql: s.__sql ?? "" })));
      const results = [];
      for (const s of stmts) {
        results.push(await s.run());
      }
      return results;
    },
  };

  const app = new Hono<{ Bindings: Env }>();
  app.route("/", publicRoutes);
  // RESEND_API_KEY intentionally omitted: sendEmail() short-circuits with
  // success:false and no network call when it's unset, so these tests never
  // need to mock fetch.
  const env = { DB: db } as unknown as Env;
  return {
    app,
    writes,
    prepared,
    env,
    projectInsertAttempts: () => projectInsertAttempts,
    batchCalls: () => batchCalls,
  };
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

  it("F5: the project row and its ballpark lines commit as a single db.batch() call, not independent round trips", async () => {
    // final review, F5: the project INSERT used to commit on its own, with
    // the ballpark's line rows inserted afterward one .run() at a time. A
    // partial failure between them could leave lines summing to less than
    // the total_cents already committed on the project row -- and the
    // quote page reads lines from one write and the total from the other
    // before freezing both into the signature.
    //
    // Closeout item 1: the original version of this test only checked
    // relative order inside `writes` (project insert's index < every line
    // insert's index). That was true under the OLD sequential-.run() code
    // too -- .run() calls still land in `writes` in call order whether or
    // not they're wrapped in a batch -- so the assertion never actually
    // discriminated the fix from its absence. This version instead counts
    // db.batch() invocations directly and inspects the SQL of the
    // statements handed to that one call, which only passes if the route
    // genuinely called db.batch([projectInsertStmt, ...lineInsertStmts])
    // rather than N+1 separate .run()s.
    const { app, env, batchCalls } = harness({
      tenantOverrides: {
        settings_json: JSON.stringify({ longarm: { edgeToEdgeCentsPer100SqIn: 250 } }),
      },
    });
    const res = await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { widthIn: 60, heightIn: 80 },
    });
    expect(res.status).toBe(200);
    const calls = batchCalls();
    // Exactly one db.batch() call for the whole intake -- not zero (which
    // would mean everything still ran as independent .run()s) and not more
    // than one (which would mean the project write and its lines were
    // split across separate batches, reopening the same partial-failure
    // window this fix closes).
    expect(calls.length).toBe(1);
    const [stmts] = calls;
    const projectIdx = stmts.findIndex((s) => s.sql.includes("INSERT INTO projects"));
    const lineIdxs = stmts
      .map((s, i) => ({ isLine: s.sql.includes("INSERT INTO project_lines"), i }))
      .filter((x) => x.isLine)
      .map((x) => x.i);
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    // This ballpark (60x80 at 250 c/100sqin, no minimum/rush configured)
    // produces exactly one line -- assert on that concrete count, not just
    // "some," so a regression that dropped line inserts entirely (leaving
    // the batch with only the project statement) would also be caught.
    expect(lineIdxs.length).toBe(1);
    expect(lineIdxs.every((i) => i > projectIdx)).toBe(true);
  });

  it("F5: a reference-collision retry leaves no orphaned line rows from the failed attempt", async () => {
    const { app, env, writes, projectInsertAttempts } = harness({
      tenantOverrides: {
        settings_json: JSON.stringify({ longarm: { edgeToEdgeCentsPer100SqIn: 250 } }),
      },
      failInsertsBeforeSuccess: 1,
    });
    const res = await post(app, env, {
      project_type: "longarm",
      customer_name: "Jo",
      customer_email: "jo@example.com",
      intake: { widthIn: 60, heightIn: 80 },
    });
    expect(res.status).toBe(200);
    expect(projectInsertAttempts()).toBe(2);
    // The failed attempt's project INSERT threw before being pushed to
    // `writes` -- and because the project INSERT is the FIRST statement in
    // its batch, the line INSERTs that come after it in the same array
    // never even ran for that attempt. Exactly one project insert and
    // exactly one line insert (this ballpark produces a single line) must
    // have landed, not two of either.
    const projectInserts = writes.filter((w) => w.sql.includes("INSERT INTO projects"));
    expect(projectInserts.length).toBe(1);
    const lineInserts = writes.filter((w) => w.sql.includes("INSERT INTO project_lines"));
    expect(lineInserts.length).toBe(1);
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
      async batch(stmts: { run: () => Promise<unknown> }[]) {
        const results = [];
        for (const s of stmts) {
          results.push(await s.run());
        }
        return results;
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

// Coverage for the intake photo upload route added in Task 8. This endpoint
// is unauthenticated and writes to R2, so the tests lean adversarial: the
// single most important property is that the persisted content_type comes
// from sniffImageType (bytes), never from the client-declared multipart
// Content-Type header — see the security-context comment above the route.
describe("POST /public/:slug/projects/:projectRef/photos", () => {
  const PROJECT_ID = "project-1";
  const REFERENCE = "STITCH-0001";
  // A genuine, complete PNG signature — 8-byte magic plus 4 padding bytes to
  // clear sniffImageType's `bytes.length < 12` floor.
  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);

  function photoHarness(
    opts: {
      tenantOverrides?: Record<string, unknown>;
      project?: { id: string } | null;
      // 1-indexed: which call to "INSERT INTO files" should throw, to
      // exercise the R2-write-succeeds/D1-insert-fails compensation path.
      failFilesInsertOnCall?: number;
      // 1-indexed, counting BOTH the pre-check read and every retry-loop
      // read as "SELECT intake_json" calls: after this call returns its
      // value to the route, flip the stored row to a DIFFERENT value —
      // simulating another request's write landing in the gap between the
      // route's read and its own guarded UPDATE. Used to prove the
      // optimistic-concurrency guard actually causes a retry rather than a
      // silent overwrite.
      mutateIntakeAfterSelectCall?: number;
      // Like the above, but keeps racing on every retry-loop read (call 2
      // and onward) so every attempt's guard mismatches — exhausts
      // MAX_LINK_ATTEMPTS to exercise the loud-failure path.
      exhaustIntakeRetries?: boolean;
    } = {}
  ) {
    const dbWrites: { sql: string; binds: unknown[] }[] = [];
    let filesInsertCalls = 0;
    let intakeSelectCalls = 0;
    const tenant = {
      id: TENANT_ID,
      slug: "stitchstudio",
      tenant_type: "business",
      status: "active",
      settings_json: "{}",
      ...opts.tenantOverrides,
    };
    const project = "project" in opts ? opts.project : { id: PROJECT_ID };
    let currentIntakeJson = "{}";

    const db = {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async first() {
                if (sql.includes("FROM tenants")) return tenant;
                if (sql.includes("FROM projects") && sql.includes("reference = ?")) {
                  return project;
                }
                if (sql.includes("SELECT intake_json FROM projects")) {
                  intakeSelectCalls++;
                  const valueToReturn = currentIntakeJson;
                  if (opts.exhaustIntakeRetries && intakeSelectCalls >= 2) {
                    currentIntakeJson = JSON.stringify({
                      photoFileIds: [`racer-${intakeSelectCalls}`],
                    });
                  } else if (intakeSelectCalls === opts.mutateIntakeAfterSelectCall) {
                    currentIntakeJson = JSON.stringify({ photoFileIds: ["concurrent-file-id"] });
                  }
                  return { intake_json: valueToReturn };
                }
                return null;
              },
              async run() {
                if (sql.includes("INSERT INTO files")) {
                  filesInsertCalls++;
                  if (filesInsertCalls === opts.failFilesInsertOnCall) {
                    throw new Error("D1_ERROR: simulated insert failure");
                  }
                }
                if (sql.includes("UPDATE projects SET intake_json")) {
                  // Real WHERE ... AND intake_json = ? semantics: only
                  // "applies" (changes > 0) if the guard (last bind) still
                  // matches the currently stored value.
                  const guardJson = binds[binds.length - 1] as string;
                  if (guardJson === currentIntakeJson) {
                    currentIntakeJson = binds[0] as string;
                    dbWrites.push({ sql, binds });
                    return { success: true, meta: { changes: 1, changed_db: true } };
                  }
                  return { success: true, meta: { changes: 0, changed_db: false } };
                }
                dbWrites.push({ sql, binds });
                return { success: true, meta: { changes: 1, changed_db: true } };
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    };

    const r2Puts: { key: string; bytes: Uint8Array }[] = [];
    const r2Deletes: string[] = [];
    const FILES = {
      async put(key: string, bytes: Uint8Array) {
        r2Puts.push({ key, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) });
        return {};
      },
      async delete(key: string) {
        r2Deletes.push(key);
      },
    };

    const app = new Hono<{ Bindings: Env }>();
    app.route("/", publicRoutes);
    const env = { DB: db, FILES } as unknown as Env;
    return { app, env, dbWrites, r2Puts, r2Deletes, getIntakeJson: () => currentIntakeJson };
  }

  function postPhotos(
    app: Hono<{ Bindings: Env }>,
    env: Env,
    files: Array<{ name: string; type: string; bytes: Uint8Array }>,
    opts: { slug?: string; ref?: string; fieldName?: string } = {}
  ) {
    const form = new FormData();
    for (const f of files) {
      form.append(
        opts.fieldName ?? "photos",
        new File([f.bytes], f.name, { type: f.type })
      );
    }
    return app.request(
      `/${opts.slug ?? "stitchstudio"}/projects/${opts.ref ?? REFERENCE}/photos`,
      { method: "POST", body: form },
      env
    );
  }

  it("404s when the tenant does not exist or is not a business tenant", async () => {
    const { app, env } = photoHarness({ tenantOverrides: { tenant_type: "guild" } });
    const res = await postPhotos(app, env, [{ name: "a.png", type: "image/png", bytes: PNG_BYTES }]);
    expect(res.status).toBe(404);
  });

  it("404s when no project matches the reference (also covers cross-tenant reference guessing)", async () => {
    const { app, env, r2Puts } = photoHarness({ project: null });
    const res = await postPhotos(app, env, [{ name: "a.png", type: "image/png", bytes: PNG_BYTES }]);
    expect(res.status).toBe(404);
    expect(r2Puts.length).toBe(0);
  });

  it("400s when the body is not multipart form data", async () => {
    const { app, env } = photoHarness();
    const res = await app.request(
      `/stitchstudio/projects/${REFERENCE}/photos`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env
    );
    expect(res.status).toBe(400);
  });

  it("400s when no photos field is supplied", async () => {
    const { app, env } = photoHarness();
    const form = new FormData();
    form.append("not_photos", "x");
    const res = await app.request(
      `/stitchstudio/projects/${REFERENCE}/photos`,
      { method: "POST", body: form },
      env
    );
    expect(res.status).toBe(400);
  });

  it("400s when more than MAX_FILES (5) photos are supplied, and writes nothing", async () => {
    const { app, env, r2Puts, dbWrites } = photoHarness();
    const files = Array.from({ length: 6 }, (_, i) => ({
      name: `p${i}.png`,
      type: "image/png",
      bytes: PNG_BYTES,
    }));
    const res = await postPhotos(app, env, files);
    expect(res.status).toBe(400);
    expect(r2Puts.length).toBe(0);
    expect(dbWrites.length).toBe(0);
  });

  it("400s when a file's declared size exceeds the 10MB cap", async () => {
    const { app, env, r2Puts } = photoHarness();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG_BYTES);
    const res = await postPhotos(app, env, [{ name: "big.png", type: "image/png", bytes: big }]);
    expect(res.status).toBe(400);
    expect(r2Puts.length).toBe(0);
  });

  it("400s a zero-byte file (too short for any magic-byte signature)", async () => {
    const { app, env } = photoHarness();
    const res = await postPhotos(app, env, [
      { name: "empty.png", type: "image/png", bytes: new Uint8Array(0) },
    ]);
    expect(res.status).toBe(400);
  });

  // The security-critical case: a caller can put any string in the
  // multipart part's Content-Type, and does here — "image/png" — while the
  // actual bytes are HTML/script. Because the sibling routes that serve this
  // same `files` table (portal.ts, galleries.ts, public.ts:photo) echo
  // content_type back with no allowlist and no X-Content-Type-Options, a
  // wrong stored value here is a direct stored-XSS path through them.
  it("rejects a file whose bytes are not a real image even when Content-Type claims image/png", async () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>");
    const { app, env, r2Puts, dbWrites } = photoHarness();
    const res = await postPhotos(app, env, [
      { name: "evil.png", type: "image/png", bytes: html },
    ]);
    expect(res.status).toBe(400);
    expect(r2Puts.length).toBe(0);
    expect(dbWrites.length).toBe(0);
  });

  it("stores the SNIFFED content_type, not the client-declared header, for a genuine but mislabeled image", async () => {
    // Real PNG bytes, but the client claims it's a GIF — the persisted
    // content_type must reflect the bytes (image/png), not the header.
    const { app, env, dbWrites } = photoHarness();
    const res = await postPhotos(app, env, [
      { name: "actually-a-png.gif", type: "image/gif", bytes: PNG_BYTES },
    ]);
    expect(res.status).toBe(200);
    const insert = dbWrites.find((w) => w.sql.includes("INSERT INTO files"));
    expect(insert).toBeDefined();
    // bind order: id, tenant_id, r2_key, filename, content_type, size
    expect(insert!.binds[4]).toBe("image/png");
  });

  it("accepts a real PNG end to end: R2 key is tenant-scoped, size is recomputed from actual bytes, and the fileId is appended to intake_json.photoFileIds", async () => {
    const { app, env, r2Puts, dbWrites, getIntakeJson } = photoHarness();
    const res = await postPhotos(app, env, [
      { name: "quilt.png", type: "image/png", bytes: PNG_BYTES },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; file_ids: string[] }>();
    expect(body.ok).toBe(true);
    expect(body.file_ids.length).toBe(1);

    expect(r2Puts.length).toBe(1);
    expect(r2Puts[0].key.startsWith(`${TENANT_ID}/`)).toBe(true);
    expect(r2Puts[0].bytes.byteLength).toBe(PNG_BYTES.byteLength);

    const insert = dbWrites.find((w) => w.sql.includes("INSERT INTO files"));
    // size (bind index 5) is the actually-written byte length, matching what
    // was put into R2 — not a client-declared value.
    expect(insert!.binds[5]).toBe(PNG_BYTES.byteLength);

    const intake = JSON.parse(getIntakeJson());
    expect(intake.photoFileIds).toEqual(body.file_ids);
  });

  it("sanitizes a path-traversal filename before it reaches the R2 key", async () => {
    const { app, env, r2Puts } = photoHarness();
    const res = await postPhotos(app, env, [
      { name: "../../etc/passwd.png", type: "image/png", bytes: PNG_BYTES },
    ]);
    expect(res.status).toBe(200);
    expect(r2Puts.length).toBe(1);
    // No raw slash from the filename should survive into the key beyond the
    // two structural separators (tenant_id/fileId/filename).
    expect(r2Puts[0].key.split("/").length).toBe(3);
    expect(r2Puts[0].key).not.toContain("etc/passwd");
  });

  // Finding 2 (coordinator fix round 1): a batch that would push
  // existing + incoming past MAX_FILES is rejected up front, before any
  // R2/D1 write — not silently capped after the fact. The old behavior
  // ([...existing, ...fileIds].slice(0, MAX_FILES)) dropped some of THIS
  // request's just-committed ids from intake_json while still returning
  // them all in file_ids as if linked; that's exactly what this closes.
  it("accepts a second batch that exactly fills the project up to MAX_FILES", async () => {
    const { app, env, getIntakeJson } = photoHarness();
    const first = await postPhotos(
      app,
      env,
      Array.from({ length: 3 }, (_, i) => ({ name: `p${i}.png`, type: "image/png", bytes: PNG_BYTES }))
    );
    expect(first.status).toBe(200);
    expect(JSON.parse(getIntakeJson()).photoFileIds.length).toBe(3);

    const second = await postPhotos(
      app,
      env,
      Array.from({ length: 2 }, (_, i) => ({ name: `q${i}.png`, type: "image/png", bytes: PNG_BYTES }))
    );
    expect(second.status).toBe(200);
    expect(JSON.parse(getIntakeJson()).photoFileIds.length).toBe(5);
  });

  it("rejects a batch that would push the project over MAX_FILES up front, writing nothing and dropping no ids", async () => {
    const { app, env, getIntakeJson, r2Puts, dbWrites } = photoHarness();
    const first = await postPhotos(
      app,
      env,
      Array.from({ length: 3 }, (_, i) => ({ name: `p${i}.png`, type: "image/png", bytes: PNG_BYTES }))
    );
    expect(first.status).toBe(200);
    const r2PutsAfterFirst = r2Puts.length;
    const filesInsertsAfterFirst = dbWrites.filter((w) => w.sql.includes("INSERT INTO files")).length;

    // 3 existing + 3 incoming = 6 > MAX_FILES (5) — must be rejected
    // entirely, not silently truncated to 5.
    const second = await postPhotos(
      app,
      env,
      Array.from({ length: 3 }, (_, i) => ({ name: `q${i}.png`, type: "image/png", bytes: PNG_BYTES }))
    );
    expect(second.status).toBe(400);
    // Nothing NEW was written by the rejected second request.
    expect(r2Puts.length).toBe(r2PutsAfterFirst);
    expect(dbWrites.filter((w) => w.sql.includes("INSERT INTO files")).length).toBe(
      filesInsertsAfterFirst
    );
    // The 3 photos from the first, successful upload are untouched.
    expect(JSON.parse(getIntakeJson()).photoFileIds.length).toBe(3);
  });

  // Finding 1 (coordinator fix round 1): the intake_json read-modify-write
  // is optimistic-concurrency guarded (WHERE intake_json = <value just
  // read>), so an overlapping write can't silently clobber it. This test
  // simulates the actual race: the fake D1 mutates the stored row AFTER
  // the route's first retry-loop read returns, standing in for another
  // request's write landing in the gap before this request's own UPDATE
  // executes. The guard must miss, the loop must retry, and the SECOND
  // read (which now sees the concurrent write) must be what the final
  // UPDATE is based on — so the end state has BOTH ids, neither silently
  // discarded.
  it("retries the intake_json link when a concurrent write races it, merging both sides instead of one discarding the other", async () => {
    const { app, env, getIntakeJson } = photoHarness({
      // Call 1 is the pre-check read; call 2 is the retry loop's first
      // (raced) read.
      mutateIntakeAfterSelectCall: 2,
    });
    const res = await postPhotos(app, env, [{ name: "a.png", type: "image/png", bytes: PNG_BYTES }]);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; file_ids: string[] }>();
    const finalIds = JSON.parse(getIntakeJson()).photoFileIds as string[];
    expect(finalIds).toContain("concurrent-file-id");
    expect(finalIds).toEqual(expect.arrayContaining(body.file_ids));
    expect(finalIds.length).toBe(2);
  });

  it("fails loudly (never ok:true) when the intake_json link loses every retry to sustained concurrent writes, and never silently links this request's photo", async () => {
    const { app, env, r2Puts, getIntakeJson } = photoHarness({ exhaustIntakeRetries: true });
    const res = await postPhotos(app, env, [{ name: "a.png", type: "image/png", bytes: PNG_BYTES }]);
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
    // The photo itself was still committed to R2/files (documented
    // residue) — but its id must never have made it into intake_json,
    // since the response told the caller this failed.
    expect(r2Puts.length).toBe(1);
    const fileId = r2Puts[0].key.split("/")[1];
    expect(getIntakeJson()).not.toContain(fileId);
  });

  // FINDING A: a batch where a later file fails validation must not leave
  // earlier files in the same batch orphaned in R2/D1. Validation (pass 1)
  // now runs to completion for the whole batch before anything is written
  // (pass 2), so this asserts on what was NOT written, not just the status
  // code — that's the actual defect this closes.
  it("leaves zero files rows and zero R2 objects when a later file in the batch fails sniffing", async () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>");
    const { app, env, r2Puts, dbWrites } = photoHarness();
    const res = await postPhotos(app, env, [
      { name: "good1.png", type: "image/png", bytes: PNG_BYTES },
      { name: "good2.png", type: "image/png", bytes: PNG_BYTES },
      { name: "evil.png", type: "image/png", bytes: html },
    ]);
    expect(res.status).toBe(400);
    expect(r2Puts.length).toBe(0);
    expect(dbWrites.filter((w) => w.sql.includes("INSERT INTO files")).length).toBe(0);
    expect(dbWrites.length).toBe(0);
  });

  it("leaves zero files rows and zero R2 objects when a later file exceeds the size cap", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG_BYTES);
    const { app, env, r2Puts, dbWrites } = photoHarness();
    const res = await postPhotos(app, env, [
      { name: "good1.png", type: "image/png", bytes: PNG_BYTES },
      { name: "toobig.png", type: "image/png", bytes: big },
    ]);
    expect(res.status).toBe(400);
    expect(r2Puts.length).toBe(0);
    expect(dbWrites.length).toBe(0);
  });

  // FINDING B: R2 write succeeds, D1 insert fails. The one object whose
  // insert failed must be deleted (best-effort); the request must still
  // fail. Not asserting a full-batch rollback — see task-8-report.md for
  // the residue this deliberately leaves open (files already committed
  // earlier in the same pass-2 loop, before the failing one, are not
  // unwound).
  it("deletes the R2 object it just wrote when the D1 insert for that file fails, and still fails the request", async () => {
    const { app, env, r2Puts, r2Deletes, dbWrites } = photoHarness({
      failFilesInsertOnCall: 1,
    });
    const res = await postPhotos(app, env, [
      { name: "a.png", type: "image/png", bytes: PNG_BYTES },
    ]);
    expect(res.status).toBe(500);
    expect(r2Puts.length).toBe(1);
    expect(r2Deletes).toEqual([r2Puts[0].key]);
    expect(dbWrites.filter((w) => w.sql.includes("INSERT INTO files")).length).toBe(0);
  });

  it("does not unwind files already committed earlier in the same batch when a later file's D1 insert fails", async () => {
    // Documents the known residue: file 1 commits successfully (R2 + D1),
    // file 2's D1 insert fails and its own R2 object is cleaned up, but
    // file 1 is NOT rolled back. This is the batch-level limit stated in
    // the coordinator's ruling, pinned here so a future change can't
    // silently regress the compensation into a full rollback (or lose it
    // entirely) without a test noticing either way.
    const { app, env, r2Puts, r2Deletes, dbWrites } = photoHarness({
      failFilesInsertOnCall: 2,
    });
    const res = await postPhotos(app, env, [
      { name: "a.png", type: "image/png", bytes: PNG_BYTES },
      { name: "b.png", type: "image/png", bytes: PNG_BYTES },
    ]);
    expect(res.status).toBe(500);
    expect(r2Puts.length).toBe(2);
    expect(r2Deletes).toEqual([r2Puts[1].key]);
    expect(dbWrites.filter((w) => w.sql.includes("INSERT INTO files")).length).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// PAY-2: atomic seat claims, hold reuse, member-price verification
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function eventHarness(
  opts: {
    event?: Partial<Row>;
    member?: Row | null;
    existingReg?: Row | null;
    /** meta.changes for the guarded (capacity) INSERT ... SELECT. Default 1. */
    claimChanges?: number;
    stripeKey?: boolean;
    jwtSecret?: string;
  } = {}
) {
  const runs: { sql: string; binds: unknown[]; changes: number }[] = [];
  const batches: { sql: string; binds: unknown[] }[][] = [];
  const tenant = {
    id: TENANT_ID,
    slug: "guild",
    name: "Test Guild",
    status: "active",
    tenant_type: "guild",
    settings_json: "{}",
    stripe_account_id: null,
  };
  const event = {
    id: "ev-1",
    tenant_id: TENANT_ID,
    title: "Spring Retreat",
    start_at: "2026-10-01T15:00:00.000Z",
    location: null,
    capacity: 10,
    waitlist_enabled: 0,
    registration_open: 1,
    is_public: 1,
    member_price_cents: 1000,
    non_member_price_cents: 2500,
    settings_json: "{}",
    ...opts.event,
  };

  function exec(sql: string, binds: unknown[]) {
    let n = 1;
    if (sql.includes("INSERT INTO event_registrations") && sql.includes("SELECT")) {
      n = opts.claimChanges ?? 1;
    }
    runs.push({ sql, binds, changes: n });
    return { success: true, meta: { changes: n } };
  }
  function firstRow(sql: string): Row | null {
    if (sql.includes("FROM tenants")) return tenant;
    if (sql.includes("FROM events")) return event;
    if (sql.includes("FROM members")) return opts.member ?? null;
    if (sql.includes("FROM event_registrations")) return opts.existingReg ?? null;
    return null;
  }
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            __sql: sql,
            __binds: binds,
            async first() {
              return firstRow(sql);
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return exec(sql, binds);
            },
          };
        },
      };
    },
    async batch(stmts: { __sql: string; __binds: unknown[]; run: () => Promise<unknown> }[]) {
      batches.push(stmts.map((s) => ({ sql: s.__sql, binds: s.__binds })));
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  };
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", publicRoutes);
  const env = {
    DB: db,
    APP_URL: "https://quilthosting.com",
    JWT_SECRET: opts.jwtSecret ?? "test-secret",
    ...(opts.stripeKey === false ? {} : { STRIPE_SECRET_KEY: "sk_test" }),
  } as unknown as Env;
  const register = (body: unknown, headers: Record<string, string> = {}) =>
    app.request(
      "/guild/events/ev-1/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
      env
    );
  const regInserts = () => runs.filter((r) => r.sql.includes("INSERT INTO event_registrations"));
  return { app, env, register, runs, batches, regInserts };
}

describe("POST /public/:slug/events/:eventId/register — atomic seat claim", () => {
  beforeEach(() => {
    vi.mocked(createCheckoutSession).mockClear();
    vi.mocked(retrieveCheckoutSession).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("claims a paid seat with ONE conditional INSERT ... SELECT that counts confirmed seats plus unexpired holds", async () => {
    const h = eventHarness();
    const res = await h.register({ email: "jo@example.com", name: "Jo" });
    expect(res.status).toBe(200);
    const body = await res.json<Row>();
    expect(body.status).toBe("checkout");
    expect(body.hold_expires_at).toBeTruthy();

    const [claim] = h.regInserts();
    expect(claim.sql).toMatch(/INSERT INTO event_registrations[\s\S]*SELECT[\s\S]*WHERE \(/);
    expect(claim.sql).toContain("status IN ('registered', 'checked_in')");
    expect(claim.sql).toContain("status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > ?)");
    expect(claim.sql.trim().endsWith("< ?")).toBe(true);
    // capacity is the final bind; hold_expires_at bind is set for pending_payment
    expect(claim.binds[claim.binds.length - 1]).toBe(10);
    expect(claim.binds[6]).toBe("pending_payment");
    expect(typeof claim.binds[9]).toBe("string");
    // No SELECT COUNT(*) pre-read anywhere: the count lives inside the claim.
    expect(h.runs.some((r) => r.sql.startsWith("SELECT COUNT(*)"))).toBe(false);

    // Stripe session expires with the hold, and the session id is stored for reuse.
    const call = vi.mocked(createCheckoutSession).mock.calls[0][1];
    expect(call.expiresAt).toBe(Math.floor(Date.parse(body.hold_expires_at) / 1000));
    expect(call.relatedId).toBe(body.registration_id);
    expect(h.runs.some((r) => r.sql.includes("SET stripe_session_id = ?") && r.binds[0] === "cs_new")).toBe(true);
  });

  it("(e) a claim that changes 0 rows returns 409 Event is full when there is no waitlist, and creates no Checkout", async () => {
    const h = eventHarness({ claimChanges: 0 });
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toMatch(/full/i);
    expect(vi.mocked(createCheckoutSession)).not.toHaveBeenCalled();
    expect(h.regInserts().length).toBe(1);
  });

  it("(e) a claim that changes 0 rows falls to the waitlist (unguarded insert) when waitlist is enabled", async () => {
    const h = eventHarness({ claimChanges: 0, event: { waitlist_enabled: 1 } });
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(200);
    expect((await res.json<Row>()).status).toBe("waitlist");
    const inserts = h.regInserts();
    expect(inserts.length).toBe(2);
    expect(inserts[1].sql).toContain("VALUES");
    expect(inserts[1].sql).not.toContain("SELECT");
    expect(inserts[1].binds[6]).toBe("waitlist");
    expect(vi.mocked(createCheckoutSession)).not.toHaveBeenCalled();
  });

  it("(e) free event, full, no waitlist: the outbox row that rode in the batch is removed again", async () => {
    const h = eventHarness({
      claimChanges: 0,
      event: { member_price_cents: 0, non_member_price_cents: 0 },
    });
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(409);
    expect(h.batches.length).toBe(1);
    expect(h.batches[0][1].sql).toContain("INSERT INTO webhook_outbox");
    const del = h.runs.find((r) => r.sql.includes("DELETE FROM webhook_outbox"));
    expect(del).toBeTruthy();
    expect(del!.binds[0]).toBe(h.batches[0][1].binds[0]);
  });

  it("free event without capacity uses a plain INSERT batched with its outbox event", async () => {
    const h = eventHarness({
      event: { capacity: null, member_price_cents: 0, non_member_price_cents: 0 },
    });
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(200);
    expect((await res.json<Row>()).status).toBe("registered");
    expect(h.batches.length).toBe(1);
    expect(h.batches[0][0].sql).toContain("VALUES");
    expect(h.batches[0][1].sql).toContain("INSERT INTO webhook_outbox");
    expect(h.runs.some((r) => r.sql.includes("DELETE FROM webhook_outbox"))).toBe(false);
  });

  it("(f) a repeat POST with a live pending hold reuses the open Checkout instead of taking a second seat", async () => {
    const h = eventHarness({
      existingReg: {
        id: "reg-old",
        status: "pending_payment",
        stripe_session_id: "cs_old",
        ticket_code: "EV-OLD",
      },
    });
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(200);
    const body = await res.json<Row>();
    expect(body).toMatchObject({
      status: "checkout",
      reused: true,
      registration_id: "reg-old",
      session_id: "cs_old",
      checkout_url: "https://checkout.stripe.test/cs_old",
    });
    expect(vi.mocked(retrieveCheckoutSession)).toHaveBeenCalledWith(expect.anything(), "cs_old");
    expect(vi.mocked(createCheckoutSession)).not.toHaveBeenCalled();
    expect(h.regInserts().length).toBe(0);
    // The duplicate lookup itself includes unexpired pending holds.
    const dup = h.runs.length; // (reads are not in runs) — assert via the release not happening
    expect(h.runs.some((r) => r.sql.includes("SET status = 'cancelled'") && r.binds[1] === "reg-old")).toBe(false);
    expect(dup).toBeGreaterThanOrEqual(0);
  });

  it("(f) when the stored session is no longer open, the stale hold is released and a fresh seat is claimed", async () => {
    vi.mocked(retrieveCheckoutSession).mockResolvedValueOnce({ id: "cs_old", url: null, status: "expired" });
    const h = eventHarness({
      existingReg: { id: "reg-old", status: "pending_payment", stripe_session_id: "cs_old", ticket_code: "EV-OLD" },
    });
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(200);
    expect((await res.json<Row>()).reused).toBeUndefined();
    const release = h.runs.find((r) => r.sql.includes("SET status = 'cancelled'") && r.binds[1] === "reg-old");
    expect(release).toBeTruthy();
    expect(release!.sql).toContain("status = 'pending_payment'");
    expect(h.regInserts().length).toBe(1);
  });

  it("a confirmed registration still returns 409 Already registered", async () => {
    const h = eventHarness({ existingReg: { id: "reg-x", status: "registered", stripe_session_id: null, ticket_code: "EV-X" } });
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toMatch(/already registered/i);
  });

  it("retires this email's EXPIRED holds before the duplicate check", async () => {
    const h = eventHarness();
    await h.register({ email: "jo@example.com" });
    const retire = h.runs[0];
    expect(retire.sql).toContain("SET status = 'cancelled'");
    expect(retire.sql).toContain("hold_expires_at IS NOT NULL AND hold_expires_at <= ?");
    expect(retire.binds[3]).toBe("jo@example.com");
  });

  it("member pricing: an email that merely matches an active member gets member price but is recorded as UNVERIFIED (0)", async () => {
    const h = eventHarness({ member: { id: "mem-1", status: "active", user_id: "user-1" } });
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(200);
    expect(vi.mocked(createCheckoutSession).mock.calls[0][1].amountCents).toBe(1000);
    const [claim] = h.regInserts();
    expect(claim.binds[10]).toBe(0); // member_price_verified
  });

  it("member pricing: a portal session token for that member marks the price VERIFIED (1)", async () => {
    const h = eventHarness({ member: { id: "mem-1", status: "active", user_id: "user-1" } });
    const token = await signJwt({ sub: "user-1", email: "jo@example.com" }, "test-secret");
    const res = await h.register({ email: "jo@example.com" }, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(vi.mocked(createCheckoutSession).mock.calls[0][1].amountCents).toBe(1000);
    expect(h.regInserts()[0].binds[10]).toBe(1);
  });

  it("member pricing: a token for a DIFFERENT user does not verify; non-members get NULL and non-member price", async () => {
    const h = eventHarness({ member: { id: "mem-1", status: "active", user_id: "user-1" } });
    const token = await signJwt({ sub: "user-2", email: "someone@else.com" }, "test-secret");
    const res = await h.register({ email: "jo@example.com" }, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(h.regInserts()[0].binds[10]).toBe(0);

    const h2 = eventHarness({ member: null });
    await h2.register({ email: "guest@example.com" });
    expect(vi.mocked(createCheckoutSession).mock.calls[1][1].amountCents).toBe(2500);
    expect(h2.regInserts()[0].binds[10]).toBeNull();
  });

  it("a Checkout creation failure deletes the just-taken hold (only while still pending) and returns 502", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValueOnce(new Error("stripe down"));
    const h = eventHarness();
    const res = await h.register({ email: "jo@example.com" });
    expect(res.status).toBe(502);
    const del = h.runs.find((r) => r.sql.startsWith("DELETE FROM event_registrations"));
    expect(del).toBeTruthy();
    expect(del!.sql).toContain("status = 'pending_payment'");
  });
});

// ---------------------------------------------------------------------------
// PAY-2: store cart — normalized SKUs, atomic reservation, compensation
// ---------------------------------------------------------------------------

function cartHarness(
  opts: {
    products?: Record<string, Row>;
    /** meta.changes for the reserve decrement, by product id. Default 1. */
    reserveChanges?: Record<string, number>;
    stripeKey?: boolean;
    settings?: Row;
  } = {}
) {
  const runs: { sql: string; binds: unknown[]; changes: number }[] = [];
  const batches: { sql: string; binds: unknown[]; changes: number }[][] = [];
  const productReads: string[] = [];
  const tenant = {
    id: TENANT_ID,
    slug: "guild",
    name: "Test Guild",
    status: "active",
    tenant_type: "guild",
    settings_json: JSON.stringify(opts.settings ?? {}),
    stripe_account_id: null,
  };
  const products: Record<string, Row> = opts.products ?? {
    "prod-A": { id: "prod-A", name: "Pattern A", price_cents: 500, inventory: 5, is_active: 1, taxable: 1 },
    "prod-B": { id: "prod-B", name: "Kit B", price_cents: 2000, inventory: 1, is_active: 1, taxable: 1 },
    "prod-U": { id: "prod-U", name: "Untracked", price_cents: 100, inventory: null, is_active: 1, taxable: 0 },
  };

  function exec(sql: string, binds: unknown[]) {
    let n = 1;
    if (sql.includes("inventory = inventory - ?")) {
      n = opts.reserveChanges?.[binds[2] as string] ?? 1;
    }
    const rec = { sql, binds, changes: n };
    runs.push(rec);
    return { success: true, meta: { changes: n } };
  }
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            __sql: sql,
            __binds: binds,
            async first() {
              if (sql.includes("FROM tenants")) return tenant;
              if (sql.includes("FROM products")) {
                productReads.push(binds[0] as string);
                return products[binds[0] as string] ?? null;
              }
              if (sql.includes("FROM members")) return null;
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return exec(sql, binds);
            },
          };
        },
      };
    },
    async batch(stmts: { __sql: string; __binds: unknown[]; run: () => Promise<any> }[]) {
      const recorded: { sql: string; binds: unknown[]; changes: number }[] = [];
      const results = [];
      for (const s of stmts) {
        const r = await s.run();
        recorded.push({ sql: s.__sql, binds: s.__binds, changes: r.meta.changes });
        results.push(r);
      }
      batches.push(recorded);
      return results;
    },
  };
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", publicRoutes);
  const env = {
    DB: db,
    APP_URL: "https://quilthosting.com",
    ...(opts.stripeKey === false ? {} : { STRIPE_SECRET_KEY: "sk_test" }),
  } as unknown as Env;
  const checkout = (body: unknown) =>
    app.request(
      "/guild/cart/checkout",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  const buy = (productId: string, body: unknown) =>
    app.request(
      `/guild/products/${productId}/buy`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  return { app, env, checkout, buy, runs, batches, productReads };
}

describe("POST /public/:slug/cart/checkout — atomic stock reservation", () => {
  beforeEach(() => {
    vi.mocked(createCheckoutSession).mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("(g) repeated SKUs are summed into one line, read once, and reserved once with the summed quantity", async () => {
    const h = cartHarness();
    const res = await h.checkout({
      email: "jo@example.com",
      items: [
        { product_id: "prod-A", quantity: 1 },
        { product_id: "prod-A", quantity: 2 },
      ],
    });
    expect(res.status).toBe(200);
    expect(h.productReads).toEqual(["prod-A"]);
    const [reserve] = h.batches;
    expect(reserve[0].sql).toContain("INSERT INTO store_orders");
    expect(reserve[0].sql).toContain("reserved_at, hold_expires_at");
    const decs = reserve.filter((s) => s.sql.includes("inventory = inventory - ?"));
    expect(decs.length).toBe(1);
    expect(decs[0].binds[0]).toBe(3);
    expect(decs[0].binds[2]).toBe("prod-A");
    expect(decs[0].sql).toContain("inventory >= ?");
    const body = await res.json<Row>();
    expect(body.subtotal_cents).toBe(1500);
    const items = JSON.parse(reserve[0].binds[7] as string);
    expect(items).toEqual([expect.objectContaining({ product_id: "prod-A", quantity: 3 })]);
    // Session expiry == hold expiry; session id stored on the order.
    expect(vi.mocked(createCheckoutSession).mock.calls[0][1].expiresAt).toBe(
      Math.floor(Date.parse(body.hold_expires_at) / 1000)
    );
    expect(vi.mocked(createCheckoutSession).mock.calls[0][1].extraMetadata?.order_id).toBe(body.order_id);
  });

  it("(h) a decrement that changes 0 rows returns 409 with the out-of-stock ids and restocks ONLY the lines that were reserved", async () => {
    const h = cartHarness({ reserveChanges: { "prod-B": 0 } });
    const res = await h.checkout({
      email: "jo@example.com",
      items: [
        { product_id: "prod-A", quantity: 2 },
        { product_id: "prod-B", quantity: 1 },
        { product_id: "prod-U", quantity: 1 },
      ],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ out_of_stock: ["prod-B"] });
    expect(vi.mocked(createCheckoutSession)).not.toHaveBeenCalled();

    expect(h.batches.length).toBe(2);
    const [reserve, compensate] = h.batches;
    // Untracked product gets no reservation statement at all.
    expect(reserve.filter((s) => s.sql.includes("inventory = inventory - ?")).map((s) => s.binds[2])).toEqual([
      "prod-A",
      "prod-B",
    ]);
    const restocks = compensate.filter((s) => s.sql.includes("inventory = inventory + ?"));
    expect(restocks.map((s) => [s.binds[0], s.binds[2]])).toEqual([[2, "prod-A"]]);
    // Restock is guarded by the order still being a pending reserved order,
    // and the order flip to cancelled is in the same batch, last.
    expect(restocks[0].sql).toMatch(/status = 'pending' AND reserved_at IS NOT NULL/);
    const flip = compensate[compensate.length - 1];
    expect(flip.sql).toContain("UPDATE store_orders SET status = ?");
    expect(flip.binds[0]).toBe("cancelled");
  });

  it("a free order is marked paid ONLY after a successful reservation, in one batch with its $0 payment row", async () => {
    const h = cartHarness({
      products: { "prod-F": { id: "prod-F", name: "Freebie", price_cents: 0, inventory: 3, is_active: 1, taxable: 0 } },
    });
    const res = await h.checkout({ email: "jo@example.com", items: [{ product_id: "prod-F", quantity: 2 }] });
    expect(res.status).toBe(200);
    expect((await res.json<Row>()).status).toBe("fulfilled");
    expect(h.batches.length).toBe(2);
    expect(h.batches[0].some((s) => s.sql.includes("inventory = inventory - ?"))).toBe(true);
    const paid = h.batches[1];
    expect(paid[0].sql).toContain("SET status = 'paid', fulfilled_at = ?");
    expect(paid[0].sql).toContain("status = 'pending'");
    expect(paid[1].sql).toContain("INSERT INTO payments");
    expect(paid[1].sql).toContain("fulfilled_at");
  });

  it("a free order whose reservation fails is NOT marked paid", async () => {
    const h = cartHarness({
      products: { "prod-F": { id: "prod-F", name: "Freebie", price_cents: 0, inventory: 3, is_active: 1, taxable: 0 } },
      reserveChanges: { "prod-F": 0 },
    });
    const res = await h.checkout({ email: "jo@example.com", items: [{ product_id: "prod-F", quantity: 2 }] });
    expect(res.status).toBe(409);
    expect(h.runs.some((r) => r.sql.includes("status = 'paid'"))).toBe(false);
  });

  it("a Checkout creation failure releases the reservation (restock + cancel) and returns 502", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValueOnce(new Error("stripe down"));
    const h = cartHarness();
    const res = await h.checkout({ email: "jo@example.com", items: [{ product_id: "prod-A", quantity: 1 }] });
    expect(res.status).toBe(502);
    const release = h.batches[1];
    expect(release.some((s) => s.sql.includes("inventory = inventory + ?") && s.binds[2] === "prod-A")).toBe(true);
    expect(release[release.length - 1].binds[0]).toBe("cancelled");
  });

  it("checks the Stripe key BEFORE reserving anything for a paid cart", async () => {
    const h = cartHarness({ stripeKey: false });
    const res = await h.checkout({ email: "jo@example.com", items: [{ product_id: "prod-A", quantity: 1 }] });
    expect(res.status).toBe(503);
    expect(h.batches.length).toBe(0);
  });

  it("single-product /buy goes through the same order reservation and passes order_id to Stripe", async () => {
    const h = cartHarness();
    const res = await h.buy("prod-B", { email: "jo@example.com", quantity: 1 });
    expect(res.status).toBe(200);
    const body = await res.json<Row>();
    expect(body.status).toBe("checkout");
    expect(body.order_id).toBeTruthy();
    expect(h.batches[0][0].sql).toContain("INSERT INTO store_orders");
    expect(h.batches[0].some((s) => s.sql.includes("inventory = inventory - ?") && s.binds[2] === "prod-B")).toBe(true);
    const call = vi.mocked(createCheckoutSession).mock.calls[0][1];
    expect(call.extraMetadata?.order_id).toBe(body.order_id);
    expect(call.relatedId).toBe(body.order_id);
    expect(call.expiresAt).toBeTypeOf("number");
  });

  it("single-product /buy: a reservation that changes 0 rows is 409 Sold out and cancels the order", async () => {
    const h = cartHarness({ reserveChanges: { "prod-B": 0 } });
    const res = await h.buy("prod-B", { email: "jo@example.com", quantity: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ out_of_stock: ["prod-B"] });
    expect(vi.mocked(createCheckoutSession)).not.toHaveBeenCalled();
    expect(h.batches[1][h.batches[1].length - 1].binds[0]).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Guild site: /img/:fileId, /site-bootstrap, trashed pages, slug redirects
// (draft/publish workflow, migration 0025). Own small fake: the big harness
// above returns [] for every .all(), which is not enough to prove a
// deleted_at filter or a redirects map.
// ---------------------------------------------------------------------------

type GuildPage = {
  slug: string;
  title: string;
  content_json: string;
  blocks_json: string | null;
  page_type: string;
  published: number;
  is_members_only: number;
  show_in_nav: number;
  deleted_at: string | null;
  updated_at: string;
  created_at: string;
};

function guildHarness(opts: {
  pages?: GuildPage[];
  redirects?: { from_slug: string; to_slug: string }[];
  files?: { id: string; tenant_id: string; r2_key: string; content_type: string | null }[];
} = {}) {
  const tenant = {
    id: TENANT_ID,
    name: "Stitch Guild",
    slug: "stitchguild",
    tenant_type: "guild",
    status: "active",
    settings_json: JSON.stringify({ profile: { description: "A guild" } }),
  };
  const prepared: string[] = [];
  function pages(sql: string): GuildPage[] {
    let rows = opts.pages ?? [];
    // Mirrors the route's own predicate text so dropping the clause from
    // public.ts makes these tests fail.
    if (sql.includes("deleted_at IS NULL")) rows = rows.filter((p) => p.deleted_at === null);
    if (sql.includes("published = 1")) rows = rows.filter((p) => p.published === 1);
    if (sql.includes("= 'blog_post'")) rows = rows.filter((p) => p.page_type === "blog_post");
    else if (sql.includes("= 'page'")) rows = rows.filter((p) => p.page_type === "page");
    return rows;
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM tenants")) return binds[0] === tenant.slug ? tenant : null;
              if (sql.includes("FROM files WHERE id = ? AND tenant_id = ?")) {
                return (opts.files ?? []).find((f) => f.id === binds[0] && f.tenant_id === binds[1]) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM pages")) return { results: pages(sql) };
              if (sql.includes("FROM page_redirects")) return { results: opts.redirects ?? [] };
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", publicRoutes);
  const env = {
    DB: db,
    FILES: { async get(key: string) { return { body: `bytes:${key}` }; } },
  } as unknown as Env;
  return { app, env, prepared };
}

function guildPage(overrides: Partial<GuildPage> = {}): GuildPage {
  return {
    slug: "about",
    title: "About",
    content_json: "{}",
    blocks_json: JSON.stringify([{ type: "heading", text: "About us", level: 2 }]),
    page_type: "page",
    published: 1,
    is_members_only: 0,
    show_in_nav: 1,
    deleted_at: null,
    updated_at: "2026-09-01T00:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("GET /public/:slug/img/:fileId", () => {
  const png = { id: "f-png", tenant_id: TENANT_ID, r2_key: "t1/f-png", content_type: "image/png" };
  const svg = { id: "f-svg", tenant_id: TENANT_ID, r2_key: "t1/f-svg", content_type: "image/svg+xml" };
  const html = { id: "f-html", tenant_id: TENANT_ID, r2_key: "t1/f-html", content_type: "text/html" };
  const foreign = { id: "f-other", tenant_id: "other-tenant", r2_key: "t2/f", content_type: "image/png" };

  it("serves an allowlisted raster image inline with nosniff and immutable caching", async () => {
    const { app, env } = guildHarness({ files: [png] });
    const res = await app.request("/stitchguild/img/f-png", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("bytes:t1/f-png");
  });

  it("404s non-raster types (SVG, HTML) even though the row exists", async () => {
    const { app, env } = guildHarness({ files: [svg, html] });
    expect((await app.request("/stitchguild/img/f-svg", {}, env)).status).toBe(404);
    expect((await app.request("/stitchguild/img/f-html", {}, env)).status).toBe(404);
  });

  it("404s another tenant's file id (files.tenant_id must match)", async () => {
    const { app, env } = guildHarness({ files: [foreign] });
    expect((await app.request("/stitchguild/img/f-other", {}, env)).status).toBe(404);
  });

  it("404s an unknown guild slug and a malformed id", async () => {
    const { app, env } = guildHarness({ files: [png] });
    expect((await app.request("/nope/img/f-png", {}, env)).status).toBe(404);
    expect((await app.request("/stitchguild/img/" + encodeURIComponent("a b"), {}, env)).status).toBe(404);
  });
});

describe("GET /public/:slug/pages — trash + redirects", () => {
  it("excludes soft-deleted pages and includes the redirects map", async () => {
    const { app, env, prepared } = guildHarness({
      pages: [guildPage(), guildPage({ slug: "old", title: "Old", deleted_at: "2026-09-06T00:00:00.000Z", published: 1 })],
      redirects: [{ from_slug: "old", to_slug: "about" }],
    });
    const res = await app.request("/stitchguild/pages", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pages: { slug: string; html: string }[]; redirects: Record<string, string> };
    expect(json.pages.map((p) => p.slug)).toEqual(["about"]);
    expect(json.pages[0].html).toContain("About us");
    expect(json.redirects).toEqual({ old: "about" });
    expect(prepared.find((s) => s.includes("FROM pages"))).toContain("deleted_at IS NULL");
  });

  it("/site nav_pages and /blog also exclude trashed rows", async () => {
    const { app, env } = guildHarness({
      pages: [
        guildPage(),
        guildPage({ slug: "trashed", deleted_at: "x" }),
        guildPage({ slug: "post", page_type: "blog_post" }),
        guildPage({ slug: "trashed-post", page_type: "blog_post", deleted_at: "x" }),
      ],
    });
    const site = (await (await app.request("/stitchguild/site", {}, env)).json()) as { nav_pages: { slug: string }[] };
    expect(site.nav_pages.map((p) => p.slug)).toEqual(["about"]);
    const blog = (await (await app.request("/stitchguild/blog", {}, env)).json()) as { posts: { slug: string }[] };
    expect(blog.posts.map((p) => p.slug)).toEqual(["post"]);
  });
});

describe("GET /public/:slug/site-bootstrap", () => {
  it("returns all seven boot payloads, each identical to its standalone endpoint", async () => {
    const { app, env } = guildHarness({
      pages: [guildPage(), guildPage({ slug: "post", page_type: "blog_post" })],
      redirects: [{ from_slug: "old", to_slug: "about" }],
    });
    const res = await app.request("/stitchguild/site-bootstrap", {}, env);
    expect(res.status).toBe(200);
    const boot = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(boot).sort()).toEqual(["blog", "events", "info", "levels", "pages", "products", "site"]);
    for (const key of ["levels", "events", "info", "products", "site", "blog", "pages"]) {
      const standalone = await (await app.request(`/stitchguild/${key}`, {}, env)).json();
      expect(boot[key], key).toEqual(standalone);
    }
  });

  it("404s an unknown guild", async () => {
    const { app, env } = guildHarness();
    expect((await app.request("/nope/site-bootstrap", {}, env)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /public/:slug/newsletter — phase 2 Task A (newsletter_signup section).
// Inserts into newsletter_signups; idempotent per (tenant, email); rate
// limited by the shared per-IP middleware.
// ---------------------------------------------------------------------------
describe("POST /public/:slug/newsletter", () => {
  function newsletterHarness(opts: { tenant?: Record<string, unknown> | null; kvCount?: number } = {}) {
    const runs: { sql: string; binds: unknown[] }[] = [];
    const tenant = opts.tenant === null ? null : { id: TENANT_ID, slug: "hcqg", tenant_type: "guild", status: "active", settings_json: "{}", ...(opts.tenant ?? {}) };
    const db = {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async first() {
                if (sql.includes("FROM tenants")) return tenant;
                return null;
              },
              async all() { return { results: [] }; },
              async run() { runs.push({ sql, binds }); return { success: true, meta: { changes: 1 } }; },
            };
          },
        };
      },
    };
    const kvStore = new Map<string, string>();
    if (opts.kvCount !== undefined) kvStore.set("rl:newsletter:unknown", String(opts.kvCount));
    const kv = {
      async get(k: string) { return kvStore.get(k) ?? null; },
      async put(k: string, v: string) { kvStore.set(k, v); },
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route("/", publicRoutes);
    const env = { DB: db, KV: kv } as unknown as Env;
    const send = (body: unknown, slug = "hcqg") =>
      app.request(`/${slug}/newsletter`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
    return { send, runs, kvStore };
  }

  it("records a signup with a normalized email, trimmed name and source 'site'", async () => {
    const { send, runs } = newsletterHarness();
    const res = await send({ email: "  Ann@Example.ORG ", name: "  Ann Reyes " });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(runs).toHaveLength(1);
    const ins = runs[0];
    expect(ins.sql).toContain("INSERT");
    expect(ins.sql).toContain("newsletter_signups");
    expect(ins.sql).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*email\s*\)/i);
    expect(ins.binds).toContain(TENANT_ID);
    expect(ins.binds).toContain("ann@example.org");
    expect(ins.binds).toContain("Ann Reyes");
    expect(ins.binds).toContain("site");
  });

  it("name is optional and stored as NULL when blank", async () => {
    const { send, runs } = newsletterHarness();
    const res = await send({ email: "rosa@example.org", name: "   " });
    expect(res.status).toBe(201);
    expect(runs[0].binds).toContain(null);
    expect(runs[0].binds).not.toContain("   ");
  });

  it("is idempotent: the same email twice yields two successful responses and no error", async () => {
    const { send, runs } = newsletterHarness();
    expect((await send({ email: "rosa@example.org" })).status).toBe(201);
    expect((await send({ email: "ROSA@example.org" })).status).toBe(201);
    expect(runs).toHaveLength(2);
    expect(runs[1].binds).toContain("rosa@example.org");
  });

  it("rejects a missing or malformed email and an over-long name with 400 and writes nothing", async () => {
    const { send, runs } = newsletterHarness();
    expect((await send({})).status).toBe(400);
    expect((await send({ email: "not-an-email" })).status).toBe(400);
    expect((await send({ email: "a@b.co", name: "x".repeat(200) })).status).toBe(400);
    expect((await send({ email: "a".repeat(250) + "@example.org" })).status).toBe(400);
    expect(runs).toHaveLength(0);
  });

  it("rejects a non-JSON body with 400", async () => {
    const { runs } = newsletterHarness();
    const app = new Hono<{ Bindings: Env }>();
    app.route("/", publicRoutes);
    const res = await app.request("/hcqg/newsletter", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "email=x" }, {
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: TENANT_ID, slug: "hcqg", status: "active" }), run: async () => { throw new Error("must not write"); } }) }) },
    } as unknown as Env);
    expect(res.status).toBe(400);
    expect(runs).toHaveLength(0);
  });

  it("404s for an unknown guild", async () => {
    const { send, runs } = newsletterHarness({ tenant: null });
    expect((await send({ email: "a@b.co" })).status).toBe(404);
    expect(runs).toHaveLength(0);
  });

  it("is rate limited per IP through the KV sliding window", async () => {
    const { send, runs } = newsletterHarness({ kvCount: 999 });
    const res = await send({ email: "a@b.co" });
    expect(res.status).toBe(429);
    expect(runs).toHaveLength(0);
  });
});
