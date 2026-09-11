import { describe, expect, it } from "vitest";
import { resolveComposition } from "./signature";

describe("resolveComposition", () => {
  it("uses an explicit composition before the installed kit fallback", () => {
    expect(resolveComposition("journal", "indigo-house")).toBe("journal");
    expect(resolveComposition("classic", "indigo-house")).toBe("classic");
  });

  it("keeps existing signature kits styled when no explicit choice is stored", () => {
    expect(resolveComposition(undefined, "indigo-house")).toBe("cinema");
    expect(resolveComposition(undefined, "weekend-house")).toBe("destination");
  });

  it("falls back safely for unknown values", () => {
    expect(resolveComposition(undefined, "unknown-kit")).toBe("classic");
    expect(resolveComposition("parallax", "indigo-house")).toBe("cinema");
  });
});
