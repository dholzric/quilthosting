// src/lib/email/sendEmail.test.ts
// sendEmail permission + header behaviour with the Resend fetch stubbed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail } from "./index";
import { applyMergeFields } from "./merge";
import type { Env } from "../../types";

type SuppRow = { tenant_id: string | null; email: string; scope: string; reason: string };

function fakeDb(supp: SuppRow[], optOut: Record<string, string | null> = {}) {
  const updates: { sql: string; binds: unknown[] }[] = [];
  const stmt = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    async run() {
      updates.push({ sql, binds });
      return { success: true, meta: { changes: 1 } };
    },
    async first() {
      if (sql.includes("FROM email_suppressions")) {
        const email = binds[0] as string;
        const tenantId = binds[binds.length - 1] as string;
        const scopes = binds.slice(1, -1) as string[];
        return (
          supp.find(
            (r) =>
              r.email === email &&
              scopes.includes(r.scope) &&
              (r.tenant_id === null || r.tenant_id === tenantId)
          ) ?? null
        );
      }
      if (sql.includes("SELECT email_opt_out_at FROM members")) {
        const key = `${binds[0]}:${binds[1]}`;
        return key in optOut ? { email_opt_out_at: optOut[key] } : null;
      }
      return null;
    },
    async all() {
      return { results: [] };
    },
  });
  return { updates, prepare: (sql: string) => stmt(sql, []) };
}

function env(db: ReturnType<typeof fakeDb>, extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    RESEND_API_KEY: "re_test",
    JWT_SECRET: "jwt-secret",
    APP_URL: "https://quilthosting.com",
    EMAIL_FROM: "QuiltHosting <noreply@quilthosting.test>",
    ...extra,
  } as unknown as Env;
}

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit; json: any }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const json = JSON.parse(String(init.body));
    calls.push({ url, init, json });
    return new Response(JSON.stringify(body), { status, headers });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("sendEmail", () => {
  it("never fakes success when the API key is missing", async () => {
    const calls = stubFetch(200, { id: "x" });
    const res = await sendEmail(env(fakeDb([]), { RESEND_API_KEY: "" }), {
      to: "a@example.test",
      subject: "s",
      html: "<p>hi</p>",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not configured/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses a globally suppressed address even for transactional mail", async () => {
    const calls = stubFetch(200, { id: "x" });
    const db = fakeDb([{ tenant_id: null, email: "dead@example.test", scope: "all", reason: "bounce" }]);
    const res = await sendEmail(env(db), { to: "Dead@example.test", subject: "s", html: "<p>hi</p>" });
    expect(res).toMatchObject({ success: false, suppressed: true, reason: "bounce" });
    expect(calls).toHaveLength(0);
  });

  it("marketing mail to an opted-out member is suppressed; transactional still goes", async () => {
    const calls = stubFetch(200, { id: "msg_1" });
    const db = fakeDb([], { "t1:m@example.test": "2026-01-01T00:00:00Z" });
    const blocked = await sendEmail(env(db), {
      to: "m@example.test",
      subject: "News",
      html: "<p>hi</p>",
      kind: "marketing",
      tenantId: "t1",
    });
    expect(blocked).toMatchObject({ success: false, suppressed: true, reason: "opt_out" });
    const ok = await sendEmail(env(db), {
      to: "m@example.test",
      subject: "Receipt",
      html: "<p>hi</p>",
      tenantId: "t1",
    });
    expect(ok.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].json.headers).toBeUndefined();
  });

  it("marketing mail gets List-Unsubscribe headers and an appended footer", async () => {
    const calls = stubFetch(200, { id: "msg_2" });
    const db = fakeDb([]);
    const res = await sendEmail(env(db), {
      to: "m@example.test",
      subject: "News",
      html: "<p>hi</p>",
      text: "hi",
      kind: "marketing",
      tenantId: "t1",
      guildName: "Test Guild",
      emailLogId: "log-1",
    });
    expect(res.success).toBe(true);
    expect(res.id).toBe("msg_2");
    expect(res.unsubscribeUrl).toMatch(/^https:\/\/quilthosting\.com\/u\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const body = calls[0].json;
    expect(body.headers["List-Unsubscribe"]).toContain(`<${res.unsubscribeUrl}>`);
    expect(body.headers["List-Unsubscribe"]).toContain("<mailto:unsubscribe@quilthosting.com");
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(body.html).toContain(`href="${res.unsubscribeUrl}"`);
    expect(body.html).toContain("Test Guild");
    expect(body.text).toContain(`Unsubscribe: ${res.unsubscribeUrl}`);
    // email_logs row stamped with provider id + accepted
    const stamp = db.updates.find((u) => u.sql.includes("UPDATE email_logs"));
    expect(stamp?.binds).toEqual(["msg_2", "msg_2", "log-1"]);
    expect(stamp?.sql).toContain("delivery_status = 'accepted'");
  });

  it("does not append a second footer when the template placed {{unsubscribe_url}}", async () => {
    const calls = stubFetch(200, { id: "msg_3" });
    const url = "https://quilthosting.com/u/abc.def";
    const html = applyMergeFields('<p>Bye</p><a href="{{unsubscribe_url}}">stop</a>', {
      unsubscribe_url: url,
    });
    expect(html).toContain(`href="${url}"`);
    await sendEmail(env(fakeDb([])), {
      to: "m@example.test",
      subject: "News",
      html,
      kind: "marketing",
      tenantId: "t1",
      unsubscribeUrl: url,
    });
    const sent = calls[0].json.html as string;
    expect(sent.split(url).length - 1).toBe(1);
    expect(sent).not.toContain("You're receiving this email");
  });

  it("surfaces 429 as retryable with Retry-After", async () => {
    stubFetch(429, { message: "rate limited" }, { "Retry-After": "2" });
    const res = await sendEmail(env(fakeDb([])), { to: "m@example.test", subject: "s", html: "x" });
    expect(res).toMatchObject({ success: false, status: 429, retryable: true, retryAfterMs: 2000 });
  });

  it("marks 4xx (other than 429) as non-retryable and network errors as retryable", async () => {
    stubFetch(422, { message: "bad address" });
    const bad = await sendEmail(env(fakeDb([])), { to: "m@example.test", subject: "s", html: "x" });
    expect(bad).toMatchObject({ success: false, status: 422, retryable: false, error: "bad address" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const net = await sendEmail(env(fakeDb([])), { to: "m@example.test", subject: "s", html: "x" });
    expect(net).toMatchObject({ success: false, retryable: true, error: "ECONNRESET" });
  });
});

// ---------------------------------------------------------------------------
// The sender must be a domain the provider will accept
//
// Resend rejects mail from an unverified domain. quiltmap.com is verified;
// quilthosting.com is not, so a fallback pointing at it turned a missing
// EMAIL_FROM into "no email at all, anywhere" — magic links included.
// ---------------------------------------------------------------------------

describe("the From address", () => {
  it("falls back to the verified sending domain when EMAIL_FROM is unset", async () => {
    const calls = stubFetch(200, { id: "e1" });
    const e = env(fakeDb([]));
    delete (e as { EMAIL_FROM?: string }).EMAIL_FROM;
    await sendEmail(e, { to: "a@example.test", subject: "s", html: "<p>h</p>" });
    expect(calls[0].json.from).toContain("@quiltmap.com");
  });

  it("still prefers EMAIL_FROM, and an explicit per-message from over that", async () => {
    const calls = stubFetch(200, { id: "e1" });
    const e = env(fakeDb([]), { EMAIL_FROM: "Guild <hello@configured.test>" } as never);
    await sendEmail(e, { to: "a@example.test", subject: "s", html: "<p>h</p>" });
    expect(calls[0].json.from).toBe("Guild <hello@configured.test>");
    await sendEmail(e, { to: "a@example.test", subject: "s", html: "<p>h</p>", from: "One <one@explicit.test>" });
    expect(calls[1].json.from).toBe("One <one@explicit.test>");
  });
});
