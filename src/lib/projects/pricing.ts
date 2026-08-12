// Pure pricing. No I/O, no database, no clock — every input is an argument
// so the whole surface is unit-testable and deterministic.
//
// WHY CENTS PER 100 SQUARE INCHES: longarm work is conventionally priced at
// $0.02-$0.03 per square inch. Integer cents cannot represent $0.025, and
// float money is not acceptable, so rates are scaled by 100 and divided back
// out at the end of the multiplication (not before it).

import type {
  EstimateLine,
  EstimateResult,
  LongarmRates,
  ProjectType,
} from "./types";

export interface EstimateInput {
  projectType: ProjectType;
  widthIn?: number;
  heightIn?: number;
  serviceLevel?: "edge_to_edge" | "custom";
  batting?: boolean;
  thread?: boolean;
  binding?: boolean;
  backingPrep?: boolean;
  rush?: boolean;
  blockCount?: number;
}

// A single module-level object returned BY REFERENCE from every early-return
// above (and from finalize() below) -- every suppressed call site shares
// this exact instance, not a fresh copy. A caller mutating `result.lines`
// (e.g. `result.lines.push(...)`) would corrupt every other, unrelated
// suppressed result anywhere else in the process, past or future (final
// review, F9). Object.freeze on both the object and its `lines` array turns
// that mutation into a silent no-op in non-strict code and a thrown
// TypeError in strict/module code, rather than shared, invisible state
// corruption.
const SUPPRESSED: EstimateResult = Object.freeze({
  suppressed: true,
  lines: Object.freeze([]) as unknown as EstimateLine[],
  subtotalCents: 0,
  totalCents: 0,
});

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Rate lookups return undefined when unset; a rate of 0 is NOT usable. */
function rate(value: number | undefined): number | undefined {
  return positive(value) ? value : undefined;
}

function line(
  kind: EstimateLine["kind"],
  description: string,
  quantity: number,
  unitCents: number,
  amountCents: number
): EstimateLine {
  return { kind, description, quantity, unitCents, amountCents };
}

/**
 * Compute a ballpark. Returns `suppressed: true` when the rate table or the
 * inputs are insufficient — the caller MUST then show no price at all rather
 * than rendering $0, which reads as "free" instead of "unknown".
 */
export function computeEstimate(
  input: EstimateInput,
  rates: LongarmRates
): EstimateResult {
  const lines: EstimateLine[] = [];

  if (input.projectType === "tshirt_quilt") {
    const perBlock = rate(rates.tshirtPerBlockCents);
    if (!perBlock || !positive(input.blockCount)) return SUPPRESSED;
    const blocks = Math.round(input.blockCount);
    lines.push(line("service", "T-shirt blocks", blocks, perBlock, blocks * perBlock));
    const finishing = rate(rates.tshirtFinishingFlatCents);
    if (finishing) {
      lines.push(line("service", "Finishing", 1, finishing, finishing));
    }
    return finalize(lines, input, rates);
  }

  if (!positive(input.widthIn) || !positive(input.heightIn)) return SUPPRESSED;

  // Tier is derived from projectType, not serviceLevel: a custom_quilt is
  // always priced at the custom rate. serviceLevel only selects the tier
  // for "longarm" — otherwise an omitted serviceLevel would default a
  // custom_quilt to the cheap edge-to-edge rate plus the design fee, a
  // tier that does not exist.
  const level: "custom" | "edge_to_edge" =
    input.projectType === "custom_quilt"
      ? "custom"
      : input.serviceLevel === "custom"
        ? "custom"
        : "edge_to_edge";
  const perSq =
    level === "custom"
      ? rate(rates.customCentsPer100SqIn)
      : rate(rates.edgeToEdgeCentsPer100SqIn);
  if (!perSq) return SUPPRESSED;

  const areaSqIn = input.widthIn * input.heightIn;
  const quiltingCents = Math.round((areaSqIn * perSq) / 100);
  lines.push(
    line(
      "service",
      level === "custom" ? "Custom quilting" : "Edge-to-edge quilting",
      areaSqIn,
      perSq,
      quiltingCents
    )
  );

  if (input.projectType === "custom_quilt") {
    const design = rate(rates.customDesignFlatCents);
    if (design) lines.push(line("service", "Custom design", 1, design, design));
  }

  // Customer-selected add-ons (batting/thread/binding/backingPrep/rush) are
  // requests, not suggestions: if the shop hasn't configured a rate for one
  // the customer explicitly ticked, dropping the line would quietly return
  // a normal-looking price that excludes something they asked for — the
  // same failure mode the top-level suppression rule exists to prevent, one
  // level down. Suppress the whole estimate instead. This does NOT apply to
  // customDesignFlatCents / tshirtFinishingFlatCents below, which are
  // type-implied fees the customer never selected.
  if (input.batting) {
    const r = rate(rates.battingCentsPer100SqIn);
    if (!r) return SUPPRESSED;
    lines.push(line("addon", "Batting", areaSqIn, r, Math.round((areaSqIn * r) / 100)));
  }
  if (input.thread) {
    const r = rate(rates.threadFlatCents);
    if (!r) return SUPPRESSED;
    lines.push(line("addon", "Thread", 1, r, r));
  }
  if (input.binding) {
    const r = rate(rates.bindingCentsPerLinearInch);
    if (!r) return SUPPRESSED;
    // Perimeter, not area — binding is sold by the linear inch.
    const perimeterIn = 2 * (input.widthIn + input.heightIn);
    lines.push(line("addon", "Binding", perimeterIn, r, Math.round(perimeterIn * r)));
  }
  if (input.backingPrep) {
    const r = rate(rates.backingPrepFlatCents);
    if (!r) return SUPPRESSED;
    lines.push(line("addon", "Backing preparation", 1, r, r));
  }

  return finalize(lines, input, rates);
}

function finalize(
  lines: EstimateLine[],
  input: EstimateInput,
  rates: LongarmRates
): EstimateResult {
  if (!lines.length) return SUPPRESSED;

  // Rush is a customer-selected extra like batting/thread/binding/
  // backingPrep: if it's requested but unpriceable, suppress the whole
  // estimate rather than silently charging nothing for it.
  const rushPct = input.rush ? rate(rates.rushPercent) : undefined;
  if (input.rush && !rushPct) return SUPPRESSED;

  const subtotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);

  // Minimum is applied to the pre-rush subtotal FIRST, then rush is charged
  // on top of the (possibly raised) floor. Applying rush before the minimum
  // lets the minimum silently absorb it: the customer would see a
  // "Rush (25%)" line item while paying the exact same total as with no
  // rush at all, because both paths get floored to the same minimum.
  let totalCents = subtotalCents;
  const minimum = rates.minimumCents?.[input.projectType];
  if (positive(minimum) && totalCents < minimum) {
    const adjustment = minimum - totalCents;
    lines.push(line("service", "Minimum charge adjustment", 1, adjustment, adjustment));
    totalCents = minimum;
  }

  if (input.rush && rushPct) {
    const rushCents = Math.round((totalCents * rushPct) / 100);
    lines.push(line("service", `Rush (${rushPct}%)`, 1, rushCents, rushCents));
    totalCents += rushCents;
  }

  return { suppressed: false, lines, subtotalCents, totalCents };
}
