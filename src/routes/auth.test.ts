// P0 auth defects 2-5 at the route layer: purpose confusion at
// /verify-magic, one-time magic links, /magic-link honouring sendEmail's
// result, and the Google OAuth state being bound to the starting browser.
//
// Same fake-D1, real-signed-JWT idiom as src/routes/portal.test.ts: dispatch
// through the exported `authRoutes` Hono app with an in-memory users +
// auth_tokens stand-in (src/lib/auth/fakeAuthDb.ts). `sendEmail` is mocked so
// the provider result can be steered per test.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authRoutes } from "./auth";
import { signJwt, verifyJwt } from "../lib/auth";
import { fakeAuthDb } from "../lib/auth/fakeAuthDb";
import { sendEmail } from "../lib/email";
import type { Env } from "../types";

vi.mock("../lib/email", () => ({
  sendEmail: vi.fn(),
  // Echo the login URL so tests can read the exact token that was emailed.
  magicLinkEmail: ({ loginUrl }: { loginUrl: string }) => ({ subject: "Sign in", html: loginUrl }),
}));

const mockedSendEmail = vi.mocked(sendEmail);

const SECRET = "test-secret-not-used-in-prod";
const APP_URL = "https://quilthosting.test";
const EMAIL = "member@example.test";
const seedUser = { id: "user-1", email: EMAIL, password_hash: null, name: "Zoë 🧵" };

function envFor(db: ReturnType<typeof fakeAuthDb>, extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    JWT_SECRET: SECRET,
    APP_URL,
    ENVIRONMENT: "test",
    ...extra,
  } as unknown as Env;
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  mockedSendEmail.mockReset();
  mockedSendEmail.mockResolvedValue({ id: "email-1", success: true });
});

/** The magic token inside the login URL the route just emailed. */
function sentToken(): string {
  const call = mockedSendEmail.mock.calls.at(-1);
  if (!call) throw new Error("sendEmail not called");
  const url = new URL(String(call[1].html));
  expect(url.pathname).toBe("/auth/verify");
  return url.searchParams.get("token") || "";
}

describe("POST /magic-link", () => {
  it("issues a one-time magic token, sends it, and returns the generic message", async () => {
    const db = fakeAuthDb([seedUser]);
    const res = await authRoutes.request("/magic-link", json({ email: EMAIL }), envFor(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "If that email exists, a login link has been sent." });
    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
    expect(db.tokens.size).toBe(1);
    const row = [...db.tokens.values()][0];
    expect(row.user_id).toBe("user-1");
    expect(row.used_at).toBeNull();
    const emailed = await verifyJwt(sentToken(), SECRET, { purpose: "magic" });
    expect(emailed?.jti).toBe(row.jti);
    expect(emailed?.name).toBe(seedUser.name);
  });

  it("returns 503 when the email provider fails and does not create a user", async () => {
    mockedSendEmail.mockResolvedValue({ id: "", success: false, error: "Email not configured" });
    const db = fakeAuthDb(); // no users yet
    const res = await authRoutes.request(
      "/magic-link",
      json({ email: "newperson@example.test" }),
      envFor(db)
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "We couldn't send email right now. Please try again in a few minutes.",
    });
    expect(db.users.size).toBe(0);
    // The undelivered token was revoked, so nothing dangling is consumable.
    expect(db.tokens.size).toBe(0);
  });

  it("creates the user row only after a successful send", async () => {
    const db = fakeAuthDb();
    const res = await authRoutes.request(
      "/magic-link",
      json({ email: "NewPerson@Example.test" }),
      envFor(db)
    );
    expect(res.status).toBe(200);
    expect(db.users.get("newperson@example.test")).toBeTruthy();
    const order = db.log.map((l) => l.sql.trim().slice(0, 22));
    expect(order.findIndex((s) => s.startsWith("INSERT INTO auth_tokens"))).toBeLessThan(
      order.findIndex((s) => s.startsWith("INSERT INTO users"))
    );
  });

  it("requires an email", async () => {
    const res = await authRoutes.request("/magic-link", json({}), envFor(fakeAuthDb()));
    expect(res.status).toBe(400);
  });
});

describe("POST /verify-magic", () => {
  /** Request a magic link through the real route and return the emailed token. */
  async function issueViaRoute(db: ReturnType<typeof fakeAuthDb>): Promise<string> {
    const res = await authRoutes.request("/magic-link", json({ email: EMAIL }), envFor(db));
    expect(res.status).toBe(200);
    return sentToken();
  }

  it("exchanges a magic token for a session once; the second use is 401", async () => {
    const db = fakeAuthDb([seedUser]);
    const magic = await issueViaRoute(db);

    const first = await authRoutes.request("/verify-magic", json({ token: magic }), envFor(db));
    expect(first.status).toBe(200);
    const body = (await first.json()) as { token: string; user: { id: string; name: string } };
    expect(body.user).toEqual({ id: "user-1", email: EMAIL, name: seedUser.name });
    const session = await verifyJwt(body.token, SECRET);
    expect(session?.purpose).toBe("session");
    expect(session?.name).toBe(seedUser.name);

    const second = await authRoutes.request("/verify-magic", json({ token: magic }), envFor(db));
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: "Invalid or expired link" });
  });

  it("rejects a 7-day session token (cannot mint itself a fresh session)", async () => {
    const db = fakeAuthDb([seedUser]);
    const session = await signJwt({ sub: "user-1", email: EMAIL }, SECRET);
    const res = await authRoutes.request("/verify-magic", json({ token: session }), envFor(db));
    expect(res.status).toBe(401);
  });

  it("rejects an expired magic token", async () => {
    const db = fakeAuthDb([seedUser]);
    const expired = await signJwt({ sub: "user-1", email: EMAIL, jti: "j1" }, SECRET, -1, "magic");
    db.tokens.set("j1", {
      jti: "j1",
      user_id: "user-1",
      purpose: "magic",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      created_at: new Date().toISOString(),
    });
    const res = await authRoutes.request("/verify-magic", json({ token: expired }), envFor(db));
    expect(res.status).toBe(401);
  });

  it("rejects a tampered token", async () => {
    const db = fakeAuthDb([seedUser]);
    const magic = await issueViaRoute(db);
    const tampered = magic.slice(0, -2) + (magic.endsWith("aa") ? "bb" : "aa");
    const res = await authRoutes.request("/verify-magic", json({ token: tampered }), envFor(db));
    expect(res.status).toBe(401);
  });
});

describe("magic token is not a bearer for /me", () => {
  it("GET /me rejects a purpose:magic token", async () => {
    const db = fakeAuthDb([seedUser]);
    const magic = await signJwt({ sub: "user-1", email: EMAIL }, SECRET, 900, "magic");
    const res = await authRoutes.request(
      "/me",
      { headers: { Authorization: `Bearer ${magic}` } },
      envFor(db)
    );
    expect(res.status).toBe(401);
  });

  it("GET /me accepts a session token", async () => {
    const db = fakeAuthDb([seedUser]);
    const session = await signJwt({ sub: "user-1", email: EMAIL }, SECRET);
    const res = await authRoutes.request(
      "/me",
      { headers: { Authorization: `Bearer ${session}` } },
      envFor(db)
    );
    expect(res.status).toBe(200);
  });
});

describe("Google OAuth — state bound to the starting browser", () => {
  const googleEnv = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" };

  async function startFlow(db = fakeAuthDb()) {
    // Absolute https URL: Hono's .request() defaults to http://localhost, where
    // the Secure attribute is (correctly) omitted.
    const res = await authRoutes.request(
      `${APP_URL}/google?dest=admin`,
      {},
      envFor(db, googleEnv)
    );
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") || "";
    const nonce = /qh_oauth=([^;]+)/.exec(setCookie)?.[1] || "";
    const state = new URL(res.headers.get("location")!).searchParams.get("state") || "";
    return { setCookie, nonce, state };
  }

  it("sets an HttpOnly, Secure, SameSite=Lax, 10-minute nonce cookie and signs the nonce into state", async () => {
    const { setCookie, nonce, state } = await startFlow();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("Path=/api/auth/google");
    expect(state.split(".")).toHaveLength(5);
    expect(state.split(".")[3]).toBe(nonce);
  });

  it("callback fails when the nonce cookie is missing", async () => {
    const { state } = await startFlow();
    const res = await authRoutes.request(
      `/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      {},
      envFor(fakeAuthDb(), googleEnv)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin#gerror=");
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("could not be verified");
  });

  it("callback fails when the nonce cookie does not match the state", async () => {
    const { state } = await startFlow();
    const res = await authRoutes.request(
      `/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: "qh_oauth=deadbeefdeadbeefdeadbeefdeadbeef" } },
      envFor(fakeAuthDb(), googleEnv)
    );
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("could not be verified");
  });

  it("callback fails on a state whose nonce was swapped (signature covers the nonce)", async () => {
    const { state, nonce } = await startFlow();
    const parts = state.split(".");
    parts[3] = "0".repeat(32);
    const res = await authRoutes.request(
      `/google/callback?code=abc&state=${encodeURIComponent(parts.join("."))}`,
      { headers: { Cookie: `qh_oauth=${nonce}` } },
      envFor(fakeAuthDb(), googleEnv)
    );
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("Sign-in expired");
  });

  it("legacy 4-part state (pre-nonce) is rejected", async () => {
    const res = await authRoutes.request(
      `/google/callback?code=abc&state=${Date.now()}.admin..abc`,
      {},
      envFor(fakeAuthDb(), googleEnv)
    );
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("Sign-in expired");
  });

  describe("with matching cookie", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("completes sign-in, mints a SESSION token, and clears the cookie", async () => {
      const db = fakeAuthDb([seedUser]);
      const { state, nonce } = await startFlow(db);
      const idBytes = new TextEncoder().encode(
        JSON.stringify({ email: EMAIL, email_verified: true, name: "Zoë 🧵" })
      );
      let idBin = "";
      for (const b of idBytes) idBin += String.fromCharCode(b);
      const idPayload = btoa(idBin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ id_token: `h.${idPayload}.s` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ) as unknown as typeof fetch;

      const res = await authRoutes.request(
        `/google/callback?code=abc&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: `qh_oauth=${nonce}` } },
        envFor(db, googleEnv)
      );
      expect(res.status).toBe(302);
      const loc = res.headers.get("location") || "";
      expect(loc.startsWith("/admin#gtoken=")).toBe(true);
      const session = await verifyJwt(loc.split("#gtoken=")[1], SECRET);
      expect(session?.purpose).toBe("session");
      expect(session?.sub).toBe("user-1");
      const cleared = res.headers.get("set-cookie") || "";
      expect(cleared).toContain("qh_oauth=");
      expect(cleared).toContain("Max-Age=0");
    });
  });
});
