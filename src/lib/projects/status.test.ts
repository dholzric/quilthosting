import { describe, it, expect } from "vitest";
import { canTransition, assertTransition } from "./status";

describe("status machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("submitted", "estimated")).toBe(true);
    expect(canTransition("estimated", "signed")).toBe(true);
    expect(canTransition("signed", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
  });

  it("allows declining an estimate and cancelling accepted work", () => {
    expect(canTransition("estimated", "declined")).toBe(true);
    expect(canTransition("signed", "cancelled")).toBe(true);
    expect(canTransition("in_progress", "cancelled")).toBe(true);
  });

  it("refuses to skip the signature", () => {
    expect(canTransition("estimated", "in_progress")).toBe(false);
    expect(canTransition("submitted", "signed")).toBe(false);
  });

  it("refuses to move backwards", () => {
    expect(canTransition("signed", "estimated")).toBe(false);
    expect(canTransition("completed", "in_progress")).toBe(false);
  });

  it("treats declined, cancelled and completed as terminal", () => {
    for (const from of ["declined", "cancelled", "completed"] as const) {
      for (const to of ["submitted", "estimated", "signed", "in_progress"] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("allows re-sending an estimate without changing status", () => {
    expect(canTransition("estimated", "estimated")).toBe(true);
  });

  it("assertTransition throws with both states named", () => {
    expect(() => assertTransition("submitted", "completed")).toThrow(
      "Illegal transition: submitted -> completed"
    );
  });
});
