// Server-side state for the first-run wizard (four screens: 1 Your guild →
// 2 Pick a design → 3 Make it yours → 4 You're live).
//
// Like ./onboarding.ts, nothing here is a stored cursor: the step an owner
// resumes on is DERIVED from the tenant's own settings, so closing the tab,
// switching device or coming back a week later all land in the same place and
// a half-finished wizard can never disagree with the site it is building.
//
// The ladder, in order:
//   no settings.site.kit                     → 2 (nothing has been designed yet)
//   a logo or a chosen palette exists        → 4 (the site is personalised: done)
//   settings.site.kit is not the create
//   route's default                          → 3 (a design was actively picked)
//   otherwise                                → 2
//
// The one thing this cannot see is an owner who picks the default kit
// (heritage) on screen 2 and then reloads: they resume on 2 with heritage
// already selected, one click from where they left off. That is the honest
// cost of deriving instead of storing, and it is cheaper than a cursor that
// can lie.

import { readSiteDesign } from "./site/design/migrate";
import { DEFAULT_DESIGN } from "./site/design/tokens";
import type { SiteDesign } from "./site/design/tokens";
import { KITS, kitById, kitDesign } from "./site/kits";
import type { Kit } from "./site/kits";
import { hasLogo } from "./onboarding";

/** The kit `POST /api/tenants` seeds when the caller does not name one. */
export const FIRST_RUN_DEFAULT_KIT = "heritage";

/**
 * The six designs screen 2 shows before "More designs". Curated for guilds
 * and ordered deliberately: the two everyone recognises first, then the three
 * with a strong character, then the plain one. public/admin.html mirrors this
 * list as FR_CURATED_KITS; firstRun.test.ts pins the two together.
 */
export const CURATED_GUILD_KIT_IDS: readonly string[] = [
  "heritage",
  "modern-guild",
  "prairie",
  "show-festival",
  "community-threads",
  "minimal",
];

export type FirstRunStep = 1 | 2 | 3 | 4;

export type FirstRunGuild = {
  slug: string;
  public_url: string;
  /** settings.site.kit, or null for a tenant seeded before kits existed. */
  kit: string | null;
  has_logo: boolean;
  has_palette: boolean;
};

export type FirstRunState = {
  done: boolean;
  step: FirstRunStep;
  guild: FirstRunGuild;
};

/** Only the columns the derivation reads. */
export type FirstRunTenant = {
  slug: string;
  settings_json?: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parse(settingsJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(settingsJson || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The kit id a tenant's site was built from, or null. Never throws. */
export function readSiteKit(settingsJson: string | null | undefined): string | null {
  const site = parse(settingsJson).site;
  const kit = isRecord(site) ? site.kit : null;
  return typeof kit === "string" && kit ? kit : null;
}

function samePalette(a: SiteDesign["palette"], b: SiteDesign["palette"]): boolean {
  if ((a.id || null) !== (b.id || null)) return false;
  return (
    a.input.brand === b.input.brand &&
    a.input.brandAlt === b.input.brandAlt &&
    a.input.accent === b.input.accent &&
    a.input.neutral === b.input.neutral
  );
}

/**
 * Has the owner picked colours of their own? True when the saved palette
 * differs from the one the tenant's kit ships with (or from DEFAULT_DESIGN
 * when there is no kit) — that difference can only come from screen 3 or the
 * Design panel, so it is a truthful "they made it theirs" signal. Never throws.
 */
export function hasChosenPalette(settingsJson: string | null | undefined): boolean {
  const kitId = readSiteKit(settingsJson);
  const kit = kitId ? kitById(kitId) : null;
  const baseline = kit ? kitDesign(kit).palette : DEFAULT_DESIGN.palette;
  return !samePalette(readSiteDesign(settingsJson).palette, baseline);
}

/**
 * Which screen this guild resumes on, and whether the wizard has anything
 * left to collect. `publicUrl` comes from the route (publicUrlFor) so this
 * module stays free of Env.
 */
export function firstRunState(tenant: FirstRunTenant, publicUrl: string): FirstRunState {
  const settings = tenant.settings_json;
  const kit = readSiteKit(settings);
  const has_logo = hasLogo(settings);
  const has_palette = hasChosenPalette(settings);
  const step: FirstRunStep = !kit
    ? 2
    : has_logo || has_palette
      ? 4
      : kit !== FIRST_RUN_DEFAULT_KIT
        ? 3
        : 2;
  return {
    done: step === 4,
    step,
    guild: { slug: tenant.slug, public_url: publicUrl, kit, has_logo, has_palette },
  };
}

/**
 * Screen 2's two rows: the curated six first, then everything else this
 * tenant type may use. A guild never sees a business-only kit and vice versa;
 * "both" kits appear for either.
 */
export function firstRunKits(tenantType: "guild" | "business"): { curated: Kit[]; more: Kit[] } {
  const usable = KITS.filter((k) => k.audience === "both" || k.audience === tenantType);
  const curatedIds = tenantType === "guild" ? CURATED_GUILD_KIT_IDS : [];
  const curated = curatedIds
    .map((id) => usable.find((k) => k.id === id))
    .filter((k): k is Kit => !!k);
  const picked = new Set(curated.map((k) => k.id));
  return { curated, more: usable.filter((k) => !picked.has(k.id)) };
}
