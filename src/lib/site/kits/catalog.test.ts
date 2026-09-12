import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KITS } from "./index";
import { KIT_CATALOG, catalogPolicy } from "./catalog";

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

  it("reserves Showcase classification for the six new IDs", () => {
    const ids = ["quilt-biennial", "common-thread-review", "patchwork-social", "atelier-noir", "fieldstone-retreat", "heirloom-house"];
    expect(ids.map((id, index) => catalogPolicy(id, 114 + index).collection)).toEqual(Array(6).fill("showcase"));
    expect(KITS.filter((kit) => ids.includes(kit.id)).map((kit) => kit.defaults.composition)).toEqual(["biennial", "review", "noir", "social", "fieldstone", "heirloom"]);
    expect(catalogPolicy("heritage", 0).collection).toBe("featured");
  });

  it("offers every showcase design to both guild and business sites", () => {
    const showcase = KIT_CATALOG.filter((entry) => entry.collection === "showcase");
    expect(showcase).toHaveLength(6);
    expect(showcase.map((entry) => KITS.find((kit) => kit.id === entry.id)?.audience)).toEqual(Array(6).fill("both"));
  });
});
