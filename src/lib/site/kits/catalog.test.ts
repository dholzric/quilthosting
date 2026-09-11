import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KITS } from "./index";
import { KIT_CATALOG } from "./catalog";

describe("kit catalog", () => {
  it("covers every registered and on-disk kit exactly once", () => {
    const disk = readdirSync(fileURLToPath(new URL(".", import.meta.url))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
    const registered = KITS.map((kit) => kit.id).sort();
    const catalog = KIT_CATALOG.map((entry) => entry.id).sort();
    expect(new Set(catalog).size).toBe(catalog.length);
    expect(catalog).toEqual(registered);
    expect(catalog).toEqual(disk);
  });

  it("features one representative per signature family plus compatibility references", () => {
    const featured = KIT_CATALOG.filter((entry) => entry.collection === "featured");
    expect(featured).toHaveLength(8);
    expect(new Set(featured.map((entry) => entry.family))).toEqual(new Set(["cinema", "destination", "poster", "collage", "journal", "salon", "classic"]));
    expect(featured.map((entry) => entry.id)).toEqual(["indigo-house", "weekend-house", "color-assembly", "paper-pieces", "linen-journal", "modern-heirloom", "minimal", "heritage"]);
  });
});
