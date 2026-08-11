import { describe, it, expect } from "vitest";
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
