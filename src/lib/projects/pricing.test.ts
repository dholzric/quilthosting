import { describe, it, expect } from "vitest";
import { computeEstimate } from "./pricing";
import type { LongarmRates } from "./types";

const RATES: LongarmRates = {
  edgeToEdgeCentsPer100SqIn: 250,   // $0.025 / sq in
  customCentsPer100SqIn: 500,       // $0.05  / sq in
  battingCentsPer100SqIn: 100,
  threadFlatCents: 1200,
  bindingCentsPerLinearInch: 25,
  backingPrepFlatCents: 2500,
  customDesignFlatCents: 5000,
  tshirtPerBlockCents: 1800,
  tshirtFinishingFlatCents: 7500,
  rushPercent: 25,
  minimumCents: { longarm: 5000, custom_quilt: 9000, tshirt_quilt: 15000 },
};

describe("computeEstimate", () => {
  it("prices edge-to-edge longarm by area at cents per 100 sq in", () => {
    // 60 x 80 = 4800 sq in -> 4800 * 250 / 100 = 12000 cents
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "edge_to_edge" },
      RATES
    );
    expect(r.suppressed).toBe(false);
    expect(r.lines[0].amountCents).toBe(12000);
    expect(r.totalCents).toBe(12000);
  });

  it("applies the custom rate when serviceLevel is custom", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "custom" },
      RATES
    );
    expect(r.lines[0].amountCents).toBe(24000);
  });

  it("rounds to the nearest cent rather than truncating", () => {
    // 5 x 5 = 25 sq in -> 25 * 250 / 100 = 62.5 -> 63
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 5, heightIn: 5, serviceLevel: "edge_to_edge" },
      { ...RATES, minimumCents: {} }
    );
    expect(r.lines[0].amountCents).toBe(63);
  });

  it("adds add-ons as their own lines", () => {
    const r = computeEstimate(
      {
        projectType: "longarm", widthIn: 60, heightIn: 80,
        serviceLevel: "edge_to_edge", batting: true, thread: true,
        binding: true, backingPrep: true,
      },
      RATES
    );
    const byDesc = Object.fromEntries(r.lines.map((l) => [l.description, l.amountCents]));
    expect(byDesc["Batting"]).toBe(4800);            // 4800 sq in * 100 / 100
    expect(byDesc["Thread"]).toBe(1200);
    expect(byDesc["Binding"]).toBe(7000);            // perimeter 280 in * 25
    expect(byDesc["Backing preparation"]).toBe(2500);
    expect(r.totalCents).toBe(12000 + 4800 + 1200 + 7000 + 2500);
  });

  it("applies rush as a percentage line on the subtotal", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "edge_to_edge", rush: true },
      RATES
    );
    expect(r.totalCents).toBe(15000);                // 12000 + 25%
    expect(r.lines.some((l) => l.description.startsWith("Rush"))).toBe(true);
  });

  it("raises a below-minimum total to the minimum with an explicit line", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 10, heightIn: 10, serviceLevel: "edge_to_edge" },
      RATES
    );
    expect(r.totalCents).toBe(5000);
    expect(r.lines.some((l) => l.description === "Minimum charge adjustment")).toBe(true);
  });

  it("applies the minimum BEFORE rush, so rush is never absorbed by the floor", () => {
    // 10 x 10 = 100 sq in -> 100 * 250 / 100 = 250 cents (edge-to-edge)
    // Below the 5000-cent minimum, so: 250 -> minimum adjustment -> 5000
    // -> THEN rush 25% of the floored total: 5000 * 0.25 = 1250 -> 6250.
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 10, heightIn: 10, serviceLevel: "edge_to_edge", rush: true },
      RATES
    );
    expect(r.suppressed).toBe(false);
    expect(r.lines.some((l) => l.description === "Minimum charge adjustment")).toBe(true);
    expect(r.lines.some((l) => l.description.startsWith("Rush"))).toBe(true);
    expect(r.totalCents).toBe(6250);
    // The minimum-adjustment line must precede the rush line, matching the
    // "minimum first, then rush on top of the floor" ordering.
    const minIdx = r.lines.findIndex((l) => l.description === "Minimum charge adjustment");
    const rushIdx = r.lines.findIndex((l) => l.description.startsWith("Rush"));
    expect(minIdx).toBeGreaterThanOrEqual(0);
    expect(rushIdx).toBeGreaterThan(minIdx);
  });

  it("prices a T-shirt quilt per block plus finishing, not by area", () => {
    const r = computeEstimate({ projectType: "tshirt_quilt", blockCount: 20 }, RATES);
    expect(r.totalCents).toBe(20 * 1800 + 7500);
  });

  it("adds a design fee for a custom quilt", () => {
    const r = computeEstimate(
      { projectType: "custom_quilt", widthIn: 60, heightIn: 80, serviceLevel: "custom" },
      RATES
    );
    expect(r.lines.some((l) => l.description === "Custom design")).toBe(true);
    expect(r.totalCents).toBe(24000 + 5000);
  });

  it("prices a custom_quilt at the custom rate even when serviceLevel is omitted", () => {
    // Tier is derived from projectType for custom_quilt, not from
    // serviceLevel: an omitted serviceLevel must NOT fall back to the
    // cheap edge-to-edge rate. 60 x 80 = 4800 sq in -> 4800 * 500 / 100 =
    // 24000 cents (custom rate), same as the explicit "custom" case.
    const r = computeEstimate(
      { projectType: "custom_quilt", widthIn: 60, heightIn: 80 },
      RATES
    );
    expect(r.suppressed).toBe(false);
    expect(r.lines[0].amountCents).toBe(24000);
    expect(r.totalCents).toBe(24000 + 5000);
  });

  it("SUPPRESSES when a requested add-on's rate is missing, rather than dropping the line", () => {
    const r = computeEstimate(
      {
        projectType: "longarm", widthIn: 60, heightIn: 80,
        serviceLevel: "edge_to_edge", batting: true,
      },
      { ...RATES, battingCentsPer100SqIn: undefined }
    );
    expect(r.suppressed).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.totalCents).toBe(0);
  });

  it("SUPPRESSES when rush is requested but rushPercent is missing", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "edge_to_edge", rush: true },
      { ...RATES, rushPercent: undefined }
    );
    expect(r.suppressed).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.totalCents).toBe(0);
  });

  it("SUPPRESSES rather than returning zero when the needed rate is missing", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "edge_to_edge" },
      {}
    );
    expect(r.suppressed).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.totalCents).toBe(0);
  });

  it("suppresses when dimensions are missing, zero, or negative", () => {
    for (const dims of [{}, { widthIn: 0, heightIn: 80 }, { widthIn: -60, heightIn: 80 }]) {
      const r = computeEstimate(
        { projectType: "longarm", serviceLevel: "edge_to_edge", ...dims },
        RATES
      );
      expect(r.suppressed).toBe(true);
    }
  });

  it("suppresses a T-shirt quilt with no block count", () => {
    expect(computeEstimate({ projectType: "tshirt_quilt" }, RATES).suppressed).toBe(true);
  });
});
