// Putting the site menu in your own order.
//
// The menu has always had two states. With `settings.nav` arranged, that is
// the menu. With it empty — which is every new guild — the site lists the
// pages flagged "Show in menu" in sort_order and appends Events.
//
// The menu editor could only ever show and reorder `settings.nav`. So an
// owner on the automatic menu opened the editor, found an empty list and two
// arrow buttons with nothing to move, and had no way to change the order of
// the menu they were looking at. sort_order is not editable anywhere either.
// The only route to a different order was rebuilding the whole menu by hand,
// one page at a time.
//
// The server now hands the editor that automatic list as `nav_default`,
// computed by the same two functions the renderer uses, so the two cannot
// describe different menus.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMenu, withEventsLink } from "./render";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ADMIN = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");
const PAGES_ROUTE = readFileSync(path.join(REPO_ROOT, "src/routes/pages.ts"), "utf8").replace(/\r\n/g, "\n");

const PAGES = [
  { slug: "home", title: "Home" },
  { slug: "about", title: "About & History", nav_label: "About" },
  { slug: "meetings", title: "Meetings" },
  { slug: "hidden", title: "Members only notes", show_in_nav: 0 },
];

describe("the automatic menu the editor starts from", () => {
  it("is the pages in the order given, plus Events when there are events", () => {
    const menu = withEventsLink(buildMenu(PAGES, [], ""), "", { hasEvents: true, explicitMenu: false });
    expect(menu.map((m) => m.label)).toEqual(["Home", "About", "Meetings", "Events"]);
  });

  it("leaves out pages that are not marked Show in menu", () => {
    const menu = buildMenu(PAGES, [], "");
    expect(menu.map((m) => m.label)).not.toContain("Members only notes");
  });

  it("adopting it and saving it unchanged reproduces the same menu", () => {
    // The whole promise of "Start from my current menu": taking it over must
    // not silently rearrange or drop anything.
    const auto = withEventsLink(buildMenu(PAGES, [], ""), "", { hasEvents: true, explicitMenu: false });
    const adopted = auto.map((m) => ({ label: m.label, href: m.href, external: !!m.external }));
    const asExplicit = buildMenu(PAGES, adopted, "");
    expect(asExplicit.map((m) => m.label)).toEqual(auto.map((m) => m.label));
    expect(asExplicit.map((m) => m.href)).toEqual(auto.map((m) => m.href));
  });

  it("an arranged menu is the owner's list, and Events is not re-added to it", () => {
    // If they took Events out on purpose, it stays out.
    const arranged = [{ label: "About", href: "/about" }];
    const menu = withEventsLink(buildMenu(PAGES, arranged, ""), "", { hasEvents: true, explicitMenu: true });
    expect(menu.map((m) => m.label)).toEqual(["About"]);
  });

  it("reordering is just the array order, so the arrows are the whole feature", () => {
    const reordered = [
      { label: "Meetings", href: "/meetings" },
      { label: "About", href: "/about" },
      { label: "Home", href: "/" },
    ];
    expect(buildMenu(PAGES, reordered, "").map((m) => m.label)).toEqual(["Meetings", "About", "Home"]);
  });
});

describe("the endpoint and the editor agree", () => {
  it("GET /site/settings computes nav_default with the renderer's own functions", () => {
    // Not a second implementation of the ordering rules: the same two calls.
    const handler = PAGES_ROUTE.slice(PAGES_ROUTE.indexOf('pageRoutes.get("/site/settings"'));
    expect(handler).toContain("withEventsLink(buildMenu(");
    expect(handler).toContain("nav_default");
    // Same predicate the site's own nav query uses.
    expect(handler).toContain('coalesce(show_in_nav, 1) = 1');
    expect(handler).toContain("ORDER BY sort_order, title");
  });

  it("the editor reads nav_default wherever it loads site settings", () => {
    const hits = ADMIN.match(/navDefault: /g) || [];
    expect(hits.length, "every WB.site assignment must carry it").toBe(2);
    expect(ADMIN).toContain("site.nav_default");
    expect(ADMIN).toContain("siteSettings.nav_default");
  });

  it("offers the list rather than making the owner retype their own site", () => {
    expect(ADMIN).toContain("Start from my current menu");
    // Naming what it will add, so it is not a blind button.
    expect(ADMIN).toMatch(/Adds \$\{auto\.length\}/);
  });

  it("adopting is not saving", () => {
    // It fills the editor; nothing reaches the site until Save menu.
    const card = ADMIN.slice(ADMIN.indexOf("function wbRenderNavCard"), ADMIN.indexOf("/* ---------- editor ---------- */"));
    const start = card.indexOf("adopt.addEventListener");
    const adopt = card.slice(start, card.indexOf("wb-nav-save", start));
    expect(adopt).not.toContain("api(");
    expect(adopt).toContain("Save menu");
  });

  it("stores root-relative hrefs, which is what the renderer expects", () => {
    // A stored href is prefixed with the site's base at render time. Handing
    // the editor the admin's own preview path would make a guild's menu point
    // at https://<guild>.quilthosting.com/g/<guild>/about.
    const card = ADMIN.slice(ADMIN.indexOf("function wbRenderNavCard"), ADMIN.indexOf("/* ---------- editor ---------- */"));
    expect(card).not.toMatch(/linkFor: \(p\) => wbPagePath/);
    expect(card).toMatch(/linkFor: \(p\) => \(!p\.slug \|\| p\.slug === "home" \? "\/" : `\/\$\{p\.slug\}`\)/);
  });

  it("the arrow buttons it hands the rows to are still there", () => {
    expect(ADMIN).toContain('mk("↑", "Move up"');
    expect(ADMIN).toContain('mk("↓", "Move down"');
  });
});
