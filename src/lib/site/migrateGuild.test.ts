// src/lib/site/migrateGuild.test.ts
// "Try the new design" composition (phase 2 Task D): block pages become
// styled section documents, the home page is composed when missing or
// completed when present, and the design comes from the legacy theme or
// the chosen kit. Pure -- no D1 here; the routes are covered in
// src/routes/tenants.test.ts.
import { describe, it, expect } from "vitest";
import { composeUpgrade, upgradedSiteSettings, downgradedSiteSettings } from "./migrateGuild";
import { blocksToSectionsStyled } from "./sections/normalize";
import { parseBlocks } from "../blocks";
import { parseSections } from "./sections/schema";
import { kitDesign, kitById } from "./kits";

const TENANT = {
  name: "Prairie Star Quilters",
  settings_json: JSON.stringify({
    theme: { primary: "#336699", font: "serif", style: "classic" },
    profile: { description: "A friendly guild in Lincoln.", meeting_info: "2nd Tuesdays, 6:30 pm", location: "Grange Hall" },
    site: { renderer: "legacy" },
  }),
};

const ABOUT_BLOCKS = [
  { type: "heading", text: "About us", level: 2 },
  { type: "text", html: "<p>We have quilted together since 1982.</p>" },
  { type: "heading", text: "Our meetings", level: 2 },
  { type: "text", html: "<p>Second Tuesdays.</p>" },
  { type: "divider" },
  { type: "image", url: "https://example.com/quilt.jpg", alt: "A quilt" },
  { type: "button", label: "Join", href: "/membership" },
];

const page = (slug: string, blocks: unknown[], id = `p_${slug}`) => ({
  id,
  slug,
  title: slug[0].toUpperCase() + slug.slice(1),
  blocks_json: JSON.stringify(blocks),
  content_json: null,
});

describe("blocksToSectionsStyled", () => {
  it("merges heading + text pairs into one rich_text with a heading and alternates tint/none", () => {
    const out = blocksToSectionsStyled(parseBlocks(ABOUT_BLOCKS));
    expect(out.map((s) => s.type)).toEqual(["rich_text", "rich_text", "divider", "image", "cta"]);
    const [first, second, divider, image, cta] = out;
    if (first.type !== "rich_text" || second.type !== "rich_text") throw new Error("expected rich_text");
    expect(first.heading).toBe("About us");
    expect(first.html).toBe("<p>We have quilted together since 1982.</p>");
    expect(second.heading).toBe("Our meetings");
    // Backgrounds alternate by content position; dividers/spacers neither count nor tint.
    expect(first.style.bg).toBe("none");
    expect(second.style.bg).toBe("tint");
    expect(divider.style.bg).toBe("none");
    expect(image.style.bg).toBe("none");
    expect(cta.style.bg).toBe("tint");
    // Ids are stable and unique.
    expect(out.map((s) => s.id)).toEqual(["s_0", "s_1", "s_2", "s_3", "s_4"]);
  });

  it("turns the first heading + text into a minimal hero when asked (home page)", () => {
    const out = blocksToSectionsStyled(parseBlocks(ABOUT_BLOCKS), { hero: true });
    expect(out[0].type).toBe("hero");
    if (out[0].type !== "hero") return;
    expect(out[0].variant).toBe("minimal");
    expect(out[0].title).toBe("About us");
    expect(out[0].subtitle).toBe("We have quilted together since 1982.");
    expect(out[0].style.align).toBe("center");
    expect(out[1].type).toBe("rich_text");
  });

  it("keeps a lone heading as a heading-only rich_text, and an existing hero block as a hero", () => {
    const lone = blocksToSectionsStyled(parseBlocks([{ type: "heading", text: "Only" }, { type: "divider" }]));
    expect(lone[0]).toMatchObject({ type: "rich_text", heading: "Only", html: "" });
    const hero = blocksToSectionsStyled(parseBlocks([{ type: "hero", title: "Welcome" }, { type: "text", html: "<p>x</p>" }]), { hero: true });
    expect(hero[0].type).toBe("hero");
    expect(hero[1].style.bg).toBe("tint");
  });

  it("does not tint a section that already carries a background (image hero)", () => {
    const out = blocksToSectionsStyled(
      parseBlocks([
        { type: "text", html: "<p>a</p>" },
        { type: "hero", title: "Photo", imageUrl: "/img/abc123" },
      ])
    );
    expect(out[1].type).toBe("hero");
    expect(out[1].style.bg).toBe("image");
  });

  it("produces documents parseSections accepts unchanged", () => {
    const out = blocksToSectionsStyled(parseBlocks(ABOUT_BLOCKS), { hero: true });
    const { sections, issues } = parseSections(out);
    expect(issues).toEqual([]);
    expect(sections).toEqual(out);
  });
});

describe("composeUpgrade", () => {
  it("converts every block page and composes a home when the guild has none", () => {
    const result = composeUpgrade(TENANT, [page("about", ABOUT_BLOCKS), page("contact", [{ type: "contact_form", formSlug: "hello" }])]);
    expect(result.createdHome).toBe(true);
    expect(result.kit).toBeNull();
    expect(result.pages.map((p) => p.slug)).toEqual(["about", "contact", "home"]);
    const about = result.pages[0];
    expect(about.id).toBe("p_about");
    expect(about.sections[0].type).toBe("rich_text"); // not a hero: only home gets one
    const home = result.pages[2];
    expect(home.id).toBeUndefined();
    expect(home.title).toBe("Home");
    expect(home.sections.map((s) => s.type)).toEqual(["hero", "meeting_info", "membership_levels", "events", "blog_teaser", "join_band"]);
    const hero = home.sections[0];
    if (hero.type !== "hero") throw new Error("expected hero");
    expect(hero.title).toBe("Prairie Star Quilters");
    expect(hero.subtitle).toBe("A friendly guild in Lincoln.");
    const meeting = home.sections[1];
    if (meeting.type !== "meeting_info") throw new Error("expected meeting_info");
    expect(meeting.when).toBe("2nd Tuesdays, 6:30 pm");
    expect(meeting.where).toBe("Grange Hall");
    // No two adjacent sections share a background on the composed home.
    for (let i = 1; i < home.sections.length; i++) {
      expect(home.sections[i].style.bg).not.toBe(home.sections[i - 1].style.bg);
    }
  });

  it("omits meeting_info from the composed home when the profile has no meeting info", () => {
    const tenant = { name: "G", settings_json: JSON.stringify({ profile: { description: "d" } }) };
    const result = composeUpgrade(tenant, []);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].sections.map((s) => s.type)).toEqual(["hero", "membership_levels", "events", "blog_teaser", "join_band"]);
  });

  it("keeps an existing home: hero from its first heading + text, then events/levels/join band appended", () => {
    const result = composeUpgrade(TENANT, [page("home", ABOUT_BLOCKS)]);
    expect(result.createdHome).toBe(false);
    expect(result.pages).toHaveLength(1);
    const home = result.pages[0];
    expect(home.id).toBe("p_home");
    const types = home.sections.map((s) => s.type);
    expect(types[0]).toBe("hero");
    expect(types.slice(-3)).toEqual(["events", "membership_levels", "join_band"]);
    const hero = home.sections[0];
    if (hero.type !== "hero") throw new Error("expected hero");
    expect(hero.title).toBe("About us");
    const events = home.sections.find((s) => s.type === "events");
    if (!events || events.type !== "events") throw new Error("expected events");
    expect(events.variant).toBe("cards");
    expect(events.limit).toBe(3);
    expect(new Set(home.sections.map((s) => s.id)).size).toBe(home.sections.length);
  });

  it("prepends the profile hero when the existing home does not start with a heading, and never duplicates dynamic sections", () => {
    const result = composeUpgrade(TENANT, [
      page("home", [
        { type: "text", html: "<p>Welcome!</p>" },
        { type: "events_list", limit: 5 },
        { type: "join_cta", title: "Join us" },
      ]),
    ]);
    const home = result.pages[0];
    const types = home.sections.map((s) => s.type);
    expect(types[0]).toBe("hero");
    const hero = home.sections[0];
    if (hero.type !== "hero") throw new Error("expected hero");
    expect(hero.title).toBe("Prairie Star Quilters");
    expect(types.filter((t) => t === "events")).toHaveLength(1);
    expect(types.filter((t) => t === "join_band")).toHaveLength(1);
    expect(types.filter((t) => t === "membership_levels")).toHaveLength(1);
  });

  it("leaves a page that is already a section document untouched", () => {
    const doc = [{ type: "hero", variant: "split", title: "Kit hero", style: { bg: "brand", width: "normal", spacing: "normal", align: "left", media: "right" }, id: "k1" }];
    const result = composeUpgrade(TENANT, [page("home", doc)]);
    expect(result.pages[0].sections[0]).toMatchObject({ type: "hero", variant: "split", title: "Kit hero", id: "k1" });
    expect(result.pages[0].sections[0].style.bg).toBe("brand");
  });

  it("falls back to content_json html for a page without blocks", () => {
    const result = composeUpgrade(TENANT, [
      { id: "p1", slug: "old", title: "Old", blocks_json: null, content_json: JSON.stringify({ html: "<p>Legacy html</p>" }) },
    ]);
    expect(result.pages[0].sections).toHaveLength(1);
    expect(result.pages[0].sections[0]).toMatchObject({ type: "rich_text", html: "<p>Legacy html</p>" });
  });

  it("migrates the legacy guild theme to the design, or uses the kit's defaults when a kit is given", () => {
    const migrated = composeUpgrade(TENANT, []);
    expect(migrated.design.palette.input.brand).toBe("#336699");
    expect(migrated.design.typePair).toBe("playfair-lato");
    const kit = kitById("heritage")!;
    const withKit = composeUpgrade(TENANT, [], "heritage");
    expect(withKit.kit).toBe("heritage");
    expect(withKit.design).toEqual(kitDesign(kit));
    expect(() => composeUpgrade(TENANT, [], "no-such-kit")).toThrow(/kit/i);
  });
});

describe("site settings for upgrade / downgrade", () => {
  it("upgrade marks the renderer, kit, timestamp, created-home flag and the previous renderer; keeps every other key", () => {
    const before = { theme: { primary: "#336699" }, profile: { description: "d" }, site: { renderer: "legacy" }, nav: [{ label: "A", href: "/a" }] };
    const composition = composeUpgrade({ name: "G", settings_json: JSON.stringify(before) }, [], "heritage");
    const after = upgradedSiteSettings(before, composition, "2026-09-08T00:00:00.000Z");
    expect(after.theme).toEqual(before.theme);
    expect(after.nav).toEqual(before.nav);
    expect(after.site).toEqual({
      renderer: "sections",
      kit: "heritage",
      upgraded_at: "2026-09-08T00:00:00.000Z",
      upgrade_created_home: true,
      previous: { renderer: "legacy" },
    });
    expect(after.design).toEqual(composition.design);
  });

  it("upgrade without a kit records kit null and the migrated design; a prior custom design is remembered for downgrade", () => {
    const before = { design: { typePair: "manrope" }, site: { renderer: "legacy" } };
    const composition = composeUpgrade({ name: "G", settings_json: JSON.stringify(before) }, [{ id: "h", slug: "home", title: "Home", blocks_json: "[]", content_json: null }], "heritage");
    const after = upgradedSiteSettings(before, composition, "t");
    expect((after.site as any).kit).toBe("heritage");
    expect((after.site as any).upgrade_created_home).toBe(false);
    expect((after.site as any).previous).toEqual({ renderer: "legacy", design: before.design });
    const plain = upgradedSiteSettings({}, composeUpgrade({ name: "G", settings_json: "{}" }, []), "t");
    expect((plain.site as any).kit).toBeNull();
    expect(plain.design).toBeDefined();
  });

  it("downgrade restores renderer legacy and the remembered design, dropping the upgrade markers", () => {
    const before = { design: { typePair: "manrope" }, theme: { primary: "#336699" }, site: { renderer: "legacy" } };
    const composition = composeUpgrade({ name: "G", settings_json: JSON.stringify(before) }, [], "heritage");
    const upgraded = upgradedSiteSettings(before, composition, "t1");
    const restored = downgradedSiteSettings(upgraded, "t2");
    expect(restored.theme).toEqual(before.theme);
    expect(restored.design).toEqual(before.design);
    expect(restored.site).toEqual({ renderer: "legacy", downgraded_at: "t2", previous: { renderer: "sections", kit: "heritage" } });
    // Without a remembered design the migrated one stays (nothing to restore).
    const plain = downgradedSiteSettings(upgradedSiteSettings({}, composeUpgrade({ name: "G", settings_json: "{}" }, []), "t"), "t2");
    expect(plain.design).toBeDefined();
    expect((plain.site as any).renderer).toBe("legacy");
  });
});
