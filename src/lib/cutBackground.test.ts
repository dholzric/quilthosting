// Removing a logo's background, in the owner's browser.
//
// Guild logos are very often a photograph of an embroidered or appliqued badge
// lying on white cloth, so the badge arrives inside a pale rectangle that
// reads as a box against the page. One guild hit exactly that, and the fix was
// an operator running an image tool by hand and re-uploading for them — which
// is precisely the kind of thing customers must be able to do themselves.
//
// admin.html has no build step, so these pin the algorithm's contract from the
// source. The visual result was checked by running this same function in a
// real browser against the guild's own logo.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");
const FN = ADMIN.slice(
  ADMIN.indexOf("async function wbCutBackground"),
  ADMIN.indexOf("async function wbUploadImage")
);

describe("wbCutBackground", () => {
  it("exists and is a real function body", () => {
    expect(FN.length).toBeGreaterThan(400);
    expect(() => new Function("return " + FN.trim())).not.toThrow();
  });

  it("seeds only from the four edges, so pale fabric inside the badge is kept", () => {
    // The centre of a patch is usually pale. A plain "make white transparent"
    // would punch holes through the middle of the artwork.
    expect(FN).toMatch(/for \(let x = 0; x < w; x\+\+\).*push\(x, 0\).*push\(x, h - 1\)/s);
    expect(FN).toMatch(/for \(let y = 0; y < h; y\+\+\).*push\(0, y\).*push\(w - 1, y\)/s);
  });

  it("requires a pixel to be both pale AND near-neutral", () => {
    // Brightness alone would eat a pale yellow or pink area of the artwork.
    expect(FN).toContain("minL");
    expect(FN).toContain("maxChroma");
    expect(FN).toMatch(/lo > minL && hi - lo < maxChroma/);
  });

  it("gives up rather than returning a subtly damaged image", () => {
    // Nothing flat around the edges means this is not that kind of picture.
    expect(FN).toMatch(/if \(cut < seen\.length \* 0\.02\) return null/);
    // And an undecodable file leaves the original alone.
    expect(FN).toMatch(/catch \{ return null; \}/);
  });

  it("softens the cut edge instead of leaving it stair-stepped", () => {
    expect(FN).toContain("edge.push(p)");
    expect(FN).toMatch(/d\[p \* 4 \+ 3\] = 140/);
  });

  it("trims to what survived, which is what removes the dead margin", () => {
    expect(FN).toMatch(/out\.width = tw; out\.height = th/);
    expect(FN).toContain("drawImage(c, x0, y0, tw, th, 0, 0, tw, th)");
  });

  it("returns PNG, because the cut is worthless without an alpha channel", () => {
    expect(FN).toContain('toBlob(res, "image/png")');
    expect(FN).toMatch(/type: "image\/png"/);
  });

  it("refuses an image big enough to hang the tab", () => {
    expect(FN).toMatch(/w \* h > 40e6/);
  });
});

describe("the owner drives it, and can see what it will do first", () => {
  const PREVIEW = ADMIN.slice(ADMIN.indexOf("async function previewGuildLogo"), ADMIN.indexOf("async function uploadGuildLogo"));

  it("is opt-in, not applied to every upload", () => {
    expect(ADMIN).toContain('id="logo-cutbg"');
    expect(ADMIN).toContain("Remove the background behind it");
  });

  it("re-previews when either the checkbox or the chosen file changes", () => {
    expect(ADMIN).toMatch(/id="logo-cutbg"[^>]*onchange="previewGuildLogo\(\)"/);
    expect(ADMIN).toMatch(/id="logo-input"[^>]*onchange="previewGuildLogo\(\)"/);
  });

  it("shows before and after rather than just claiming it worked", () => {
    expect(ADMIN).toContain('id="logo-cut-before"');
    expect(ADMIN).toContain('id="logo-cut-after"');
    // On a chequerboard, or transparency is invisible against a white card.
    expect(ADMIN).toContain("repeating-conic-gradient");
  });

  it("says so plainly when there was nothing to cut", () => {
    expect(PREVIEW).toContain("No flat background found");
  });

  it("uploads the cut file only when the box is ticked", () => {
    const UP = ADMIN.slice(ADMIN.indexOf("async function uploadGuildLogo"));
    expect(UP).toMatch(/const f = \(cutOn && cutOn\.checked && _logoCutFile\) \|\| chosen;/);
  });
});
