// Cloth: what the page is woven from.
//
// We had 120 starter designs that differed only in paint — palette, type,
// spacing, shape. None of the nine things a kit could set changed what the
// page was MADE of, and the one texture we had was a flat SVG tile at 8%
// opacity behind a couple of bands.
//
// `material` is the first axis that changes the substance rather than the
// colour, and it is deliberately cheap: two repeating gradients and one
// turbulence filter, no images and no extra requests.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MATERIALS, MATERIAL_LABELS, MATERIAL_HINTS, siteDesignSchema, DEFAULT_DESIGN } from "./design/tokens";
import { SECTION_VARIANTS, SECTION_MOTIONS, DEFAULT_STYLE } from "./sections/schema";
import { renderSitePage } from "./render";
import type { SiteDesign } from "./design/tokens";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CSS = readFileSync(path.join(REPO_ROOT, "public/qh-site.css"), "utf8").replace(/\r\n/g, "\n");

describe("the material vocabulary", () => {
  it("is plain plus three cloths, each with a label and a line of help", () => {
    expect(MATERIALS).toEqual(["plain", "cotton", "linen", "flannel"]);
    for (const m of MATERIALS) {
      expect(MATERIAL_LABELS[m], m).toBeTruthy();
      expect(MATERIAL_HINTS[m], m).toBeTruthy();
    }
  });

  it("is absent unless chosen, so no existing design changes shape", () => {
    // A .default() here would have rewritten every stored design and every
    // kit's defaults the first time they were parsed.
    expect("material" in DEFAULT_DESIGN).toBe(false);
    const parsed = siteDesignSchema.parse({ ...DEFAULT_DESIGN });
    expect(parsed.material).toBeUndefined();
  });

  it("round-trips a real choice and refuses an invented one", () => {
    expect(siteDesignSchema.parse({ ...DEFAULT_DESIGN, material: "linen" }).material).toBe("linen");
    expect(siteDesignSchema.safeParse({ ...DEFAULT_DESIGN, material: "velvet" }).success).toBe(false);
  });
});

describe("the page says what it is made of", () => {
  const render = (material?: string) =>
    renderSitePage({
      tenant: {
        name: "Hill Country Quilt Guild",
        slug: "hcqg",
        settings_json: JSON.stringify({ profile: {} }),
        tenant_type: "guild",
      },
      page: { title: "Home", slug: "", sections: [] },
      menu: [],
      baseUrl: "",
      host: "quilthosting.com",
      showPlatformCredit: true,
      design: { ...DEFAULT_DESIGN, ...(material ? { material } : {}) } as SiteDesign,
      data: {},
      imgUrl: (id: string) => `/img/${id}`,
    } as never);

  it("stamps the chosen cloth on the body", () => {
    expect(render("linen")).toContain('data-qh-material="linen"');
  });

  it("says plain when nothing was chosen, and when something invented was", () => {
    expect(render()).toContain('data-qh-material="plain"');
    expect(render("velvet")).toContain('data-qh-material="plain"');
  });
});

describe("the weave itself", () => {
  it("covers the whole page, not just the gaps between sections", () => {
    // First attempt put the weave on the body's own background. Every section
    // paints its own ground, so it showed only in the strips between them —
    // which is not what cloth does. One fixed overlay, multiplied over
    // everything, is what makes the cards and the type sit on the same piece.
    expect(CSS).toMatch(/body\.qh-site\[data-qh-material="cotton"\]::after/);
    expect(CSS).toMatch(/position:fixed;inset:0/);
    expect(CSS).toContain("mix-blend-mode:multiply");
  });

  it("cannot swallow a click or a tap", () => {
    const layer = CSS.slice(CSS.indexOf('body.qh-site[data-qh-material="cotton"]::after'));
    expect(layer.slice(0, 400)).toContain("pointer-events:none");
  });

  it("is drawn, not downloaded", () => {
    const cloth = CSS.slice(CSS.indexOf("/* ---- Cloth"), CSS.indexOf("/* ---- The hand"));
    expect(cloth).toContain("repeating-linear-gradient");
    expect(cloth).toContain("feTurbulence");
    // Nothing fetched over the network — a texture must not cost a request.
    // (url(%23s) inside the data URI is the SVG's own filter reference.)
    expect(cloth).not.toMatch(/url\(\s*["']?(https?:|\/)/);
  });

  it("lights a dark page instead of muddying it", () => {
    // Multiplying black over a dark ground just makes mud.
    expect(CSS).toMatch(/qh-site--dark\[data-qh-material\][^{]*\{[^}]*mix-blend-mode:screen/);
  });

  it("leaves plain alone entirely", () => {
    expect(CSS).not.toMatch(/\[data-qh-material="plain"\]::after\s*\{/);
  });
});

describe("the hand: finished edges", () => {
  it.each(["stitch", "pinked", "binding"])("styles the %s edge", (d) => {
    expect(CSS).toContain(`.qh-s--divider-${d}`);
  });

  it("keeps the five edges that already existed", () => {
    for (const d of ["rule", "points", "scallop", "notch"]) expect(CSS).toContain(`.qh-s--divider-${d}`);
  });
});

describe("piecing: the gallery as a quilt top", () => {
  it("is offered as a gallery variant", () => {
    expect(SECTION_VARIANTS.gallery).toContain("piecing");
  });

  it("joins the blocks with sashing — the container's own ground in the gap", () => {
    const css = CSS.slice(CSS.indexOf(".qh-gallery--piecing"));
    expect(css).toContain("--_sash");
    expect(css).toMatch(/background:var\(--_accent\)/);
    expect(css).toMatch(/gap:var\(--_sash\)/);
  });

  it("uses one span size, because more than one opened holes in the top", () => {
    // A 2x2 every seventh block still lets four columns pack solid. Adding a
    // second and third span size left gaps in the MIDDLE of the quilt, which
    // a pieced top does not have.
    const spans = CSS.match(/\.qh-gallery--piecing \.qh-gallery__item:nth-child\([^)]+\)\{grid-/g) || [];
    expect(spans.length).toBe(1);
    expect(CSS).toContain("grid-auto-flow:dense");
  });

  it("drops to two columns on a phone, where four blocks wide is unreadable", () => {
    expect(CSS).toMatch(/\.qh-gallery--piecing \.qh-gallery__items\{grid-template-columns:repeat\(2,1fr\)\}/);
  });
});

describe("piecing: the motion", () => {
  const MOTION = CSS.slice(CSS.indexOf("/* ---- Piecing (motion)"), CSS.indexOf("/* ---- Section: membership_levels"));

  it("is driven by the scroll position, with no JavaScript at all", () => {
    expect(MOTION).toContain("animation-timeline:view()");
    const js = readFileSync(path.join(REPO_ROOT, "public/qh-site.js"), "utf8");
    expect(js).not.toContain("qh-s--piece-in");
  });

  it("rests ASSEMBLED — nothing is ever hidden waiting for a scroll", () => {
    // The single rule the whole thing is built around. A browser with no
    // scroll timelines, or a stylesheet that arrives before the feature query
    // resolves, must show a finished quilt top, not a blank page.
    expect(MOTION).toMatch(/to\{opacity:1;transform:none\}/);
    expect(MOTION).toMatch(/from\{opacity:0/);
    // and the animating rules live INSIDE the guards, so they cannot apply
    // anywhere the animation will not run.
    const guardStart = MOTION.indexOf("@media (prefers-reduced-motion:no-preference)");
    expect(guardStart).toBeGreaterThan(-1);
    expect(MOTION.indexOf(".qh-s--piece-in")).toBeGreaterThan(guardStart);
    expect(MOTION.indexOf("@supports (animation-timeline:view())")).toBeGreaterThan(guardStart);
  });

  it("does not move for a visitor who asked for less motion", () => {
    expect(MOTION).toContain("prefers-reduced-motion:no-preference");
  });

  it("is opt-in per section, off by default", () => {
    expect(DEFAULT_STYLE.motion).toBeUndefined();
    expect(SECTION_MOTIONS).toEqual(["none", "piece_in"]);
  });

  it("settles a pieced gallery block by block, not all at once", () => {
    expect(MOTION).toContain(".qh-gallery--piecing .qh-gallery__item");
    expect(MOTION).toMatch(/nth-child\(3n\+2\)\{--_piece-r/);
  });
});
