// src/lib/adminNavGating.test.ts
//
// Pins the business-tenant/guild sidebar split in public/admin.html so a
// future edit can't silently unhide the wrong nav item. This is a code
// review finding (Task 13, round 1): the pre-existing `data-page="pages"`
// entry (the older drag-and-drop guild "Website builder", renderPagesAdmin)
// was not marked guild-only, so a business tenant would see two
// identically-labeled "Website" links -- one of them (the old one) previews
// via /g/<slug>, which src/index.ts always serves as the guild.html shell,
// never the business site (serveBusinessSite). Its "theme" sub-panel also
// writes settings.theme in the old {primary, style, font, headerBg} shape,
// which would collide with the new 13-token ThemeConfig the business
// Appearance panel writes to the same settings.theme key -- a real bug, not
// just a UX rough edge, if a business tenant ever reached it.
//
// This test does two things, matching how src/lib/platformPaths.test.ts
// pins a similar "reserved list must stay in sync with reality" invariant:
//   1. Reads the REAL public/admin.html and asserts the exact set of nav
//      entries carry business-only / guild-only, so someone editing the
//      <nav> markup gets a failing test instead of a silent regression.
//   2. Re-derives visibility with the exact same two-`classList.toggle`
//      calls applyTenantTypeNav() uses, and asserts that exact source text
//      still appears verbatim in admin.html -- if the toggle algorithm
//      itself ever changes, this test fails and forces a look, rather than
//      quietly testing a stale copy of logic nobody runs anymore.
import { describe, it, expect } from "vitest";
import { PERMISSION_MATRIX, ADMIN_ONLY_AREAS } from "./permissions";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN_HTML = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8");

/** Extract { dataPage -> Set<class> } for every sidebar <a data-page="..."> entry. */
function parseNavClasses(html: string): Record<string, Set<string>> {
  const navMatch = html.match(/<nav>([\s\S]*?)<\/nav>/);
  if (!navMatch) throw new Error("Could not find <nav>...</nav> in admin.html");
  const nav = navMatch[1];
  const out: Record<string, Set<string>> = {};
  const linkRe = /<a\s+([^>]*?)>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(nav))) {
    const attrs = m[1];
    const pageMatch = attrs.match(/data-page="([\w-]+)"/);
    if (!pageMatch) continue;
    const classMatch = attrs.match(/class="([^"]*)"/);
    out[pageMatch[1]] = new Set((classMatch ? classMatch[1] : "").split(/\s+/).filter(Boolean));
  }
  return out;
}

/** Same two calls as applyTenantTypeNav() in admin.html's inline script --
 * see the verbatim-source assertion below, which keeps this in sync. */
function isHiddenForTenant(classes: Set<string>, isBusinessTenant: boolean): boolean {
  let hidden = false;
  if (classes.has("business-only")) hidden = !isBusinessTenant; // toggle("hidden", !isBusinessTenant)
  if (classes.has("guild-only")) hidden = isBusinessTenant; // toggle("hidden", isBusinessTenant)
  return hidden;
}

describe("admin.html sidebar — business-only / guild-only classes", () => {
  const nav = parseNavClasses(ADMIN_HTML);

  it("the three site-builder entries are business-only", () => {
    for (const page of ["site-pages", "site-theme", "site-domain"]) {
      expect(nav[page], `data-page="${page}" missing from <nav>`).toBeDefined();
      expect(nav[page].has("business-only"), `data-page="${page}" should be business-only`).toBe(true);
    }
  });

  it("the pre-existing guild-oriented entries are guild-only, INCLUDING the old page builder", () => {
    // "pages" is the fix from round 1: the older renderPagesAdmin() builder
    // duplicates site-pages's "Website" label and previews the wrong
    // product for a business tenant (guild.html via /g/<slug>).
    for (const page of ["pages", "levels", "chapters", "forum"]) {
      expect(nav[page], `data-page="${page}" missing from <nav>`).toBeDefined();
      expect(nav[page].has("guild-only"), `data-page="${page}" should be guild-only`).toBe(true);
    }
  });

  it("un-gated entries (e.g. dashboard, members, blog) carry neither class", () => {
    for (const page of ["dashboard", "members", "blog", "settings"]) {
      expect(nav[page]).toBeDefined();
      expect(nav[page].has("business-only")).toBe(false);
      expect(nav[page].has("guild-only")).toBe(false);
    }
  });

  it("the applyTenantTypeNav() toggle source is unchanged (keeps isHiddenForTenant honest)", () => {
    // admin.html is CRLF on disk (Windows checkout) -- normalize before the
    // substring match so this pins content, not line endings.
    const normalized = ADMIN_HTML.replace(/\r\n/g, "\n");
    const expectedSnippet =
      'document.querySelectorAll(".business-only").forEach((el) => {\n' +
      '        el.classList.toggle("hidden", !isBusinessTenant);\n' +
      "      });\n" +
      '      document.querySelectorAll(".guild-only").forEach((el) => {\n' +
      '        el.classList.toggle("hidden", isBusinessTenant);\n' +
      "      });";
    expect(normalized).toContain(expectedSnippet);
  });

  it("on a business tenant: old 'pages' Website builder is hidden, new site-pages is visible", () => {
    expect(isHiddenForTenant(nav["pages"], true)).toBe(true);
    expect(isHiddenForTenant(nav["site-pages"], true)).toBe(false);
    // The rest of the guild-only set follows the same rule.
    expect(isHiddenForTenant(nav["levels"], true)).toBe(true);
    expect(isHiddenForTenant(nav["chapters"], true)).toBe(true);
    expect(isHiddenForTenant(nav["forum"], true)).toBe(true);
  });

  it("on a guild: old 'pages' Website builder is visible, new site-pages is hidden", () => {
    expect(isHiddenForTenant(nav["pages"], false)).toBe(false);
    expect(isHiddenForTenant(nav["site-pages"], false)).toBe(true);
    expect(isHiddenForTenant(nav["site-theme"], false)).toBe(true);
    expect(isHiddenForTenant(nav["site-domain"], false)).toBe(true);
  });
});

// The editor rewrite (2026-09-08) gates the sidebar and write buttons from a
// client-side copy of PERMISSION_MATRIX (ADMIN_AREAS in admin.html). Pin the
// copy to the real matrix so a permissions change cannot silently leave the
// admin showing (or hiding) the wrong screens.
describe("admin.html ADMIN_AREAS mirrors src/lib/permissions.ts", () => {
  const src = ADMIN_HTML.replace(/\r\n/g, "\n");
  const listOf = (text: string) =>
    text.split(",").map((t) => t.trim().replace(/^"|"$/g, "")).filter(Boolean);

  it("ADMIN_ONLY_AREAS matches", () => {
    const m = src.match(/const ADMIN_ONLY_AREAS = \[([^\]]*)\];/);
    expect(m, "ADMIN_ONLY_AREAS const missing from admin.html").toBeTruthy();
    expect(listOf(m![1]).sort()).toEqual([...ADMIN_ONLY_AREAS].sort());
  });

  it("every limited role's write list matches the matrix", () => {
    for (const role of ["membership", "events", "viewer"] as const) {
      const re = new RegExp(role + ": \\{ write: \\[([^\\]]*)\\], noRead: ADMIN_ONLY_AREAS \\}");
      const m = src.match(re);
      expect(m, "role " + role + " missing from ADMIN_AREAS").toBeTruthy();
      expect(listOf(m![1]).sort()).toEqual([...(PERMISSION_MATRIX[role].write as readonly string[])].sort());
    }
    for (const role of ["owner", "admin", "platform"]) {
      expect(src).toContain(role + ': { write: "*", noRead: [] }');
    }
  });

  it("navigate() applies the read-only state after every screen renders", () => {
    expect(src).toContain("applyReadOnlyState(page);");
  });
});
