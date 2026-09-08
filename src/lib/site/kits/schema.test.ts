// src/lib/site/kits/schema.test.ts
// The kit validator is the gate for contributed kits, so every rule it
// enforces is pinned here with the exact issue path an author would see.
// The second half iterates every kit JSON file in this directory (this is
// what `npm run kits:validate` runs), so a broken kit fails the suite.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kitSchema, validateKit, KIT_SYSTEM_PATHS } from "./schema";
import { KITS, kitById } from "./index";
import heritage from "./heritage.json";
import { RESERVED_SLUGS } from "../../../routes/pages";
import { SECTION_TYPES, SECTION_VARIANTS } from "../sections/schema";
import { SAMPLE_MARKER } from "../../starterSite";

const KITS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(KITS_DIR, "../../../..");

/** existsSync/basename are not in the Worker-types shims of node:fs/node:path; a directory listing is. */
function fileExists(abs: string): boolean {
  const name = abs.split(/[\\/]/).pop() ?? "";
  try {
    return readdirSync(path.dirname(abs)).includes(name);
  } catch {
    return false;
  }
}

/** A minimal valid kit to mutate in the negative cases. */
function tinyKit(): Record<string, any> {
  return {
    id: "tiny",
    name: "Tiny",
    audience: "guild",
    character: "One page, one hero.",
    defaults: {
      palette: "heritage-madder",
      typePair: "cormorantgaramond-sourcesans",
      scale: "comfortable",
      shape: { radius: "soft", shadow: "subtle" },
      rhythm: { spacing: "normal", container: "normal" },
      header: { variant: "left", sticky: true, cta: "join", overlayHero: false },
      footer: { variant: "meeting" },
      pattern: { id: "log-cabin", opacity: 0.14 },
    },
    imagery: [{ id: "hero-art", kind: "pattern", alt: "" }],
    previewSeed: { guildName: "Bluebonnet Quilt Guild", city: "Round Rock, Texas" },
    pages: [
      {
        slug: "home",
        title: "Home",
        nav: false,
        sections: [
          {
            type: "hero",
            variant: "pattern",
            title: "Welcome to {{guild_name}}",
            subtitle: `${SAMPLE_MARKER} A guild in {{city}}.`,
            ctaLabel: "Join",
            ctaHref: "/membership",
            style: { bg: "pattern", imageId: "hero-art" },
          },
          { type: "rich_text", variant: "prose", html: `<p><em>${SAMPLE_MARKER}</em> We meet {{meeting_info}}.</p>` },
        ],
      },
      {
        slug: "about",
        title: "About",
        nav: true,
        sections: [{ type: "rich_text", html: `<p>${SAMPLE_MARKER} About us.</p>` }],
      },
    ],
  };
}

function issuePaths(raw: unknown): string[] {
  return validateKit(raw).issues.map((i) => i.path);
}

describe("validateKit — reference kit", () => {
  it("the Heritage kit validates with zero issues", () => {
    const r = validateKit(heritage);
    expect(r.issues).toEqual([]);
    expect(r.kit?.id).toBe("heritage");
  });

  it("kitSchema parses the Heritage kit into typed sections with ids and styles", () => {
    const kit = kitSchema.parse(heritage);
    for (const page of kit.pages) {
      for (const s of page.sections) {
        expect(s.id).toMatch(/^[a-z0-9_-]{1,40}$/);
        expect(s.style.bg).toBeDefined();
      }
    }
    expect(kit.defaults.palette).toBe("heritage-madder");
  });
});

describe("validateKit — schema issues carry the exact path", () => {
  it("accepts the tiny fixture", () => {
    expect(validateKit(tinyKit()).issues).toEqual([]);
  });

  it("rejects a non-object", () => {
    expect(issuePaths(null)).toEqual(["kit"]);
    expect(issuePaths([])).toEqual(["kit"]);
  });

  it("reports an unknown section type at pages.N.sections.M.type", () => {
    const k = tinyKit();
    k.pages[0].sections.push({ type: "sponsors", items: [] });
    expect(issuePaths(k)).toContain("pages.0.sections.2.type");
  });

  it("rejects legacy block types (text, heading, join_cta) as sections", () => {
    const k = tinyKit();
    k.pages[1].sections.push({ type: "text", html: "<p>old</p>" });
    expect(issuePaths(k)).toContain("pages.1.sections.1.type");
  });

  it("reports an unknown variant at pages.N.sections.M.variant", () => {
    const k = tinyKit();
    k.pages[0].sections[0].variant = "cinematic";
    expect(issuePaths(k)).toContain("pages.0.sections.0.variant");
  });

  it("reports a missing required field on a section", () => {
    const k = tinyKit();
    delete k.pages[0].sections[0].title;
    expect(issuePaths(k)).toContain("pages.0.sections.0.title");
  });

  it("reports a reserved page slug at pages.N.slug", () => {
    const k = tinyKit();
    k.pages[1].slug = "membership";
    expect(issuePaths(k)).toContain("pages.1.slug");
    expect(RESERVED_SLUGS.has("membership")).toBe(true);
  });

  it("reports a duplicate page slug", () => {
    const k = tinyKit();
    k.pages[1].slug = "home";
    expect(issuePaths(k)).toContain("pages.1.slug");
  });

  it("requires a home page", () => {
    const k = tinyKit();
    k.pages[0].slug = "welcome";
    expect(issuePaths(k)).toContain("pages");
  });

  it("reports lorem / ipsum / [placeholder] in copy at the field path", () => {
    const k = tinyKit();
    k.pages[1].sections[0].html = "<p>Lorem ipsum dolor</p>";
    expect(issuePaths(k)).toContain("pages.1.sections.0.html");
    const k2 = tinyKit();
    k2.pages[0].sections[0].subtitle = `${SAMPLE_MARKER} [placeholder]`;
    expect(issuePaths(k2)).toContain("pages.0.sections.0.subtitle");
  });

  it("reports superlatives and exclamation marks (copy rules)", () => {
    const k = tinyKit();
    k.pages[0].sections[0].title = "The world-class guild";
    expect(issuePaths(k)).toContain("pages.0.sections.0.title");
    const k2 = tinyKit();
    k2.pages[0].sections[0].ctaLabel = "Join now!";
    expect(issuePaths(k2)).toContain("pages.0.sections.0.ctaLabel");
  });

  it("reports an unknown palette at defaults.palette", () => {
    const k = tinyKit();
    k.defaults.palette = "neon-lime";
    expect(issuePaths(k)).toContain("defaults.palette");
  });

  it("reports an unknown type pair at defaults.typePair", () => {
    const k = tinyKit();
    k.defaults.typePair = "comic-sans";
    expect(issuePaths(k)).toContain("defaults.typePair");
  });

  it("reports an unknown pattern or enum value under defaults", () => {
    const k = tinyKit();
    k.defaults.pattern.id = "tumbling-blocks";
    expect(issuePaths(k)).toContain("defaults.pattern.id");
    const k2 = tinyKit();
    k2.defaults.footer.variant = "mega";
    expect(issuePaths(k2)).toContain("defaults.footer.variant");
  });

  it("reports an imageId that is not declared in imagery", () => {
    const k = tinyKit();
    k.pages[0].sections[0].style.imageId = "missing-photo";
    expect(issuePaths(k)).toContain("pages.0.sections.0.style.imageId");
    const k2 = tinyKit();
    k2.pages[1].sections.push({ type: "image", variant: "single", items: [{ imageId: "nope", alt: "x" }] });
    expect(issuePaths(k2)).toContain("pages.1.sections.1.items.0.imageId");
  });

  it("requires src under public/kit-assets/<id>/ for photo imagery, and unique imagery ids", () => {
    const k = tinyKit();
    k.imagery.push({ id: "bee", kind: "photo", alt: "Members at a design wall" });
    expect(issuePaths(k)).toContain("imagery.1.src");
    const k2 = tinyKit();
    k2.imagery.push({ id: "bee", kind: "photo", alt: "x", src: "somewhere/else.jpg" });
    expect(issuePaths(k2)).toContain("imagery.1.src");
    const k3 = tinyKit();
    k3.imagery.push({ id: "hero-art", kind: "pattern", alt: "" });
    expect(issuePaths(k3)).toContain("imagery.1.id");
  });

  it("reports an internal link that is neither a kit page nor a system page", () => {
    const k = tinyKit();
    k.pages[0].sections[0].ctaHref = "/sponsors";
    expect(issuePaths(k)).toContain("pages.0.sections.0.ctaHref");
    // System pages and kit pages are fine.
    const ok = tinyKit();
    ok.pages[0].sections[0].ctaHref = "/about";
    ok.pages[0].sections[0].secondaryLabel = "Events";
    ok.pages[0].sections[0].secondaryHref = "/events";
    expect(validateKit(ok).issues).toEqual([]);
    for (const p of KIT_SYSTEM_PATHS) expect(p).toMatch(/^[a-z-]+$/);
  });

  it("checks menu hrefs and caps the top-level menu at seven items", () => {
    const k = tinyKit();
    k.menu = [{ label: "Sponsors", href: "/sponsors" }];
    expect(issuePaths(k)).toContain("menu.0.href");
    const k2 = tinyKit();
    k2.menu = Array.from({ length: 8 }, (_, i) => ({ label: `Item ${i}`, href: "/about" }));
    expect(issuePaths(k2)).toContain("menu");
    const ok = tinyKit();
    ok.menu = [{ label: "About", href: "/about", children: [{ label: "Join", href: "/membership" }] }];
    expect(validateKit(ok).issues).toEqual([]);
  });

  it("requires the sample marker on every page", () => {
    const k = tinyKit();
    k.pages[1].sections[0].html = "<p>Final copy with no marker.</p>";
    expect(issuePaths(k)).toContain("pages.1.sections");
  });

  it("reports duplicate explicit section ids within a page", () => {
    const k = tinyKit();
    k.pages[0].sections[0].id = "intro";
    k.pages[0].sections[1].id = "intro";
    expect(issuePaths(k)).toContain("pages.0.sections.1.id");
  });

  it("rejects a kit id that is not kebab-case", () => {
    const k = tinyKit();
    k.id = "Tiny Kit";
    expect(issuePaths(k)).toContain("id");
  });
});

describe("kit files in src/lib/site/kits", () => {
  const files = readdirSync(KITS_DIR).filter((f) => f.endsWith(".json"));

  it("has at least the heritage kit", () => {
    expect(files).toContain("heritage.json");
  });

  for (const file of files) {
    describe(file, () => {
      const raw = JSON.parse(readFileSync(path.join(KITS_DIR, file), "utf8")) as Record<string, unknown>;

      it("validates with zero issues", () => {
        expect(validateKit(raw).issues).toEqual([]);
      });

      it("file name matches the kit id and the kit is in the registry", () => {
        expect(`${raw.id}.json`).toBe(file);
        expect(kitById(String(raw.id))?.id).toBe(raw.id);
      });

      it("uses only phase-1 section types and variants", () => {
        const kit = kitSchema.parse(raw);
        for (const page of kit.pages) {
          for (const s of page.sections) {
            expect(SECTION_TYPES).toContain(s.type);
            const variant = "variant" in s ? String(s.variant) : "";
            expect(SECTION_VARIANTS[s.type]).toContain(variant);
          }
        }
      });

      it("ships every photo it references with a LICENSE.txt", () => {
        const kit = kitSchema.parse(raw);
        for (const img of kit.imagery) {
          if (img.kind !== "photo") continue;
          const abs = path.join(REPO_ROOT, img.src as string);
          expect(fileExists(abs), `${img.src} missing`).toBe(true);
          expect(fileExists(path.join(path.dirname(abs), "LICENSE.txt")), `LICENSE.txt next to ${img.src}`).toBe(true);
        }
      });
    });
  }

  it("KITS registry lists every kit file exactly once", () => {
    expect(KITS.map((k) => `${k.id}.json`).sort()).toEqual([...files].sort());
    expect(kitById("nope")).toBeNull();
  });
});

describe("heritage kit content", () => {
  const kit = kitSchema.parse(heritage);

  it("has the eight spec pages, in order, with home first", () => {
    expect(kit.pages.map((p) => p.slug)).toEqual([
      "home", "about", "why-join", "meetings", "community", "newsletter", "gallery", "contact",
    ]);
    expect(kit.pages.map((p) => p.title)).toEqual([
      "Home", "About & History", "Membership", "Meetings & Events", "Community Projects", "Newsletter", "Gallery", "Contact",
    ]);
  });

  it("keeps every page to three to six sections", () => {
    for (const p of kit.pages) {
      expect(p.sections.length, p.slug).toBeGreaterThanOrEqual(3);
      expect(p.sections.length, p.slug).toBeLessThanOrEqual(6);
    }
  });

  it("home is the spec stack: split hero, meeting info, 3 events, activity grid, blog teaser, join band", () => {
    const home = kit.pages[0].sections;
    expect(home.map((s) => s.type)).toEqual(["hero", "meeting_info", "events", "feature_grid", "blog_teaser", "join_band"]);
    expect(home[0]).toMatchObject({ variant: "split", style: { bg: "pattern" } });
    expect(home[2]).toMatchObject({ variant: "cards", limit: 3 });
    const grid = home[3] as Extract<typeof home[number], { type: "feature_grid" }>;
    expect(grid.variant).toBe("cards");
    expect(grid.items.map((i) => i.title)).toEqual(["Bees", "Block of the month", "Charity quilts", "Workshops"]);
  });

  it("uses the spec defaults", () => {
    expect(kit.defaults).toEqual({
      palette: "heritage-madder",
      typePair: "cormorantgaramond-sourcesans",
      scale: "comfortable",
      shape: { radius: "soft", shadow: "subtle" },
      rhythm: { spacing: "normal", container: "normal" },
      header: { variant: "left", sticky: true, cta: "join", overlayHero: false },
      footer: { variant: "meeting" },
      pattern: { id: "log-cabin", opacity: 0.14 },
    });
  });

  it("never puts two identical backgrounds next to each other", () => {
    for (const p of kit.pages) {
      for (let i = 1; i < p.sections.length; i++) {
        expect(p.sections[i].style.bg, `${p.slug} sections ${i - 1}/${i}`).not.toBe(p.sections[i - 1].style.bg);
      }
    }
  });

  it("uses the three placeholders and the sample marker; the join page links to /membership", () => {
    const text = JSON.stringify(heritage);
    expect(text).toContain("{{guild_name}}");
    expect(text).toContain("{{city}}");
    expect(text).toContain("{{meeting_info}}");
    expect(text).toContain(SAMPLE_MARKER);
    const join = JSON.stringify(kit.pages.find((p) => p.slug === "why-join"));
    expect(join).toContain("/membership");
    const gallery = JSON.stringify(kit.pages.find((p) => p.slug === "gallery"));
    expect(gallery).toContain("/galleries");
  });

  it("links Membership as Join and keeps the nav at seven items or fewer", () => {
    const nav = kit.pages.filter((p) => p.nav);
    expect(nav.length).toBeLessThanOrEqual(7);
    expect(kit.pages.find((p) => p.slug === "why-join")?.navLabel).toBe("Join");
  });
});
