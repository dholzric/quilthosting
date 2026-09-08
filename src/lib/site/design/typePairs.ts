// Curated display/body font pairs. `display` and `body` are keys into
// FONT_OPTIONS (src/lib/site/fonts.ts) or the literal "system", which loads
// no web font at all. `sample` is the line the Design panel renders in the
// pair so an owner can judge it without leaving the form.

export type TypePair = {
  id: string;
  name: string;
  /** FONT_OPTIONS key or "system". */
  display: string;
  /** FONT_OPTIONS key or "system". */
  body: string;
  sample: string;
};

export const DEFAULT_TYPE_PAIR_ID = "fraunces-inter";

export const TYPE_PAIRS: TypePair[] = [
  { id: "fraunces-inter", name: "Fraunces / Inter", display: "fraunces", body: "inter",
    sample: "Monthly meeting, second Tuesday at 6:30 — guests welcome." },
  { id: "cormorantgaramond-sourcesans", name: "Cormorant Garamond / Source Sans 3", display: "cormorantgaramond", body: "sourcesans",
    sample: "Quilt show entries close March 1; drop-off is the Friday before." },
  { id: "playfair-lato", name: "Playfair Display / Lato", display: "playfair", body: "lato",
    sample: "Charity quilts go to the children's hospital every December." },
  { id: "dmserif-dmsans", name: "DM Serif Display / DM Sans", display: "dmserif", body: "dmsans",
    sample: "Bring your rotary cutter, a mat, and a 6½-inch ruler to class." },
  { id: "lora-karla", name: "Lora / Karla", display: "lora", body: "karla",
    sample: "The block of the month is a nine-patch in two-color prints." },
  { id: "librebaskerville-nunitosans", name: "Libre Baskerville / Nunito Sans", display: "librebaskerville", body: "nunitosans",
    sample: "Dues are $40 a year and include the newsletter and library." },
  { id: "manrope", name: "Manrope", display: "manrope", body: "manrope",
    sample: "Longarm rental: $20 an hour, certification class required." },
  { id: "spacegrotesk-worksans", name: "Space Grotesk / Work Sans", display: "spacegrotesk", body: "worksans",
    sample: "Retreat registration opens to members first, then the public." },
  { id: "bitter-opensans", name: "Bitter / Open Sans", display: "bitter", body: "opensans",
    sample: "Sew day at the library, 10 to 3, bring a project and a lunch." },
  { id: "newsreader-ibmplexsans", name: "Newsreader / IBM Plex Sans", display: "newsreader", body: "ibmplexsans",
    sample: "Our 2026 raffle quilt is a flying geese medallion in indigo." },
  { id: "nunito", name: "Nunito", display: "nunito", body: "nunito",
    sample: "Beginner friendly: we will help you finish your first quilt." },
  { id: "system", name: "System (fastest)", display: "system", body: "system",
    sample: "Meeting minutes and the newsletter archive are in the member area." },
];

const BY_ID: Map<string, TypePair> = new Map(TYPE_PAIRS.map((p) => [p.id, p]));

/** Look up a pair; unknown ids fall back to fraunces-inter. */
export function typePairById(id: string): TypePair {
  return BY_ID.get(id) ?? (BY_ID.get(DEFAULT_TYPE_PAIR_ID) as TypePair);
}

export function isTypePairId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}
