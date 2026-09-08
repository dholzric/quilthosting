// Starter website seeded for every new guild at POST /api/tenants.
//
// Content comes from the Heritage kit (src/lib/site/kits/heritage.json); this
// module is the legacy adapter for it. Until the kit picker (phase-1 plan,
// Task 11) inserts full kits through `kitPageRows`, new guilds still get the
// five legacy slugs below as block pages that guild.html and the guild website
// builder in public/admin.html can render (heading, text, button, divider,
// join_cta, spacer), produced by `sectionsToLegacyBlocks` from the kit's
// section stacks. `starterSettingsJson` carries the kit's design and renderer
// flag next to the legacy {primary, style, font} theme, so the same tenant row
// renders on either shell.
//
// Slugs deliberately avoid guild.html's built-in routes ("join", "membership",
// "events", "calendar", "galleries", "photos"): a CMS page with one of those
// slugs is never rendered (applyRoute() handles the built-in first) and only
// adds a duplicate nav link. So "Join" lives at /why-join and "Events" at
// /meetings, next to the built-in Membership and Events views.
//
// Every page carries SAMPLE_MARKER so the onboarding checklist can tell, from
// the database alone, whether the admin has replaced the sample copy yet
// (src/lib/onboarding.ts). The kit validator requires the marker on every
// kit page for the same reason.

import { blocksToHtml, parseBlocks, type PageBlock, type SiteTheme } from "./blocks";
import { FONT_OPTIONS } from "./site/fonts";
import { typePairById } from "./site/design/typePairs";
import { kitDesign, kitSettingsJson, sectionsToLegacyBlocks, substitutePlaceholders } from "./site/kits/apply";
import { kitById } from "./site/kits/index";
import { SAMPLE_MARKER } from "./site/kits/schema";
import type { Kit } from "./site/kits/schema";

/** Visible prefix on every sample paragraph. Detected with a LIKE in onboarding.ts. */
export { SAMPLE_MARKER };

export type StarterPage = {
  slug: string;
  title: string;
  sort_order: number;
  blocks: PageBlock[];
};

export type StarterSiteInput = {
  /** Optional "City, ST" shown on Home and Contact. */
  city?: string | null;
  /** Optional free-text meeting schedule shown on Home and Meetings. */
  meetingInfo?: string | null;
};

/** The kit every new guild is seeded from. */
export const STARTER_KIT_ID = "heritage";

/**
 * Kit pages the legacy block seed keeps, in order. The kit has more (community,
 * newsletter, gallery); they arrive with the sections renderer via kitPageRows.
 */
export const LEGACY_STARTER_SLUGS: readonly string[] = ["home", "about", "why-join", "meetings", "contact"];

function starterKit(): Kit {
  const kit = kitById(STARTER_KIT_ID);
  if (!kit) throw new Error(`Starter kit "${STARTER_KIT_ID}" is not registered`);
  return kit;
}

/** Legacy {primary, style, font} theme guild.html reads, derived from the kit's design. */
function legacyTheme(kit: Kit): SiteTheme {
  const design = kitDesign(kit);
  const { radius, shadow } = design.shape;
  const style: SiteTheme["style"] = radius === "sharp" && shadow === "none" ? "modern" : radius === "round" ? "warm" : "classic";
  const pair = typePairById(design.typePair);
  let font: SiteTheme["font"] = "system";
  if (pair.id === "nunito") font = "rounded";
  else if (pair.display !== "system") {
    const category = FONT_OPTIONS[pair.display]?.category;
    if (category === "serif" || category === "display") font = "serif";
  }
  return { primary: design.palette.input.brand, style, font };
}

/** Default guild theme in the legacy {primary, style, font} shape guild.html reads. */
export const STARTER_THEME: SiteTheme = legacyTheme(starterKit());

export function starterPages(guildName: string, input: StarterSiteInput = {}): StarterPage[] {
  const kit = starterKit();
  const vars = { guildName: String(guildName || "").trim(), city: input.city, meetingInfo: input.meetingInfo };
  const pages = kit.pages.filter((p) => LEGACY_STARTER_SLUGS.includes(p.slug));
  // Round-trip through parseBlocks so what we persist is exactly what the
  // page editor would have written (field clamping, defaults), and a section
  // the downgrade mishandles surfaces as a dropped block in starterSite.test.ts.
  return pages.map((p, i) => ({
    slug: p.slug,
    title: p.slug === "home" ? "Home" : p.title,
    sort_order: i,
    blocks: parseBlocks(sectionsToLegacyBlocks(substitutePlaceholders(p.sections, vars))),
  }));
}

/** Column-order-matched row values for the `INSERT INTO pages` in tenants.ts. */
export function starterPageRow(page: StarterPage): {
  slug: string;
  title: string;
  content_json: string;
  blocks_json: string;
  sort_order: number;
} {
  return {
    slug: page.slug,
    title: page.title,
    content_json: JSON.stringify({ html: blocksToHtml(page.blocks) }),
    blocks_json: JSON.stringify(page.blocks),
    sort_order: page.sort_order,
  };
}

/**
 * settings_json for a freshly created guild: the kit's design and renderer
 * flag (read by the sections renderer) plus the legacy theme (read by
 * guild.html and parseTheme).
 */
export function starterSettingsJson(): string {
  const kit = starterKit();
  return JSON.stringify({ theme: legacyTheme(kit), ...JSON.parse(kitSettingsJson(kit)) });
}
