// src/lib/firstRun.test.ts
// The first-run wizard's server-side state (Task C). Every assertion here is
// about DERIVED state: firstRunState() is handed a tenant row and must decide
// which of the four screens the owner should resume on without ever reading a
// stored cursor. The curated kit list is pinned too — the wizard promises six
// guild designs before "More designs", and public/admin.html must offer the
// same six in the same order.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURATED_GUILD_KIT_IDS,
  FIRST_RUN_DEFAULT_KIT,
  firstRunKits,
  firstRunState,
  hasChosenPalette,
  readSiteKit,
} from "./firstRun";
import { KITS, kitById, kitSettingsJson } from "./site/kits";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN_HTML = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");

const PUBLIC_URL = "https://quilthosting.com/g/prairie-star";

function tenant(settingsJson: string | null) {
  return { id: "t1", slug: "prairie-star", settings_json: settingsJson } as Parameters<typeof firstRunState>[0];
}

function settingsFor(kitId: string, extra: Record<string, unknown> = {}) {
  const kit = kitById(kitId);
  if (!kit) throw new Error(`no kit ${kitId}`);
  return JSON.stringify({ ...JSON.parse(kitSettingsJson(kit)), ...extra });
}

describe("readSiteKit", () => {
  it("reads settings.site.kit and tolerates junk", () => {
    expect(readSiteKit(settingsFor("minimal"))).toBe("minimal");
    expect(readSiteKit("{}")).toBeNull();
    expect(readSiteKit(null)).toBeNull();
    expect(readSiteKit("not json")).toBeNull();
    expect(readSiteKit(JSON.stringify({ site: { kit: 12 } }))).toBeNull();
  });
});

describe("hasChosenPalette", () => {
  it("is false while the palette is still the kit's own", () => {
    expect(hasChosenPalette(settingsFor("heritage"))).toBe(false);
    expect(hasChosenPalette(settingsFor("minimal"))).toBe(false);
  });

  it("is true once a different library palette is saved", () => {
    const s = JSON.parse(settingsFor("heritage"));
    s.design.palette = { id: "jewel-emerald", input: { brand: "#1c6b4a", brandAlt: "#0f3f2c", accent: "#d9b24a", neutral: "#172520" } };
    expect(hasChosenPalette(JSON.stringify(s))).toBe(true);
  });

  it("is true once custom colours (from a logo) are saved", () => {
    const s = JSON.parse(settingsFor("heritage"));
    s.design.palette = { input: { brand: "#123456", brandAlt: "#223344", accent: "#ffcc00", neutral: "#111111" } };
    expect(hasChosenPalette(JSON.stringify(s))).toBe(true);
  });

  it("compares against the default design when no kit is recorded, and never throws", () => {
    expect(hasChosenPalette("{}")).toBe(false);
    expect(hasChosenPalette("not json")).toBe(false);
    expect(hasChosenPalette(JSON.stringify({ design: { palette: { id: "jewel-emerald" } } }))).toBe(true);
  });
});

describe("firstRunState", () => {
  it("resumes on 2 (pick a design) for a guild still on the kit the create route defaults to", () => {
    const state = firstRunState(tenant(settingsFor(FIRST_RUN_DEFAULT_KIT)), PUBLIC_URL);
    expect(state.done).toBe(false);
    expect(state.step).toBe(2);
    expect(state.guild).toEqual({
      slug: "prairie-star",
      public_url: PUBLIC_URL,
      kit: FIRST_RUN_DEFAULT_KIT,
      has_logo: false,
      has_palette: false,
    });
  });

  it("resumes on 3 (make it yours) once a design has been chosen", () => {
    const state = firstRunState(tenant(settingsFor("show-festival")), PUBLIC_URL);
    expect(state.step).toBe(3);
    expect(state.done).toBe(false);
    expect(state.guild.kit).toBe("show-festival");
  });

  it("is done on 4 once a logo is uploaded — from either settings key", () => {
    const profile = settingsFor("heritage", { profile: { logo_file_id: "abc123" } });
    expect(firstRunState(tenant(profile), PUBLIC_URL)).toMatchObject({ done: true, step: 4 });
    const assets = settingsFor("heritage", { assets: { logo_file_id: "abc123" } });
    const state = firstRunState(tenant(assets), PUBLIC_URL);
    expect(state).toMatchObject({ done: true, step: 4 });
    expect(state.guild.has_logo).toBe(true);
  });

  it("is done on 4 once colours are chosen even without a logo", () => {
    const s = JSON.parse(settingsFor("heritage"));
    s.design.palette = { id: "soft-sky" };
    const state = firstRunState(tenant(JSON.stringify(s)), PUBLIC_URL);
    expect(state).toMatchObject({ done: true, step: 4 });
    expect(state.guild.has_palette).toBe(true);
    expect(state.guild.has_logo).toBe(false);
  });

  it("falls back to 2 for a tenant with no kit at all, and never throws on junk", () => {
    expect(firstRunState(tenant("{}"), PUBLIC_URL)).toMatchObject({ step: 2, done: false });
    expect(firstRunState(tenant(null), PUBLIC_URL)).toMatchObject({ step: 2, done: false });
    const junk = firstRunState(tenant("}{"), PUBLIC_URL);
    expect(junk.step).toBe(2);
    expect(junk.guild.kit).toBeNull();
  });
});

describe("firstRunKits", () => {
  it("offers exactly six curated guild designs, in the documented order", () => {
    const { curated } = firstRunKits("guild");
    expect(curated).toHaveLength(6);
    expect(curated.map((k) => k.id)).toEqual([
      "heritage",
      "modern-guild",
      "prairie",
      "show-festival",
      "community-threads",
      "minimal",
    ]);
    expect(curated.map((k) => k.id)).toEqual([...CURATED_GUILD_KIT_IDS]);
    for (const k of curated) expect(k.audience).not.toBe("business");
  });

  it("puts every other kit for that tenant type behind More designs, with no repeats", () => {
    const { curated, more } = firstRunKits("guild");
    const ids = new Set(curated.map((k) => k.id));
    for (const k of more) {
      expect(ids.has(k.id)).toBe(false);
      expect(k.audience).not.toBe("business");
    }
    expect(curated.length + more.length).toBe(KITS.filter((k) => k.audience !== "business").length);
  });

  it("never shows guild-only kits to a business tenant", () => {
    const { curated, more } = firstRunKits("business");
    for (const k of [...curated, ...more]) expect(k.audience).not.toBe("guild");
    expect(curated.length + more.length).toBe(KITS.filter((k) => k.audience !== "guild").length);
  });

  it("every curated id is a real kit", () => {
    for (const id of CURATED_GUILD_KIT_IDS) expect(kitById(id)).not.toBeNull();
  });
});

describe("public/admin.html mirrors the curated list", () => {
  it("declares the same six kit ids in the same order", () => {
    const m = ADMIN_HTML.match(/const FR_CURATED_KITS = \[([^\]]*)\]/);
    expect(m, "public/admin.html must declare FR_CURATED_KITS").toBeTruthy();
    const ids = (m as RegExpMatchArray)[1].match(/"[a-z0-9-]+"/g)?.map((s) => s.slice(1, -1)) || [];
    expect(ids).toEqual([...CURATED_GUILD_KIT_IDS]);
  });
});
