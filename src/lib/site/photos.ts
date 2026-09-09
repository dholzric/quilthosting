// src/lib/site/photos.ts
//
// Stock photography for the starter kits.
//
// Kits shipped with pattern art in every picture slot, which meant the
// photo-led designs — a full-bleed hero, a split hero, a portfolio — had never
// actually been seen with a photograph in them. A quilt guild's site lives or
// dies on whether it looks like real quilts, so the kits now open with one.
//
// A kit refers to a photo as `photo:<id>`, the same shape as `pattern:<id>`.
// Nothing is copied into the repo or into R2: the id is an Unsplash photo and
// the URL is built against their CDN, which resizes and re-encodes on the fly,
// so the responsive widths the renderer asks for cost us nothing to store.
//
// Licence: the Unsplash Licence permits free commercial use without
// permission. Attribution is not required; the photographers are credited in
// docs/photo-credits.md because it is the decent thing to do.
//
// Every id in this file was fetched and confirmed to return an image before it
// was added; photos.test.ts keeps the table honest about its own shape, and
// `npm run photos:check` re-checks them against the CDN.

/** A photo a kit can use, with what it shows so a slot gets a sensible one. */
export type StockPhoto = {
  /** Unsplash photo id: the part after "photo-" in the CDN path. */
  id: string;
  /** Alt text. Written for a screen reader, not for search engines. */
  alt: string;
  /** What it is, for choosing: a quilt, a machine, hands working, materials. */
  kind: "quilt" | "machine" | "hands" | "materials";
};

export const STOCK_PHOTOS: readonly StockPhoto[] = Object.freeze([
  { id: "1594526761005-4ccdbd608d2b", alt: "A patchwork quilt in white, brown and black", kind: "quilt" },
  { id: "1602730273286-22b077c994de", alt: "A quilt close up, many colours meeting at the seams", kind: "quilt" },
  { id: "1531456786827-de29dd0fa8b7", alt: "A multicoloured patchwork throw", kind: "quilt" },
  { id: "1634075853493-66688f345d87", alt: "A quilt spread across a bed, seen close", kind: "quilt" },
  { id: "1570362685387-3cf5499c3fdc", alt: "A quilt in grey and green", kind: "quilt" },
  { id: "1692561146174-d108741eee80", alt: "A colourful quilt on a bed", kind: "quilt" },
  { id: "1623111773154-05d3be4a70d7", alt: "A quilt in white, red and green", kind: "quilt" },
  { id: "1755138452921-650d508d6b54", alt: "A colourful quilt over a wooden fence post", kind: "quilt" },
  { id: "1701350659612-c4740dac512b", alt: "A patchwork quilt of many colours and patterns", kind: "quilt" },
  { id: "1610768400574-a588f7e1a7b7", alt: "Green and beige floral quilting fabric", kind: "quilt" },
  { id: "1610768399515-8df89e969e11", alt: "Blue and white floral quilting fabric", kind: "quilt" },
  { id: "1755138207288-b5c8fb5b8614", alt: "A checked quilt over a wooden railing", kind: "quilt" },
  { id: "1692561141101-c1528235e6bf", alt: "A colourful quilt on a bed", kind: "quilt" },
  { id: "1466027397211-20d0f2449a3f", alt: "An old black and yellow sewing machine", kind: "machine" },
  { id: "1626274890657-e28d5b65b04b", alt: "A sewing machine on a wooden table", kind: "machine" },
  { id: "1564848534648-558dc1ef55c7", alt: "A blue vintage sewing machine", kind: "machine" },
  { id: "1673786586360-19e8f8acb53f", alt: "A sewing machine at work, close up", kind: "machine" },
  { id: "1497997092403-f091fcf5b6c4", alt: "A presser foot and thread on dark cloth", kind: "machine" },
  { id: "1630930678172-63343537a00a", alt: "Someone working at a sewing machine", kind: "hands" },
  { id: "1606501126768-b78d4569d3f9", alt: "Someone sewing in a grey shirt", kind: "hands" },
  { id: "1641320197434-6ae0ca235048", alt: "Hands guiding fabric through a sewing machine", kind: "hands" },
  { id: "1533758488827-1ed0f9b03899", alt: "A quilter at a sewing machine", kind: "hands" },
  { id: "1663612619657-f876bfca791e", alt: "A hand holding scissors and reading glasses", kind: "hands" },
  { id: "1516707471165-777029111409", alt: "Silk and scissors laid out on a table", kind: "materials" },
  { id: "1542044801-30d3e45ae49a", alt: "Spools of thread in many colours", kind: "materials" },
  { id: "1578353022142-09264fd64295", alt: "Threads and scissors on a work table", kind: "materials" },
  { id: "1536867520774-5b4f2628a69b", alt: "A tape measure and scissors", kind: "materials" },
  { id: "1502217625004-89c03571bcca", alt: "A sewing needle, very close", kind: "materials" },
  { id: "1560796952-f1c9b838544c", alt: "A sewing machine in black and white", kind: "machine" },
]);

const BY_ID = new Map(STOCK_PHOTOS.map((p) => [p.id, p]));

/** `photo:<id>` -> the entry, or null for anything that is not one of ours. */
export function stockPhoto(ref: string | undefined): StockPhoto | null {
  if (typeof ref !== "string" || !ref.startsWith("photo:")) return null;
  return BY_ID.get(ref.slice("photo:".length)) ?? null;
}

export function isPhotoRef(ref: string | undefined): boolean {
  return typeof ref === "string" && ref.startsWith("photo:");
}

/**
 * The CDN URL at a given width. Unsplash resizes and re-encodes on request,
 * so asking for the width the slot needs is the whole responsive story: there
 * is nothing for us to store or generate.
 */
export function stockPhotoUrl(id: string, width = 1600): string {
  const w = Math.min(2400, Math.max(240, Math.round(width)));
  return `https://images.unsplash.com/photo-${id}?w=${w}&q=80&fm=webp&fit=crop&crop=entropy`;
}
