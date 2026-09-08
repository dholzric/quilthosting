// src/routes/events.test.ts
// PATCH /events/:id omitted-vs-cleared semantics. The old handler used
// coalesce(?, col) for every column, so waitlist_enabled could never be
// changed after creation and no optional field (location, description,
// end_at, capacity) could ever be cleared. Fake D1 records the UPDATE the
// route builds so the assertions check the SET list and binds directly.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";
import { eventRoutes } from "./events";

const TENANT_ID = "tenant-1";

function harness() {
  const event = {
    id: "ev-1",
    tenant_id: TENANT_ID,
    title: "Retreat",
    description: "Old text",
    location: "Hall",
    start_at: "2026-10-01T15:00:00.000Z",
    end_at: "2026-10-01T18:00:00.000Z",
    capacity: 20,
    is_public: 1,
    member_price_cents: 0,
    non_member_price_cents: 500,
    registration_open: 1,
    waitlist_enabled: 0,
    settings_json: JSON.stringify({ questions: [{ key: "diet", label: "Diet", type: "text" }] }),
  };
  const updates: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM events")) return binds[0] === "ev-1" ? event : null;
              return null;
            },
            async run() {
              if (sql.startsWith("UPDATE events SET")) updates.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, name: "Guild" } as Tenant);
    await next();
  });
  app.route("/", eventRoutes);
  const env = { DB: db } as unknown as Env;
  const patch = (body: unknown) =>
    app.request(
      "/ev-1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  /** Map of column -> bound value from the single UPDATE the route issued. */
  const setMap = () => {
    expect(updates.length).toBe(1);
    const { sql, binds } = updates[0];
    const cols = sql
      .replace(/^UPDATE events SET /, "")
      .replace(/ WHERE id = \? AND tenant_id = \?$/, "")
      .split(", ")
      .map((s) => s.replace(/ = \?$/, ""));
    expect(binds.length).toBe(cols.length + 2);
    return Object.fromEntries(cols.map((c, i) => [c, binds[i]]));
  };
  return { patch, updates, setMap };
}

describe("PATCH /events/:id", () => {
  it("accepts waitlist_enabled (true -> 1, false -> 0) and touches nothing else", async () => {
    const h = harness();
    expect((await h.patch({ waitlist_enabled: true })).status).toBe(200);
    const s = h.setMap();
    expect(s).toEqual({ waitlist_enabled: 1, updated_at: expect.any(String) });

    const h2 = harness();
    await h2.patch({ waitlist_enabled: false });
    expect(h2.setMap().waitlist_enabled).toBe(0);
  });

  it("explicit null or \"\" clears optional fields; omitted fields are left alone", async () => {
    const h = harness();
    expect((await h.patch({ location: "", description: null, end_at: null, capacity: "" })).status).toBe(200);
    const s = h.setMap();
    expect(s).toEqual({
      location: null,
      description: null,
      end_at: null,
      capacity: null,
      updated_at: expect.any(String),
    });
    // Nothing about title/start_at/prices/flags in the SET list.
    expect(Object.keys(s)).not.toContain("title");
    expect(Object.keys(s)).not.toContain("registration_open");
  });

  it("required fields update but never clear; prices ignore null", async () => {
    const h = harness();
    expect((await h.patch({ title: "New title", start_at: "2026-11-01T15:00:00.000Z", member_price_cents: 1500, non_member_price_cents: null })).status).toBe(200);
    expect(h.setMap()).toEqual({
      title: "New title",
      start_at: "2026-11-01T15:00:00.000Z",
      member_price_cents: 1500,
      updated_at: expect.any(String),
    });

    const h2 = harness();
    expect((await h2.patch({ title: "" })).status).toBe(400);
    expect(h2.updates.length).toBe(0);
    const h3 = harness();
    expect((await h3.patch({ start_at: null })).status).toBe(400);
  });

  it("a body with nothing to change issues no UPDATE and returns the event", async () => {
    const h = harness();
    const res = await h.patch({});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("ev-1");
    expect(h.updates.length).toBe(0);
  });

  it("questions are normalized into settings_json alongside other fields", async () => {
    const h = harness();
    await h.patch({ questions: [{ label: "T-shirt size", type: "select", options: ["S", "M"], required: true }], location: "Annex" });
    const s = h.setMap();
    expect(s.location).toBe("Annex");
    expect(JSON.parse(s.settings_json as string)).toEqual({
      questions: [{ key: "t_shirt_size", label: "T-shirt size", type: "select", options: ["S", "M"], required: true }],
    });
  });

  it("rejects a non-object body and a bad capacity", async () => {
    const h = harness();
    expect((await h.patch([1, 2])).status).toBe(400);
    expect((await h.patch({ capacity: -3 })).status).toBe(400);
    expect((await h.patch({ capacity: 2.5 })).status).toBe(400);
    expect(h.updates.length).toBe(0);
  });
});
