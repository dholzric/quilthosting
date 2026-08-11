import { describe, it, expect } from "vitest";
import { isBusiness, isLaunched } from "./tenantType";

describe("isBusiness", () => {
  it("is true only for tenant_type 'business'", () => {
    expect(isBusiness({ tenant_type: "business" })).toBe(true);
    expect(isBusiness({ tenant_type: "guild" })).toBe(false);
  });

  it("defaults to guild when the column is missing or junk", () => {
    // Rows written before migration 0019, or a bad manual UPDATE.
    expect(isBusiness({ tenant_type: undefined as never })).toBe(false);
    expect(isBusiness({ tenant_type: null as never })).toBe(false);
    expect(isBusiness({ tenant_type: "BUSINESS" as never })).toBe(false);
  });
});

describe("isLaunched", () => {
  it("requires both business type and public_launched=1", () => {
    expect(isLaunched({ tenant_type: "business", public_launched: 1 })).toBe(true);
    expect(isLaunched({ tenant_type: "business", public_launched: 0 })).toBe(false);
    expect(isLaunched({ tenant_type: "guild", public_launched: 1 })).toBe(false);
  });

  it("is false when public_launched is absent", () => {
    expect(isLaunched({ tenant_type: "business", public_launched: undefined as never })).toBe(false);
  });
});
