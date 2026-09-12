// Source assertions on public/qh-site.css: the stylesheet is the contract the
// section and shell renderers (Tasks 4-5) emit class names against, so a
// missing class here is a missing style on every tenant site.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const css = readFileSync(path.join(REPO_ROOT, "public/qh-site.css"), "utf8");
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const compact = noComments.replace(/\s+/g, "");

// Shell + section + component classes, straight from the plan's CSS contract.
const SHELL = [
  "qh-site", "qh-header", "qh-header--left", "qh-header--centered", "qh-header--split",
  "qh-header--sticky", "qh-header--overlay", "qh-nav", "qh-nav__item", "qh-nav__menu",
  "qh-nav-toggle", "qh-drawer", "qh-header__cta", "qh-footer", "qh-footer--simple",
  "qh-footer--columns", "qh-footer--meeting", "qh-container", "qh-container--narrow",
  "qh-container--normal", "qh-container--wide", "qh-container--full",
];
const SECTION_MODIFIERS = [
  "qh-s", "qh-s--bg-none", "qh-s--bg-tint", "qh-s--bg-brand", "qh-s--bg-dark", "qh-s--bg-image",
  "qh-s--bg-pattern", "qh-s--w-narrow", "qh-s--w-normal", "qh-s--w-wide", "qh-s--w-full",
  "qh-s--sp-tight", "qh-s--sp-normal", "qh-s--sp-airy", "qh-s--align-center",
  "qh-s--media-left", "qh-s--media-right", "qh-s--media-top",
];
const SECTION_TYPES = [
  "qh-hero", "qh-hero--image", "qh-hero--split", "qh-hero--pattern", "qh-hero--minimal", "qh-hero--stats",
  "qh-rich", "qh-rich--prose", "qh-rich--two_column", "qh-rich--with_image",
  "qh-image--single", "qh-image--full_bleed", "qh-image--duo",
  "qh-features--cards", "qh-features--icons", "qh-features--numbered",
  "qh-faq", "qh-testimonials--grid", "qh-testimonials--single",
  "qh-gallery--grid", "qh-gallery--masonry",
  "qh-events--cards", "qh-events--list", "qh-events--calendar", "qh-events--next_up",
  "qh-levels--cards", "qh-levels--compact",
  "qh-join-band", "qh-meeting", "qh-store", "qh-blog", "qh-contact", "qh-quote-cta",
  "qh-cta", "qh-divider", "qh-spacer", "qh-embed",
  // Phase 2 (docs/superpowers/plans/2026-09-08-site-sections-imagery-phase2.md Task A)
  "qh-timeline", "qh-quote", "qh-officers", "qh-benefits", "qh-spotlight", "qh-projects", "qh-sponsors",
  "qh-newsletter", "qh-services--cards", "qh-services--table", "qh-portfolio--grid", "qh-portfolio--featured",
  "qh-hours", "qh-process", "qh-documents", "qh-donate",
];
const COMPONENTS = [
  "qh-btn", "qh-btn--primary", "qh-btn--secondary", "qh-btn--ghost", "qh-card", "qh-badge", "qh-empty",
];
// Old class names the legacy block renderer still emits; aliased for one release.
const LEGACY = [
  "qh-site-header", "qh-site-main", "qh-site-footer", "qh-block-hero", "qh-block-services",
  "qh-block-gallery", "qh-block-testimonials", "qh-block-project-intake", "qh-block-contact-form",
  "qh-quote-lines", "qh-agreement-body",
];

function hasClass(name: string): boolean {
  return new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(noComments);
}

describe("qh-site.css class contract", () => {
  it.each([...SHELL, ...SECTION_MODIFIERS, ...SECTION_TYPES, ...COMPONENTS, ...LEGACY])(
    "styles .%s",
    (name) => {
      expect(hasClass(name)).toBe(true);
    }
  );

  it("opens the nested menu on hover and focus-within", () => {
    expect(compact).toContain(".qh-nav__item.has-children:hover>.qh-nav__menu");
    expect(compact).toContain(".qh-nav__item.has-children:focus-within>.qh-nav__menu");
  });

  it("shows the drawer only when open", () => {
    expect(hasClass("qh-drawer[open]")).toBe(true);
  });

  it("switches to the drawer under 800px", () => {
    // There is more than one max-width:799.98px block, and matching only the
    // first made this depend on where every other rule happened to sit — a
    // nested min-width query added later ended the match early. Take all of
    // them and require that the drawer lives in one.
    const blocks = [...noComments.matchAll(/@media\s*\(max-width:\s*799\.98px\)\s*\{([\s\S]*?)\n\}/g)]
      .map((m) => m[1].replace(/\s+/g, ""));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.includes(".qh-nav{display:none}")), "drawer hides the nav").toBe(true);
    expect(blocks.some((b) => b.includes(".qh-nav-toggle{display:inline-flex}")), "drawer shows the toggle").toBe(true);
  });
});

describe("qh-site.css design rules", () => {
  it("uses only #fff / #000 literals; every other color is a --qh-* variable", () => {
    const hexes = noComments.match(/#[0-9a-fA-F]{3,8}(?![\w-])/g) || [];
    const offenders = hexes.filter((h) => !/^#(f{3}|f{6}|0{3}|0{6})$/i.test(h));
    expect(offenders).toEqual([]);
    expect(noComments).not.toMatch(/\b(?:rgb|hsl)a?\(\s*(?!0[\s,]|255[\s,])/);
  });

  it("consumes the design token variables with fallbacks", () => {
    for (const v of [
      "--qh-bg", "--qh-surface", "--qh-surface-alt", "--qh-ink", "--qh-ink-muted", "--qh-border",
      "--qh-primary", "--qh-on-primary", "--qh-primary-hover", "--qh-accent", "--qh-on-accent",
      "--qh-dark", "--qh-on-dark", "--qh-tint", "--qh-font-display", "--qh-font-body",
      "--qh-fs-1", "--qh-fs-2", "--qh-fs-3", "--qh-fs-4", "--qh-fs-5", "--qh-fs-6",
      "--qh-radius", "--qh-shadow", "--qh-section-y", "--qh-container",
    ]) {
      expect(compact, v).toMatch(new RegExp(`var\\(${v},`));
    }
    expect(compact).toContain("var(--qh-s-image");
    expect(compact).toContain("var(--qh-s-focal,");
    expect(compact).toContain("var(--qh-s-pattern");
  });

  it("keeps prose measure, balanced headings, and section rhythm", () => {
    expect(compact).toContain("max-width:70ch");
    expect(compact).toContain("text-wrap:balance");
    expect(compact).toMatch(/padding-block:var\(--_section-y\)/);
  });

  it("respects reduced motion, constrains images, and scrolls wide tables inside their box", () => {
    expect(noComments).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(compact).toMatch(/img[^{]*\{[^}]*max-width:100%/);
    expect(compact).toMatch(/table[^{]*\{[^}]*overflow-x:auto/);
  });

  it("gives every focusable control a visible focus ring", () => {
    expect(compact).toMatch(/:focus-visible\{outline:2pxsolid/);
  });

  it("keeps drawer tap targets at 48px", () => {
    expect(compact).toMatch(/\.qh-drawer[^{]*a[^{]*\{[^}]*min-height:48px/);
  });

  it("stays a single readable file", () => {
    // 650 covered the 19-section library; the fourteen phase-2 sections added
    // ~100; the composition axes (six section shapes, five quilt-shaped edges)
    // add ~45. The cap keeps the one stylesheet every visitor downloads
    // readable by a person — it is not meant to freeze the file. The phone-layout
    // fixes (the collapsed hero/section padding pair, the month nav on one row,
    // calendar chips confined to their day) took it to 809, leaving no room to
    // fix the next thing a phone turns up. The cloth layer and the three
    // handwork edges add ~45: they are new capability for every one of the
    // 120 kits at once, not decoration on one of them.
    expect(css.split("\n").length).toBeLessThanOrEqual(940);
  });

  it("phase 2: sponsors logos are grayscale until hover, process steps use counter(), services table scrolls in its wrapper", () => {
    expect(compact).toMatch(/\.qh-sponsor[^{]*img[^{]*\{[^}]*filter:grayscale\(1\)/);
    expect(compact).toMatch(/\.qh-sponsor[^{]*:hover[^{]*img[^{]*\{[^}]*filter:none/);
    expect(compact).toMatch(/\.qh-process__steps\{[^}]*counter-reset:qh-step/);
    expect(compact).toMatch(/\.qh-process__step::before\{[^}]*content:counter\(qh-step/);
    expect(compact).toMatch(/\.qh-services__table/);
    expect(compact).toMatch(/\.qh-table-wrap[^{]*\{[^}]*overflow-x:auto/);
  });
});
