/**
 * Kit registry. Every JSON file in this directory is validated by
 * schema.test.ts (`npm run kits:validate`). Gallery order follows
 * QuiltHostingTemplates.md.
 */

import { kitSchema } from "./schema";
import type { Kit } from "./schema";
import heritage from "./heritage.json";
import modernGuild from "./modern-guild.json";
import showFestival from "./show-festival.json";
import artQuilt from "./art-quilt.json";
import communityThreads from "./community-threads.json";
import appliqueBloom from "./applique-bloom.json";
import prairie from "./prairie.json";
import minimal from "./minimal.json";
import onePager from "./one-pager.json";
import longarmStudio from "./longarm-studio.json";
import quiltShop from "./quilt-shop.json";
import patternDesigner from "./pattern-designer.json";

export type { Kit, KitDefaults, KitImage, KitIssue, KitPage, SiteMenuItem } from "./schema";
export { kitSchema, validateKit, KIT_SYSTEM_PATHS, SAMPLE_MARKER } from "./schema";
export type { KitTenant, KitVars, PageInsert } from "./apply";
export {
  CITY_FALLBACK,
  MEETING_INFO_FALLBACK,
  kitDesign,
  kitPageRows,
  kitSettingsJson,
  sectionsToLegacyBlocks,
  substitutePlaceholders,
} from "./apply";

/** Parsed (typed, section-normalized) kits, in gallery order. */
export const KITS: Kit[] = [
  heritage,
  modernGuild,
  showFestival,
  artQuilt,
  communityThreads,
  appliqueBloom,
  prairie,
  minimal,
  onePager,
  longarmStudio,
  quiltShop,
  patternDesigner,
].map((raw) => kitSchema.parse(raw));

const BY_ID = new Map(KITS.map((k) => [k.id, k]));

export function kitById(id: string): Kit | null {
  return BY_ID.get(id) ?? null;
}
