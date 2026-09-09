/**
 * Admin Members screen: the household column, the household mates on the
 * member detail, and the move-in / move-out actions.
 *
 * These dispatch through the real Hono app against a real in-memory SQLite
 * (src/lib/householdTestDb.ts) rather than a SQL-shape fake, because what is
 * being asserted is the ANSWER — "does the roster call the spouse a member
 * now that the payer lapsed?" — and a fake would answer whatever it was told.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { memberRoutes } from "./members";
import {
  createHouseholdTestDb,
  seedLevel,
  seedMember,
  seedMembership,
  seedTenant,
  type HouseholdTestDb,
} from "../lib/householdTestDb";

const TENANT_ID = "tenant-1";

let db: HouseholdTestDb;
let app: Hono<{ Bindings: Env }>;

function mount() {
  const tenant = db.rows("SELECT * FROM tenants WHERE id = ?", TENANT_ID)[0];
  const a = new Hono<{ Bindings: Env }>();
  a.use("*", async (c, next) => {
    // Stands in for tenantMiddleware + requireAuth, which are not what these
    // tests are about.
    (c as unknown as { set(k: string, v: unknown): void }).set("tenant", tenant);
    (c as unknown as { set(k: string, v: unknown): void }).set("user", {
      id: "u1",
      email: "officer@example.test",
    });
    await next();
  });
  a.route("/members", memberRoutes as never);
  return a;
}

function req(path: string, init?: RequestInit) {
  return app.request(`http://x${path}`, init, { DB: db } as unknown as Env);
}

beforeEach(() => {
  db = createHouseholdTestDb();
  seedTenant(db);
  seedLevel(db, { id: "level-household", household_max: 2, household_add_cents: 1500 });
  app = mount();
});

describe("GET /members — the roster", () => {
  it("carries the household and the DERIVED membership answer", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test", last_name: "Alvarez" });
    seedMember(db, { id: "spouse", email: "spouse@example.test", last_name: "Alvarez", status: "pending" });
    seedMember(db, { id: "solo", email: "solo@example.test", last_name: "Zed" });
    seedMembership(db, { id: "ms-payer", member_id: "payer", level_id: "level-household" });
    db.run(
      "INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at) VALUES ('h1', ?, 'The Alvarez household', 'payer', '', '')",
      TENANT_ID
    );
    db.run(
      "INSERT INTO household_members (household_id, member_id, role, added_at) VALUES ('h1', 'payer', 'payer', ''), ('h1', 'spouse', 'member', '')"
    );

    const res = await req("/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{ id: string; household: { name: string; role: string } | null; is_active_member: boolean }>;
    };
    const byId = Object.fromEntries(body.members.map((m) => [m.id, m]));

    expect(byId.payer.household).toMatchObject({ name: "The Alvarez household", role: "payer" });
    expect(byId.spouse.household).toMatchObject({ name: "The Alvarez household", role: "member" });
    expect(byId.solo.household).toBeNull();

    // The spouse's own members.status is 'pending' and she is still a member:
    // the payment covers her. That is the whole point of the household level.
    expect(byId.spouse.is_active_member).toBe(true);
    expect(byId.payer.is_active_member).toBe(true);
    expect(byId.solo.is_active_member).toBe(true); // active member row, no household
  });

  it("stops calling the spouse a member when the payer's membership ends", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test" });
    seedMember(db, { id: "spouse", email: "spouse@example.test" });
    seedMembership(db, { id: "ms-payer", member_id: "payer", status: "expired" });
    db.run(
      "INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at) VALUES ('h1', ?, 'House', 'payer', '', '')",
      TENANT_ID
    );
    db.run(
      "INSERT INTO household_members (household_id, member_id, role, added_at) VALUES ('h1', 'payer', 'payer', ''), ('h1', 'spouse', 'member', '')"
    );
    const body = (await (await req("/members")).json()) as {
      members: Array<{ id: string; is_active_member: boolean }>;
    };
    const byId = Object.fromEntries(body.members.map((m) => [m.id, m]));
    expect(byId.spouse.is_active_member).toBe(false);
  });
});

describe("GET /members/households", () => {
  it("lists every household with its payer and headcount", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test", first_name: "Jane", last_name: "Alvarez" });
    seedMember(db, { id: "spouse", email: "spouse@example.test" });
    db.run(
      "INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at) VALUES ('h1', ?, 'The Alvarez household', 'payer', '', '')",
      TENANT_ID
    );
    db.run(
      "INSERT INTO household_members (household_id, member_id, role, added_at) VALUES ('h1', 'payer', 'payer', ''), ('h1', 'spouse', 'member', '')"
    );
    const res = await req("/members/households");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { households: Array<Record<string, unknown>> };
    expect(body.households).toHaveLength(1);
    expect(body.households[0]).toMatchObject({
      id: "h1",
      name: "The Alvarez household",
      payer_first_name: "Jane",
      people: 2,
    });
  });

  it("is not swallowed by the /:memberId route", async () => {
    const res = await req("/members/households");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ households: [] });
  });
});

describe("GET /members/:memberId — household mates on the detail", () => {
  it("names everyone the one payment covers, payer first", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test", first_name: "Jane" });
    seedMember(db, { id: "spouse", email: "spouse@example.test", first_name: "Dana" });
    db.run(
      "INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at) VALUES ('h1', ?, 'House', 'payer', '', '')",
      TENANT_ID
    );
    db.run(
      "INSERT INTO household_members (household_id, member_id, role, added_at) VALUES ('h1', 'payer', 'payer', ''), ('h1', 'spouse', 'member', '')"
    );
    const body = (await (await req("/members/spouse")).json()) as {
      id: string;
      household: { name: string; payer_member_id: string; members: Array<{ id: string; role: string }> };
    };
    expect(body.id).toBe("spouse");
    expect(body.household.payer_member_id).toBe("payer");
    expect(body.household.members.map((m) => m.id)).toEqual(["payer", "spouse"]);
  });

  it("returns household: null for someone in none", async () => {
    seedMember(db, { id: "solo", email: "solo@example.test" });
    const body = (await (await req("/members/solo")).json()) as { household: unknown };
    expect(body.household).toBeNull();
  });
});

describe("POST /members/:memberId/household — move in", () => {
  it("starts a new household with this member as the payer", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test", last_name: "Alvarez" });
    const res = await req("/members/payer/household", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { household: { name: string; payer_member_id: string } };
    expect(body.household.payer_member_id).toBe("payer");
    expect(body.household.name).toBe("Alvarez household");
  });

  it("joins an existing household", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test" });
    seedMember(db, { id: "newcomer", email: "newcomer@example.test", status: "pending" });
    seedMembership(db, { id: "ms-payer", member_id: "payer" });
    db.run(
      "INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at) VALUES ('h1', ?, 'House', 'payer', '', '')",
      TENANT_ID
    );
    db.run(
      "INSERT INTO household_members (household_id, member_id, role, added_at) VALUES ('h1', 'payer', 'payer', '')"
    );
    const res = await req("/members/newcomer/household", {
      method: "POST",
      body: JSON.stringify({ household_id: "h1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { household: { id: string } };
    expect(body.household.id).toBe("h1");
    // Derived: the newcomer is now covered by the payer's membership.
    const roster = (await (await req("/members")).json()) as {
      members: Array<{ id: string; is_active_member: boolean }>;
    };
    expect(roster.members.find((m) => m.id === "newcomer")?.is_active_member).toBe(true);
  });

  it("refuses to put one person in two households", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test" });
    seedMember(db, { id: "dana", email: "dana@example.test" });
    db.run(
      "INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at) VALUES ('h1', ?, 'One', 'payer', '', '')",
      TENANT_ID
    );
    db.run(
      "INSERT INTO household_members (household_id, member_id, role, added_at) VALUES ('h1', 'payer', 'payer', ''), ('h1', 'dana', 'member', '')"
    );
    const res = await req("/members/dana/household", {
      method: "POST",
      body: JSON.stringify({ name: "Two" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "already_in_household" });
  });

  it("404s for a member of another tenant", async () => {
    seedMember(db, { id: "outsider", tenant_id: "tenant-2", email: "out@example.test" });
    const res = await req("/members/outsider/household", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /members/:memberId/household — move out", () => {
  it("ends the derived membership and keeps the person", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test" });
    seedMember(db, { id: "spouse", email: "spouse@example.test" });
    seedMembership(db, { id: "ms-payer", member_id: "payer" });
    db.run(
      "INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at) VALUES ('h1', ?, 'House', 'payer', '', '')",
      TENANT_ID
    );
    db.run(
      "INSERT INTO household_members (household_id, member_id, role, added_at) VALUES ('h1', 'payer', 'payer', ''), ('h1', 'spouse', 'member', '')"
    );

    const res = await req("/members/spouse/household", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dissolved: false });

    // Still on the roster...
    const roster = (await (await req("/members")).json()) as {
      members: Array<{ id: string; status: string; household: unknown; is_active_member: boolean }>;
    };
    const spouse = roster.members.find((m) => m.id === "spouse");
    expect(spouse).toBeTruthy();
    // ...but no longer a member off someone else's payment.
    expect(spouse?.household).toBeNull();
    expect(spouse?.status).toBe("lapsed");
    expect(spouse?.is_active_member).toBe(false);
    // The payer is untouched.
    expect(roster.members.find((m) => m.id === "payer")?.is_active_member).toBe(true);
  });

  it("dissolves the household when the payer moves out", async () => {
    seedMember(db, { id: "payer", email: "payer@example.test" });
    seedMember(db, { id: "spouse", email: "spouse@example.test" });
    seedMembership(db, { id: "ms-payer", member_id: "payer", household_id: "h1" });
    db.run(
      "INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at) VALUES ('h1', ?, 'House', 'payer', '', '')",
      TENANT_ID
    );
    db.run(
      "INSERT INTO household_members (household_id, member_id, role, added_at) VALUES ('h1', 'payer', 'payer', ''), ('h1', 'spouse', 'member', '')"
    );
    const res = await req("/members/payer/household", { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true, dissolved: true });
    expect(db.rows("SELECT * FROM households")).toHaveLength(0);
    expect(db.rows("SELECT * FROM household_members")).toHaveLength(0);
    expect(db.rows("SELECT * FROM members")).toHaveLength(2);
  });

  it("404s when the member is in no household", async () => {
    seedMember(db, { id: "solo", email: "solo@example.test" });
    const res = await req("/members/solo/household", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
