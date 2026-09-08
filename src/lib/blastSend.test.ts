// src/lib/blastSend.test.ts
// Lease contention, held cursor on a whole-page provider failure, per-recipient
// failure rows + 'partial' status, retry-failed re-run, suppressed = skipped,
// and per-recipient unsubscribe links. The audience query is mocked; the
// blasts/email_logs tables are an in-memory D1 stand-in keyed on SQL shape.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../types";
import type { SendEmailParams, SendEmailResult } from "./email";

const audience = vi.hoisted(() => ({
  members: [] as { id: string; email: string; first_name: string | null; last_name: string | null; level_name: null; end_date: null }[],
}));

vi.mock("./audience", () => ({
  fetchAudiencePage: vi.fn(async (_db: unknown, _t: string, _s: string, opts: { limit: number; afterEmail?: string | null }) => {
    const after = opts.afterEmail || "";
    return audience.members.filter((m) => m.email > after).sort((a, b) => (a.email < b.email ? -1 : 1)).slice(0, opts.limit);
  }),
}));

import { processBlastChunk, queueFailedRetry, acquireBlastLease } from "./blastSend";

type Blast = {
  id: string; tenant_id: string; subject: string; body_html: string; body_text: string | null;
  segment: string; layout: string; recipients: number; sent_count: number; error_count: number;
  skipped_count: number; retry_failed: number; cursor_email: string | null; status: string;
  lease_until: string | null; lease_owner: string | null; last_error: string | null; created_at: string;
};
type Log = {
  id: string; tenant_id: string; member_id: string; to_email: string; template: string; resend_id: string | null;
  status: string; created_at: string; blast_id: string; delivery_status: string; provider_message_id: string | null;
  delivery_error: string | null;
};

function fakeDb(blast: Blast) {
  const state = { blast, logs: [] as Log[], sql: [] as string[] };
  const stmt = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    async run() {
      state.sql.push(sql);
      const b = state.blast;
      if (sql.includes("SET lease_until = ?, lease_owner = ?")) {
        const [until, owner, id, now] = binds as string[];
        if (id === b.id && ["queued", "sending"].includes(b.status) && (!b.lease_until || b.lease_until < now)) {
          b.lease_until = until; b.lease_owner = owner;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      if (sql.includes("SET lease_until = ? WHERE id = ? AND lease_owner = ?")) {
        if (binds[2] === b.lease_owner) b.lease_until = binds[0] as string;
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("SET lease_until = NULL, lease_owner = NULL")) {
        if (binds[1] === b.lease_owner) { b.lease_until = null; b.lease_owner = null; }
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("SET status = 'sending' WHERE id = ? AND status = 'queued'")) {
        if (b.status === "queued") b.status = "sending";
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("SET cursor_email = ?, sent_count = sent_count + ?")) {
        const [cursor, sent, err, skipped, lastError] = binds as [string, number, number, number, string | null];
        b.cursor_email = cursor; b.sent_count += sent; b.error_count += err; b.skipped_count += skipped; b.last_error = lastError;
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("SET status = 'sending', last_error = ?")) {
        b.status = "sending"; b.last_error = binds[0] as string | null;
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("SET status = ?, error_count = ?, cursor_email = NULL, retry_failed = 0")) {
        b.status = binds[0] as string; b.error_count = binds[1] as number; b.cursor_email = null; b.retry_failed = 0;
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("SET status = 'queued', retry_failed = 1")) {
        if (["partial", "sent", "failed"].includes(b.status) && b.error_count > 0) {
          b.status = "queued"; b.retry_failed = 1; b.cursor_email = null; b.lease_until = null; b.lease_owner = null;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      if (sql.includes("INSERT INTO email_logs")) {
        const [id, tenant_id, member_id, to_email, resend_id, status, created_at, blast_id, delivery_status, provider_message_id, delivery_error] = binds as any[];
        state.logs.push({ id, tenant_id, member_id, to_email, template: "blast", resend_id, status, created_at, blast_id, delivery_status, provider_message_id, delivery_error });
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("UPDATE email_logs SET status = ?, delivery_status = ?")) {
        const [status, delivery_status, delivery_error, resend_id, pid, id] = binds as any[];
        const row = state.logs.find((l) => l.id === id)!;
        Object.assign(row, { status, delivery_status, delivery_error, resend_id: resend_id ?? row.resend_id, provider_message_id: pid ?? row.provider_message_id });
        return { success: true, meta: { changes: 1 } };
      }
      throw new Error(`unexpected run: ${sql}`);
    },
    async first() {
      state.sql.push(sql);
      const b = state.blast;
      if (sql.includes("SELECT * FROM blasts")) return binds[0] === b.id ? { ...b } : null;
      if (sql.includes("FROM tenants")) return { id: b.tenant_id, name: "Test Guild" };
      if (sql.includes("SELECT sent_count, error_count, skipped_count")) return { sent_count: b.sent_count, error_count: b.error_count, skipped_count: b.skipped_count };
      if (sql.includes("COUNT(*) as cnt FROM email_logs")) return { cnt: state.logs.filter((l) => l.blast_id === b.id && l.delivery_status === "failed").length };
      throw new Error(`unexpected first: ${sql}`);
    },
    async all() {
      state.sql.push(sql);
      if (sql.includes("FROM email_logs l")) {
        const [blastId, after] = binds as [string, string];
        const rows = state.logs
          .filter((l) => l.blast_id === blastId && l.delivery_status === "failed" && l.to_email > after)
          .sort((a, b) => (a.to_email < b.to_email ? -1 : 1))
          .map((l) => {
            const m = audience.members.find((x) => x.id === l.member_id)!;
            return { log_id: l.id, id: m.id, email: m.email, first_name: m.first_name, last_name: m.last_name, level_name: null, end_date: null };
          });
        return { results: rows };
      }
      throw new Error(`unexpected all: ${sql}`);
    },
  });
  return {
    state,
    prepare: (sql: string) => stmt(sql, []),
    async batch(stmts: { run: () => Promise<unknown> }[]) { return Promise.all(stmts.map((s) => s.run())); },
  };
}

function blastRow(over: Partial<Blast> = {}): Blast {
  return {
    id: "b1", tenant_id: "t1", subject: "Hello {{first_name}}", body_html: "<p>News</p>", body_text: null,
    segment: "active", layout: "plain", recipients: 3, sent_count: 0, error_count: 0, skipped_count: 0, retry_failed: 0,
    cursor_email: null, status: "queued", lease_until: null, lease_owner: null, last_error: null, created_at: "2026-09-08T00:00:00Z",
    ...over,
  };
}

function envFor(db: ReturnType<typeof fakeDb>): Env {
  return { DB: db, APP_URL: "https://quilthosting.com", JWT_SECRET: "jwt-secret", RESEND_API_KEY: "re_x" } as unknown as Env;
}

const ok = (id: string): SendEmailResult => ({ id, success: true, status: 200 });
const retryable: SendEmailResult = { id: "", success: false, error: "HTTP 503", status: 503, retryable: true };
const permanent: SendEmailResult = { id: "", success: false, error: "invalid recipient", status: 422, retryable: false };
const suppressed: SendEmailResult = { id: "", success: false, suppressed: true, reason: "opt_out", error: "Recipient suppressed" };

beforeEach(() => {
  audience.members = [
    { id: "m1", email: "a@example.test", first_name: "Ann", last_name: null, level_name: null, end_date: null },
    { id: "m2", email: "b@example.test", first_name: "Bo", last_name: null, level_name: null, end_date: null },
    { id: "m3", email: "c@example.test", first_name: "Cy", last_name: null, level_name: null, end_date: null },
  ];
});

describe("acquireBlastLease", () => {
  it("second caller gets 0 changes while the lease is live, and wins after expiry", async () => {
    const db = fakeDb(blastRow());
    const t0 = Date.parse("2026-09-08T10:00:00Z");
    expect(await acquireBlastLease(db as any, "b1", "w1", t0)).toBe(true);
    expect(await acquireBlastLease(db as any, "b1", "w2", t0 + 1000)).toBe(false);
    expect(db.state.blast.lease_owner).toBe("w1");
    expect(await acquireBlastLease(db as any, "b1", "w2", t0 + 4 * 60 * 1000)).toBe(true);
    expect(db.state.blast.lease_owner).toBe("w2");
  });
});

describe("processBlastChunk", () => {
  it("exits without sending when another processor holds the lease", async () => {
    const db = fakeDb(blastRow({ status: "sending", lease_until: new Date(Date.now() + 60_000).toISOString(), lease_owner: "other" }));
    const send = vi.fn(async () => ok("x"));
    const r = await processBlastChunk(envFor(db), "b1", { send, owner: "me" });
    expect(r).toMatchObject({ claimed: false, sent: 0, done: false });
    expect(send).not.toHaveBeenCalled();
    expect(db.state.blast.lease_owner).toBe("other");
    expect(db.state.logs).toHaveLength(0);
  });

  it("sends to everyone with per-recipient unsubscribe links, logs accepted rows, finishes 'sent', releases the lease", async () => {
    const db = fakeDb(blastRow({ body_html: '<p>News</p><a href="https://example.test/x">x</a> <a href="{{unsubscribe_url}}">stop</a>' }));
    const sent: SendEmailParams[] = [];
    const send = vi.fn(async (_e: Env, p: SendEmailParams) => { sent.push(p); return ok(`re_${p.to}`); });
    const r = await processBlastChunk(envFor(db), "b1", { send, owner: "me", sleep: async () => {} });
    expect(r).toMatchObject({ claimed: true, done: true, sent: 3, errors: 0, skipped: 0 });
    expect(db.state.blast).toMatchObject({ status: "sent", sent_count: 3, error_count: 0, cursor_email: null, lease_until: null, lease_owner: null });
    expect(db.state.logs.map((l) => [l.to_email, l.delivery_status, l.provider_message_id, l.blast_id])).toEqual([
      ["a@example.test", "accepted", "re_a@example.test", "b1"],
      ["b@example.test", "accepted", "re_b@example.test", "b1"],
      ["c@example.test", "accepted", "re_c@example.test", "b1"],
    ]);
    for (const p of sent) {
      expect(p.kind).toBe("marketing");
      expect(p.tenantId).toBe("t1");
      expect(p.unsubscribeUrl).toMatch(/^https:\/\/quilthosting\.com\/u\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      // template placed {{unsubscribe_url}}: the real link is present, untracked, no sentinel left
      expect(p.html).toContain(`href="${p.unsubscribeUrl}"`);
      expect(p.html).not.toContain("SENTINEL");
      // other links are click-tracked
      expect(p.html).toContain("/t/c/");
    }
    expect(new Set(sent.map((p) => p.unsubscribeUrl)).size).toBe(3);
    expect(sent[0].subject).toBe("Hello Ann");
  });

  it("holds the cursor and records nothing when the whole page fails with retryable errors", async () => {
    const db = fakeDb(blastRow());
    const send = vi.fn(async () => retryable);
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await processBlastChunk(envFor(db), "b1", { send, owner: "me", sleep });
    expect(r).toMatchObject({ claimed: true, done: false, stalled: true, sent: 0 });
    expect(send).toHaveBeenCalledTimes(9); // 3 recipients x 3 attempts
    expect(sleep).toHaveBeenCalledTimes(6); // backoff between attempts
    expect(db.state.logs).toHaveLength(0);
    expect(db.state.blast).toMatchObject({ status: "sending", cursor_email: null, sent_count: 0, error_count: 0, last_error: "HTTP 503", lease_until: null });
  });

  it("honours Retry-After on 429", async () => {
    const db = fakeDb(blastRow());
    audience.members = audience.members.slice(0, 1);
    let n = 0;
    const send = vi.fn(async () => (n++ === 0 ? { ...retryable, status: 429, retryAfterMs: 1500 } : ok("re_1")));
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await processBlastChunk(envFor(db), "b1", { send, owner: "me", sleep });
    expect(r).toMatchObject({ sent: 1, done: true });
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(1500);
    expect(sleep.mock.calls[0][0]).toBeLessThan(1600);
  });

  it("records a failed row for a permanently failing recipient, finishes 'partial', and retry-failed re-sends only that one", async () => {
    const db = fakeDb(blastRow());
    const send = vi.fn(async (_e: Env, p: SendEmailParams) => (p.to === "b@example.test" ? permanent : ok(`re_${p.to}`)));
    const r = await processBlastChunk(envFor(db), "b1", { send, owner: "me", sleep: async () => {} });
    expect(r).toMatchObject({ done: true, sent: 2, errors: 1 });
    expect(send).toHaveBeenCalledTimes(3); // non-retryable: no retries
    expect(db.state.blast).toMatchObject({ status: "partial", sent_count: 2, error_count: 1, cursor_email: null });
    const failed = db.state.logs.find((l) => l.to_email === "b@example.test")!;
    expect(failed).toMatchObject({ status: "failed", delivery_status: "failed", delivery_error: "invalid recipient", provider_message_id: null });

    // Admin retries: only the failed recipient is attempted; the row is updated in place.
    expect(await queueFailedRetry(envFor(db), "b1")).toEqual({ queued: true });
    expect(db.state.blast).toMatchObject({ status: "queued", retry_failed: 1 });
    const send2 = vi.fn(async (_e: Env, p: SendEmailParams) => ok(`re2_${p.to}`));
    const r2 = await processBlastChunk(envFor(db), "b1", { send: send2, owner: "me2", sleep: async () => {} });
    expect(send2).toHaveBeenCalledTimes(1);
    expect(send2.mock.calls[0][1].to).toBe("b@example.test");
    expect(r2).toMatchObject({ done: true, sent: 1, errors: 0 });
    expect(db.state.logs).toHaveLength(3);
    expect(db.state.logs.find((l) => l.to_email === "b@example.test")).toMatchObject({
      status: "sent", delivery_status: "accepted", delivery_error: null, provider_message_id: "re2_b@example.test",
    });
    expect(db.state.blast).toMatchObject({ status: "sent", sent_count: 3, error_count: 0, retry_failed: 0 });
    expect(await queueFailedRetry(envFor(db), "b1")).toEqual({ queued: false });
  });

  it("counts suppressed recipients as skipped and still finishes 'sent'", async () => {
    const db = fakeDb(blastRow());
    const send = vi.fn(async (_e: Env, p: SendEmailParams) => (p.to === "c@example.test" ? suppressed : ok(`re_${p.to}`)));
    const r = await processBlastChunk(envFor(db), "b1", { send, owner: "me", sleep: async () => {} });
    expect(r).toMatchObject({ done: true, sent: 2, errors: 0, skipped: 1 });
    expect(db.state.blast).toMatchObject({ status: "sent", sent_count: 2, error_count: 0, skipped_count: 1 });
    expect(db.state.logs.find((l) => l.to_email === "c@example.test")).toMatchObject({ delivery_status: "skipped", delivery_error: "Recipient suppressed" });
  });

  it("does nothing for a blast that is not queued/sending", async () => {
    const db = fakeDb(blastRow({ status: "sent" }));
    const send = vi.fn(async () => ok("x"));
    const r = await processBlastChunk(envFor(db), "b1", { send });
    expect(r).toMatchObject({ claimed: true, done: true, sent: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
