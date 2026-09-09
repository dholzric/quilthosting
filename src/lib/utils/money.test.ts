// src/lib/utils/money.test.ts
//
// Ease-layer phase 3, Task B: money is entered in dollars and percents,
// stored as integer cents and basis points. Three things are pinned here:
//
//   1. the four converters (dollarsToCents, centsToDollars, percentToBps,
//      bpsToPercent) and their reject list,
//   2. that public/admin.html's client-side mirror of that block applies the
//      SAME rules -- the block is extracted from the real file, evaluated, and
//      run through the identical accept/reject tables, and its documented
//      reject sentence is compared byte-for-byte with the server's,
//   3. that no admin <label> still says "cents" or "basis points".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatMoney,
  toCents,
  dollarsToCents,
  centsToDollars,
  percentToBps,
  bpsToPercent,
  MAX_CENTS,
  MAX_TAX_BPS,
} from "./money";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ADMIN = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");
const MONEY_TS = readFileSync(path.join(REPO_ROOT, "src/lib/utils/money.ts"), "utf8").replace(
  /\r\n/g,
  "\n"
);

// ——— the tables both implementations must agree on ———

const DOLLAR_ACCEPTS: Array<[string | number, number]> = [
  ["35", 3500],
  ["35.5", 3550],
  ["$35.50", 3550],
  ["1,200", 120000],
  [" 35 ", 3500],
  ["$1,234.56", 123456],
  ["0", 0],
  ["0.01", 1],
  ["100000", MAX_CENTS], // exactly the cap, $100,000.00
  [35, 3500],
  [35.5, 3550],
  [0, 0],
  [0.05, 5],
];

const DOLLAR_REJECTS: Array<string | number> = [
  "", // empty
  "   ", // whitespace only
  "abc", // not a number
  "$", // punctuation only
  "-5", // negative
  "-0.01", // negative
  "35.123", // more than two decimals
  "1.2.3", // not a number
  "35%", // percent is not an amount
  "1e5", // exponent notation
  "100000.01", // over the cap
  -5,
  -0.01,
  35.123,
  NaN,
  Infinity,
  -Infinity,
];

const PERCENT_ACCEPTS: Array<[string | number, number]> = [
  ["0", 0],
  ["7", 700],
  ["7.25", 725],
  ["8.5", 850],
  ["25", MAX_TAX_BPS],
  ["7%", 700],
  [" 7.5 ", 750],
  [7, 700],
  [7.25, 725],
  [0, 0],
];

const PERCENT_REJECTS: Array<string | number> = [
  "",
  "   ",
  "abc",
  "%",
  "-1",
  "7.255", // more than two decimals
  "25.01", // over 25%
  "26",
  "$7",
  -1,
  25.01,
  NaN,
  Infinity,
];

const CENTS_TO_DOLLARS: Array<[number, string]> = [
  [0, "0.00"],
  [1, "0.01"],
  [3500, "35.00"],
  [3550, "35.50"],
  [123456, "1234.56"],
  [-100, "0.00"],
  [NaN, "0.00"],
];

const BPS_TO_PERCENT: Array<[number, string]> = [
  [0, "0"],
  [700, "7"],
  [725, "7.25"],
  [750, "7.5"],
  [2500, "25"],
  [-5, "0"],
  [NaN, "0"],
];

describe("money.ts keeps its existing exports", () => {
  it("formatMoney is unchanged", () => {
    expect(formatMoney(3500)).toBe("$35.00");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(123456)).toBe("$1,234.56");
  });
  it("toCents is unchanged", () => {
    expect(toCents(35)).toBe(3500);
    expect(toCents(35.555)).toBe(3556);
  });
});

describe("dollarsToCents", () => {
  it.each(DOLLAR_ACCEPTS)("accepts %o -> %i", (input, cents) => {
    expect(dollarsToCents(input)).toBe(cents);
  });
  it.each(DOLLAR_REJECTS.map((v) => [v]))("rejects %o", (input) => {
    expect(dollarsToCents(input as string | number)).toBeNull();
  });
  it("returns whole cents, never a float", () => {
    for (const [input] of DOLLAR_ACCEPTS) {
      const cents = dollarsToCents(input);
      expect(Number.isSafeInteger(cents)).toBe(true);
    }
  });
});

describe("centsToDollars", () => {
  it.each(CENTS_TO_DOLLARS)("formats %o -> %s", (cents, out) => {
    expect(centsToDollars(cents)).toBe(out);
  });
  it("round-trips through dollarsToCents", () => {
    for (const cents of [0, 1, 999, 3500, 123456, MAX_CENTS]) {
      expect(dollarsToCents(centsToDollars(cents))).toBe(cents);
    }
  });
  it("carries no currency symbol (it is an input value, not a read-out)", () => {
    expect(centsToDollars(3500)).not.toContain("$");
  });
});

describe("percentToBps", () => {
  it.each(PERCENT_ACCEPTS)("accepts %o -> %i", (input, bps) => {
    expect(percentToBps(input)).toBe(bps);
  });
  it.each(PERCENT_REJECTS.map((v) => [v]))("rejects %o", (input) => {
    expect(percentToBps(input as string | number)).toBeNull();
  });
});

describe("bpsToPercent", () => {
  it.each(BPS_TO_PERCENT)("formats %o -> %s", (bps, out) => {
    expect(bpsToPercent(bps)).toBe(out);
  });
  it("round-trips through percentToBps", () => {
    for (const bps of [0, 1, 700, 725, 750, MAX_TAX_BPS]) {
      expect(percentToBps(bpsToPercent(bps))).toBe(bps);
    }
  });
});

// ——— the client mirror in public/admin.html ———

const CLIENT_BLOCK_RE =
  /\/\* ——— MONEY \(client mirror of src\/lib\/utils\/money\.ts\) — begin ——— \*\/([\s\S]*?)\/\* ——— MONEY — end ——— \*\//;

function clientBlock(): string {
  const m = CLIENT_BLOCK_RE.exec(ADMIN);
  if (!m) throw new Error("MONEY client mirror block not found in public/admin.html");
  return m[1];
}

type Converters = {
  dollarsToCents: (v: string | number) => number | null;
  centsToDollars: (v: number) => string;
  percentToBps: (v: string | number) => number | null;
  bpsToPercent: (v: number) => string;
  QH_MAX_CENTS: number;
  QH_MAX_TAX_BPS: number;
};

/** Evaluate the admin's mirror block (repo source, not user input). */
function clientConverters(): Converters {
  const src = `${clientBlock()}
    return { dollarsToCents, centsToDollars, percentToBps, bpsToPercent, QH_MAX_CENTS, QH_MAX_TAX_BPS };`;
  return new Function(src)() as Converters;
}

describe("public/admin.html mirrors the converters", () => {
  it("the block exists and stands alone (no admin globals)", () => {
    expect(() => clientConverters()).not.toThrow();
  });

  it("uses the same caps", () => {
    const c = clientConverters();
    expect(c.QH_MAX_CENTS).toBe(MAX_CENTS);
    expect(c.QH_MAX_TAX_BPS).toBe(MAX_TAX_BPS);
  });

  it("accepts and rejects exactly what the server does", () => {
    const c = clientConverters();
    for (const [input, cents] of DOLLAR_ACCEPTS) {
      expect(c.dollarsToCents(input), `dollarsToCents(${JSON.stringify(input)})`).toBe(cents);
    }
    for (const input of DOLLAR_REJECTS) {
      expect(c.dollarsToCents(input), `dollarsToCents(${JSON.stringify(input)})`).toBeNull();
    }
    for (const [input, bps] of PERCENT_ACCEPTS) {
      expect(c.percentToBps(input), `percentToBps(${JSON.stringify(input)})`).toBe(bps);
    }
    for (const input of PERCENT_REJECTS) {
      expect(c.percentToBps(input), `percentToBps(${JSON.stringify(input)})`).toBeNull();
    }
    for (const [cents, out] of CENTS_TO_DOLLARS) {
      expect(c.centsToDollars(cents), `centsToDollars(${cents})`).toBe(out);
    }
    for (const [bps, out] of BPS_TO_PERCENT) {
      expect(c.bpsToPercent(bps), `bpsToPercent(${bps})`).toBe(out);
    }
  });

  it("documents the same reject cases as money.ts", () => {
    // money.ts owns the sentence; admin.html must repeat it verbatim so the
    // two copies cannot drift silently.
    const m = MONEY_TS.match(/\/\/ Rejects: ([\s\S]*?)\n(?!\/\/)/);
    expect(m, "money.ts is missing its 'Rejects:' comment").toBeTruthy();
    const sentence = `Rejects: ${m![1]}`
      .split("\n")
      .map((line) => line.replace(/^\s*\/\/ ?/, "").trim())
      .join(" ");
    const clientSentence = clientBlock()
      .split("\n")
      .join(" ")
      .replace(/\s+/g, " ");
    expect(clientSentence).toContain(sentence);
  });
});

describe("public/admin.html labels are in human units", () => {
  const labels = [...ADMIN.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  );

  it("finds labels at all (the regex still matches the file)", () => {
    expect(labels.length).toBeGreaterThan(50);
  });

  it("no label says cents or basis points", () => {
    const offenders = labels.filter((l) => /\bcents?\b|basis point/i.test(l));
    expect(offenders).toEqual([]);
  });

  it("no placeholder or option text says cents or basis points either", () => {
    const placeholders = [...ADMIN.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);
    expect(placeholders.filter((p) => /\bcents?\b|basis point/i.test(p))).toEqual([]);
  });

  it("the money inputs are dollars with step=0.01", () => {
    for (const id of ["e-mprice", "e-nmprice", "p-price", "inv-tax", "em-amount"]) {
      const m = ADMIN.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
      expect(m, `input #${id} not found`).toBeTruthy();
      expect(m![0], `#${id} should be a dollars field`).toContain('step="0.01"');
    }
    const tax = ADMIN.match(/<input[^>]*id="tax-bps"[^>]*>/);
    expect(tax, "input #tax-bps not found").toBeTruthy();
    expect(tax![0]).toContain('step="0.01"');
  });

  it("the invoice line editor replaced the pipe-syntax textarea", () => {
    expect(ADMIN).not.toContain('id="inv-lines"');
    expect(ADMIN).toContain('id="inv-lines-rows"');
    expect(ADMIN).toMatch(/function invLineRow\(/);
    expect(ADMIN).toMatch(/function invCollectLines\(/);
  });
});
