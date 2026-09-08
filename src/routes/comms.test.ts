// src/routes/comms.test.ts
// POST /emails/blasts/:id/retry (re-queue failed recipients + work one
// chunk), the blasts list columns the admin Email page reads, and the
// opted_out count on GET /audience. blastSend is mocked: what matters here
// is that the route calls queueFailedRetry THEN processBlastChunk with the
// right id, scoped to the caller's tenant.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";

const blastSend = vi.hoisted(() => ({
  queueFailedRetry: vi.fn(async (_env: unknown, _id: string) => ({ queued: true })),
  processBlastChunk: vi.fn(async (_env: unknown, _id: string) => ({
    sent: 2,
    done: true,
    errors: 0,
    skipped: 0,
    claimed: true,
  })),
}));
vi.mock("../lib/blastSend", () => blastSend);

const audience = vi.hoisted(() => ({
  countAudience: vi.fn(async () => ({ count: 40, label: "Active members", opted_out: 3 })),
  fetchAudiencePage: vi.fn(async () => []),
}));
vi.mock("../lib/audience", () => audience);

const email = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_env: unknown, _params: unknown) => ({ id: "msg_1", success: true })),
}));
vi.mock("../lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/email")>()),
  sendEmail: email.sendEmail,
}));

import { commsRoutes } from "./comms";

const TENANT_ID = "tenant-1";

function fakeDb(blasts: { id: string; tenant_id: string }[]) {
  const prepared: string[] = [];
  const batches: { sql: string; binds: unknown[] }[][] = [];
  const db = {
    async batch(stmts: { __sql: string; __binds: unknown[] }[]) {
      batches.push(stmts.map((s) => ({ sql: s.__sql, binds: s.__binds })));
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind(...binds: unknown[]) {
          return {
            __sql: sql,
            __binds: binds,
            async first() {
              if (sql.includes("FROM blasts WHERE id = ? AND tenant_id = ?")) {
                return blasts.find((b) => b.id === binds[0] && b.tenant_id === binds[1]) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM blasts WHERE tenant_id = ?")) {
                return {
                  results: blasts
                    .filter((b) => b.tenant_id === binds[0])
                    .map((b) => ({ ...b, status: "partial", error_count: 2, skipped_count: 1, last_error: "boom" })),
                };
              }
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { db, prepared, batches };
}

function buildApp(blasts: { id: string; tenant_id: string }[]) {
  const { db, prepared, batches } = fakeDb(blasts);
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, name: "Guild", settings_json: "{}" } as Tenant);
    await next();
  });
  app.route("/", commsRoutes);
  const env = {
    DB: db,
    APP_URL: "https://quilthosting.com",
    JWT_SECRET: "test-secret",
  } as unknown as Env;
  return { app, env, prepared, batches };
}

beforeEach(() => {
  blastSend.queueFailedRetry.mockClear();
  blastSend.processBlastChunk.mockClear();
  blastSend.queueFailedRetry.mockImplementation(async () => ({ queued: true }));
  email.sendEmail.mockClear();
  audience.fetchAudiencePage.mockReset();
  audience.fetchAudiencePage.mockImplementation(async () => []);
});

describe("POST / — small (sync) blasts", () => {
  const members = [
    { id: "m1", email: "a@example.test", first_name: "Ann", last_name: null, level_name: null, end_date: null },
    { id: "m2", email: "b@example.test", first_name: "Bo", last_name: null, level_name: null, end_date: null },
  ];

  it("renders a per-recipient {{unsubscribe_url}}, passes it + emailLogId to sendEmail, and logs blast_id + delivery_status", async () => {
    audience.fetchAudiencePage.mockImplementationOnce(async () => members as never);
    const { app, env, batches } = buildApp([]);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Hi {{first_name}}",
          body_html: "<p>News.</p><p><a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>",
          body_text: "News. Unsubscribe: {{unsubscribe_url}}",
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, sent: 2, failed: 0 });
    const blastId = json.blast_id as string;

    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    const urls = new Set<string>();
    for (const call of email.sendEmail.mock.calls) {
      const p = call[1] as Record<string, unknown>;
      const unsub = p.unsubscribeUrl as string;
      expect(unsub).toMatch(/^https:\/\/quilthosting\.com\/u\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      urls.add(unsub);
      // The merge field became the real link (not empty, not a tracked redirect).
      expect(p.html).toContain(`href="${unsub}"`);
      expect(p.html).not.toContain("QH_UNSUBSCRIBE_URL_SENTINEL");
      expect(p.text).toContain(`Unsubscribe: ${unsub}`);
      expect(p.kind).toBe("marketing");
      expect(p.tenantId).toBe(TENANT_ID);
      expect(typeof p.emailLogId).toBe("string");
      expect(p.tags).toEqual([
        { name: "template", value: "blast" },
        { name: "blast", value: blastId.slice(0, 32) },
      ]);
    }
    expect(urls.size).toBe(2); // per recipient, not shared

    const logBatch = batches.find((b) => b[0]?.sql.includes("INSERT INTO email_logs"))!;
    expect(logBatch.length).toBe(2);
    for (const [i, stmt] of logBatch.entries()) {
      expect(stmt.sql).toContain("blast_id, delivery_status");
      // (id, tenant, member, email, resend_id, status, created_at, blast_id, delivery_status, provider_message_id, delivery_error)
      expect(stmt.binds[0]).toBe((email.sendEmail.mock.calls[i][1] as Record<string, unknown>).emailLogId);
      expect(stmt.binds[5]).toBe("sent");
      expect(stmt.binds[7]).toBe(blastId);
      expect(stmt.binds[8]).toBe("accepted");
      expect(stmt.binds[9]).toBe("msg_1");
      expect(stmt.binds[10]).toBeNull();
    }
  });

  it("records failed and suppressed recipients with delivery_status failed/skipped", async () => {
    audience.fetchAudiencePage.mockImplementationOnce(async () => members as never);
    email.sendEmail
      .mockImplementationOnce(async () => ({ id: "", success: false, error: "boom", retryable: false }) as never)
      .mockImplementationOnce(async () => ({ id: "", success: false, suppressed: true, reason: "unsubscribe" }) as never);
    const { app, env, batches } = buildApp([]);
    const res = await app.request(
      "/",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "s", body_text: "t" }) },
      env
    );
    expect(await res.json()).toMatchObject({ sent: 0, skipped: 1, failed: 1, errors: ["a@example.test: boom"] });
    const logBatch = batches.find((b) => b[0]?.sql.includes("INSERT INTO email_logs"))!;
    expect(logBatch.map((s) => [s.binds[5], s.binds[8], s.binds[10]])).toEqual([
      ["failed", "failed", "boom"],
      ["skipped", "skipped", "unsubscribe"],
    ]);
  });
});

describe("POST /blasts/:id/retry", () => {
  it("calls queueFailedRetry then processBlastChunk for the tenant's blast and returns the chunk result", async () => {
    const { app, env } = buildApp([{ id: "blast-1", tenant_id: TENANT_ID }]);
    const res = await app.request("/blasts/blast-1/retry", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: true, sent: 2, done: true, errors: 0, skipped: 0, claimed: true });
    expect(blastSend.queueFailedRetry).toHaveBeenCalledTimes(1);
    expect(blastSend.queueFailedRetry.mock.calls[0][1]).toBe("blast-1");
    expect(blastSend.processBlastChunk).toHaveBeenCalledTimes(1);
    expect(blastSend.processBlastChunk.mock.calls[0][1]).toBe("blast-1");
    // Order: queue first, then process.
    expect(blastSend.queueFailedRetry.mock.invocationCallOrder[0]).toBeLessThan(
      blastSend.processBlastChunk.mock.invocationCallOrder[0]
    );
  });

  it("404s (and never touches blastSend) for a blast that belongs to another tenant", async () => {
    const { app, env } = buildApp([{ id: "blast-1", tenant_id: "other-tenant" }]);
    const res = await app.request("/blasts/blast-1/retry", { method: "POST" }, env);
    expect(res.status).toBe(404);
    expect(blastSend.queueFailedRetry).not.toHaveBeenCalled();
    expect(blastSend.processBlastChunk).not.toHaveBeenCalled();
  });

  it("409s when there is nothing to retry, without processing", async () => {
    blastSend.queueFailedRetry.mockImplementation(async () => ({ queued: false }));
    const { app, env } = buildApp([{ id: "blast-1", tenant_id: TENANT_ID }]);
    const res = await app.request("/blasts/blast-1/retry", { method: "POST" }, env);
    expect(res.status).toBe(409);
    expect(blastSend.processBlastChunk).not.toHaveBeenCalled();
  });
});

describe("GET /blasts", () => {
  it("selects error_count, skipped_count, last_error and status", async () => {
    const { app, env, prepared } = buildApp([{ id: "blast-1", tenant_id: TENANT_ID }]);
    const res = await app.request("/blasts", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const sql = prepared.find((s) => s.includes("FROM blasts WHERE tenant_id = ?"))!;
    for (const col of ["status", "error_count", "skipped_count", "last_error"]) {
      expect(sql, col).toContain(col);
    }
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ id: "blast-1", status: "partial", error_count: 2, skipped_count: 1, last_error: "boom" });
  });
});

describe("GET /audience", () => {
  it("exposes opted_out alongside count", async () => {
    const { app, env } = buildApp([]);
    const res = await app.request("/audience?segment=active", { method: "GET" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ segment: "Active members", count: 40, opted_out: 3 });
  });
});
