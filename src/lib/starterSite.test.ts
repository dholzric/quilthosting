// src/lib/starterSite.test.ts
// The starter site is inserted straight into `pages` at guild creation, so a
// block that parseBlocks() would drop, or a slug guild.html already routes
// itself, silently produces a broken first-run site. Pin both here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseBlocks, parseTheme } from "./blocks";
import {
  SAMPLE_MARKER,
  starterPageRow,
  starterPages,
  starterSettingsJson,
} from "./starterSite";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("starterPages", () => {
  const pages = starterPages("Prairie Star Quilt Guild");

  it("seeds Home, About, Why Join, Meetings, Contact with home first", () => {
    expect(pages.map((p) => p.slug)).toEqual(["home", "about", "why-join", "meetings", "contact"]);
    expect(pages[0].sort_order).toBe(0);
    const orders = pages.map((p) => p.sort_order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("uses only block types parseBlocks accepts -- nothing is dropped on the round trip", () => {
    for (const p of pages) {
      expect(p.blocks.length).toBeGreaterThan(0);
      const reparsed = parseBlocks(JSON.parse(JSON.stringify(p.blocks)));
      expect(reparsed).toEqual(p.blocks);
    }
  });

  it("uses only block types the guild builder in admin.html can render on its canvas", () => {
    // renderBlockPreview()'s switch in public/admin.html: anything else falls
    // to `default:` and shows as a bare type name to the admin.
    const html = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8");
    const used = new Set(pages.flatMap((p) => p.blocks.map((b) => b.type)));
    for (const type of used) {
      expect(html, `admin.html has no preview case for "${type}"`).toContain(`case "${type}":`);
    }
  });

  it("marks every page as sample copy so the checklist can detect it", () => {
    for (const p of pages) {
      const row = starterPageRow(p);
      expect(row.blocks_json).toContain(SAMPLE_MARKER);
      expect(row.content_json).toContain(SAMPLE_MARKER);
      expect(JSON.parse(row.content_json).html).toContain("qh-block-");
    }
  });

  it("avoids slugs guild.html routes itself (join/membership/events/...)", () => {
    const reserved = ["join", "join-renew", "membership", "events", "calendar", "galleries", "photos"];
    for (const p of pages) expect(reserved).not.toContain(p.slug);
  });

  it("weaves city and meeting info in, HTML-escaped", () => {
    const withInfo = starterPages("Bee & Thread <Guild>", {
      city: "Austin, TX <b>",
      meetingInfo: "1st Thursdays 7pm",
    });
    const all = JSON.stringify(withInfo);
    expect(all).toContain("Austin, TX &lt;b&gt;");
    expect(all).toContain("We meet 1st Thursdays 7pm.");
    expect(all).not.toContain("<b>");
    // Headings go through escapeHtml at render time, so they keep raw text.
    expect(withInfo[0].blocks[0]).toEqual({ type: "heading", text: "Welcome to Bee & Thread <Guild>", level: 1 });
    // Text blocks are raw HTML -> escaped at seed time.
    expect(all).toContain("Bee &amp; Thread &lt;Guild&gt; is a community");
  });

  it("falls back to placeholder meeting copy when nothing is supplied", () => {
    const text = JSON.stringify(starterPages("X", { city: "", meetingInfo: null }));
    expect(text).toContain("second Tuesday of every month");
  });
});

describe("starterSettingsJson", () => {
  it("is a legacy-shape theme parseTheme understands", () => {
    const theme = parseTheme(starterSettingsJson());
    expect(theme.primary).toMatch(/^#[0-9a-f]{6}$/i);
    expect(["classic", "modern", "warm"]).toContain(theme.style);
    expect(["system", "serif", "rounded"]).toContain(theme.font);
  });
});
