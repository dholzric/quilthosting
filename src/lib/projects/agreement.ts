// The signed document. What gets hashed and stored is a SNAPSHOT — the
// agreement body Linda had configured at the moment of signing, with this
// project's specifics interpolated. A foreign key to a template she has
// since edited could not answer "what did this customer actually agree to",
// which is the only question this record exists to answer.

export const CONSENT_TEXT =
  "I have read this agreement and I agree to be bound by it.";

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Byte-stable plain text. Deliberately NOT HTML: the stored artefact should
 * be readable as-is years from now without a renderer, and stability matters
 * more than presentation because its hash is the integrity guarantee.
 */
export function buildAgreementSnapshot(args: {
  title: string;
  body: string;
  project: { reference: string; customerName: string; totalCents: number };
}): string {
  const { title, body, project } = args;
  return [
    title,
    "",
    `Project: ${project.reference}`,
    `Customer: ${project.customerName}`,
    `Agreed total: ${money(project.totalCents)}`,
    "",
    body,
  ].join("\n");
}
