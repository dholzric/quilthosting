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

  it("proves hash covers the consent section (not the body)", async () => {
    const snap = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: PROJECT,
    });
    // Same snapshot but with consent section stripped (removes trailing blank + CONSENT_TEXT)
    const snapWithoutConsent = snap.slice(0, snap.lastIndexOf("\n\n"));
    expect(await sha256Hex(snap)).not.toBe(await sha256Hex(snapWithoutConsent));
  });

  it("snapshot ends with the consent text", () => {
    const snap = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: PROJECT,
    });
    expect(snap.endsWith(CONSENT_TEXT)).toBe(true);
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

  it("throws TypeError when totalCents is NaN", () => {
    expect(() => {
      buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: { ...PROJECT, totalCents: NaN },
      });
    }).toThrow(TypeError);
  });

  it("throws TypeError when totalCents is Infinity", () => {
    expect(() => {
      buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: { ...PROJECT, totalCents: Infinity },
      });
    }).toThrow(TypeError);
  });

  it("throws TypeError when totalCents is fractional", () => {
    expect(() => {
      buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: { ...PROJECT, totalCents: 100.5 },
      });
    }).toThrow(TypeError);
  });

  it("handles -0 correctly", () => {
    const snap = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: { ...PROJECT, totalCents: -0 },
    });
    expect(snap).toContain("$0.00");
  });

  it("handles Number.MAX_SAFE_INTEGER correctly", () => {
    const snap = buildAgreementSnapshot({
      title: "T",
      body: "B",
      project: { ...PROJECT, totalCents: Number.MAX_SAFE_INTEGER },
    });
    // MAX_SAFE_INTEGER is 9007199254740991 cents = $90071992547409.91
    expect(snap).toContain("$90071992547409.91");
  });
});
