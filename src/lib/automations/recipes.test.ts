// src/lib/automations/recipes.test.ts
// The four recipes the plan names, and the guarantee that installing one
// produces an ordinary editable sequence rather than a special object.
import { describe, it, expect } from "vitest";
import { RECIPES, RECIPE_IDS, findRecipe, recipeToSequence } from "./recipes";
import { parseSteps, serializeSteps } from "./steps";
import { TRIGGERS } from "./triggers";

describe("RECIPES", () => {
  it("ships exactly the four the plan names", () => {
    expect(RECIPES.map((r) => r.id)).toEqual([
      "welcome_series",
      "renewal_ladder",
      "post_event_thank_you",
      "win_back",
    ]);
    expect([...RECIPE_IDS]).toEqual(RECIPES.map((r) => r.id));
  });

  it("every recipe has a name, one-sentence description, a real trigger and steps", () => {
    for (const r of RECIPES) {
      expect(r.name.length).toBeGreaterThan(2);
      expect(r.description.length).toBeGreaterThan(20);
      expect(TRIGGERS as readonly string[]).toContain(r.trigger);
      expect(r.steps.length).toBeGreaterThan(0);
    }
  });

  it("every step survives parseSteps unchanged (subject + body, sane wait)", () => {
    for (const r of RECIPES) {
      const parsed = parseSteps(JSON.stringify(r.steps));
      expect(parsed).toHaveLength(r.steps.length);
      parsed.forEach((s, i) => {
        expect(s.subject).toBe(r.steps[i].subject);
        expect(s.bodyHtml).toBe(r.steps[i].bodyHtml);
        expect(s.waitDays).toBe(r.steps[i].waitDays);
        expect(s.waitDays).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it("uses only merge fields that resolve for every subject type", () => {
    const allowed = new Set(["first_name", "last_name", "email", "guild_name"]);
    for (const r of RECIPES) {
      for (const s of r.steps) {
        const fields = [...`${s.subject} ${s.bodyHtml}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)];
        for (const [, name] of fields) expect(allowed).toContain(name);
      }
    }
  });

  it("waits are non-decreasing so a series never sends out of order", () => {
    for (const r of RECIPES) {
      // Step 0's wait is measured from the trigger, later steps from the
      // previous send, so each is just a positive gap.
      r.steps.slice(1).forEach((s) => expect(s.waitDays).toBeGreaterThan(0));
    }
  });

  it("findRecipe returns null for anything unknown", () => {
    expect(findRecipe("welcome_series")?.name).toBe("Welcome series");
    expect(findRecipe("nope")).toBeNull();
    expect(findRecipe("")).toBeNull();
  });
});

describe("recipeToSequence", () => {
  it("produces the row body of a plain, editable sequence", () => {
    const now = "2026-09-08T12:00:00.000Z";
    const seq = recipeToSequence(findRecipe("welcome_series")!, now);
    expect(seq.name).toBe("Welcome series");
    expect(seq.trigger_event).toBe("member_activated");
    expect(seq.conditions).toBeNull();
    expect(seq.trigger_config).toEqual({ recipe: "welcome_series", active_from: now });
    expect(seq.steps).toHaveLength(3);
  });

  it("serializes to the v2 step spelling only", () => {
    const seq = recipeToSequence(findRecipe("post_event_thank_you")!);
    const stored = JSON.parse(serializeSteps(seq.steps));
    expect(Object.keys(stored[0]).sort()).toEqual(["bodyHtml", "subject", "waitDays"]);
    // ...and reads back identically, which is what makes it editable.
    expect(parseSteps(JSON.stringify(stored))).toEqual(seq.steps);
  });

  it("stamps active_from at install time so nothing back-fills", () => {
    const before = Date.now();
    const seq = recipeToSequence(findRecipe("win_back")!);
    expect(Date.parse(seq.trigger_config.active_from)).toBeGreaterThanOrEqual(before - 1000);
  });
});
