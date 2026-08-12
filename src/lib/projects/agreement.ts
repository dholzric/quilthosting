// The signed document. What gets hashed and stored is a SNAPSHOT — the
// agreement body Linda had configured at the moment of signing, with this
// project's specifics interpolated. A foreign key to a template she has
// since edited could not answer "what did this customer actually agree to",
// which is the only question this record exists to answer.

export const CONSENT_TEXT =
  "I have read this agreement and I agree to be bound by it.";

function money(cents: number): string {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
    throw new TypeError(`money() requires a finite integer; got ${cents}`);
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function assertIntCents(cents: number, label: string): void {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
    throw new TypeError(`${label} requires a finite integer; got ${cents}`);
  }
}

/** One priced row as it enters the hashed/stored document. */
export interface AgreementSnapshotLine {
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

/**
 * Byte-stable plain text. Deliberately NOT HTML: the stored artefact should
 * be readable as-is years from now without a renderer, and stability matters
 * more than presentation because its hash is the integrity guarantee.
 *
 * `lines` is optional so every pre-existing call site/test that doesn't pass
 * it produces BYTE-IDENTICAL output to before (see agreement.test.ts's
 * byte-stability assertions). When a caller does pass it, the line items
 * become part of the same document that gets hashed and stored -- closing a
 * gap where only the title/body/total were covered: a shop could re-itemise
 * a project between a customer loading the quote page and clicking Sign,
 * keep the total unchanged, and the top-level hash would still match even
 * though the customer never saw the new breakdown. Each tuple is rendered
 * from RAW integer cents, never a dollar-formatted string, so the hash input
 * has no dependency on money()'s own formatting choices (or any future
 * change to them) -- fixed field order, no locale formatting, integer cents
 * only.
 */
export function buildAgreementSnapshot(args: {
  title: string;
  body: string;
  project: { reference: string; customerName: string; totalCents: number };
  lines?: AgreementSnapshotLine[];
}): string {
  const { title, body, project, lines } = args;
  const parts = [
    title,
    "",
    // JSON.stringify, not raw interpolation -- fix round 2 closed this
    // exact ambiguity class for line `description` (see below) because it
    // is shop-authored free text, but left `reference` and `customerName`
    // raw. `customerName` comes straight from the ANONYMOUS public intake
    // form (public.ts's /projects/intake), where only length is bounded
    // (.slice(0, 200)) -- interior newlines survive the trim/slice
    // untouched. A customer-supplied name containing literal "\n" plus
    // fake "Project: ..." / "Agreed total: ..." text could inject lines
    // that read as document content into the exact artifact whose purpose
    // is proving what was agreed (the hashed snapshot, the signed-copy
    // page, and the confirmation email all render this verbatim). Applying
    // the same treatment to `reference` too, even though it's
    // server-generated and not attacker-controlled today, keeps both
    // fields on the same footing as `description` and removes any future
    // dependency on reference's generation logic staying newline-free
    // forever (final review, F4).
    `Project: ${JSON.stringify(project.reference)}`,
    `Customer: ${JSON.stringify(project.customerName)}`,
    `Agreed total: ${money(project.totalCents)}`,
  ];
  if (lines !== undefined) {
    parts.push("", "Line items:");
    if (lines.length === 0) {
      parts.push("(none)");
    } else {
      lines.forEach((l, i) => {
        assertIntCents(l.unitCents, `lines[${i}].unitCents`);
        assertIntCents(l.amountCents, `lines[${i}].amountCents`);
        // JSON.stringify, not the raw string: `description` is shop-authored
        // free text (PUT /lines only bounds its length, never its content),
        // and without escaping, a description containing embedded "\n"
        // characters plus fake numbered-row text can reproduce the EXACT
        // byte rendering of several separate, differently-priced lines --
        // a hash collision between two genuinely different itemisations
        // (fix round 2, Finding 1). JSON.stringify escapes any literal
        // newline to the two-character sequence \n and any embedded quote,
        // so a raw newline byte can only ever appear here as a genuine row
        // separator, never as part of a row's own content -- making each
        // row's span unambiguous. This also makes the field unambiguous for
        // a human reading the stored artefact years later.
        parts.push(
          `${i + 1}. ${JSON.stringify(l.description)} (qty ${l.quantity}, unit_cents ${l.unitCents}, amount_cents ${l.amountCents})`
        );
      });
    }
  }
  parts.push("", body, "", CONSENT_TEXT);
  return parts.join("\n");
}
