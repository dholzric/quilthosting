// Every starter design has a picture of itself.
//
// The Design panel used to show a miniature PAINTED from the palette's four
// colours. With 120 designs those are almost impossible to tell apart, which
// is the one job the card has — an owner picking a design cannot pick from
// 120 near-identical swatches.
//
// public/kit-shots/<id>.webp is the real page, rendered by the real renderer
// (scripts/kit-shots.mjs). Committed, so CI and deploys never run a browser.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KITS } from "./index";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SHOTS = path.join(REPO_ROOT, "public", "kit-shots");

describe("kit shots", () => {
  const files = readdirSync(SHOTS).filter((f) => f.endsWith(".webp"));

  it("exists for every design in the library", () => {
    const have = new Set(files);
    const missing = KITS.filter((k) => !have.has(`${k.id}.webp`)).map((k) => k.id);
    expect(missing, `run \`npm run kits:shots\` for: ${missing.join(", ")}`).toEqual([]);
  });

  it("carries no shot for a design that no longer exists", () => {
    const live = new Set(KITS.map((k) => k.id));
    const stale = files
      .map((f) => f.replace(/\.webp$/, ""))
      .filter((id) => !live.has(id));
    expect(stale, "these ship on every deploy and are shown to nobody").toEqual([]);
  });

  // The size guard lives in scripts/kit-shots.mjs, where the file is made:
  // the Worker's fs types only permit utf-8 reads, so a byte count here would
  // be a lie. The script refuses to write a shot over the cap.

  it("is served from a path the platform owns, not routed as a tenant page", async () => {
    const { PLATFORM_PATH_PREFIXES } = await import("../../platformPaths");
    expect(PLATFORM_PATH_PREFIXES).toContain("/kit-shots");
  });
});
