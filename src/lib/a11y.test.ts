// Source assertions for the accessibility invariants that hold statically.
//
// The browser pass (a Playwright tab-walk over the admin dashboard, the
// Website editor with a section selected, Settings, the portal, and a rendered
// kit site) is what found these; this file is what keeps them fixed. Anything
// that needs a live DOM — focus restoration, the drawer's focus trap, the
// keyboard tab order — is not asserted here and has to be re-walked by hand.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf8");

const ADMIN = read("public/admin.html");
const PORTAL = read("public/portal.html");
const SITE_JS = read("public/qh-site.js");
const QH_CSS = read("public/qh.css");
const SITE_CSS = read("public/qh-site.css");

const HTML_FILES: [string, string][] = [
  ["public/admin.html", ADMIN],
  ["public/portal.html", PORTAL],
];
const CSS_FILES: [string, string][] = [
  ["public/qh.css", QH_CSS],
  ["public/qh-site.css", SITE_CSS],
];
const ALL_FILES: [string, string][] = [...HTML_FILES, ["public/qh-site.js", SITE_JS], ...CSS_FILES];

const stripCssComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const stripHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

describe("no positive tabindex", () => {
  // A tabindex above zero jumps the control ahead of the document order and
  // breaks the tab sequence for everything after it. 0 and -1 are fine.
  it.each(ALL_FILES)("%s", (_name, src) => {
    const offenders = [...src.matchAll(/tabindex\s*=\s*["']?\s*(\d+)/gi)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 0);
    expect(offenders).toEqual([]);
    // The JS form: setAttribute("tabindex", "2") / el.tabIndex = 2.
    expect(src).not.toMatch(/setAttribute\(\s*["']tabindex["']\s*,\s*["'](?!-?[01]["'])/);
    expect(src).not.toMatch(/\.tabIndex\s*=\s*(?![-]?[01]\b)\d/);
  });
});

describe("outline is never removed without a :focus-visible replacement", () => {
  // `outline: none` is the single most common way a codebase loses its focus
  // ring. Allowed only where the same rule (or its neighbour) paints one back.
  it.each(CSS_FILES)("%s", (_name, src) => {
    const css = stripCssComments(src);
    const lines = css.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/outline\s*:\s*(none|0)\b/.test(line)) return;
      const near = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
      const replaced =
        /:focus-visible/.test(near) &&
        (/outline\s*:\s*\d/.test(near) || /box-shadow\s*:/.test(near) || /border-color\s*:/.test(near));
      if (!replaced) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it("both stylesheets paint a token-driven ring with an offset", () => {
    for (const [name, src] of CSS_FILES) {
      const compact = stripCssComments(src).replace(/\s+/g, "");
      expect(compact, name).toMatch(/:focus-visible\{outline:2pxsolidvar\(--/);
      expect(compact, name).toContain("outline-offset:");
    }
  });

  it("qh-site.css resolves --_focus outside .qh-site (the admin canvas rescopes it)", () => {
    // Without the fallback the declaration is invalid at computed-value time
    // and every control in the editor canvas silently loses its ring.
    const compact = stripCssComments(SITE_CSS).replace(/\s+/g, "");
    expect(compact).toContain(":focus-visible{outline:2pxsolidvar(--_focus,currentColor)");
    expect(compact).not.toMatch(/outline:2pxsolidvar\(--_focus\)/);
  });

  it("an inverted button on a dark ground aims its ring at the ground, not itself", () => {
    const compact = stripCssComments(SITE_CSS).replace(/\s+/g, "");
    expect(compact).toContain(":is(.qh-s--bg-dark,.qh-s--bg-image).qh-btn--primary{");
    for (const sel of [
      ":is(.qh-s--bg-dark,.qh-s--bg-image).qh-btn--primary{",
      ".qh-s--bg-brand.qh-btn--primary{",
      ".qh-join-band.qh-btn--primary{",
    ]) {
      const at = compact.indexOf(sel);
      expect(at, sel).toBeGreaterThan(-1);
      expect(compact.slice(at, compact.indexOf("}", at)), sel).toMatch(/--_focus:var\(--_on-/);
    }
    // The lightbox sits on near-black: its ink and ring flip to the on-dark role.
    const lb = compact.indexOf(".qh-lightbox{");
    expect(lb).toBeGreaterThan(-1);
    expect(compact.slice(lb, compact.indexOf("}", lb))).toContain("--_focus:currentColor");
  });
});

describe("every <dialog> is a labelled modal", () => {
  it.each(HTML_FILES)("%s markup", (name, src) => {
    const tags = [...stripHtmlComments(src).matchAll(/<dialog\b[^>]*>/gi)].map((m) => m[0]);
    expect(tags.length, `${name} has no <dialog>`).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, name).toMatch(/\brole\s*=\s*["']dialog["']/);
      expect(tag, name).toMatch(/\baria-modal\s*=\s*["']true["']/);
      expect(tag, name).toMatch(/\baria-label(ledby)?\s*=/);
    }
  });

  it("public/qh-site.js stamps role/aria-modal on every dialog it builds", () => {
    // wireDialog() is the single door: makeDialog(), the lightbox and the nav
    // drawer all go through it or set the pair themselves.
    const wire = SITE_JS.slice(SITE_JS.indexOf("function wireDialog("));
    expect(wire).toMatch(/setAttribute\("role", "dialog"\)/);
    expect(wire).toMatch(/setAttribute\("aria-modal", "true"\)/);
    // Every created dialog is either wired or labelled by hand.
    const created = (SITE_JS.match(/createElement\("dialog"\)/g) || []).length;
    expect(created).toBeGreaterThan(0);
    expect((SITE_JS.match(/wireDialog\(/g) || []).length).toBeGreaterThanOrEqual(created);
    // makeDialog() names itself from its own heading.
    expect(SITE_JS).toContain('d.setAttribute("aria-labelledby", h.id)');
    // The drawer is server-rendered, so initNav stamps the pair at boot.
    const nav = SITE_JS.slice(SITE_JS.indexOf("function initNav("));
    expect(nav).toMatch(/drawer\.setAttribute\("role", "dialog"\)/);
    expect(nav).toMatch(/drawer\.setAttribute\("aria-modal", "true"\)/);
    expect(nav).toMatch(/aria-expanded/);
    expect(nav).toMatch(/aria-controls/);
  });

  it("public/qh-site.js returns focus to the opener when a dialog closes", () => {
    expect(SITE_JS).toMatch(/dialog\.qhOpener\s*=\s*opener\s*\|\|\s*document\.activeElement/);
    expect(SITE_JS).toMatch(/addEventListener\("close",\s*function\s*\(\)\s*\{\s*if\s*\(d\.qhOpener/);
    // and the drawer restores focus to its toggle.
    expect(SITE_JS).toContain("if (refocusToggle) toggle.focus();");
  });

  it("admin builds its runtime dialog with the same three attributes", () => {
    const up = ADMIN.slice(ADMIN.indexOf('dlg.id = "qh-upgrade-dlg"'));
    expect(up.slice(0, 400)).toMatch(/setAttribute\("role", "dialog"\)/);
    expect(up.slice(0, 400)).toMatch(/setAttribute\("aria-modal", "true"\)/);
    expect(up.slice(0, 400)).toMatch(/setAttribute\("aria-label",/);
  });
});

describe("every icon-only control carries a name", () => {
  // A <button> whose only child is a glyph, an <svg> or nothing at all reads
  // as "button" and nothing else unless it has aria-label or title.
  const iconOnly = (html: string): string[] => {
    const bad: string[] = [];
    for (const m of stripHtmlComments(html).matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const [, attrs, inner] = m;
      if (/\baria-label\s*=|\btitle\s*=|\baria-labelledby\s*=/.test(attrs)) continue;
      // Text (including a template expression) counts as a name.
      const text = inner.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, "x").trim();
      if (text.length > 1) continue;
      bad.push(m[0].slice(0, 120));
    }
    return bad;
  };
  it.each(HTML_FILES)("%s", (_name, src) => {
    expect(iconOnly(src)).toEqual([]);
  });

  it("public/qh-site.js names every button it builds without text", () => {
    // button(cls, text, label) is the only constructor; every call with a
    // glyph for text passes a label.
    for (const glyph of ["×", "‹", "›"]) {
      const re = new RegExp(`button\\([^)]*"${glyph}"\\s*,\\s*"[^"]+"\\)`);
      expect(SITE_JS, glyph).toMatch(re);
    }
  });

  it("the admin canvas toolbar names its five glyph buttons", () => {
    for (const label of ["Move up", "Move down", "Duplicate", "Hide section", "Delete section"]) {
      expect(ADMIN).toContain(`aria-label="${label}"`);
    }
  });
});

describe("form controls are labelled and errors are announced", () => {
  it("admin links orphan labels to their control at runtime", () => {
    // ~90 screens write `<label>X</label><input id=…>`; one observer links
    // them rather than 90 hand edits across three concurrent workstreams.
    expect(ADMIN).toContain("function qhLinkLabels(");
    expect(ADMIN).toMatch(/label:not\(\[for\]\):not\(\[data-qh-lbl\]\)/);
    expect(ADMIN).toContain("new MutationObserver(");
    expect(ADMIN).toMatch(/label\.setAttribute\("for", n\.id\)/);
  });

  it("portal labels every static control with for=", () => {
    const orphans = [...stripHtmlComments(PORTAL).matchAll(/<label(?![^>]*\bfor=)[^>]*>([\s\S]{0,60}?)<\/label>/gi)]
      // A label that wraps its own control is already correct.
      .filter((m) => !/<input|<select|<textarea/i.test(m[0]))
      .map((m) => m[1].trim());
    expect(orphans).toEqual([]);
  });

  it("portal ties dynamically built fields to their labels", () => {
    expect(PORTAL).toContain('label.htmlFor = "reg-q-" + q.key');
    expect(PORTAL).toContain('input.id = "reg-q-" + q.key');
    expect(PORTAL).toContain('label.htmlFor = "p-cf-" + f.key');
    expect(PORTAL).toContain('lab.htmlFor = "pick-guild-slug"');
  });

  it("every error summary announces itself and is named by its fields", () => {
    for (const id of ["login-error", "guild-error", "fr-error"]) {
      const tag = ADMIN.match(new RegExp(`<div id="${id}"[^>]*>`))![0];
      expect(tag, id).toContain('role="alert"');
      expect(tag, id).toContain('aria-live="assertive"');
    }
    for (const id of ["login-error", "reg-error"]) {
      const tag = PORTAL.match(new RegExp(`<div id="${id}"[^>]*>`))![0];
      expect(tag, id).toContain('role="alert"');
      expect(tag, id).toContain('aria-live="assertive"');
    }
    // aria-describedby ties the summary back to the inputs it is about.
    expect(ADMIN).toContain('aria-describedby="login-error"');
    expect(PORTAL).toContain('aria-describedby="login-error"');
    expect(PORTAL).toContain('input.setAttribute("aria-describedby", "reg-error")');
    expect(SITE_JS).toContain("function describe(root, id, forId)");
    expect(SITE_JS).toMatch(/fail:\s*function\s*\(msg\)\s*\{[^}]*describe\(d, err\.id, err\.id\)/);
  });

  it("the editor's save-status pill and status lines are live regions", () => {
    const pill = ADMIN.match(/<span class="wb-pill" id="wb-save-state"[^>]*>/)![0];
    expect(pill).toContain('role="status"');
    expect(pill).toContain('aria-live="polite"');
    expect(ADMIN).toMatch(/id="wb-conflict"[^>]*role="alert"|<div id="wb-conflict"/);
    // The site toast is the only feedback for a completed join/purchase.
    expect(SITE_JS).toMatch(/toastEl\.setAttribute\("role", "status"\);\s*toastEl\.setAttribute\("aria-live", "polite"\)/);
  });

  it("portal tabs are a real tablist with a roving tabindex", () => {
    expect(PORTAL).toContain('role="tablist"');
    expect((PORTAL.match(/role="tab"/g) || []).length).toBe(8);
    expect((PORTAL.match(/role="tabpanel"/g) || []).length).toBe(8);
    expect(PORTAL).toMatch(/btn\.setAttribute\("aria-selected"/);
    expect(PORTAL).toMatch(/btn\.tabIndex = on \? 0 : -1/);
    expect(PORTAL).toMatch(/ArrowRight/);
  });
});

describe("disclosures, landmarks and skip links", () => {
  it("the admin's collapsible groups are native <details>, so state is built in", () => {
    // "More" in the sidebar, "More designs", and the editor's Page settings.
    expect(ADMIN).toMatch(/createElement\("details"\)/);
    expect(ADMIN).toContain("qh-nav-more");
    expect(ADMIN).toContain("wb-settings");
    expect(ADMIN).toMatch(/frMk\("summary", "", "More designs"\)/);
  });

  it("admin and portal each offer a skip link into their main region", () => {
    expect(ADMIN).toContain('<a class="qh-skip" href="#page-content">Skip to content</a>');
    expect(ADMIN).toContain('<div id="page-content" tabindex="-1">');
    expect(PORTAL).toContain('<a class="qh-skip" href="#portal-main">Skip to content</a>');
    expect(PORTAL).toContain('id="portal-main"');
    // Off-screen until focused.
    const css = stripCssComments(QH_CSS).replace(/\s+/g, "");
    expect(css).toMatch(/\.qh-skip\{[^}]*position:absolute/);
    expect(css).toMatch(/\.qh-skip\{[^}]*left:-999px/);
    expect(css).toMatch(/\.qh-skip:focus\{[^}]*left:0/);
  });

  it("the shell has one main landmark and named navigation", () => {
    expect(ADMIN).toContain('<main class="main">');
    expect(PORTAL).toContain('<main class="wrap" id="portal-main">');
    expect(ADMIN).toMatch(/nav\.setAttribute\("aria-label", "Admin sections"\)/);
    expect(ADMIN).toContain('<nav aria-label="Footer links">');
    expect(PORTAL).toContain('<nav aria-label="Footer links">');
  });

  it("the click-to-switch guild tag is operable from the keyboard", () => {
    expect(ADMIN).toMatch(/id="tenant-label" role="button" tabindex="0"/);
    expect(ADMIN).toMatch(/getElementById\("tenant-label"\)\?\.addEventListener\("keydown"/);
  });

  it("the editor canvas keeps its preview out of the tab order", () => {
    // Preview links/buttons would be dozens of dead stops between sections,
    // and activating one would navigate out of the editor.
    expect(ADMIN).toMatch(/\.wb-block-body a\[href\][\s\S]{0,220}?setAttribute\("tabindex", "-1"\)/);
  });

  it("the editor panels sit at the right outline level", () => {
    // The tags stay h4/h5 for the type scale; aria-level fixes the outline.
    expect(ADMIN).toContain('<h4 role="heading" aria-level="2">Add a section</h4>');
    expect(ADMIN).toContain('<h5 role="heading" aria-level="3">');
    expect(ADMIN).toMatch(/h\.setAttribute\("role", "heading"\); h\.setAttribute\("aria-level", "2"\)/);
  });
});

describe("prefers-reduced-motion", () => {
  // Any sheet with an animation or a transition slower than 200ms must offer
  // a way out; both of ours do it globally.
  const slowMotion = (css: string): boolean => {
    const body = stripCssComments(css);
    if (/@keyframes|animation\s*:/.test(body)) return true;
    return [...body.matchAll(/transition[^;{}]*?(\d*\.?\d+)\s*(m?s)\b/g)]
      .some((m) => (m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1])) > 200);
  };
  it.each(CSS_FILES)("%s", (name, src) => {
    if (!slowMotion(src)) return; // nothing to opt out of
    expect(stripCssComments(src), name).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("the island bundle checks the media query before it animates", () => {
    expect(SITE_JS).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(SITE_JS).toContain("if (!reducedMotion && typeof panel.animate === \"function\")");
  });
});

describe("the admin palette clears WCAG AA at the token level", () => {
  // The tenant themes are contrast-checked by buildDesignVars; the admin's own
  // palette was not, and three pairs failed. These are the pairs the audit
  // found in use, at the sizes they are used.
  const luminance = (hex: string): number => {
    const h = hex.replace("#", "");
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const ratio = (a: string, b: string): number => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const token = (name: string): string => {
    const m = QH_CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    expect(m, `--${name} is not a hex token in qh.css`).not.toBeNull();
    return m![1];
  };

  const PAIRS: [string, string, string][] = [
    ["ink", "paper", "body text on the page"],
    ["ink", "surface", "body text on a card"],
    ["ink-2", "surface", "secondary text on a card"],
    ["ink-3", "paper", ".muted on the page"],
    ["ink-3", "surface", ".muted on a card"],
    ["ink-3", "surface-2", ".muted on a panel"],
    ["brand", "surface", "links and primary text"],
    ["brand", "paper", "links on the page"],
    ["brand-ink", "brand-soft", "active chips"],
    ["ok", "ok-soft", "success badges"],
    ["warn", "warn-soft", "warning badges"],
    ["danger", "danger-soft", "error badges"],
    ["ink-2", "neutral-soft", "neutral badges"],
  ];
  it.each(PAIRS)("--%s on --%s (%s) clears 4.5:1", (fg, bg) => {
    expect(Number(ratio(token(fg), token(bg)).toFixed(2))).toBeGreaterThanOrEqual(4.5);
  });

  it("white on --brand clears 4.5:1 (primary buttons, active nav)", () => {
    expect(ratio("#ffffff", token("brand"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the dark sidebar, portal header and fleet footer clear 4.5:1", () => {
    const dark = "#262019", fleet = "#2b2b2e";
    for (const [fg, bg, what] of [
      ["#cfc4b2", dark, "sidebar link"],
      ["#a89a83", dark, "guild tag"],
      ["#d9a441", dark, "brand thread"],
      ["#c87853", dark, "platform badge"],
      ["#b8b4ab", fleet, "fleet footer text"],
      ["#9b978f", fleet, "fleet footer legal"],
      ["#9ccbd6", fleet, "fleet footer link"],
    ] as [string, string, string][]) {
      expect(Number(ratio(fg, bg).toFixed(2)), what).toBeGreaterThanOrEqual(4.5);
      // and each one is really in the stylesheet
      expect(QH_CSS, what).toContain(fg);
    }
  });

  it("dark grounds flip the focus ring to the on-dark ink", () => {
    const css = stripCssComments(QH_CSS).replace(/\s+/g, "");
    expect(css).toMatch(/\.sidebar,\.portal-header,\.qh-fleet-footer\{--focus-ring:#ffffff;?\}/);
  });
});

describe("no user data is interpolated into inline event handlers", () => {
  it("portal.html never builds an onclick from a member-supplied name", () => {
    const portal = readFileSync(path.join(REPO_ROOT, "public/portal.html"), "utf8");
    // JSON.stringify escapes " but not ', so a name like O'Brien breaks out of
    // a single-quoted onclick. Names must reach the DOM as text, never markup.
    const handlerWithStringify = /on[a-z]+\s*=\s*'[^']*\$\{JSON\.stringify\([^)]*name[^)]*\)\}/i;
    expect(portal).not.toMatch(handlerWithStringify);
    expect(portal).not.toMatch(/onclick='removeFromHousehold\(/);
  });
});
