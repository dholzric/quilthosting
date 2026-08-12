// src/routes/credentials.test.ts
// Authorization gate on the write/clear endpoints. GET is deliberately not
// covered here — it stays open to any requireTenantAccess role (see the
// comment on credentialRoutes.get("/") in credentials.ts) since it leaks no
// secret material.
//
// This dispatches real requests through the exported `credentialRoutes` Hono
// app (Hono's `.request(path, init, env)` test helper), with a thin
// upstream middleware standing in for what `tenantMiddleware` /
// `requireTenantAccess` normally attach to context (`tenant`, `tenantRole`)
// when this router is mounted in src/index.ts. No D1 binding or live Worker
// is used -- a minimal in-memory stand-in for `env.DB` keeps this a
// pure-unit test per this repo's vitest.config.ts convention.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { credentialRoutes, requireOwnerAdmin } from "./credentials";
import type { Env, Tenant, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";

// 32 random bytes, base64. Test-only value, matches src/lib/credentials.test.ts.
const CREDENTIAL_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

/** Minimal D1 stand-in: every prepared statement no-ops successfully. */
function fakeDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              return { success: true };
            },
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

function buildApp(role: string) {
  const app = new Hono<{
    Bindings: Env;
    Variables: AuthVariables & TenantVariables & { tenantRole: string };
  }>();
  // Stands in for requireAuth + tenantMiddleware + requireTenantAccess,
  // which attach `user`, `tenant`, and `tenantRole` before any tenant-scoped
  // route runs (see the tenantApp chain in src/index.ts).
  app.use("*", async (c, next) => {
    c.set("user", { id: "user-1", email: "user1@example.test" });
    c.set("tenant", { id: "tenant-1" } as Tenant);
    c.set("tenantRole", role);
    await next();
  });
  app.route("/", credentialRoutes);
  return app;
}

const fakeEnv = { DB: fakeDb(), CREDENTIAL_KEY } as unknown as Env;

describe("requireOwnerAdmin", () => {
  it("denies viewer", async () => {
    const res = await requireOwnerAdmin({ get: () => "viewer" });
    expect(res?.status).toBe(403);
  });

  it("denies membership and events roles", async () => {
    expect((await requireOwnerAdmin({ get: () => "membership" }))?.status).toBe(403);
    expect((await requireOwnerAdmin({ get: () => "events" }))?.status).toBe(403);
  });

  it("admits owner, admin, and platform", async () => {
    expect(await requireOwnerAdmin({ get: () => "owner" })).toBeNull();
    expect(await requireOwnerAdmin({ get: () => "admin" })).toBeNull();
    expect(await requireOwnerAdmin({ get: () => "platform" })).toBeNull();
  });
});

describe("PUT / — role gate", () => {
  const body = JSON.stringify({ provider: "paypal", key: "client_id", value: "x" });
  const init = { method: "PUT", headers: { "Content-Type": "application/json" }, body };

  it("rejects a viewer-role actor with 403 and never reaches storage", async () => {
    const res = await buildApp("viewer").request("/", init, fakeEnv);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("accepts an owner-role actor", async () => {
    const res = await buildApp("owner").request("/", init, fakeEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, configured: true });
  });

  it("accepts an admin-role actor", async () => {
    const res = await buildApp("admin").request("/", init, fakeEnv);
    expect(res.status).toBe(200);
  });
});

describe("DELETE /:provider/:key — role gate", () => {
  it("rejects a viewer-role actor with 403 and never reaches storage", async () => {
    const res = await buildApp("viewer").request(
      "/paypal/client_id",
      { method: "DELETE" },
      fakeEnv,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("accepts an owner-role actor", async () => {
    const res = await buildApp("owner").request(
      "/paypal/client_id",
      { method: "DELETE" },
      fakeEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, configured: false });
  });

  it("accepts an admin-role actor", async () => {
    const res = await buildApp("admin").request(
      "/paypal/client_id",
      { method: "DELETE" },
      fakeEnv,
    );
    expect(res.status).toBe(200);
  });
});
