import { describe, it, expect } from "vitest";
import { sha256Hex } from "./hash";
import { buildAgreementSnapshot, CONSENT_TEXT } from "./agreement";

const PROJECT = { reference: "SSQ-0042", customerName: "Jane Quilter", totalCents: 12500 };

describe("agreement snapshot", () => {
  it("embeds the reference, the customer, and the agreed total", () => {
    const snap = buildAgreementSnapshot({
      title: "Service Agreement",
      body: "Quilting is performed at the customer's risk.",
      project: PROJECT,
    });
    expect(snap).toContain("SSQ-0042");
    expect(snap).toContain("Jane Quilter");
    expect(snap).toContain("$125.00");
    expect(snap).toContain("Quilting is performed at the customer's risk.");
  });

  it("is byte-stable for identical input", () => {
    const a = buildAgreementSnapshot({ title: "T", body: "B", project: PROJECT });
    const b = buildAgreementSnapshot({ title: "T", body: "B", project: PROJECT });
    expect(a).toBe(b);
  });

  it("changes its hash when the total changes", async () => {
    const a = buildAgreementSnapshot({ title: "T", body: "B", project: PROJECT });
    const b = buildAgreementSnapshot({
      title: "T", body: "B",
      project: { ...PROJECT, totalCents: 12501 },
    });
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it("states that the customer is agreeing to be bound", () => {
    expect(CONSENT_TEXT.toLowerCase()).toContain("agree");
    expect(CONSENT_TEXT.toLowerCase()).toContain("bound");
  });

  it("includes the consent text in the snapshot", () => {
    const snap = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: PROJECT,
    });
    expect(snap).toContain(CONSENT_TEXT);
  });

  it("changes its hash when consent text changes", async () => {
    const a = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: PROJECT,
    });
    const b = buildAgreementSnapshot({
      title: "T",
      body: "B with different consent ending.",
      project: PROJECT,
    });
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it("formats zero cents as $0.00", () => {
    const snap = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: { ...PROJECT, totalCents: 0 },
    });
    expect(snap).toContain("$0.00");
  });

  it("formats five cents with padding as $0.05", () => {
    const snap = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: { ...PROJECT, totalCents: 5 },
    });
    expect(snap).toContain("$0.05");
  });

  it("formats negative amounts with leading minus sign as -$5.00", () => {
    const snap = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: { ...PROJECT, totalCents: -500 },
    });
    expect(snap).toContain("-$5.00");
  });
});
