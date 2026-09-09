// Source assertions on public/qh-site.js (the island bundle) and public/qh-cal.js.
// There is no DOM in vitest, so these tests hold the file to its structural
// contract: it parses, it is one strict-mode IIFE, the eight island modules
// exist and are booted, every network call goes through qhBase, and no data
// ever reaches innerHTML (DOM APIs only — the same rule qh-admin-ext.js keeps).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const site = readFileSync(path.join(REPO_ROOT, "public/qh-site.js"), "utf8");
const cal = readFileSync(path.join(REPO_ROOT, "public/qh-cal.js"), "utf8");
const siteNoComments = site.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const siteLines = siteNoComments.split("\n");

const MODULES = [
  "initNav", "initJoin", "initRegister", "initCart", "initDonate",
  "initCalendar", "initLightbox", "initVolunteer", "initNewsletter", "initDirectorySearch",
];

describe("public/qh-site.js — shape", () => {
  it("parses as a script (node --check equivalent)", () => {
    expect(() => new Function(site)).not.toThrow();
  });

  it("is a single strict-mode IIFE", () => {
    const trimmed = site.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(trimmed.startsWith("(function")).toBe(true);
    expect(trimmed.endsWith("})();")).toBe(true);
    expect(site).toContain('"use strict"');
  });

  it("stays under the ~760 line budget (700 + the phase-2 newsletter and directory-search islands)", () => {
    expect(site.split("\n").length).toBeLessThan(760);
  });

  it.each(MODULES)("defines module %s as a named function", (name) => {
    expect(site).toMatch(new RegExp(`function ${name}\\s*\\(`));
  });

  it("boots every module from boot() on DOMContentLoaded", () => {
    expect(site).toMatch(/function boot\s*\(/);
    const bootBody = site.slice(site.indexOf("function boot("));
    for (const name of MODULES) expect(bootBody).toContain(`${name}(`);
    expect(site).toContain("DOMContentLoaded");
  });

  it("keeps the legacy block hydration", () => {
    for (const cls of [".qh-block-events", ".qh-block-store", ".qh-block-contact-form", ".qh-block-project-intake"]) {
      expect(site).toContain(cls);
    }
  });
});

describe("public/qh-site.js — safety rules", () => {
  it("never assigns innerHTML / outerHTML / insertAdjacentHTML / document.write", () => {
    expect(siteNoComments).not.toMatch(/\.innerHTML\s*[+]?=/);
    expect(siteNoComments).not.toMatch(/\.outerHTML\s*=/);
    expect(siteNoComments).not.toContain("insertAdjacentHTML");
    expect(siteNoComments).not.toContain("document.write");
    expect(siteNoComments).not.toMatch(/\beval\s*\(/);
  });

  it("has no template-literal HTML (`${` is only ever in text, never markup)", () => {
    // The stricter form of the plan's rule: no innerHTML at all, so the
    // `innerHTML = \`…${` pattern cannot exist.
    expect(siteNoComments).not.toMatch(/innerHTML\s*=\s*`[^`]*\$\{/);
  });

  it("routes every fetch( through qhBase", () => {
    const fetchLines = siteLines.filter((l) => /(^|[^A-Za-z_$.])fetch\s*\(/.test(l));
    expect(fetchLines.length).toBeGreaterThan(0);
    for (const line of fetchLines) expect(line).toContain("qhBase");
  });

  it("reads slug/base/type from <body data-qh-*> with location.origin as the base fallback", () => {
    expect(site).toContain("qhSlug");
    expect(site).toContain("qhBase");
    expect(site).toContain("qhType");
    expect(site).toContain("location.origin");
    // Old business pages still stamp the slug on <html>; keep it as the fallback.
    expect(site).toContain("data-tenant-slug");
  });
});

describe("public/qh-site.js — hooks and endpoints", () => {
  it.each([
    "[data-join]", "[data-register]", '[id^="register-"]', "[data-buy]", "[data-add]",
    "[data-donate]", "a[data-lightbox]", ".qh-events--calendar", "[data-volunteer]", '[id^="volunteer-"]',
    ".qh-nav-toggle", ".qh-drawer", "form[data-newsletter]", "[data-directory-filter]", "[data-directory-count]",
  ])("consumes hook %s", (hook) => {
    expect(site).toContain(hook);
  });

  it.each([
    "/info", "/join", "/register", "/buy", "/cart/checkout", "/donate", "/volunteer", "/volunteers", "?month=", "/newsletter",
  ])("calls endpoint %s", (ep) => {
    expect(site).toContain(ep);
  });

  it("redirects to checkout_url when the server returns one", () => {
    expect(site).toContain("checkout_url");
    expect(site).toMatch(/location\.href\s*=\s*\w+\.checkout_url/);
  });

  it("sends the same request bodies as guild.html", () => {
    for (const key of ["level_id", "custom_fields", "custom_answers", "amount_cents", "slot_id", "product_id", "quantity"]) {
      expect(site).toContain(key);
    }
  });
});

describe("public/qh-site.js — dialogs and motion", () => {
  it("creates <dialog> elements once, with a close button, Escape handling and a focus trap", () => {
    expect(site).toContain('createElement("dialog")');
    expect(site).toContain("showModal");
    expect(site).toContain("Escape");
    expect(site).toMatch(/Tab/);
    expect(site).toContain("aria-label");
    expect(site).toMatch(/qh-dialog__close/);
  });

  it("respects prefers-reduced-motion", () => {
    expect(site).toContain("prefers-reduced-motion");
  });
});

describe("public/qh-cal.js", () => {
  it("parses as a script", () => {
    expect(() => new Function(cal)).not.toThrow();
  });

  it("exposes window.qhCal.render(container, events, onClick) and keeps qhRenderCalendar", () => {
    expect(cal).toContain("window.qhCal");
    expect(cal).toMatch(/render\s*[:=]\s*function\s*\(container,\s*events,\s*onClick/);
    expect(cal).toContain("window.qhRenderCalendar");
  });

  it("emits the BEM classes the token stylesheet styles", () => {
    for (const cls of ["qh-cal__head", "qh-cal__dow", "qh-cal__day", "qh-cal__num", "qh-cal__event", "qh-cal__day--today", "qh-cal__day--other"]) {
      expect(cal).toContain(cls);
    }
  });
});
