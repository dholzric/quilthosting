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
