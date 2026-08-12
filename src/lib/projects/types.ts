// Shared vocabulary for P1. Kept separate from src/types.ts (which holds D1
// row shapes) because these are domain types the pure-function libraries in
// this directory trade in — no database involved.

export type ProjectType = "longarm" | "custom_quilt" | "tshirt_quilt";

export const PROJECT_TYPES: readonly ProjectType[] = [
  "longarm",
  "custom_quilt",
  "tshirt_quilt",
];

export type ProjectStatus =
  | "submitted"
  | "estimated"
  | "signed"
  | "in_progress"
  | "completed"
  | "declined"
  | "cancelled";

export type EstimateLineKind = "service" | "addon" | "discount";

export interface EstimateLine {
  kind: EstimateLineKind;
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

/**
 * Owner-configured rates, stored in tenants.settings_json under "longarm".
 * Every rate is in CENTS PER 100 SQUARE INCHES where marked, because
 * longarm's conventional $0.02-$0.03 per square inch is not representable
 * in integer cents and float money is not acceptable.
 */
export interface LongarmRates {
  referencePrefix?: string;
  edgeToEdgeCentsPer100SqIn?: number;
  customCentsPer100SqIn?: number;
  battingCentsPer100SqIn?: number;
  threadFlatCents?: number;
  bindingCentsPerLinearInch?: number;
  backingPrepFlatCents?: number;
  customDesignFlatCents?: number;
  tshirtPerBlockCents?: number;
  tshirtFinishingFlatCents?: number;
  rushPercent?: number;
  minimumCents?: Partial<Record<ProjectType, number>>;
}

/** What computeEstimate returns. `suppressed` means: do not show a price. */
export interface EstimateResult {
  suppressed: boolean;
  lines: EstimateLine[];
  subtotalCents: number;
  totalCents: number;
}
