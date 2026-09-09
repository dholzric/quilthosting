// src/lib/features.ts
//
// The two per-tenant switches (phase 3, Task A):
//
//   settings.ui.advanced  -- boolean, default false. Hides SCREENS, never
//                            capability: everything an officer could do in
//                            Simple mode she can still do, and Advanced only
//                            adds. Nothing here is ever gated by plan tier;
//                            the only paywall stays the free 30-member cap in
//                            src/lib/plans.ts.
//   settings.features     -- JSON booleans for capabilities that add real
//                            machinery (a builder, a module, a new checkout
//                            path). Default OFF for all of them except
//                            `recipes`, which replaces behavior that is
//                            already hardcoded today, so "on" changes nothing
//                            for an existing guild.
//
// Both readers fail safe: unparsable JSON, a missing key, or a value of the
// wrong type all read as the default. A missing feature key means off.
import { z } from "zod";

export type FeatureKey =
  | "recipes"
  | "automations_v2"
  | "sample_data"
  | "waivers"
  | "installments"
  | "digital_goods"
  | "coupons"
  | "library"
  | "bom"
  | "quilt_show"
  | "polls"
  | "gifting";

export const FEATURE_KEYS: readonly FeatureKey[] = [
  "recipes",
  "automations_v2",
  "sample_data",
  "waivers",
  "installments",
  "digital_goods",
  "coupons",
  "library",
  "bom",
  "quilt_show",
  "polls",
  "gifting",
];

/** Only `recipes` ships on. Everything else is opt-in, per tenant. */
export const FEATURE_DEFAULTS: Record<FeatureKey, boolean> = {
  recipes: true,
  automations_v2: false,
  sample_data: false,
  waivers: false,
  installments: false,
  digital_goods: false,
  coupons: false,
  library: false,
  bom: false,
  quilt_show: false,
  polls: false,
  gifting: false,
};

export type FeatureGroup = "Power tools" | "Money" | "Community";

export const FEATURE_GROUPS: readonly FeatureGroup[] = ["Power tools", "Money", "Community"];

export type FeatureMeta = {
  key: FeatureKey;
  label: string;
  /** One plain sentence: what actually appears when this is on. */
  consequence: string;
  group: FeatureGroup;
};

/**
 * The Settings -> Advanced screen renders this straight through, in order.
 * Wording rule: say what the officer will SEE, not what we built.
 */
export const FEATURE_CATALOG: FeatureMeta[] = [
  {
    key: "recipes",
    label: "Automation recipes",
    consequence:
      "Adds one-click email sequences — welcome, renewal ladder, post-event thank-you — that you can edit afterwards.",
    group: "Power tools",
  },
  {
    key: "automations_v2",
    label: "Automation builder",
    consequence:
      "Adds a step-by-step builder for your own automations: pick a trigger, wait a few days, send an email.",
    group: "Power tools",
  },
  {
    key: "sample_data",
    label: "Sample data",
    consequence:
      "Fills your guild with a few example members, events and payments so you can try everything before your real data arrives.",
    group: "Power tools",
  },
  {
    key: "installments",
    label: "Deposits and installments",
    consequence:
      "Lets a retreat or workshop take a deposit at checkout and charge the balance closer to the date.",
    group: "Money",
  },
  {
    key: "digital_goods",
    label: "Digital downloads",
    consequence:
      "Lets a store product deliver a pattern PDF or other file that buyers can re-download from their portal.",
    group: "Money",
  },
  {
    key: "coupons",
    label: "Coupons and gift cards",
    consequence:
      "Adds discount codes with expiry dates and usage limits, and gift-card products that mint a code.",
    group: "Money",
  },
  {
    key: "gifting",
    label: "Gift memberships",
    consequence:
      "Lets one person buy a membership for someone else, who claims it from an emailed link.",
    group: "Money",
  },
  {
    key: "waivers",
    label: "Event waivers",
    consequence:
      "Adds a liability waiver members must accept when they register, stored with the registration and shown on their receipt.",
    group: "Community",
  },
  {
    key: "library",
    label: "Lending library",
    consequence:
      "Adds a catalog of books, rulers and dies members can borrow, with due dates and overdue reminders.",
    group: "Community",
  },
  {
    key: "bom",
    label: "Block of the Month",
    consequence:
      "Adds monthly block releases, a finished-block gallery and per-member progress for a Block of the Month program.",
    group: "Community",
  },
  {
    key: "quilt_show",
    label: "Quilt show",
    consequence:
      "Adds show entries with categories and fees, acceptance status entrants can see, and a vendor booth registry.",
    group: "Community",
  },
  {
    key: "polls",
    label: "Member polls",
    consequence:
      "Adds short polls in the member portal so your board can ask a question and see the answers.",
    group: "Community",
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseSettings(settingsJson: string | null | undefined): Record<string, unknown> | null {
  if (!settingsJson) return null;
  try {
    const parsed: unknown = JSON.parse(settingsJson);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** settings.ui, defaulted. Anything but an explicit `true` is Simple mode. */
export function readUi(settingsJson: string | null | undefined): { advanced: boolean } {
  const ui = parseSettings(settingsJson)?.ui;
  return { advanced: isRecord(ui) && ui.advanced === true };
}

/** settings.features merged over the defaults. Unknown keys are ignored. */
export function readFeatures(settingsJson: string | null | undefined): Record<FeatureKey, boolean> {
  const out = { ...FEATURE_DEFAULTS };
  const f = parseSettings(settingsJson)?.features;
  if (!isRecord(f)) return out;
  for (const key of FEATURE_KEYS) {
    if (typeof f[key] === "boolean") out[key] = f[key] as boolean;
  }
  return out;
}

export function hasFeature(settingsJson: string | null | undefined, key: FeatureKey): boolean {
  return readFeatures(settingsJson)[key] === true;
}

/** PATCH /api/tenants/:id validation for settings.ui. */
export const uiSchema: z.ZodType<{ advanced: boolean }> = z.object({
  advanced: z.boolean(),
});

/**
 * PATCH validation for settings.features. Values must be booleans; unknown
 * keys are dropped rather than rejected, so a stale key left in a tenant's
 * settings can never wedge an otherwise valid save.
 */
export const featuresSchema: z.ZodType<Partial<Record<FeatureKey, boolean>>> = z.object({
  recipes: z.boolean().optional(),
  automations_v2: z.boolean().optional(),
  sample_data: z.boolean().optional(),
  waivers: z.boolean().optional(),
  installments: z.boolean().optional(),
  digital_goods: z.boolean().optional(),
  coupons: z.boolean().optional(),
  library: z.boolean().optional(),
  bom: z.boolean().optional(),
  quilt_show: z.boolean().optional(),
  polls: z.boolean().optional(),
  gifting: z.boolean().optional(),
});
