// src/lib/site/migrateGuild.ts
// "Try the new design" for guilds still on the classic renderer (spec §5,
// phase 2 Task D). Pure composition: block pages become styled section
// documents (src/lib/site/sections/normalize.ts `blocksToSectionsStyled`),
// the home page is composed when the guild has none or completed with a
// hero, events, levels and a join band when it has one, and the design is
// the legacy theme migrated through `readSiteDesign` or a kit's defaults.
// The routes in src/routes/tenants.ts (`GET|POST /:id/site/upgrade`,
// `POST /:id/site/downgrade`) do the D1 work; `upgradedSiteSettings` /
// `downgradedSiteSettings` produce the settings_json each one writes.

import { parseBlocks } from "../blocks";
import { defaultHomeSections } from "../../routes/site";
import { readProfile } from "./data";
import type { SiteProfile } from "./data.types";
import { readSiteDesign } from "./design/migrate";
import type { SiteDesign } from "./design/tokens";
import { kitById, kitDesign } from "./kits";
import { blocksToSectionsStyled, isSectionDocument, sectionsFromPage } from "./sections/normalize";
import { DEFAULT_STYLE, parseSections, type Section } from "./sections/schema";

export type UpgradeTenant = { name: string; settings_json: string | null };

export type UpgradePageRow = {
  id: string;
  slug: string;
  title: string;
  blocks_json: string | null;
  content_json: string | null;
};

export type ComposedPage = {
  /** Absent for the home page the upgrade creates. */
  id?: string;
  slug: string;
  title: string;
  sections: Section[];
};

export type UpgradeComposition = {
  pages: ComposedPage[];
  /** true when no `home` page existed and one was composed. */
  createdHome: boolean;
  design: SiteDesign;
  /** The kit whose defaults `design` carries, or null for the migrated legacy theme. */
  kit: string | null;
};

export const HOME_SLUG = "home";
export const HOME_TITLE = "Home";
/** page_revisions.kind written by the upgrade; the downgrade restores from the newest of these per page. */
export const PRE_UPGRADE_KIND = "pre_upgrade";

const SECTION_MAX = 200;

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * One stored page as a styled section document. A page that is already a
 * section document is kept as it is; a block page is converted with the
 * position hints; a page with neither falls back to its content_json html.
 */
function convertPage(row: UpgradePageRow, isHome: boolean): Section[] {
  const raw = parseJson(row.blocks_json);
  if (Array.isArray(raw) && raw.length) {
    if (isSectionDocument(raw)) return parseSections(raw).sections;
    const blocks = parseBlocks(raw);
    if (blocks.length) return blocksToSectionsStyled(blocks, { hero: isHome });
  }
  return sectionsFromPage({ blocks_json: null, content_json: row.content_json });
}

/** `meeting_info` from the profile, for the composed home; null when the guild has not said when it meets. */
function meetingSection(profile: SiteProfile): Section | null {
  const when = (profile.meeting_info ?? "").trim().slice(0, SECTION_MAX);
  if (!when) return null;
  return {
    type: "meeting_info",
    heading: "When we meet",
    when,
    where: (profile.location ?? "").trim().slice(0, SECTION_MAX),
    style: { ...DEFAULT_STYLE, bg: "tint" },
    id: "home-meeting",
  };
}

/** The composed default home, plus the meeting band after the hero when the profile has one. */
function composedHome(tenant: UpgradeTenant, profile: SiteProfile): Section[] {
  const base = defaultHomeSections(tenant, profile).map((s) => ({ ...s, style: { ...s.style } }));
  const meeting = meetingSection(profile);
  if (!meeting) return base;
  const [hero, ...rest] = base;
  return [hero, meeting, ...rest];
}

/**
 * An existing home, completed the way a kit home reads: the profile hero in
 * front unless the page already opens with one, then events, levels and a
 * join band appended -- each only when the page does not have that section
 * already.
 */
function completeHome(sections: Section[], tenant: UpgradeTenant, profile: SiteProfile): Section[] {
  const defaults = defaultHomeSections(tenant, profile);
  const out = sections.map((s) => ({ ...s, style: { ...s.style } })) as Section[];
  if (!out.length || out[0].type !== "hero") {
    const hero = defaults.find((s) => s.type === "hero");
    if (hero) out.unshift({ ...hero, style: { ...hero.style } });
  }
  const present = new Set(out.map((s) => s.type));
  for (const type of ["events", "membership_levels", "join_band"] as const) {
    if (present.has(type)) continue;
    const s = defaults.find((d) => d.type === type);
    if (s) out.push({ ...s, style: { ...s.style } });
  }
  return out;
}

/**
 * Compose the upgrade. Pure: reads the tenant's settings and the page rows,
 * returns the section document for every page (plus a new `home` when the
 * guild has none) and the design. Throws when `kitId` is not a guild kit --
 * callers validate first.
 */
export function composeUpgrade(tenant: UpgradeTenant, pages: UpgradePageRow[], kitId?: string | null): UpgradeComposition {
  let design: SiteDesign;
  let kit: string | null = null;
  if (kitId) {
    const found = kitById(kitId);
    if (!found || found.audience === "business") throw new Error(`"${kitId}" is not a guild kit`);
    design = kitDesign(found);
    kit = found.id;
  } else {
    design = readSiteDesign(tenant.settings_json);
  }

  const profile = readProfile(tenant.settings_json);
  const out: ComposedPage[] = [];
  let sawHome = false;
  for (const row of pages) {
    const isHome = row.slug === HOME_SLUG;
    let sections = convertPage(row, isHome);
    if (isHome) {
      sawHome = true;
      sections = completeHome(sections, tenant, profile);
    }
    out.push({ id: row.id, slug: row.slug, title: row.title, sections });
  }
  if (!sawHome) {
    out.push({ slug: HOME_SLUG, title: HOME_TITLE, sections: composedHome(tenant, profile) });
  }
  return { pages: out, createdHome: !sawHome, design, kit };
}

// ---------------------------------------------------------------------------
// settings_json
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * settings after the upgrade: every other key kept, `design` set to the
 * composition's design, and `site` = renderer "sections", the kit, when it
 * happened, whether a home was created, and what to go back to. A custom
 * `design` the guild already had rides along under `previous.design` so
 * "Back to classic" can put it back.
 */
export function upgradedSiteSettings(
  settings: Record<string, unknown>,
  composition: UpgradeComposition,
  now: string
): Record<string, unknown> {
  const previous: Record<string, unknown> = { renderer: "legacy" };
  if (isRecord(settings.design)) previous.design = settings.design;
  return {
    ...settings,
    design: composition.design,
    site: {
      renderer: "sections",
      kit: composition.kit,
      upgraded_at: now,
      upgrade_created_home: composition.createdHome,
      previous,
    },
  };
}

/** true when `settings.site.upgrade_created_home` says the upgrade composed the home page. */
export function upgradeCreatedHome(settings: unknown): boolean {
  const site = isRecord(settings) ? settings.site : null;
  return isRecord(site) && site.upgrade_created_home === true;
}

/**
 * settings after the downgrade: renderer "legacy", the remembered design
 * restored when there is one, the upgrade markers gone, and `previous`
 * pointing at the section renderer (and kit) the guild just left.
 */
export function downgradedSiteSettings(settings: Record<string, unknown>, now: string): Record<string, unknown> {
  const site = isRecord(settings.site) ? settings.site : {};
  const prior = isRecord(site.previous) ? site.previous : {};
  const out: Record<string, unknown> = { ...settings };
  if (isRecord(prior.design)) out.design = prior.design;
  const previous: Record<string, unknown> = { renderer: "sections" };
  if (typeof site.kit === "string") previous.kit = site.kit;
  out.site = { renderer: "legacy", downgraded_at: now, previous };
  return out;
}
