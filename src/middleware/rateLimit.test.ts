import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimit } from "./rateLimit";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    },
  };
}

function build(env: Record<string, unknown>, opts: Parameters<typeof rateLimit>[0]) {
  const app = new Hono<{ Bindings: any }>();
  app.use("/x", rateLimit(opts));
  app.post("/x", (c) => c.text("ok"));
  return (ip = "1.1.1.1") =>
    app.request("http://h/x", { method: "POST", headers: { "cf-connecting-ip": ip } }, env);
}

describe("rateLimit", () => {
  it("uses the atomic binding and rejects when it says no", async () => {
    let calls = 0;
    const env = {
      RATE_LIMITER: { limit: async () => ({ success: ++calls <= 2 }) },
    };
    const hit = build(env, { keyPrefix: "t", limit: 100 });
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    const third = await hit();
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
  });

  it("falls back to the KV window and honours the limit", async () => {
    const { kv } = fakeKv();
    const hit = build({ KV: kv }, { keyPrefix: "t", limit: 2 });
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
    expect((await hit("2.2.2.2")).status).toBe(200);
  });

  it("fails open on infrastructure errors unless failClosed", async () => {
    const broken = {
      RATE_LIMITER: {
        limit: async () => {
          throw new Error("boom");
        },
      },
    };
    expect((await build(broken, { keyPrefix: "t" })()).status).toBe(200);
    expect((await build(broken, { keyPrefix: "t", failClosed: true })()).status).toBe(429);
  });

  it("passes through with no bindings at all", async () => {
    expect((await build({}, { keyPrefix: "t" })()).status).toBe(200);
  });
});
