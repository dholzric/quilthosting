// src/lib/eventBring.test.ts
//
// "What to bring" — asked for by a guild officer: a class is not the same as a
// meeting, and a member who turns up to a workshop without their machine has
// wasted the afternoon. Stored in events.settings_json alongside the
// registration questions, shown on the event page and in the reminder email.
import { describe, it, expect } from "vitest";
import { normalizeBring, parseEventSettings, BRING_ITEM_MAX, BRING_MAX_ITEMS } from "./eventQuestions";

describe("normalizeBring", () => {
  it("keeps a plain list in order", () => {
    expect(normalizeBring(["Sewing machine", "Rotary cutter", "Fabric"]))
      .toEqual(["Sewing machine", "Rotary cutter", "Fabric"]);
  });

  it("trims, collapses runs of space, and drops blanks", () => {
    expect(normalizeBring(["  Sewing   machine ", "", "   ", "Thread"]))
      .toEqual(["Sewing machine", "Thread"]);
  });

  it("drops duplicates without caring about case", () => {
    expect(normalizeBring(["Thread", "thread", "THREAD"])).toEqual(["Thread"]);
  });

  it("survives the shapes a hand-edited blob can hold", () => {
    expect(normalizeBring(null)).toEqual([]);
    expect(normalizeBring("machine")).toEqual([]);
    expect(normalizeBring([null, undefined, 42, {}])).toEqual(["42", "[object Object]"]);
  });

  it("caps a runaway line and a runaway list", () => {
    expect(normalizeBring(["x".repeat(500)])[0]).toHaveLength(BRING_ITEM_MAX);
    const many = Array.from({ length: 60 }, (_, i) => `item ${i}`);
    expect(normalizeBring(many)).toHaveLength(BRING_MAX_ITEMS);
  });

  it("reads back out of a settings blob, and tolerates one without it", () => {
    const withList = parseEventSettings(JSON.stringify({ questions: [], bring: ["Machine"] }));
    expect(normalizeBring(withList.bring)).toEqual(["Machine"]);
    expect(normalizeBring(parseEventSettings('{"questions":[]}').bring)).toEqual([]);
    expect(normalizeBring(parseEventSettings("not json").bring)).toEqual([]);
  });
});
