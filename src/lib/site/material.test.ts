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
