import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JS = readFileSync(path.join(ROOT, "public/qh-signature.js"), "utf8");
const CSS = readFileSync(path.join(ROOT, "public/qh-signature.css"), "utf8");
const SW = readFileSync(path.join(ROOT, "public/sw.js"), "utf8");

describe("showcase signature experiences", () => {
  it("gives every flagship composition its own named interaction", () => {
    for (const name of ["exhibition-index", "editors-note", "shuffle-table", "light-study", "daylight", "provenance"]) {
      expect(JS).toContain(`experience("${name}"`);
      expect(CSS).toContain(`[data-qh-experience="${name}"]`);
    }
  });

  it("uses accessible controls and preserves reduced-motion behavior", () => {
    expect(JS).toContain('setAttribute("aria-expanded"');
    expect(JS).toContain('setAttribute("aria-pressed"');
    expect(JS).toContain('prefers-reduced-motion: reduce');
    expect(JS).toContain('addEventListener("keydown"');
  });

  it("remains valid browser JavaScript", () => {
    expect(() => new Function(JS)).not.toThrow();
  });

  it("fetches changing signature assets from the network before cached copies", () => {
    expect(SW).toContain('url.pathname === "/qh-signature.css"');
    expect(SW).toContain('url.pathname === "/qh-signature.js"');
  });
});
