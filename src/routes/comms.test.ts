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

import { commsRoutes } from "./comms";

const TENANT_ID = "tenant-1";

function fakeDb(blasts: { id: string; tenant_id: string }[]) {
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind(...binds: unknown[]) {
          return {
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
  return { db, prepared };
}

function buildApp(blasts: { id: string; tenant_id: string }[]) {
  const { db, prepared } = fakeDb(blasts);
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, name: "Guild", settings_json: "{}" } as Tenant);
    await next();
  });
  app.route("/", commsRoutes);
  const env = { DB: db } as unknown as Env;
  return { app, env, prepared };
}

beforeEach(() => {
  blastSend.queueFailedRetry.mockClear();
  blastSend.processBlastChunk.mockClear();
  blastSend.queueFailedRetry.mockImplementation(async () => ({ queued: true }));
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
