// src/routes/levels.test.ts
//
// Phase 4, Task A: the Levels route stores a dues policy (migration 0030).
// Same fake-D1 harness idiom as products.test.ts — assertions read the
// binds the route actually sent, not what it says it sent.
//
// The rules that matter to a treasurer:
//   - a request that says nothing about the policy leaves the level on the
//     anniversary term it has always had,
//   - fixed_date without a month and day is a 400, not a level that
//     silently behaves like the calendar year,
//   - switching a July-year level to the calendar year CLEARS the anchor
//     (the column is written directly for exactly this reason), and
//   - grace_days is bounded, so "3650" is a typo the officer sees rather
//     than a decade of zombie members.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env, MembershipLevel, Tenant, TenantVariables } from "../types";
import { levelRoutes } from "./levels";

const TENANT_ID = "tenant-1";

function harness(existing: Partial<MembershipLevel & Record<string, unknown>> = {}) {
  const level = {
    id: "lvl-1",
    tenant_id: TENANT_ID,
    name: "Individual",
    description: null,
    price_cents: 3500,
    duration_months: 12,
    renewal_type: "manual",
    benefits_json: "[]",
    is_public: 1,
    sort_order: 0,
    status: "active",
    term_mode: "anniversary",
    term_anchor: null,
    proration: "none",
    grace_days: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...existing,
  };
  const runs: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              return sql.includes("FROM membership_levels") ? level : null;
            },
            async all() {
              return { results: [level] };
            },
            async run() {
              runs.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, name: "Prairie Star" } as Tenant);
    await next();
  });
  app.route("/", levelRoutes);
  const env = { DB: db } as unknown as Env;
  const post = (body: unknown) =>
    app.request(
      "/",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  const patch = (body: unknown) =>
    app.request(
      "/lvl-1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  /** The four policy binds, in the order both statements write them. */
  const insertPolicy = () => {
    const r = runs.find((x) => x.sql.includes("INSERT INTO membership_levels"))!;
    return {
      term_mode: r.binds[8],
      term_anchor: r.binds[9],
      proration: r.binds[10],
      grace_days: r.binds[11],
    };
  };
  const updatePolicy = () => {
    const r = runs.find((x) => x.sql.includes("UPDATE membership_levels SET"))!;
    return {
      term_mode: r.binds[6],
      term_anchor: r.binds[7],
      proration: r.binds[8],
      grace_days: r.binds[9],
    };
  };
  return { post, patch, runs, insertPolicy, updatePolicy };
}

describe("POST /levels — dues policy", () => {
  it("defaults to today's behavior when the request says nothing", async () => {
    const h = harness();
    expect((await h.post({ name: "Individual", price_cents: 3500 })).status).toBe(201);
    expect(h.insertPolicy()).toEqual({
      term_mode: "anniversary",
      term_anchor: null,
      proration: "none",
      grace_days: 0,
    });
  });

  it("stores a calendar year with proration and a grace period", async () => {
    const h = harness();
    const res = await h.post({
      name: "Individual",
      price_cents: 3500,
      term_mode: "calendar",
      proration: "half_year",
      grace_days: 30,
    });
    expect(res.status).toBe(201);
    expect(h.insertPolicy()).toEqual({
      term_mode: "calendar",
      term_anchor: null,
      proration: "half_year",
      grace_days: 30,
    });
  });

  it("stores a fixed-date year with its anchor", async () => {
    const h = harness();
    await h.post({ name: "Individual", term_mode: "fixed_date", term_anchor: "07-01" });
    expect(h.insertPolicy().term_mode).toBe("fixed_date");
    expect(h.insertPolicy().term_anchor).toBe("07-01");
  });

  it("drops an anchor sent with the calendar year", async () => {
    const h = harness();
    await h.post({ name: "Individual", term_mode: "calendar", term_anchor: "07-01" });
    expect(h.insertPolicy().term_anchor).toBeNull();
  });

  it("rejects fixed_date with no anchor and writes nothing", async () => {
    const h = harness();
    const res = await h.post({ name: "Individual", term_mode: "fixed_date" });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/term_anchor/);
    expect(h.runs.length).toBe(0);
  });

  it("rejects an anchor that is not a real month and day", async () => {
    for (const anchor of ["13-01", "02-30", "04-31", "7-1", "07/01", "0701"]) {
      const h = harness();
      const res = await h.post({ name: "L", term_mode: "fixed_date", term_anchor: anchor });
      expect(res.status, anchor).toBe(400);
      expect(h.runs.length, anchor).toBe(0);
    }
  });

  it("accepts February 29 (dues.ts clamps it in non-leap years)", async () => {
    const h = harness();
    const res = await h.post({ name: "L", term_mode: "fixed_date", term_anchor: "02-29" });
    expect(res.status).toBe(201);
    expect(h.insertPolicy().term_anchor).toBe("02-29");
  });

  it("rejects an unknown term_mode or proration", async () => {
    for (const body of [
      { name: "L", term_mode: "quarterly" },
      { name: "L", term_mode: "calendar", proration: "weekly" },
    ]) {
      const h = harness();
      expect((await h.post(body)).status).toBe(400);
      expect(h.runs.length).toBe(0);
    }
  });

  it("bounds grace_days", async () => {
    for (const grace_days of [-1, 366, 12.5, "30"]) {
      const h = harness();
      const res = await h.post({ name: "L", grace_days });
      expect(res.status, String(grace_days)).toBe(400);
      expect((await res.json<{ error: string }>()).error).toMatch(/grace_days/);
    }
    const ok = harness();
    expect((await ok.post({ name: "L", grace_days: 365 })).status).toBe(201);
    expect(ok.insertPolicy().grace_days).toBe(365);
  });
});

describe("PATCH /levels/:id — dues policy", () => {
  it("leaves the stored policy alone when the request only renames the level", async () => {
    const h = harness({
      term_mode: "fixed_date",
      term_anchor: "07-01",
      proration: "monthly",
      grace_days: 14,
    });
    expect((await h.patch({ name: "Individual (renamed)" })).status).toBe(200);
    expect(h.updatePolicy()).toEqual({
      term_mode: "fixed_date",
      term_anchor: "07-01",
      proration: "monthly",
      grace_days: 14,
    });
  });

  it("clears the anchor when the year switches to January–December", async () => {
    const h = harness({ term_mode: "fixed_date", term_anchor: "07-01" });
    await h.patch({ term_mode: "calendar" });
    expect(h.updatePolicy().term_mode).toBe("calendar");
    expect(h.updatePolicy().term_anchor).toBeNull();
  });

  it("clears the anchor when the year switches back to anniversary", async () => {
    const h = harness({ term_mode: "fixed_date", term_anchor: "07-01", proration: "half_year" });
    await h.patch({ term_mode: "anniversary" });
    expect(h.updatePolicy().term_mode).toBe("anniversary");
    expect(h.updatePolicy().term_anchor).toBeNull();
  });

  it("keeps the level's own anchor when only the anchor moves", async () => {
    const h = harness({ term_mode: "fixed_date", term_anchor: "07-01" });
    await h.patch({ term_anchor: "09-01" });
    expect(h.updatePolicy()).toMatchObject({ term_mode: "fixed_date", term_anchor: "09-01" });
  });

  it("rejects switching to fixed_date without an anchor and writes nothing", async () => {
    const h = harness();
    const res = await h.patch({ term_mode: "fixed_date" });
    expect(res.status).toBe(400);
    expect(h.runs.length).toBe(0);
  });

  it("rejects clearing the anchor of a fixed-date level", async () => {
    const h = harness({ term_mode: "fixed_date", term_anchor: "07-01" });
    const res = await h.patch({ term_anchor: null });
    expect(res.status).toBe(400);
    expect(h.runs.length).toBe(0);
  });

  it("still validates price and duration as before", async () => {
    const h = harness();
    expect((await h.patch({ price_cents: 35.5 })).status).toBe(400);
    expect((await h.patch({ duration_months: 0 })).status).toBe(400);
  });
});

/* ————————————————— Household columns (migration 0031) —————————————————
 *
 * A level that says nothing about households is an individual level, which
 * is what every level was before this migration. The binds are read straight
 * out of the statement the route sent, in the positions the SQL writes them.
 */
function householdInsertBinds(runs: { sql: string; binds: unknown[] }[]) {
  const r = runs.find((x) => x.sql.includes("INSERT INTO membership_levels"))!;
  return { household_max: r.binds[12], household_add_cents: r.binds[13] };
}
function householdUpdateBinds(runs: { sql: string; binds: unknown[] }[]) {
  const r = runs.find((x) => x.sql.includes("UPDATE membership_levels SET"))!;
  return { household_max: r.binds[10], household_add_cents: r.binds[11] };
}

describe("levels — household membership", () => {
  it("creates an individual level when the request says nothing", async () => {
    const h = harness();
    expect((await h.post({ name: "Individual", price_cents: 3500 })).status).toBe(201);
    expect(householdInsertBinds(h.runs)).toEqual({ household_max: 1, household_add_cents: 0 });
  });

  it("stores a household level with its extra-person price", async () => {
    const h = harness();
    const res = await h.post({
      name: "Household",
      price_cents: 4000,
      household_max: 3,
      household_add_cents: 1500,
    });
    expect(res.status).toBe(201);
    expect(householdInsertBinds(h.runs)).toEqual({ household_max: 3, household_add_cents: 1500 });
  });

  it("leaves the stored household settings alone on a PATCH that omits them", async () => {
    const h = harness({ household_max: 2, household_add_cents: 1000 });
    expect((await h.patch({ name: "Renamed" })).status).toBe(200);
    // NULL through coalesce(?, household_max) keeps the column.
    expect(householdUpdateBinds(h.runs)).toEqual({
      household_max: null,
      household_add_cents: null,
    });
  });

  it("turns a household level back into an individual one", async () => {
    const h = harness({ household_max: 3, household_add_cents: 1500 });
    expect((await h.patch({ household_max: 1, household_add_cents: 0 })).status).toBe(200);
    expect(householdUpdateBinds(h.runs)).toEqual({ household_max: 1, household_add_cents: 0 });
  });

  it("rejects a household of nobody, a household of fifty, and a fractional one", async () => {
    for (const bad of [0, -1, 50, 2.5]) {
      const h = harness();
      const res = await h.post({ name: "X", household_max: bad });
      expect(res.status, `household_max ${bad}`).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("household_max"),
      });
    }
  });

  it("rejects a negative extra-person price", async () => {
    const h = harness();
    const res = await h.post({ name: "X", household_add_cents: -100 });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("household_add_cents"),
    });
  });
});
