// src/lib/guildSite.test.ts
//
// Pins the P0 conversion fix in public/guild.html (audit 2026-09-08).
//
// Bug: applyRoute() used to populate the dedicated /membership (+ /join,
// /join-renew) and /events (+ /calendar) routes by cloning the homepage
// #levels / #events cards into #levels-page / #events-page with
// cloneNode(true). cloneNode does not copy addEventListener handlers, so
// the Join / Register buttons on those routes were inert -- no console
// error, just a dead button on the two pages most likely to be linked from
// a guild's nav. Homepage buttons worked, which is why it slipped through.
//
// Fix: keep the levels / events arrays in module-level state (levelsList,
// eventsList) and render every view from data via renderLevels(container)
// / renderEvents(container), which build fresh cards through levelCard() /
// eventCard() so handlers are always attached.
//
// Same approach as src/lib/adminNavGating.test.ts: read the REAL
// public/guild.html and assert on stable source text, so a future edit that
// reintroduces cloning (or stops routing through the render helpers) fails
// here instead of silently killing conversions again. No DOM library
// (jsdom / happy-dom) is installed, so this is a source-assertion test.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// guild.html may be CRLF on disk (Windows checkout) -- normalize so we pin
// content, not line endings.
const GUILD_HTML = readFileSync(path.join(REPO_ROOT, "public/guild.html"), "utf8").replace(/\r\n/g, "\n");

/** Body of a top-level `function name(...) { ... }` declaration in the inline script. */
function functionBody(html: string, name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name}( not found in guild.html`);
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

describe("guild.html — Join / Register buttons on dedicated routes", () => {
  it("never clones rendered cards (cloneNode drops click listeners)", () => {
    // Match a *call*, so an explanatory comment mentioning cloneNode is fine.
    expect(GUILD_HTML).not.toMatch(/\.cloneNode\s*\(/);
  });

  it("keeps the source data in module-level state", () => {
    expect(GUILD_HTML).toContain("let levelsList = [];");
    expect(GUILD_HTML).toContain("let eventsList = [];");
    const load = functionBody(GUILD_HTML, "load");
    expect(load).toContain("levelsList = levelsData.levels || [];");
    expect(load).toContain("eventsList = eventsData.events || [];");
  });

  it("renderLevels / renderEvents build fresh cards via levelCard / eventCard", () => {
    const rl = functionBody(GUILD_HTML, "renderLevels");
    expect(rl).toContain("container.replaceChildren()");
    expect(rl).toContain("container.appendChild(levelCard(l))");
    const re = functionBody(GUILD_HTML, "renderEvents");
    expect(re).toContain("container.replaceChildren()");
    expect(re).toContain("container.appendChild(eventCard(ev))");
  });

  it("applyRoute renders the membership and events routes from data, not from the homepage DOM", () => {
    const route = functionBody(GUILD_HTML, "applyRoute");
    expect(route).toContain('renderLevels($("levels-page"))');
    expect(route).toContain('renderEvents($("events-page"))');
    // The old pattern read the homepage containers as a clone source.
    expect(route).not.toContain('$("levels")');
    expect(route).not.toContain('$("events")');
    // Events route still hands off to the list/calendar toggle after rendering.
    expect(route).toContain("setEventsMode(p === \"calendar\" ? \"calendar\" : \"list\")");
  });

  it("the homepage sections go through the same render helpers", () => {
    const load = functionBody(GUILD_HTML, "load");
    expect(load).toContain('renderLevels($("levels"))');
    expect(load).toContain('renderEvents($("events"))');
  });

  it("levelCard / eventCard / event detail attach real click handlers to type=button buttons", () => {
    for (const name of ["levelCard", "eventCard", "renderEventDetail"]) {
      const body = functionBody(GUILD_HTML, name);
      expect(body, `${name} should create a button`).toContain('el("button"');
      expect(body, `${name} should set type=button`).toContain('btn.type = "button";');
      expect(body, `${name} should bind click`).toContain('btn.addEventListener("click"');
      expect(body, `${name} should open the signup dialog`).toContain("openSignup(");
    }
  });

  it("every membership/events route slug is still handled by applyRoute", () => {
    const route = functionBody(GUILD_HTML, "applyRoute");
    for (const slug of ["membership", "join", "join-renew", "events", "calendar"]) {
      expect(route, `route "${slug}" missing`).toContain(`"${slug}"`);
    }
  });
});
