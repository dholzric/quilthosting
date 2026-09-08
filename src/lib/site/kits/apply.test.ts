// src/lib/site/kits/apply.test.ts
// Applying a kit to a tenant: placeholder substitution (HTML-escaped inside
// rich HTML, raw in plain fields that the renderer escapes), the page rows
// tenants.ts inserts, the settings_json the renderer reads, and the legacy
// block downgrade starterSite.ts uses for guild.html.
import { describe, it, expect } from "vitest";
import {
  CITY_FALLBACK,
  MEETING_INFO_FALLBACK,
  kitDesign,
  kitPageRows,
  kitSettingsJson,
  sectionsToLegacyBlocks,
  substitutePlaceholders,
} from "./apply";
import { kitSchema } from "./schema";
import { kitById } from "./index";
import heritage from "./heritage.json";
import { readSiteDesign } from "../design/migrate";
import { paletteById } from "../design/palettes";
import { parseSections, type Section } from "../sections/schema";
import { parseBlocks } from "../../blocks";
import { SAMPLE_MARKER } from "../../starterSite";

const kit = kitSchema.parse(heritage);
const NOW = "2026-09-08T12:00:00.000Z";

function sections(raw: unknown[]): Section[] {
  const r = parseSections(raw);
  expect(r.issues).toEqual([]);
  return r.sections;
}

describe("substitutePlaceholders", () => {
  const src = sections([
    { type: "hero", title: "Welcome to {{guild_name}}", subtitle: "Quilters in {{city}}", ctaLabel: "Join", ctaHref: "/membership" },
    { type: "rich_text", html: "<p>{{guild_name}} meets {{meeting_info}} in {{city}}.</p>" },
    { type: "faq", items: [{ q: "Where is {{guild_name}}?", a: "In {{city}}" }] },
    { type: "meeting_info", when: "{{meeting_info}}", where: "{{city}}" },
  ]);

  it("substitutes raw into plain fields and HTML-escaped into html fields", () => {
    const out = substitutePlaceholders(src, {
      guildName: "Bee & Thread <Guild>",
      city: "Austin, TX <b>",
      meetingInfo: "1st Thursdays 7pm",
    });
    expect(out[0]).toMatchObject({ title: "Welcome to Bee & Thread <Guild>", subtitle: "Quilters in Austin, TX <b>" });
    expect(out[1]).toMatchObject({ html: "<p>Bee &amp; Thread &lt;Guild&gt; meets 1st Thursdays 7pm in Austin, TX &lt;b&gt;.</p>" });
    expect(out[2]).toMatchObject({ items: [{ q: "Where is Bee & Thread <Guild>?", a: "In Austin, TX &lt;b&gt;" }] });
    expect(out[3]).toMatchObject({ when: "1st Thursdays 7pm", where: "Austin, TX <b>" });
  });

  it("does not mutate its input and leaves ids and style untouched", () => {
    const before = JSON.stringify(src);
    const out = substitutePlaceholders(src, { guildName: "X" });
    expect(JSON.stringify(src)).toBe(before);
    expect(out[0].id).toBe(src[0].id);
    expect(out[0].style).toEqual(src[0].style);
  });

  it("falls back for missing city and meeting info", () => {
    const out = substitutePlaceholders(src, { guildName: "X", city: "", meetingInfo: null });
    expect(out[3]).toMatchObject({ when: MEETING_INFO_FALLBACK, where: CITY_FALLBACK });
    expect(MEETING_INFO_FALLBACK).toContain("second Tuesday of every month");
  });

  it("leaves unknown placeholders alone", () => {
    const out = substitutePlaceholders(sections([{ type: "rich_text", html: "<p>{{unknown}} {{guild_name}}</p>" }]), {
      guildName: "G",
    });
    expect(out[0]).toMatchObject({ html: "<p>{{unknown}} G</p>" });
  });
});

describe("kitPageRows", () => {
  const tenant = { id: "t1", name: "Prairie Star", city: "Lincoln, NE", meetingInfo: "2nd Tuesdays at 6:30 pm" };
  const rows = kitPageRows(kit, tenant, NOW);

  it("returns one row per kit page in order, with the column set tenants.ts binds", () => {
    expect(rows.map((r) => r.slug)).toEqual(kit.pages.map((p) => p.slug));
    rows.forEach((r, i) => {
      expect(r.sort_order).toBe(i);
      expect(r.tenant_id).toBe("t1");
      expect(r.created_at).toBe(NOW);
      expect(r.updated_at).toBe(NOW);
      expect(typeof r.title).toBe("string");
      expect([0, 1]).toContain(r.show_in_nav);
      expect([0, 1]).toContain(r.is_members_only);
      expect(r.nav_label === null || typeof r.nav_label === "string").toBe(true);
    });
    expect(rows[0].show_in_nav).toBe(0); // home is not a nav item
    expect(rows.find((r) => r.slug === "why-join")?.nav_label).toBe("Join");
  });

  it("stores a section document in blocks_json that parseSections reads back losslessly", () => {
    for (const row of rows) {
      const doc = JSON.parse(row.blocks_json);
      const r = parseSections(doc);
      expect(r.issues).toEqual([]);
      expect(r.sections).toEqual(doc);
    }
  });

  it("substitutes placeholders and keeps the sample marker on every page", () => {
    const all = JSON.stringify(rows);
    expect(all).not.toContain("{{guild_name}}");
    expect(all).not.toContain("{{city}}");
    expect(all).not.toContain("{{meeting_info}}");
    expect(all).toContain("Prairie Star");
    expect(all).toContain("Lincoln, NE");
    expect(all).toContain("2nd Tuesdays at 6:30 pm");
    for (const row of rows) {
      expect(row.blocks_json, row.slug).toContain(SAMPLE_MARKER);
      expect(JSON.parse(row.content_json).html, row.slug).toContain(SAMPLE_MARKER);
    }
  });

  it("writes a plain-HTML fallback into content_json", () => {
    const home = JSON.parse(rows[0].content_json) as { html: string };
    expect(home.html).toContain("<h1");
    expect(home.html).toContain("Welcome to Prairie Star");
  });

  it("escapes tenant strings inside rich HTML", () => {
    const r = kitPageRows(kit, { id: "t", name: "Bee & Thread <Guild>", city: "Austin <b>", meetingInfo: "" }, NOW);
    const about = r.find((x) => x.slug === "about")!;
    expect(about.blocks_json).toContain("Bee &amp; Thread &lt;Guild&gt;"); // inside rich_text html
    expect(about.blocks_json).toContain("About Bee & Thread <Guild>"); // plain hero title, escaped at render
    const meetings = r.find((x) => x.slug === "meetings")!;
    expect(meetings.blocks_json).toContain(MEETING_INFO_FALLBACK);
    const contact = r.find((x) => x.slug === "contact")!;
    expect(contact.blocks_json).toContain("Austin &lt;b&gt;");
  });
});

describe("kitDesign / kitSettingsJson", () => {
  it("expands the palette id into the library input", () => {
    const d = kitDesign(kit);
    expect(d.palette).toEqual({ id: "heritage-madder", input: paletteById("heritage-madder")!.input });
    expect(d.typePair).toBe("cormorantgaramond-sourcesans");
    expect(d.footer.variant).toBe("meeting");
    expect(d.pattern).toEqual({ id: "log-cabin", opacity: 0.14 });
  });

  it("writes design + site.renderer/kit, and readSiteDesign reads it back", () => {
    const json = kitSettingsJson(kit);
    const parsed = JSON.parse(json);
    expect(parsed.site).toEqual({ renderer: "sections", kit: "heritage" });
    expect(parsed.design.palette.id).toBe("heritage-madder");
    expect(readSiteDesign(json)).toEqual(kitDesign(kit));
    expect(parsed.nav).toBeUndefined(); // heritage lists nav pages in order; no explicit menu
  });

  it("copies an explicit kit menu into settings.nav", () => {
    const withMenu = { ...kit, menu: [{ label: "Join", href: "/membership", children: [{ label: "Levels", href: "/membership" }] }] };
    const parsed = JSON.parse(kitSettingsJson(withMenu));
    expect(parsed.nav).toEqual(withMenu.menu);
  });
});

describe("sectionsToLegacyBlocks", () => {
  it("downgrades the common sections to blocks guild.html and the guild builder render", () => {
    const blocks = sectionsToLegacyBlocks(
      sections([
        { type: "hero", eyebrow: "Since 1984", title: "Welcome", subtitle: "Hi <b>", ctaLabel: "Join", ctaHref: "/membership", secondaryLabel: "Visit", secondaryHref: "/meetings" },
        { type: "rich_text", heading: "Our story", html: "<p>Text</p>" },
        { type: "feature_grid", heading: "What we do", items: [{ title: "Bees", body: "Small groups" }, { title: "Retreats", price: "$40" }] },
        { type: "meeting_info", heading: "When", when: "Tuesdays", where: "The hall", address: "1 Main St", note: "Guests welcome", mapUrl: "https://maps.example/x" },
        { type: "events", variant: "cards", limit: 3 },
        { type: "join_band", title: "Join us", body: "Body", ctaLabel: "Join" },
        { type: "membership_levels", heading: "Levels" },
        { type: "faq", heading: "Questions", items: [{ q: "Q1", a: "A1" }] },
        { type: "testimonials", items: [{ quote: "Lovely", author: "Ann" }] },
        { type: "gallery", source: "gallery" },
        { type: "gallery", source: "manual", items: [{ url: "https://x/y.jpg", alt: "A quilt" }] },
        { type: "image", items: [{ url: "https://x/z.jpg", alt: "Z", caption: "Cap" }] },
        { type: "cta", label: "Go", href: "/about", kind: "secondary" },
        { type: "divider" },
        { type: "spacer", height: 40 },
        { type: "blog_teaser", limit: 3 },
        { type: "store_teaser", limit: 3 },
        { type: "contact", showDetails: true },
        { type: "embed", html: '<iframe src="https://www.youtube.com/embed/abc"></iframe>' },
        { type: "quote_cta", projectType: "longarm", heading: "Quote" },
      ])
    );
    expect(blocks[0]).toEqual({ type: "heading", text: "Welcome", level: 1 });
    expect(JSON.stringify(blocks)).toContain("Hi &lt;b&gt;");
    expect(JSON.stringify(blocks)).not.toContain("<b>");
    const types = blocks.map((b) => b.type);
    expect(types).toContain("join_cta");
    expect(types).toContain("divider");
    expect(types).toContain("spacer");
    expect(types).toContain("image");
    expect(types).toContain("html");
    expect(types).toContain("project_intake");
    // Dynamic sections the legacy shell cannot render become links or vanish.
    const buttons = blocks.filter((b) => b.type === "button") as { href: string; label: string }[];
    expect(buttons.map((b) => b.href)).toEqual(expect.arrayContaining(["/membership", "/meetings", "/events", "/galleries", "/about", "https://maps.example/x"]));
    expect(types).not.toContain("events_list");
    // Every block survives the editor round trip unchanged.
    expect(parseBlocks(JSON.parse(JSON.stringify(blocks)))).toEqual(blocks);
  });

  it("keeps the sample marker from rich text and plain fields", () => {
    const blocks = sectionsToLegacyBlocks(
      sections([{ type: "hero", title: "T", subtitle: `${SAMPLE_MARKER} sub` }, { type: "rich_text", html: `<p><em>${SAMPLE_MARKER}</em> body</p>` }])
    );
    expect(JSON.stringify(blocks).split(SAMPLE_MARKER).length - 1).toBe(2);
  });
});

describe("registry", () => {
  it("kitById returns the parsed Heritage kit", () => {
    expect(kitById("heritage")?.pages.length).toBe(8);
  });
});
