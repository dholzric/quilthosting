import { describe, it, expect } from "vitest";
import { buildReference } from "./reference";

describe("buildReference", () => {
  it("uses the owner-configured prefix when present", () => {
    expect(buildReference("SSQ", "stitchstudio", 42)).toBe("SSQ-0042");
  });

  it("falls back to the first three alphanumerics of the slug, uppercased, when no prefix is set", () => {
    expect(buildReference(undefined, "stitchstudio", 7)).toBe("STI-0007");
  });

  it("falls back to QP when both prefix and slug are empty", () => {
    expect(buildReference("", "", 1)).toBe("QP-0001");
  });

  it("strips non-alphanumerics from a configured prefix", () => {
    expect(buildReference("s-s q!", "x", 5)).toBe("SSQ-0005");
  });

  it("caps the prefix at 6 characters", () => {
    expect(buildReference("ABCDEFGH", "x", 1)).toBe("ABCDEF-0001");
  });

  it("pads the number to 4 digits and does not truncate past 4", () => {
    expect(buildReference("A", "x", 12345)).toBe("A-12345");
  });
});
