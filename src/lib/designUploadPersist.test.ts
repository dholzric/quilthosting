// Uploading an image in the Design panel has to commit it.
//
// The upload itself always worked: the file reached R2 and got a files row.
// What did not was the *reference* — the panel set design.pattern.fileId in
// memory, wrote "Save the design to use it", and left it there. An owner
// uploaded a quilt block, refreshed the page, and found the slot empty again;
// they tried three times. The stored file was real the whole time, and the
// only part they could see was the part that was never saved.
//
// So every upload and removal in this panel now calls save() itself. These
// tests read the real admin.html, because it has no build step and nothing
// else would notice if the awaits were dropped.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");

/** The body of the Design panel, where these four controls live. */
const PANEL = ADMIN.slice(ADMIN.indexOf("async function qhDesignPanel("));

/** The handler a given control attaches, up to its closing brace-ish region. */
function handlerNear(marker: string, span = 900): string {
  const i = PANEL.indexOf(marker);
  expect(i, `${marker} not found in the Design panel`).toBeGreaterThan(-1);
  return PANEL.slice(i, i + span);
}

describe("the Design panel commits its uploads", () => {
  it.each([
    ["a quilt block", 'design.pattern.fileId = id;'],
    ["a front page photo", 'design.heroPhoto = { fileId: id };'],
  ])("saves after uploading %s", (_name, marker) => {
    const body = handlerNear(marker, 400);
    expect(body).toContain("await save()");
  });

  it.each([
    ["the block", 'patClear.addEventListener'],
    ["the photo", 'heroClear.addEventListener'],
  ])("saves after removing %s", (_name, marker) => {
    const body = handlerNear(marker, 400);
    expect(body).toContain("await save()");
  });

  it("no longer tells the owner to go and save it themselves", () => {
    // The old copy was accurate and still lost people, because the sentence
    // sat next to a slot that already looked filled in.
    expect(PANEL).not.toContain("Save the design to use it");
  });

  it("keeps a handler that awaits save() async, so the await is real", () => {
    for (const marker of ["patClear.addEventListener", "heroClear.addEventListener"]) {
      expect(handlerNear(marker, 120)).toMatch(/addEventListener\("click", async \(\)/);
    }
  });
});
