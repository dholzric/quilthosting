export const COMPOSITION_IDS = ["classic", "cinema", "destination", "poster", "collage", "journal", "salon", "biennial", "review", "social", "noir", "fieldstone", "heirloom"] as const;
export type CompositionId = (typeof COMPOSITION_IDS)[number];

/** Compatibility mapping for signature kits saved before composition became explicit. */
const COMPOSITIONS: Record<string, Exclude<CompositionId, "classic">> = {
  "indigo-house": "cinema", "night-bloom": "cinema", "blackbird-studio": "cinema",
  "weekend-house": "destination", "quilt-camp": "destination", "blue-ridge-circle": "destination", "needle-and-pine": "destination",
  "color-assembly": "poster", "studio-grid": "poster", "quilt-show-edition": "poster", "citrus-press": "poster",
  "paper-pieces": "collage", "selvage-club": "collage", "sunroom-society": "collage",
  "linen-journal": "journal", "story-cloth": "journal", "redwork-archive": "journal", "lake-effect": "journal",
  "modern-heirloom": "salon", "holiday-house": "salon", "pattern-house": "salon", "mending-circle": "salon",
  "quilt-biennial": "biennial", "common-thread-review": "review", "patchwork-social": "social",
  "atelier-noir": "noir", "fieldstone-retreat": "fieldstone", "heirloom-house": "heirloom",
};

function isComposition(value: unknown): value is CompositionId {
  return typeof value === "string" && (COMPOSITION_IDS as readonly string[]).includes(value);
}

export function resolveComposition(explicit: unknown, kit: unknown): CompositionId {
  if (isComposition(explicit)) return explicit;
  return typeof kit === "string" && Object.hasOwn(COMPOSITIONS, kit) ? COMPOSITIONS[kit] : "classic";
}
