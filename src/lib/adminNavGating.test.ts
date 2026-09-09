// src/lib/adminNavGating.test.ts
//
// public/admin.html has no build step, so it carries its own copy of the
// sidebar model (ADMIN_NAV, FEATURE_DEFAULTS, FEATURE_CATALOG) and of the
// permission matrix (ADMIN_AREAS). This file pins every one of those copies
// to the real module, and then goes further: it lifts the browser's
// qhVisibleNav() straight out of the HTML, runs it, and asserts it agrees
// with src/lib/adminNav.ts's visibleNav() across every role / tenant type /
// switch combination. A divergence between what the tests prove and what the
// admin actually renders fails here.
//
// It replaces the old markup-pinning version of this file (which asserted
// business-only / guild-only classes on hand-written <a> tags), keeping its
// intent intact: **guild-only and business-only entries must never cross** --
// in particular the old drag-and-drop page builder ("pages", renderPagesAdmin,
// which previews via /g/<slug> and writes the legacy settings.theme shape) and
// the new site builder ("site-pages") both label themselves "Website" and must
// never both appear.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PERMISSION_MATRIX, ADMIN_ONLY_AREAS } from "./permissions";
import { ADMIN_NAV, NAV_GROUPS, visibleNav, type NavEntry } from "./adminNav";
import { FEATURE_CATALOG, FEATURE_DEFAULTS, FEATURE_KEYS, type FeatureKey } from "./features";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// admin.html may be CRLF on a Windows checkout -- normalize so these pin
// content, not line endings.
const ADMIN_HTML = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");

/** Pull `const <name> = <literal>;` out of the inline script. */
function literal(name: string, re: RegExp): string {
  const m = ADMIN_HTML.match(re);
  if (!m) throw new Error(`could not find ${name} in public/admin.html`);
  return m[1];
}
const navLiteral = literal("ADMIN_NAV", /const ADMIN_NAV = (\[[\s\S]*?\n {4}\]);/);
const catalogLiteral = literal("FEATURE_CATALOG", /const FEATURE_CATALOG = (\[[\s\S]*?\n {4}\]);/);
const defaultsLiteral = literal("FEATURE_DEFAULTS", /const FEATURE_DEFAULTS = (\{.*\});/);
const groupsLiteral = literal("NAV_GROUPS", /const NAV_GROUPS = (\[.*\]);/);

/** Lift the browser's own filter out of the HTML and make it callable. */
function browserVisibleNav() {
  const parts = [
    literal("ADMIN_ONLY_AREAS", /(const ADMIN_ONLY_AREAS = \[.*\];)/),
    literal("ADMIN_AREAS", /(const ADMIN_AREAS = \{[\s\S]*?\n {4}\};)/),
    `const ADMIN_NAV = ${navLiteral};`,
    literal("qhNavCanRead", /(function qhNavCanRead\(role, area\) \{[\s\S]*?\n {4}\})/),
    literal("qhVisibleNav", /(function qhVisibleNav\(opts\) \{[\s\S]*?\n {4}\})/),
  ];
  const factory = new Function(`${parts.join("\n")}\nreturn qhVisibleNav;`);
  return factory() as (opts: {
    advanced: boolean;
    role: string;
    tenantType: string;
    features: Record<string, boolean>;
  }) => NavEntry[];
}

const ALL_ON: Record<string, boolean> = FEATURE_KEYS.reduce(
  (a, k) => ({ ...a, [k]: true }),
  {} as Record<string, boolean>
);
const ALL_OFF: Record<string, boolean> = FEATURE_KEYS.reduce(
  (a, k) => ({ ...a, [k]: false }),
  {} as Record<string, boolean>
);

describe("admin.html mirrors the sidebar model", () => {
  it("ADMIN_NAV is identical to src/lib/adminNav.ts", () => {
    expect(JSON.parse(navLiteral)).toEqual(ADMIN_NAV);
  });

  it("NAV_GROUPS is identical", () => {
    expect(JSON.parse(groupsLiteral)).toEqual([...NAV_GROUPS]);
  });

  it("FEATURE_DEFAULTS and FEATURE_CATALOG are identical to src/lib/features.ts", () => {
    expect(JSON.parse(defaultsLiteral)).toEqual(FEATURE_DEFAULTS);
    expect(JSON.parse(catalogLiteral)).toEqual(FEATURE_CATALOG);
  });

  it("the <nav> carries no hand-written links (it is rendered from ADMIN_NAV)", () => {
    const navMatch = ADMIN_HTML.match(/<nav>([\s\S]*?)<\/nav>/);
    expect(navMatch, "could not find <nav>...</nav> in admin.html").toBeTruthy();
    expect(navMatch![1].trim()).toBe("");
    expect(ADMIN_HTML).toContain("function renderSidebarNav()");
  });

  it("renderSidebarNav groups the entries and collapses More behind a disclosure", () => {
    expect(ADMIN_HTML).toContain('label.className = "qh-nav-label"');
    expect(ADMIN_HTML).toContain('if (group === "More")');
    expect(ADMIN_HTML).toContain('document.createElement("details")');
  });

  it("clicks are still handled, now by delegation on the nav itself", () => {
    expect(ADMIN_HTML).toContain('e.target.closest("a[data-page]")');
    expect(ADMIN_HTML).toContain("navigate(a.dataset.page);");
  });
});

describe("admin.html's qhVisibleNav agrees with visibleNav()", () => {
  const browser = browserVisibleNav();
  const roles = ["owner", "admin", "platform", "membership", "events", "viewer", "nonsense"];
  const featureSets: Record<string, Record<string, boolean>> = {
    defaults: FEATURE_DEFAULTS,
    allOn: ALL_ON,
    allOff: ALL_OFF,
  };

  for (const advanced of [false, true]) {
    for (const tenantType of ["guild", "business"] as const) {
      for (const role of roles) {
        for (const [setName, features] of Object.entries(featureSets)) {
          it(`${advanced ? "advanced" : "simple"} / ${tenantType} / ${role} / ${setName}`, () => {
            const opts = { advanced, role, tenantType, features };
            const mine = visibleNav(opts).map((e) => e.page);
            const theirs = browser(opts).map((e) => e.page);
            expect(theirs).toEqual(mine);
          });
        }
      }
    }
  }
});

describe("guild-only and business-only entries never cross (the original intent)", () => {
  const browser = browserVisibleNav();
  const pagesFor = (tenantType: "guild" | "business") =>
    browser({ advanced: true, role: "owner", tenantType, features: ALL_ON }).map((e) => e.page);

  it("a business tenant never sees the old guild page builder, a guild never sees the new one", () => {
    const guild = pagesFor("guild");
    const business = pagesFor("business");
    expect(guild).toContain("pages");
    expect(guild).not.toContain("site-pages");
    expect(business).toContain("site-pages");
    expect(business).not.toContain("pages");
  });

  it("the rest of the guild-only set stays with guilds, and the site-builder set with businesses", () => {
    const guild = pagesFor("guild");
    const business = pagesFor("business");
    for (const page of ["levels", "chapters", "forum"]) {
      expect(guild).toContain(page);
      expect(business).not.toContain(page);
    }
    for (const page of ["site-theme", "site-domain", "site-identity", "projects", "project-rates"]) {
      expect(business).toContain(page);
      expect(guild).not.toContain(page);
    }
  });

  it("un-gated entries show for both tenant types", () => {
    const guild = pagesFor("guild");
    const business = pagesFor("business");
    for (const page of ["dashboard", "members", "blog", "settings"]) {
      expect(guild).toContain(page);
      expect(business).toContain(page);
    }
  });
});

// The editor rewrite (2026-09-08) gates the sidebar and write buttons from a
// client-side copy of PERMISSION_MATRIX (ADMIN_AREAS in admin.html). Pin the
// copy to the real matrix so a permissions change cannot silently leave the
// admin showing (or hiding) the wrong screens.
describe("admin.html ADMIN_AREAS mirrors src/lib/permissions.ts", () => {
  const src = ADMIN_HTML;
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

// Settings -> Advanced is the only place the two switches are written, and it
// must write them through the merged-settings PATCH so no other key is lost.
describe("Settings -> Advanced", () => {
  it("renders a row per feature and a Show advanced features toggle", () => {
    expect(ADMIN_HTML).toContain('id="advanced-card"');
    expect(ADMIN_HTML).toContain("function renderAdvancedCard()");
    expect(ADMIN_HTML).toContain('advBox.id = "adv-advanced"');
    expect(ADMIN_HTML).toContain('box.id = "adv-feat-" + f.key');
    expect(ADMIN_HTML).toContain("why.textContent = f.consequence;");
  });

  it("saves the merged settings object and re-renders the sidebar without a reload", () => {
    const save = ADMIN_HTML.match(/async function saveAdvancedSettings\(\) \{[\s\S]*?\n {4}\}/);
    expect(save, "saveAdvancedSettings missing").toBeTruthy();
    expect(save![0]).toContain("window._settings = { ...previous, ui, features };");
    expect(save![0]).toContain("await saveSettings();");
    expect(save![0]).toContain("renderSidebarNav();");
    expect(save![0]).not.toContain("location.reload");
  });

  it("every catalog key gets a switch (the list is not hand-written twice)", () => {
    expect(JSON.parse(catalogLiteral).map((f: { key: FeatureKey }) => f.key).sort()).toEqual(
      [...FEATURE_KEYS].sort()
    );
  });
});
