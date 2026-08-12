import { describe, it, expect } from "vitest";
import { canTransition, assertTransition } from "./status";
import type { ProjectStatus } from "./types";

// Record<ProjectStatus, true> forces this list to be updated (a TS compile
// error, not a silently-passing test) the moment ProjectStatus gains or
// loses a member — that's the whole point: the "terminal" test below must
// not be able to miss a state.
const ALL_STATUSES_MAP: Record<ProjectStatus, true> = {
  submitted: true,
  estimated: true,
  signed: true,
  in_progress: true,
  completed: true,
  declined: true,
  cancelled: true,
};
const ALL_STATUSES = Object.keys(ALL_STATUSES_MAP) as ProjectStatus[];

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
    expect(canTransition("submitted", "in_progress")).toBe(false);
    expect(canTransition("signed", "completed")).toBe(false);
    expect(canTransition("estimated", "completed")).toBe(false);
  });

  it("refuses to move backwards", () => {
    expect(canTransition("signed", "estimated")).toBe(false);
    expect(canTransition("completed", "in_progress")).toBe(false);
  });

  it("treats declined, cancelled and completed as terminal", () => {
    // Checked against EVERY status, including each other and themselves —
    // not just the four forward/non-terminal states — so a future edit
    // that lets one terminal state slide into another (e.g. declined ->
    // cancelled) is caught here too.
    for (const from of ["declined", "cancelled", "completed"] as const) {
      for (const to of ALL_STATUSES) {
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
