import { describe, it, expect, beforeEach } from "vitest";
import { activeMemberLimitForTenant, FREE_ACTIVE_MEMBER_LIMIT } from "./plans";

// activeMemberLimitForTenant reads plan, trial_ends_at, and tenant_type only.
function tenant(over: Record<string, unknown> = {}) {
  return {
    plan: "free",
    trial_ends_at: null,
    tenant_type: "guild",
    ...over,
  } as never;
}

describe("activeMemberLimitForTenant", () => {
  it("caps a free guild at the free limit", () => {
    expect(activeMemberLimitForTenant(tenant())).toBe(FREE_ACTIVE_MEMBER_LIMIT);
  });

  it("returns null (uncapped) for a free business tenant", () => {
    // A business's 'members' are its customers. Capping them at 30 would cap
    // the customer list of a paying site.
    expect(activeMemberLimitForTenant(tenant({ tenant_type: "business" }))).toBeNull();
  });

  it("still returns null for a paid guild", () => {
    expect(activeMemberLimitForTenant(tenant({ plan: "starter" }))).toBeNull();
  });
});

/* ————————————————— The cap counts PEOPLE (spec §4.2) —————————————————
 *
 * "30 active members" has to mean thirty people. A household of three is
 * three, not one — otherwise a guild of ninety sits on the free plan behind
 * thirty household levels and the pricing promise means nothing.
 */
import { countActiveMembers, assertCanActivateMember } from "./plans";
import {
  createHouseholdTestDb,
  seedMember,
  seedMembership,
  seedTenant,
  type HouseholdTestDb,
} from "./householdTestDb";

function household(db: HouseholdTestDb, id: string, payer: string, others: string[]) {
  db.run(
    `INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at)
     VALUES (?, 'tenant-1', 'House', ?, '', '')`,
    id,
    payer
  );
  db.run(
    `INSERT INTO household_members (household_id, member_id, role, added_at) VALUES (?, ?, 'payer', '')`,
    id,
    payer
  );
  for (const o of others) {
    db.run(
      `INSERT INTO household_members (household_id, member_id, role, added_at) VALUES (?, ?, 'member', '')`,
      id,
      o
    );
  }
}

describe("countActiveMembers", () => {
  let db: HouseholdTestDb;
  beforeEach(() => {
    db = createHouseholdTestDb();
    seedTenant(db);
  });

  it("counts an ordinary roster exactly as before", async () => {
    seedMember(db, { id: "a", email: "a@x.test", status: "active" });
    seedMember(db, { id: "b", email: "b@x.test", status: "lapsed" });
    seedMember(db, { id: "c", email: "c@x.test", status: "pending" });
    expect(await countActiveMembers(db, "tenant-1")).toBe(1);
  });

  it("counts a household of three as three", async () => {
    seedMember(db, { id: "payer", email: "p@x.test", status: "active" });
    seedMember(db, { id: "spouse", email: "s@x.test", status: "pending" });
    seedMember(db, { id: "kid", email: "k@x.test", status: "pending" });
    seedMembership(db, { id: "ms", member_id: "payer" });
    household(db, "h1", "payer", ["spouse", "kid"]);
    expect(await countActiveMembers(db, "tenant-1")).toBe(3);
  });

  it("stops counting a household whose payer lapsed", async () => {
    seedMember(db, { id: "payer", email: "p@x.test", status: "lapsed" });
    seedMember(db, { id: "spouse", email: "s@x.test", status: "active" });
    seedMembership(db, { id: "ms", member_id: "payer", status: "expired" });
    household(db, "h1", "payer", ["spouse"]);
    expect(await countActiveMembers(db, "tenant-1")).toBe(0);
  });

  it("never counts another tenant's household", async () => {
    seedMember(db, { id: "other", tenant_id: "tenant-2", email: "o@x.test", status: "active" });
    expect(await countActiveMembers(db, "tenant-1")).toBe(0);
  });
});

describe("assertCanActivateMember", () => {
  let db: HouseholdTestDb;
  const freeGuild = {
    id: "tenant-1",
    plan: "free",
    trial_ends_at: null,
    stripe_subscription_id: null,
  } as never;

  beforeEach(() => {
    db = createHouseholdTestDb();
    seedTenant(db);
  });

  it("does not spend a slot on a household member who is already covered", async () => {
    // Fill the plan to the brim with ordinary members...
    for (let i = 0; i < FREE_ACTIVE_MEMBER_LIMIT; i++) {
      seedMember(db, { id: `m${i}`, email: `m${i}@x.test`, status: "active" });
    }
    seedMember(db, { id: "payer", email: "p@x.test", status: "active" });
    seedMember(db, { id: "spouse", email: "s@x.test", status: "pending" });
    seedMembership(db, { id: "ms", member_id: "payer" });
    household(db, "h1", "payer", ["spouse"]);

    // The spouse already counts, so renewing/activating her is free...
    await expect(assertCanActivateMember(db, freeGuild, "spouse")).resolves.toBeUndefined();
    // ...but a brand-new person is over the line.
    await expect(assertCanActivateMember(db, freeGuild, null)).rejects.toThrow(/limited to/);
  });
});
