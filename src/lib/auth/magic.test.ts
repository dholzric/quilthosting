// P0 auth defect 3: magic links are one-time. Covers issue/consume/sweep and
// the browser landing handler (magicLinkLanding) that src/index.ts mounts.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types";
import { signJwt, verifyJwt } from "./jwt";
import {
  issueMagicToken,
  consumeMagicToken,
  sweepAuthTokens,
  magicLinkLanding,
} from "./magic";
import { fakeAuthDb } from "./fakeAuthDb";

const SECRET = "test-secret-not-used-in-prod";
const user = { id: "user-1", email: "member@example.test", name: "Zoë 🧵" };

function envFor(db: ReturnType<typeof fakeAuthDb>): Env {
  return { DB: db, JWT_SECRET: SECRET, APP_URL: "https://quilthosting.test", ENVIRONMENT: "test" } as unknown as Env;
}

describe("issueMagicToken / consumeMagicToken", () => {
  it("issues a purpose:magic token and records its jti", async () => {
    const db = fakeAuthDb();
    const { token, jti } = await issueMagicToken(db as unknown as D1Database, SECRET, user);
    const payload = await verifyJwt(token, SECRET, { purpose: "magic" });
    expect(payload?.jti).toBe(jti);
    expect(payload?.name).toBe(user.name);
    expect(db.tokens.get(jti)?.used_at).toBeNull();
    // Never usable as a session bearer.
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it("consumes exactly once: the second use returns null", async () => {
    const db = fakeAuthDb();
    const { token, jti } = await issueMagicToken(db as unknown as D1Database, SECRET, user);
    const first = await consumeMagicToken(db as unknown as D1Database, token, SECRET);
    expect(first?.sub).toBe(user.id);
    expect(db.tokens.get(jti)?.used_at).toBeTruthy();
    const second = await consumeMagicToken(db as unknown as D1Database, token, SECRET);
    expect(second).toBeNull();
  });

  it("rejects a session token (wrong purpose) without touching the table", async () => {
    const db = fakeAuthDb();
    const session = await signJwt({ sub: user.id, email: user.email }, SECRET);
    expect(await consumeMagicToken(db as unknown as D1Database, session, SECRET)).toBeNull();
    expect(db.log.some((l) => l.sql.includes("UPDATE auth_tokens"))).toBe(false);
  });

  it("rejects a validly signed magic token whose jti was never recorded", async () => {
    const db = fakeAuthDb();
    const forgedLike = await signJwt({ sub: user.id, email: user.email }, SECRET, 900, "magic");
    expect(await consumeMagicToken(db as unknown as D1Database, forgedLike, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const db = fakeAuthDb();
    const { token } = await issueMagicToken(db as unknown as D1Database, SECRET, user, -5);
    expect(await consumeMagicToken(db as unknown as D1Database, token, SECRET)).toBeNull();
  });

  it("rejects a token whose row expired even if the signature is still in date", async () => {
    const db = fakeAuthDb();
    const { token, jti } = await issueMagicToken(db as unknown as D1Database, SECRET, user);
    db.tokens.get(jti)!.expires_at = "2000-01-01T00:00:00.000Z";
    expect(await consumeMagicToken(db as unknown as D1Database, token, SECRET)).toBeNull();
  });
});

describe("sweepAuthTokens", () => {
  it("deletes expired rows (used or not) and keeps live ones", async () => {
    const db = fakeAuthDb();
    const live = await issueMagicToken(db as unknown as D1Database, SECRET, user);
    const stale = await issueMagicToken(db as unknown as D1Database, SECRET, user);
    db.tokens.get(stale.jti)!.expires_at = "2000-01-01T00:00:00.000Z";
    const { deleted } = await sweepAuthTokens(db as unknown as D1Database);
    expect(deleted).toBe(1);
    expect(db.tokens.has(live.jti)).toBe(true);
    expect(db.tokens.has(stale.jti)).toBe(false);
  });
});

describe("magicLinkLanding (GET /auth/verify)", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/auth/verify", magicLinkLanding);

  it("consumes the link and hands a SESSION token to the portal via #ptoken", async () => {
    const db = fakeAuthDb();
    const { token } = await issueMagicToken(db as unknown as D1Database, SECRET, user);
    const res = await app.request(
      `/auth/verify?token=${encodeURIComponent(token)}&slug=stitchstudio`,
      {},
      envFor(db)
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/portal?slug=stitchstudio#ptoken=")).toBe(true);
    const session = loc.split("#ptoken=")[1];
    const payload = await verifyJwt(session, SECRET);
    expect(payload?.purpose).toBe("session");
    expect(payload?.sub).toBe(user.id);
    expect(payload?.name).toBe(user.name);
  });

  it("dest=app deep-links into the native scheme", async () => {
    const db = fakeAuthDb();
    const { token } = await issueMagicToken(db as unknown as D1Database, SECRET, user);
    const res = await app.request(
      `/auth/verify?token=${encodeURIComponent(token)}&slug=stitchstudio&dest=app`,
      {},
      envFor(db)
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("quilthosting://auth?token=")).toBe(true);
    expect(loc).toContain("&slug=stitchstudio");
  });

  it("the same link cannot be used twice", async () => {
    const db = fakeAuthDb();
    const { token } = await issueMagicToken(db as unknown as D1Database, SECRET, user);
    const url = `/auth/verify?token=${encodeURIComponent(token)}`;
    expect((await app.request(url, {}, envFor(db))).status).toBe(302);
    const again = await app.request(url, {}, envFor(db));
    expect(again.status).toBe(401);
    expect(await again.text()).toContain("expired or was already used");
  });

  it("a 7-day session token cannot renew itself through the landing", async () => {
    const db = fakeAuthDb();
    const session = await signJwt({ sub: user.id, email: user.email }, SECRET);
    const res = await app.request(
      `/auth/verify?token=${encodeURIComponent(session)}`,
      {},
      envFor(db)
    );
    expect(res.status).toBe(401);
  });

  it("missing token is a 401 page, not a crash", async () => {
    const res = await app.request("/auth/verify", {}, envFor(fakeAuthDb()));
    expect(res.status).toBe(401);
  });
});
