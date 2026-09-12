import { KITS } from "./index";
import { resolveComposition, type CompositionId } from "../signature";

export type KitCollection = "showcase" | "featured" | "specialist" | "legacy";
export type KitCatalogEntry = {
  id: string;
  family: CompositionId;
  collection: KitCollection;
  order: number;
  useCases: string[];
};

const FEATURED = [
  "indigo-house",
  "weekend-house",
  "color-assembly",
  "paper-pieces",
  "linen-journal",
  "modern-heirloom",
  "minimal",
  "heritage",
] as const;

const SHOWCASE = ["quilt-biennial", "common-thread-review", "patchwork-social", "atelier-noir", "fieldstone-retreat", "heirloom-house"] as const;
const showcaseOrder = new Map<string, number>(SHOWCASE.map((id, index) => [id, index]));

const USE_CASES: Record<string, string[]> = {
  "indigo-house": ["portfolio", "studio"],
  "weekend-house": ["retreat", "booking"],
  "color-assembly": ["events", "guild"],
  "paper-pieces": ["portfolio", "artist"],
  "linen-journal": ["stories", "education"],
  "modern-heirloom": ["services", "membership"],
  minimal: ["simple", "text-focused"],
  heritage: ["guild", "traditional"],
};

const featuredOrder = new Map<string, number>(FEATURED.map((id, index) => [id, index]));

export function catalogPolicy(id: string, index: number): Pick<KitCatalogEntry, "collection" | "order"> {
  if (showcaseOrder.has(id)) return { collection: "showcase", order: showcaseOrder.get(id)! };
  if (featuredOrder.has(id)) return { collection: "featured", order: SHOWCASE.length + featuredOrder.get(id)! };
  return { collection: index < 92 ? "legacy" : "specialist", order: SHOWCASE.length + FEATURED.length + index };
}

export const KIT_CATALOG: KitCatalogEntry[] = KITS.map((kit, index): KitCatalogEntry => ({
  id: kit.id,
  family: resolveComposition(undefined, kit.id),
  ...catalogPolicy(kit.id, index),
  useCases: USE_CASES[kit.id] ?? [],
})).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

const BY_ID = new Map(KIT_CATALOG.map((entry) => [entry.id, entry]));
export function kitCatalogEntry(id: string): KitCatalogEntry | null {
  return BY_ID.get(id) ?? null;
}
