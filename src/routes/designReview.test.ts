// The design-review sheet's API.
//
// Reviewers here are collaborators who hold the site-gate password and have no
// account: the point of the sheet is that leaving a comment costs nothing.
// So the rules that matter are the ones that keep unauthenticated writes from
// doing damage — a bounded set of kits, a bounded reviewer label, a bounded
// comment, and no path to tenant data.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KITS } from "../lib/site/kits";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = readFileSync(path.join(REPO_ROOT, "src/routes/designReview.ts"), "utf8").replace(/\r\n/g, "\n");
const PAGE = readFileSync(path.join(REPO_ROOT, "public/design-review.html"), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = readFileSync(path.join(REPO_ROOT, "migrations/0032_design_reviews.sql"), "utf8");

describe("what an unauthenticated write may do", () => {
  it("only accepts a kit that exists", () => {
    // Otherwise the table fills with rows for designs nobody can ever see.
    expect(SRC).toContain("KIT_IDS.has(v)");
    expect(SRC).toContain("const KIT_IDS = new Set(KITS.map((k) => k.id))");
  });

  it("bounds the reviewer label, the rating and the comment", () => {
    expect(SRC).toMatch(/REVIEWER_RE = \/\^\[a-z0-9\]\[a-z0-9-\]\{0,39\}\$\//);
    expect(SRC).toContain("z.number().int().min(1).max(10)");
    expect(SRC).toContain("z.string().max(2000)");
    // Truncated on the way in as well as validated.
    expect(SRC).toContain('(r.comment || "").slice(0, 2000)');
  });

  it("never reads or writes tenant data", () => {
    // Comments stripped: prose about users is not a query against users.
    const code = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
    expect(code).toContain("design_reviews");
    for (const table of ["tenants", "members", "users", "events", "payments", "pages", "files"]) {
      expect(code, table).not.toMatch(new RegExp("\\b(from|into|update|join)\\s+" + table + "\\b"));
    }
  });
});

describe("the sheet behaves like a sheet", () => {
  it("gives each reviewer their own row per design", () => {
    // Two people reviewing at once must not overwrite each other.
    expect(MIGRATION).toContain("PRIMARY KEY (kit_id, reviewer)");
    expect(SRC).toContain("ON CONFLICT(kit_id, reviewer) DO UPDATE");
  });

  it("treats a fully cleared row as deleted, not as a blank review", () => {
    expect(SRC).toContain("const blank =");
    expect(SRC).toContain("DELETE FROM design_reviews WHERE kit_id = ? AND reviewer = ?");
  });

  it("serves the library with the screenshots the Design panel already ships", () => {
    // A second screenshot pipeline would be a second thing to keep current.
    expect(SRC).toContain("/kit-shots/");
    expect(SRC).not.toContain("playwright");
  });

  it("covers every design in the library", () => {
    expect(KITS.length).toBeGreaterThan(100);
  });
});

describe("the page", () => {
  it("asks for a name and says plainly when nothing will be saved", () => {
    expect(PAGE).toContain('id="who"');
    expect(PAGE).toContain("add your name above to save");
  });

  it("carries the three things a reviewer was asked for", () => {
    expect(PAGE).toMatch(/aria-label", i \+ " out of 10"/);
    expect(PAGE).toContain("Comments on ");
    expect(PAGE).toContain("Make this one of our default choices");
  });

  it("saves as you go rather than behind a submit button", () => {
    expect(PAGE).toContain("there is no submit button");
    expect(PAGE).toMatch(/method: "PUT"/);
    expect(PAGE).not.toMatch(/type="submit"/);
  });

  it("stays out of search results", () => {
    expect(PAGE).toContain('name="robots" content="noindex, nofollow"');
  });
});
