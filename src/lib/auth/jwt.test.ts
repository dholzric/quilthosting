// P0 auth defects 1 & 2: UTF-8-safe encoding and purpose-scoped tokens.
import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt, extractBearer } from "./jwt";

const SECRET = "test-secret-not-used-in-prod";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign an arbitrary header/payload with the real HMAC so only shape checks can reject it. */
async function signRaw(header: object, payload: object, secret = SECRET): Promise<string> {
  const enc = new TextEncoder();
  const data = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

const now = () => Math.floor(Date.now() / 1000);

describe("signJwt / verifyJwt — UTF-8", () => {
  it("round-trips emoji, accents, and CJK in the name claim (btoa used to throw)", async () => {
    const name = "Zoë 🧵 田中 María-José Ünterström";
    const token = await signJwt({ sub: "u1", email: "zoe@example.test", name }, SECRET);
    const payload = await verifyJwt(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.name).toBe(name);
    expect(payload!.sub).toBe("u1");
    expect(payload!.purpose).toBe("session");
    expect(payload!.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("produces a URL-safe three-part token", async () => {
    const token = await signJwt({ sub: "u1", email: "a@b.test", name: "🎉".repeat(50) }, SECRET);
    expect(token.split(".")).toHaveLength(3);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("verifyJwt — purpose scoping", () => {
  it("a magic token is rejected where a session is expected (default purpose)", async () => {
    const magic = await signJwt({ sub: "u1", email: "a@b.test" }, SECRET, 900, "magic");
    expect(await verifyJwt(magic, SECRET)).toBeNull();
    expect(await verifyJwt(magic, SECRET, { purpose: "session" })).toBeNull();
    expect(await verifyJwt(magic, SECRET, { purpose: "magic" })).not.toBeNull();
  });

  it("a session token is rejected where a magic token is expected", async () => {
    const session = await signJwt({ sub: "u1", email: "a@b.test" }, SECRET);
    expect(await verifyJwt(session, SECRET, { purpose: "magic" })).toBeNull();
    expect(await verifyJwt(session, SECRET)).not.toBeNull();
  });

  it("receipt/download link tokens are never valid sessions", async () => {
    const receipt = await signJwt({ sub: "u1", email: "a@b.test", res: "receipt:g:p" }, SECRET, 600, "receipt");
    const download = await signJwt({ sub: "u1", email: "a@b.test", res: "download:g:f" }, SECRET, 600, "download");
    expect(await verifyJwt(receipt, SECRET)).toBeNull();
    expect(await verifyJwt(download, SECRET)).toBeNull();
    expect((await verifyJwt(receipt, SECRET, { purpose: "receipt" }))?.res).toBe("receipt:g:p");
  });

  it("a legacy token with no purpose claim is rejected even with a valid signature", async () => {
    const legacy = await signRaw(
      { alg: "HS256", typ: "JWT" },
      { sub: "u1", email: "a@b.test", iat: now(), exp: now() + 3600 }
    );
    expect(await verifyJwt(legacy, SECRET)).toBeNull();
    expect(await verifyJwt(legacy, SECRET, { purpose: "magic" })).toBeNull();
  });

  it("an unknown purpose value is rejected", async () => {
    const weird = await signRaw(
      { alg: "HS256", typ: "JWT" },
      { sub: "u1", email: "a@b.test", purpose: "admin", jti: "x", iat: now(), exp: now() + 3600 }
    );
    expect(await verifyJwt(weird, SECRET)).toBeNull();
  });
});

describe("verifyJwt — integrity and shape", () => {
  it("rejects a tampered signature", async () => {
    const token = await signJwt({ sub: "u1", email: "a@b.test" }, SECRET);
    const [h, p, s] = token.split(".");
    const flipped = (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(await verifyJwt(`${h}.${p}.${flipped}`, SECRET)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signJwt({ sub: "u1", email: "a@b.test" }, SECRET);
    const [h, , s] = token.split(".");
    const forged = b64url(
      new TextEncoder().encode(
        JSON.stringify({ sub: "admin", email: "a@b.test", purpose: "session", jti: "x", iat: now(), exp: now() + 3600 })
      )
    );
    expect(await verifyJwt(`${h}.${forged}.${s}`, SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signJwt({ sub: "u1", email: "a@b.test" }, "other-secret");
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signJwt({ sub: "u1", email: "a@b.test" }, SECRET, -10);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects alg other than HS256 (alg:none / RS256 confusion)", async () => {
    const none = await signRaw(
      { alg: "none", typ: "JWT" },
      { sub: "u1", email: "a@b.test", purpose: "session", jti: "x", iat: now(), exp: now() + 3600 }
    );
    expect(await verifyJwt(none, SECRET)).toBeNull();
    const rs = await signRaw(
      { alg: "RS256", typ: "JWT" },
      { sub: "u1", email: "a@b.test", purpose: "session", jti: "x", iat: now(), exp: now() + 3600 }
    );
    expect(await verifyJwt(rs, SECRET)).toBeNull();
  });

  it("rejects an empty or non-string sub, and non-finite exp/iat", async () => {
    const base = { email: "a@b.test", purpose: "session", jti: "x", iat: now(), exp: now() + 3600 };
    const hdr = { alg: "HS256", typ: "JWT" };
    expect(await verifyJwt(await signRaw(hdr, { ...base, sub: "" }), SECRET)).toBeNull();
    expect(await verifyJwt(await signRaw(hdr, { ...base, sub: 42 }), SECRET)).toBeNull();
    expect(await verifyJwt(await signRaw(hdr, { ...base, sub: "u1", exp: "soon" }), SECRET)).toBeNull();
    expect(await verifyJwt(await signRaw(hdr, { ...base, sub: "u1", iat: null }), SECRET)).toBeNull();
    expect(await verifyJwt(await signRaw(hdr, { ...base, sub: "u1", jti: "" }), SECRET)).toBeNull();
  });

  it("rejects garbage without throwing", async () => {
    expect(await verifyJwt("", SECRET)).toBeNull();
    expect(await verifyJwt("a.b", SECRET)).toBeNull();
    expect(await verifyJwt("a.b.c", SECRET)).toBeNull();
    expect(await verifyJwt("!!.??.%%", SECRET)).toBeNull();
  });
});

describe("extractBearer", () => {
  it("parses a Bearer header and ignores others", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
    expect(extractBearer("Bearer   ")).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
  });
});
