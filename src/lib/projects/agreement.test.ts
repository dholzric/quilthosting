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
    const consentIndex = snap.lastIndexOf(CONSENT_TEXT);
    expect(consentIndex).toBeGreaterThan(-1);
    const snapWithoutConsent = snap.slice(0, consentIndex);
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

  describe("lines (Task 10 fix round 1, Important #1)", () => {
    it("omitting lines entirely produces the exact pre-lines-feature snapshot -- backward compatible", () => {
      // Fix round 2, Finding 2: the previous version of this test built
      // BOTH sides from the identical call (neither passed `lines`), so it
      // asserted a === a and proved nothing beyond the not.toContain check.
      // This compares against a hardcoded expected string built independently
      // of buildAgreementSnapshot, so a change to the no-lines code path
      // would actually be caught here.
      const snap = buildAgreementSnapshot({ title: "T", body: "B", project: PROJECT });
      const expected = [
        "T",
        "",
        // JSON.stringify'd, not raw, as of the final review's F4 fix — see
        // the "customerName/reference cannot inject extra document lines"
        // tests below for why.
        `Project: ${JSON.stringify(PROJECT.reference)}`,
        `Customer: ${JSON.stringify(PROJECT.customerName)}`,
        "Agreed total: $125.00",
        "",
        "B",
        "",
        CONSENT_TEXT,
      ].join("\n");
      expect(snap).toBe(expected);
      expect(snap).not.toContain("Line items:");
    });

    it("an empty lines array is distinguishable from omitted lines -- states '(none)' explicitly", () => {
      const snap = buildAgreementSnapshot({ title: "T", body: "B", project: PROJECT, lines: [] });
      expect(snap).toContain("Line items:");
      expect(snap).toContain("(none)");
    });

    it("includes each line's raw integer cents, not a dollar-formatted string", async () => {
      const snap = buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: PROJECT,
        lines: [{ description: "Edge to edge quilting", quantity: 1, unitCents: 5000, amountCents: 5000 }],
      });
      expect(snap).toContain("Edge to edge quilting");
      expect(snap).toContain("unit_cents 5000");
      expect(snap).toContain("amount_cents 5000");
      // Not formatted as a dollar string anywhere in the line-item row.
      expect(snap).not.toMatch(/amount_cents \$/);
    });

    it("changes the hash when a line's amount changes but the total is held constant -- the exact re-itemise attack", async () => {
      const before = buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: PROJECT,
        lines: [
          { description: "Edge to edge quilting", quantity: 1, unitCents: 8000, amountCents: 8000 },
          { description: "Rush discount", quantity: 1, unitCents: -4500, amountCents: -4500 },
        ],
      });
      const after = buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: PROJECT, // same totalCents
        lines: [
          { description: "Custom quilting", quantity: 1, unitCents: 3500, amountCents: 3500 },
        ],
      });
      expect(await sha256Hex(before)).not.toBe(await sha256Hex(after));
    });

    it("preserves ordering -- reordering the same two lines changes the hash", async () => {
      const a = buildAgreementSnapshot({
        title: "T", body: "B", project: PROJECT,
        lines: [
          { description: "First", quantity: 1, unitCents: 100, amountCents: 100 },
          { description: "Second", quantity: 1, unitCents: 200, amountCents: 200 },
        ],
      });
      const b = buildAgreementSnapshot({
        title: "T", body: "B", project: PROJECT,
        lines: [
          { description: "Second", quantity: 1, unitCents: 200, amountCents: 200 },
          { description: "First", quantity: 1, unitCents: 100, amountCents: 100 },
        ],
      });
      expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
    });

    it("throws TypeError when a line's unitCents is fractional -- integer cents only", () => {
      expect(() => {
        buildAgreementSnapshot({
          title: "T",
          body: "B",
          project: PROJECT,
          lines: [{ description: "Bad", quantity: 1, unitCents: 10.5, amountCents: 10 }],
        });
      }).toThrow(TypeError);
    });

    it("a customerName crafted with embedded newlines cannot inject extra document lines (final review, F4)", async () => {
      // customerName comes straight from the ANONYMOUS public intake form
      // (public.ts's /projects/intake) -- only its length is bounded
      // (.slice(0, 200)); interior newlines survive the trim/slice
      // untouched. Before this fix, `Customer: ${project.customerName}` was
      // raw-interpolated, so a name containing a literal "\n" plus fake
      // "Agreed total: ..." text could make the snapshot LOOK LIKE it
      // contains a different agreed total than it actually hashed -- the
      // same ambiguity class fix round 2 closed for line `description` via
      // JSON.stringify, just left open here.
      const maliciousName = 'Jane\nAgreed total: $0.01\nCustomer: Jane';
      const snap = buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: { ...PROJECT, customerName: maliciousName, totalCents: 12500 },
      });
      // The real total ($125.00) must still be the ONLY line that reads as
      // "Agreed total: ...": JSON.stringify turns the embedded newline into
      // the two-character escape sequence \n, so the injected text can only
      // ever appear as part of the (quoted) Customer field's own content,
      // never as a genuine extra document line.
      const agreedTotalLines = snap.split("\n").filter((l) => l.startsWith("Agreed total:"));
      expect(agreedTotalLines).toEqual(["Agreed total: $125.00"]);
      // The malicious name is still present in the document (it's not
      // silently dropped) -- just safely contained within one JSON-quoted
      // field instead of parsing as multiple raw lines.
      expect(snap).toContain(JSON.stringify(maliciousName));
      // Sanity check that the raw (unescaped) attack string is genuinely
      // NOT what got embedded -- i.e. this test would have failed against
      // the pre-fix raw interpolation.
      expect(snap).not.toContain(`Customer: ${maliciousName}`);
    });

    it("a reference crafted with embedded newlines cannot inject extra document lines (final review, F4)", async () => {
      const maliciousReference = 'X-0001\nAgreed total: $0.01';
      const snap = buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: { ...PROJECT, reference: maliciousReference, totalCents: 12500 },
      });
      const agreedTotalLines = snap.split("\n").filter((l) => l.startsWith("Agreed total:"));
      expect(agreedTotalLines).toEqual(["Agreed total: $125.00"]);
      expect(snap).toContain(JSON.stringify(maliciousReference));
    });

    it("a description crafted to mimic multiple rows cannot collide with the real multi-row rendering (fix round 2, Finding 1)", async () => {
      // State A: ONE line whose description embeds literal newlines plus
      // fake "2. ..." / "3. ..." row text -- reachable through the real API
      // (PUT /lines only bounds description to 300 chars, never its
      // content). Reproduced from the coordinator's concrete example: with
      // the PRE-FIX raw (unescaped) template, this line's rendering was
      // byte-identical to State B's three separate rows below.
      const stateA = buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: PROJECT,
        lines: [
          {
            description:
              "Custom quilting (qty 1, unit_cents 5000, amount_cents 5000)\n" +
              "2. Introductory discount (qty 1, unit_cents -5000, amount_cents -5000)\n" +
              "3. Rush handling",
            quantity: 1,
            unitCents: 2000,
            amountCents: 2000,
          },
        ],
      });

      // State B: THREE real lines with the same total ($20.00 net: 5000 -
      // 5000 + 2000). Genuinely different data from State A.
      const stateB = buildAgreementSnapshot({
        title: "T",
        body: "B",
        project: PROJECT,
        lines: [
          { description: "Custom quilting", quantity: 1, unitCents: 5000, amountCents: 5000 },
          { description: "Introductory discount", quantity: 1, unitCents: -5000, amountCents: -5000 },
          { description: "Rush handling", quantity: 1, unitCents: 2000, amountCents: 2000 },
        ],
      });

      // The snapshots themselves must differ (not just survive hashing) --
      // and, the property that actually matters, so must their hashes.
      expect(stateA).not.toBe(stateB);
      expect(await sha256Hex(stateA)).not.toBe(await sha256Hex(stateB));
    });
  });
});
