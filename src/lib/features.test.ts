// src/lib/features.test.ts
//
// The two per-tenant switches (phase 3, Task A). `settings.ui.advanced`
// hides screens, `settings.features` hides machinery. Both are read from the
// tenant's settings_json, both fail safe: anything unparsable, missing, or of
// the wrong shape reads as the default, and the default for every feature is
// OFF except `recipes` (which replaces behavior that is already hardcoded
// today, so turning it "on by default" changes nothing for an existing guild).
import { describe, it, expect } from "vitest";
import {
  FEATURE_KEYS,
  FEATURE_DEFAULTS,
  FEATURE_CATALOG,
  FEATURE_GROUPS,
  readUi,
  readFeatures,
  hasFeature,
  uiSchema,
  featuresSchema,
  type FeatureKey,
} from "./features";

describe("FEATURE_DEFAULTS", () => {
  it("has exactly the 13 documented keys", () => {
    expect([...FEATURE_KEYS].sort()).toEqual(
      [
        "automations_v2",
        "bom",
        "coupons",
        "digital_goods",
        "gifting",
        "installments",
        "library",
        "polls",
        "quilt_show",
        "recipes",
        "sample_data",
        "waivers",
      ].sort()
    );
    expect(Object.keys(FEATURE_DEFAULTS).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it("turns only `recipes` on", () => {
    const on = FEATURE_KEYS.filter((k) => FEATURE_DEFAULTS[k]);
    expect(on).toEqual(["recipes"]);
  });
});

describe("FEATURE_CATALOG", () => {
  it("describes every key exactly once", () => {
    expect(FEATURE_CATALOG.map((f) => f.key).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it("uses only the three documented groups and a one-sentence consequence", () => {
    for (const f of FEATURE_CATALOG) {
      expect(FEATURE_GROUPS).toContain(f.group);
      expect(f.label.length).toBeGreaterThan(2);
      // Plain language, one sentence, ends in a period -- this is the text a
      // volunteer officer reads next to the switch.
      expect(f.consequence.trim().endsWith(".")).toBe(true);
      expect(f.consequence.length).toBeGreaterThan(20);
    }
  });

  it("is ordered by group so the Settings screen can render it straight through", () => {
    const seen: string[] = [];
    for (const f of FEATURE_CATALOG) {
      if (seen[seen.length - 1] !== f.group) seen.push(f.group);
    }
    expect(seen).toEqual([...new Set(seen)]);
  });
});

describe("readUi", () => {
  it("defaults to advanced === false", () => {
    expect(readUi(null)).toEqual({ advanced: false });
    expect(readUi(undefined)).toEqual({ advanced: false });
    expect(readUi("")).toEqual({ advanced: false });
    expect(readUi("{}")).toEqual({ advanced: false });
    expect(readUi('{"ui":{}}')).toEqual({ advanced: false });
  });

  it("reads an explicit true", () => {
    expect(readUi('{"ui":{"advanced":true}}')).toEqual({ advanced: true });
    expect(readUi('{"ui":{"advanced":false}}')).toEqual({ advanced: false });
  });

  it("ignores malformed JSON and non-boolean values", () => {
    expect(readUi("{nope")).toEqual({ advanced: false });
    expect(readUi("[1,2]")).toEqual({ advanced: false });
    expect(readUi('{"ui":"yes"}')).toEqual({ advanced: false });
    expect(readUi('{"ui":{"advanced":"yes"}}')).toEqual({ advanced: false });
    expect(readUi('{"ui":{"advanced":1}}')).toEqual({ advanced: false });
  });
});

describe("readFeatures", () => {
  it("returns the defaults for a tenant that never touched the switches", () => {
    expect(readFeatures(null)).toEqual(FEATURE_DEFAULTS);
    expect(readFeatures("{}")).toEqual(FEATURE_DEFAULTS);
    expect(readFeatures('{"features":{}}')).toEqual(FEATURE_DEFAULTS);
  });

  it("applies explicit booleans, including turning recipes off", () => {
    const f = readFeatures('{"features":{"waivers":true,"recipes":false}}');
    expect(f.waivers).toBe(true);
    expect(f.recipes).toBe(false);
    expect(f.bom).toBe(false);
  });

  it("ignores unknown keys and non-boolean values", () => {
    const f = readFeatures('{"features":{"teleport":true,"waivers":"yes","bom":1}}');
    expect(f).toEqual(FEATURE_DEFAULTS);
    expect((f as Record<string, unknown>).teleport).toBeUndefined();
  });

  it("falls back to defaults on malformed settings", () => {
    expect(readFeatures("{nope")).toEqual(FEATURE_DEFAULTS);
    expect(readFeatures('{"features":[1,2]}')).toEqual(FEATURE_DEFAULTS);
  });
});

describe("hasFeature", () => {
  it("is the defaults for an untouched tenant", () => {
    expect(hasFeature(null, "recipes")).toBe(true);
    expect(hasFeature(null, "waivers")).toBe(false);
  });

  it("honors an explicit switch either way", () => {
    expect(hasFeature('{"features":{"waivers":true}}', "waivers")).toBe(true);
    expect(hasFeature('{"features":{"recipes":false}}', "recipes")).toBe(false);
  });
});

describe("uiSchema", () => {
  it("accepts a boolean advanced", () => {
    expect(uiSchema.safeParse({ advanced: true }).success).toBe(true);
    expect(uiSchema.safeParse({ advanced: false }).success).toBe(true);
  });

  it("rejects junk", () => {
    expect(uiSchema.safeParse({ advanced: "yes" }).success).toBe(false);
    expect(uiSchema.safeParse({ advanced: 1 }).success).toBe(false);
    expect(uiSchema.safeParse("advanced").success).toBe(false);
    expect(uiSchema.safeParse(null).success).toBe(false);
    expect(uiSchema.safeParse([]).success).toBe(false);
  });
});

describe("featuresSchema", () => {
  it("accepts an empty object and any subset of known booleans", () => {
    expect(featuresSchema.safeParse({}).success).toBe(true);
    const r = featuresSchema.safeParse({ waivers: true, recipes: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ waivers: true, recipes: false });
  });

  it("rejects non-boolean values and non-objects", () => {
    expect(featuresSchema.safeParse({ waivers: "yes" }).success).toBe(false);
    expect(featuresSchema.safeParse({ bom: 1 }).success).toBe(false);
    expect(featuresSchema.safeParse("waivers").success).toBe(false);
    expect(featuresSchema.safeParse(null).success).toBe(false);
  });

  it("drops unknown keys rather than failing (a stale key can't wedge a save)", () => {
    const r = featuresSchema.safeParse({ teleport: true, waivers: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ waivers: true });
      expect((r.data as Record<string, unknown>).teleport).toBeUndefined();
    }
  });

  it("every catalog key is accepted by the schema", () => {
    const all: Record<string, boolean> = {};
    for (const k of FEATURE_KEYS) all[k as FeatureKey] = true;
    const r = featuresSchema.safeParse(all);
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data).sort()).toEqual([...FEATURE_KEYS].sort());
  });
});
