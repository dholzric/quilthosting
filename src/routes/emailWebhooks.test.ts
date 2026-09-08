// src/routes/emailWebhooks.test.ts
// Svix signature verification (valid / invalid / stale), idempotent event
// ingestion, and the bounce/complaint -> suppression + email_logs effects.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { emailWebhookRoutes, svixSign, verifySvix } from "./emailWebhooks";
import type { Env } from "../types";

// 32 zero-ish bytes, base64 — test-only signing key.
const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(3)).toString("base64");

type LogRow = {
  id: string;
  tenant_id: string;
  to_email: string;
  provider_message_id: string | null;
  resend_id: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
};

function fakeDb(logs: LogRow[]) {
  const state = {
    logs,
    events: new Set<string>(),
    supp: [] as { tenant_id: string | null; email: string; scope: string; reason: string; source: string | null }[],
    optOuts: [] as { tenantId: string; email: string }[],
  };
  const stmt = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    async run() {
      if (sql.includes("INSERT OR IGNORE INTO email_events")) {
        const id = binds[0] as string;
        if (state.events.has(id)) return { success: true, meta: { changes: 0 } };
        state.events.add(id);
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("INSERT OR IGNORE INTO email_suppressions")) {
        const [, tenant_id, email, reason, scope, source] = binds as [string, string | null, string, string, string, string | null];
        if (state.supp.some((r) => r.tenant_id === tenant_id && r.email === email && r.scope === scope)) {
          return { success: true, meta: { changes: 0 } };
        }
        state.supp.push({ tenant_id, email, reason, scope, source });
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("UPDATE members SET email_opt_out_at")) {
        state.optOuts.push({ tenantId: binds[2] as string, email: binds[3] as string });
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("UPDATE email_logs") && sql.includes("delivery_status = ?")) {
        const [status, error, providerId, id, rank] = binds as [string, string | null, string | null, string, number];
        const row = state.logs.find((l) => l.id === id);
        const rankOf: Record<string, number> = { accepted: 0, delayed: 1, delivered: 2, failed: 3, bounced: 4, complained: 5 };
        if (row && (row.delivery_status == null || (rankOf[row.delivery_status] ?? -1) <= rank)) {
          row.delivery_status = status;
          row.delivery_error = error ?? row.delivery_error;
          row.provider_message_id = row.provider_message_id ?? providerId;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      if (sql.includes("UPDATE email_logs SET open_count") || sql.includes("UPDATE email_logs SET click_count")) {
        return { success: true, meta: { changes: 1 } };
      }
      throw new Error(`unexpected run: ${sql}`);
    },
    async first() {
      if (sql.includes("FROM email_logs")) {
        const pid = binds[0] as string;
        return state.logs.find((l) => l.provider_message_id === pid || l.resend_id === pid) ?? null;
      }
      return null;
    },
    async all() {
      return { results: [] };
    },
  });
  return {
    state,
    prepare: (sql: string) => stmt(sql, []),
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
}

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/api/webhooks", emailWebhookRoutes);
  return a;
}

async function signedPost(
  env: Env,
  payload: unknown,
  opts: { id?: string; timestamp?: string; signature?: string; secret?: string } = {}
) {
  const body = JSON.stringify(payload);
  const id = opts.id || "msg_evt_1";
  const timestamp = opts.timestamp || String(Math.floor(Date.now() / 1000));
  const sig = opts.signature ?? `v1,${await svixSign(opts.secret || SECRET, id, timestamp, body)}`;
  return app().request(
    "/api/webhooks/resend",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": sig,
      },
      body,
    },
    env
  );
}

function baseLogs(): LogRow[] {
  return [
    { id: "log-1", tenant_id: "t1", to_email: "m@example.test", provider_message_id: "re_1", resend_id: "re_1", delivery_status: "accepted", delivery_error: null },
    { id: "log-2", tenant_id: "t1", to_email: "legacy@example.test", provider_message_id: null, resend_id: "re_legacy", delivery_status: null, delivery_error: null },
  ];
}

function event(type: string, emailId: string, to: string, extra: Record<string, unknown> = {}) {
  return { type, created_at: new Date().toISOString(), data: { email_id: emailId, to: [to], subject: "x", ...extra } };
}

describe("verifySvix", () => {
  it("accepts a valid signature among several, rejects mismatch and stale timestamps", async () => {
    const body = '{"a":1}';
    const ts = "1700000000";
    const good = await svixSign(SECRET, "id1", ts, body);
    const now = 1700000000 + 60;
    expect(await verifySvix(SECRET, { id: "id1", timestamp: ts, signature: `v1,bogus= v1,${good}` }, body, now)).toEqual({ ok: true });
    expect((await verifySvix(SECRET, { id: "id1", timestamp: ts, signature: `v1,${good}` }, body + " ", now)).ok).toBe(false);
    expect((await verifySvix(SECRET, { id: "id2", timestamp: ts, signature: `v1,${good}` }, body, now)).ok).toBe(false);
    expect((await verifySvix(SECRET, { id: "id1", timestamp: ts, signature: `v1,${good}` }, body, now + 6 * 60)).ok).toBe(false);
    expect((await verifySvix(SECRET, { id: "id1", timestamp: ts, signature: `v0,${good}` }, body, now)).ok).toBe(false);
    expect((await verifySvix(SECRET, { id: undefined, timestamp: ts, signature: `v1,${good}` }, body, now)).ok).toBe(false);
  });
});

describe("POST /api/webhooks/resend", () => {
  it("returns 503 and processes nothing when the secret is unset", async () => {
    const db = fakeDb(baseLogs());
    const env = { DB: db } as unknown as Env;
    const res = await signedPost(env, event("email.delivered", "re_1", "m@example.test"));
    expect(res.status).toBe(503);
    expect(db.state.events.size).toBe(0);
  });

  it("rejects an invalid signature and a stale timestamp with 400", async () => {
    const db = fakeDb(baseLogs());
    const env = { DB: db, RESEND_WEBHOOK_SECRET: SECRET } as unknown as Env;
    const bad = await signedPost(env, event("email.delivered", "re_1", "m@example.test"), { signature: "v1,AAAA" });
    expect(bad.status).toBe(400);
    const wrongSecret = await signedPost(env, event("email.delivered", "re_1", "m@example.test"), {
      secret: "whsec_" + Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
    });
    expect(wrongSecret.status).toBe(400);
    const stale = await signedPost(env, event("email.delivered", "re_1", "m@example.test"), {
      timestamp: String(Math.floor(Date.now() / 1000) - 10 * 60),
    });
    expect(stale.status).toBe(400);
    expect(db.state.events.size).toBe(0);
    expect(db.state.logs[0].delivery_status).toBe("accepted");
  });

  it("applies email.delivered once; the redelivered event is a no-op", async () => {
    const db = fakeDb(baseLogs());
    const env = { DB: db, RESEND_WEBHOOK_SECRET: SECRET } as unknown as Env;
    const first = await signedPost(env, event("email.delivered", "re_1", "m@example.test"), { id: "evt_a" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, matched: true });
    expect(db.state.logs[0].delivery_status).toBe("delivered");

    // Simulate a bounce landing later, then the *same* delivered event redelivered:
    db.state.logs[0].delivery_status = "bounced";
    const dup = await signedPost(env, event("email.delivered", "re_1", "m@example.test"), { id: "evt_a" });
    expect(await dup.json()).toMatchObject({ ok: true, duplicate: true });
    expect(db.state.logs[0].delivery_status).toBe("bounced");
  });

  it("matches legacy rows by resend_id and never downgrades a bounce to delivered", async () => {
    const db = fakeDb(baseLogs());
    const env = { DB: db, RESEND_WEBHOOK_SECRET: SECRET } as unknown as Env;
    await signedPost(env, event("email.bounced", "re_legacy", "legacy@example.test", { bounce: { type: "Permanent", subType: "General", message: "no such user" } }), { id: "evt_b1" });
    expect(db.state.logs[1].delivery_status).toBe("bounced");
    expect(db.state.logs[1].delivery_error).toBe("Permanent: General: no such user");
    expect(db.state.logs[1].provider_message_id).toBe("re_legacy");
    await signedPost(env, event("email.delivered", "re_legacy", "legacy@example.test"), { id: "evt_b2" });
    expect(db.state.logs[1].delivery_status).toBe("bounced");
  });

  it("hard bounce -> global scope=all suppression; transient bounce -> none", async () => {
    const db = fakeDb(baseLogs());
    const env = { DB: db, RESEND_WEBHOOK_SECRET: SECRET } as unknown as Env;
    await signedPost(env, event("email.bounced", "re_1", "m@example.test", { bounce: { type: "Transient", subType: "MailboxFull" } }), { id: "evt_t" });
    expect(db.state.supp).toHaveLength(0);
    expect(db.state.logs[0].delivery_status).toBe("bounced");

    await signedPost(env, event("email.bounced", "re_1", "M@Example.test", { bounce: { type: "Permanent", subType: "NoEmail" } }), { id: "evt_h" });
    expect(db.state.supp).toEqual([
      { tenant_id: null, email: "m@example.test", scope: "all", reason: "bounce", source: "resend:evt_h" },
    ]);
  });

  it("complaint -> tenant marketing suppression + member opt-out; global when tenant unknown", async () => {
    const db = fakeDb(baseLogs());
    const env = { DB: db, RESEND_WEBHOOK_SECRET: SECRET } as unknown as Env;
    await signedPost(env, event("email.complained", "re_1", "m@example.test"), { id: "evt_c1" });
    expect(db.state.logs[0].delivery_status).toBe("complained");
    expect(db.state.supp).toEqual([
      { tenant_id: "t1", email: "m@example.test", scope: "marketing", reason: "complaint", source: "resend:evt_c1" },
    ]);
    expect(db.state.optOuts).toEqual([{ tenantId: "t1", email: "m@example.test" }]);

    const unknown = await signedPost(env, event("email.complained", "re_unknown", "stranger@example.test"), { id: "evt_c2" });
    expect(await unknown.json()).toMatchObject({ ok: true, matched: false });
    expect(db.state.supp[1]).toEqual({
      tenant_id: null, email: "stranger@example.test", scope: "marketing", reason: "complaint", source: "resend:evt_c2",
    });
    expect(db.state.optOuts).toHaveLength(1);
  });
});
