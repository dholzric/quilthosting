// src/routes/automations.test.ts
//
// The automations API: trigger validation gated on features.automations_v2 (the
// off path is byte-for-byte the pre-Task-E behaviour), conditions and trigger
// config round-tripping, one-click recipe install producing an ordinary
// editable sequence, and the runs listing.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";
import { automationRoutes, AUTOMATION_TRIGGERS } from "./automations";
import { createTestDb, seedTenant, seedSequence, type TestDb } from "../lib/automations/testDb";

const TENANT_ID = "tenant-1";

function harness(features: Record<string, boolean> = {}) {
  const db = createTestDb();
  seedTenant(db, { id: TENANT_ID });
  const settings = JSON.stringify({ features });
  db.sqlite.prepare(`UPDATE tenants SET settings_json = ?`).run(settings);

  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", {
      id: TENANT_ID,
      name: "River Quilters",
      slug: "river",
      settings_json: settings,
    } as Tenant);
    await next();
  });
  app.route("/", automationRoutes);
  const env = { DB: db, APP_URL: "https://quilthosting.com" } as unknown as Env;

  const call = (path: string, init?: RequestInit) =>
    app.request(
      path,
      {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      },
      env
    );
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", body: JSON.stringify(body) });
  const patch = (path: string, body: unknown) =>
    call(path, { method: "PATCH", body: JSON.stringify(body) });

  return { db, app, env, call, post, patch };
}

const STEPS = [
  { waitDays: 0, subject: "Welcome", bodyHtml: "<p>Hello</p>" },
  { waitDays: 3, subject: "Day three", bodyHtml: "<p>More</p>" },
];

describe("POST / — trigger validation", () => {
  it("with automations_v2 OFF, still rejects anything but member_activated (unchanged)", async () => {
    const h = harness();
    const res = await h.post("/", { name: "Lapse", trigger_event: "membership_lapsed", steps: STEPS });
    expect(res.status).toBe(400);
    const body = await res.json<{ code: string; valid: string[] }>();
    expect(body.code).toBe("unsupported_trigger");
    expect(body.valid).toEqual(["member_activated"]);
  });

  it("with automations_v2 OFF, member_activated still works exactly as before", async () => {
    const h = harness();
    const res = await h.post("/", { name: "Welcome", steps: STEPS });
    expect(res.status).toBe(201);
    const row = await res.json<{ id: string; trigger_event: string; steps_json: string }>();
    expect(row.trigger_event).toBe("member_activated");
    expect(JSON.parse(row.steps_json)).toHaveLength(2);
  });

  it("with automations_v2 ON, accepts every trigger in the catalog", async () => {
    const h = harness({ automations_v2: true });
    for (const trigger of AUTOMATION_TRIGGERS) {
      const res = await h.post("/", { name: `Seq ${trigger}`, trigger_event: trigger, steps: STEPS });
      expect(res.status).toBe(201);
      expect((await res.json<{ trigger_event: string }>()).trigger_event).toBe(trigger);
    }
  });

  it("rejects a trigger that is not in the catalog even when the flag is on", async () => {
    const h = harness({ automations_v2: true });
    const res = await h.post("/", { name: "X", trigger_event: "member_deleted", steps: STEPS });
    expect(res.status).toBe(400);
    expect((await res.json<{ code: string }>()).code).toBe("unsupported_trigger");
  });

  it("still requires a name and at least one usable step", async () => {
    const h = harness();
    expect((await h.post("/", { name: "", steps: STEPS })).status).toBe(400);
    expect((await h.post("/", { name: "X", steps: [] })).status).toBe(400);
    expect((await h.post("/", { name: "X", steps: [{ waitDays: 0, subject: "", bodyHtml: "" }] })).status).toBe(400);
  });

  it("stores steps in the v2 spelling and round-trips conditions and trigger config", async () => {
    const h = harness({ automations_v2: true });
    const res = await h.post("/", {
      name: "Big payers",
      trigger_event: "payment_received",
      steps: STEPS,
      conditions: { min_amount_cents: 5000, junk: 1 },
      trigger_config: { delay_days: 2 },
    });
    expect(res.status).toBe(201);
    const row = await res.json<{
      steps_json: string;
      conditions_json: string;
      trigger_config_json: string;
    }>();
    expect(Object.keys(JSON.parse(row.steps_json)[0]).sort()).toEqual([
      "bodyHtml",
      "subject",
      "waitDays",
    ]);
    expect(JSON.parse(row.conditions_json)).toEqual({ min_amount_cents: 5000 });
    expect(JSON.parse(row.trigger_config_json)).toEqual({ delay_days: 2 });
  });

  it("accepts the legacy delay_days/body_html step spelling", async () => {
    const h = harness();
    const res = await h.post("/", {
      name: "Old client",
      steps: [{ delay_days: 4, subject: "Legacy", body_html: "<p>x</p>" }],
    });
    expect(res.status).toBe(201);
    expect(JSON.parse((await res.json<{ steps_json: string }>()).steps_json)).toEqual([
      { waitDays: 4, subject: "Legacy", bodyHtml: "<p>x</p>" },
    ]);
  });
});

describe("PATCH /:seqId", () => {
  it("updates the name, steps, conditions, trigger config and trigger", async () => {
    const h = harness({ automations_v2: true });
    seedSequence(h.db, { id: "seq-1" });
    const res = await h.patch("/seq-1", {
      name: "Renamed",
      trigger_event: "event_registered",
      steps: [{ waitDays: 1, subject: "New", bodyHtml: "<p>n</p>" }],
      conditions: { event_ids: ["ev-1"] },
      trigger_config: { active_from: "2026-01-01T00:00:00.000Z" },
      is_active: false,
    });
    expect(res.status).toBe(200);
    const row = await res.json<any>();
    expect(row.name).toBe("Renamed");
    expect(row.trigger_event).toBe("event_registered");
    expect(row.is_active).toBe(0);
    expect(JSON.parse(row.conditions_json)).toEqual({ event_ids: ["ev-1"] });
    expect(JSON.parse(row.trigger_config_json)).toEqual({
      active_from: "2026-01-01T00:00:00.000Z",
    });
  });

  it("leaves omitted fields alone", async () => {
    const h = harness({ automations_v2: true });
    seedSequence(h.db, { id: "seq-1", name: "Keep", conditions: { level_ids: ["l1"] } });
    const res = await h.patch("/seq-1", { is_active: false });
    const row = await res.json<any>();
    expect(row.name).toBe("Keep");
    expect(JSON.parse(row.conditions_json)).toEqual({ level_ids: ["l1"] });
    expect(JSON.parse(row.steps_json)).toHaveLength(1);
  });

  it("clears conditions when explicitly set to null", async () => {
    const h = harness({ automations_v2: true });
    seedSequence(h.db, { id: "seq-1", conditions: { level_ids: ["l1"] } });
    const row = await (await h.patch("/seq-1", { conditions: null })).json<any>();
    expect(row.conditions_json).toBeNull();
  });

  it("refuses a trigger change while automations_v2 is off", async () => {
    const h = harness();
    seedSequence(h.db, { id: "seq-1" });
    const res = await h.patch("/seq-1", { trigger_event: "event_ended" });
    expect(res.status).toBe(400);
    expect((await res.json<{ code: string }>()).code).toBe("unsupported_trigger");
  });

  it("404s for another tenant's sequence", async () => {
    const h = harness();
    seedSequence(h.db, { id: "seq-x", tenantId: "tenant-2" });
    expect((await h.patch("/seq-x", { name: "nope" })).status).toBe(404);
    expect((await h.call("/seq-x", { method: "DELETE" })).status).toBe(404);
  });
});

describe("GET /triggers", () => {
  it("offers only member_activated while automations_v2 is off", async () => {
    const h = harness();
    const body = await (await h.call("/triggers")).json<{
      triggers: { value: string; label: string }[];
      automations_v2: boolean;
    }>();
    expect(body.automations_v2).toBe(false);
    expect(body.triggers.map((t) => t.value)).toEqual(["member_activated"]);
  });

  it("offers all six with the flag on, each with a label", async () => {
    const h = harness({ automations_v2: true });
    const body = await (await h.call("/triggers")).json<{
      triggers: { value: string; label: string }[];
    }>();
    expect(body.triggers).toHaveLength(6);
    expect(body.triggers.every((t) => t.label.length > 3)).toBe(true);
  });
});

describe("recipes", () => {
  it("lists the four recipes by default (features.recipes defaults on)", async () => {
    const h = harness();
    const res = await h.call("/recipes");
    expect(res.status).toBe(200);
    const body = await res.json<{ enabled: boolean; recipes: any[] }>();
    expect(body.enabled).toBe(true);
    expect(body.recipes.map((r) => r.id)).toEqual([
      "welcome_series",
      "renewal_ladder",
      "post_event_thank_you",
      "win_back",
    ]);
    expect(body.recipes.every((r) => r.installed === false)).toBe(true);
    expect(body.recipes[0].steps).toBe(3);
  });

  it("reports empty and refuses installs when features.recipes is off", async () => {
    const h = harness({ recipes: false });
    const body = await (await h.call("/recipes")).json<{ enabled: boolean; recipes: any[] }>();
    expect(body.enabled).toBe(false);
    expect(body.recipes).toEqual([]);
    const res = await h.post("/recipes/welcome_series/install", {});
    expect(res.status).toBe(403);
    expect((await res.json<{ code: string }>()).code).toBe("recipes_disabled");
    expect(h.db.rows(`SELECT * FROM automation_sequences`)).toHaveLength(0);
  });

  it("installs a recipe as a real, active, editable sequence", async () => {
    const h = harness();
    const res = await h.post("/recipes/welcome_series/install", {});
    expect(res.status).toBe(201);
    const row = await res.json<any>();
    expect(row.name).toBe("Welcome series");
    expect(row.trigger_event).toBe("member_activated");
    expect(row.is_active).toBe(1);
    expect(JSON.parse(row.steps_json)).toHaveLength(3);
    expect(JSON.parse(row.trigger_config_json).recipe).toBe("welcome_series");
    // active_from is stamped so the install never back-fills old members.
    expect(Date.parse(JSON.parse(row.trigger_config_json).active_from)).toBeGreaterThan(0);

    // ...and it is editable like any other sequence.
    const edited = await h.patch(`/${row.id}`, {
      name: "Our welcome",
      steps: [{ waitDays: 0, subject: "Hi", bodyHtml: "<p>ours</p>" }],
    });
    expect(edited.status).toBe(200);
    const after = await edited.json<any>();
    expect(after.name).toBe("Our welcome");
    expect(JSON.parse(after.steps_json)).toHaveLength(1);
  });

  it("installs a recipe whose trigger is not member_activated even with automations_v2 off", async () => {
    const h = harness();
    const res = await h.post("/recipes/post_event_thank_you/install", {});
    expect(res.status).toBe(201);
    expect((await res.json<any>()).trigger_event).toBe("event_ended");
  });

  it("refuses to install the same recipe twice and marks it installed in the listing", async () => {
    const h = harness();
    expect((await h.post("/recipes/win_back/install", {})).status).toBe(201);
    const again = await h.post("/recipes/win_back/install", {});
    expect(again.status).toBe(409);
    expect((await again.json<{ code: string }>()).code).toBe("already_installed");
    expect(h.db.rows(`SELECT * FROM automation_sequences`)).toHaveLength(1);

    const body = await (await h.call("/recipes")).json<{ recipes: any[] }>();
    expect(body.recipes.find((r) => r.id === "win_back").installed).toBe(true);
    expect(body.recipes.find((r) => r.id === "welcome_series").installed).toBe(false);
  });

  it("404s for an unknown recipe", async () => {
    const h = harness();
    expect((await h.post("/recipes/nope/install", {})).status).toBe(404);
  });
});

describe("GET /:seqId/runs", () => {
  it("lists this sequence's runs, newest first, with the subject", async () => {
    const h = harness();
    seedSequence(h.db, { id: "seq-1" });
    h.db.sqlite
      .prepare(
        `INSERT INTO automation_runs (id, tenant_id, sequence_id, subject_type, subject_id, step, status, scheduled_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run("run-1", TENANT_ID, "seq-1", "member", "m-1", 1, "pending", "2026-09-09T00:00:00Z", "2026-09-01T00:00:00Z");
    const res = await h.call("/seq-1/runs");
    expect(res.status).toBe(200);
    const rows = await res.json<any[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe("m-1");
    expect(rows[0].status).toBe("pending");
  });

  it("404s for another tenant's sequence", async () => {
    const h = harness();
    seedSequence(h.db, { id: "seq-x", tenantId: "tenant-2" });
    expect((await h.call("/seq-x/runs")).status).toBe(404);
  });
});

describe("GET /", () => {
  it("lists this tenant's sequences only", async () => {
    const h = harness();
    seedSequence(h.db, { id: "seq-1" });
    seedSequence(h.db, { id: "seq-2", tenantId: "tenant-2" });
    const rows = await (await h.call("/")).json<any[]>();
    expect(rows.map((r) => r.id)).toEqual(["seq-1"]);
  });
});
