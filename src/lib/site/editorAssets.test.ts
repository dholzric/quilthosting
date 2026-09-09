// src/lib/site/editorAssets.test.ts
//
// Source assertions on the phase-2 editor work in public/admin.html and
// public/qh.css (site sections + imagery, Task C). The admin is a static
// page with no build step, so these tests read the real files and pin:
//   1. the functions each behaviour hangs off exist by name,
//   2. the server contracts they call (Task B image pipeline, Task D upgrade),
//   3. the image-pipeline constants match the plan (widths, quality, 10 MB),
//   4. the new code builds its UI through DOM APIs -- no innerHTML templates
//      carrying data,
//   5. both inline <script> blocks still parse (the node --check step, in
//      vitest form),
//   6. every section type / variant has thumbnail art, and the Style tab's
//      defaults mirror the schema's DEFAULT_STYLE.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_STYLE, SECTION_TYPES, SECTION_VARIANTS } from "./sections/schema";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ADMIN = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(path.join(REPO_ROOT, "public/qh.css"), "utf8");

/** Source of one top-level (4-space indented) function in the admin script. */
function fnSource(name: string): string {
  const re = new RegExp(`\\n {4}(?:async )?function ${name}\\(`);
  const m = re.exec(ADMIN);
  if (!m) throw new Error(`function ${name} not found in admin.html`);
  const rest = ADMIN.slice(m.index + 1);
  const end = rest.slice(1).search(/\n {4}(?:async function |function |const |let |window\.|\/\*)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** Evaluate a `const NAME = {...};` object literal from admin.html (repo source, not user input). */
function literalOf(name: string): Record<string, unknown> {
  const m = ADMIN.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n {4}\\});`));
  if (!m) throw new Error(`${name} literal not found in admin.html`);
  return new Function(`return ${m[1]}`)() as Record<string, unknown>;
}

const NEW_FUNCTIONS = [
  "wbResizeImage", "wbUploadVariants", "wbUploadImage", "wbXhr", "wbProgressHandler",
  "wbFocalPicker", "wbFileMeta", "wbLoadFiles",
  "wbRenderStyleTab", "wbVariantTiles", "wbTileGroup", "wbRadioKeys",
  "wbSectionThumb", "wbLineArt", "wbRenderPalette", "wbWireChip", "wbDesignRoles",
  "qhPaletteFromLogo", "qhLogoPixels", "qhMedianCut", "qhPaletteCandidates",
];

describe("admin.html editor phase 2 — functions and contracts", () => {
  it("every behaviour's function exists", () => {
    for (const name of NEW_FUNCTIONS) expect(() => fnSource(name), name).not.toThrow();
  });

  it("the image pipeline follows the Task B contract", () => {
    expect(ADMIN).toContain("const WB_VARIANT_WIDTHS = [480, 960, 1600, 2400];");
    expect(ADMIN).toContain("const WB_VARIANT_QUALITY = 0.82;");
    expect(ADMIN).toContain("const WB_IMAGE_MAX_BYTES = 10 * 1024 * 1024;");
    expect(ADMIN).toContain("const WB_VARIANTS_MAX_BYTES = 25 * 1024 * 1024;");
    const resize = fnSource("wbResizeImage");
    expect(resize).toContain("createImageBitmap(file)");
    expect(resize).toContain("WB_VARIANT_WIDTHS.filter((w) => w <= width)"); // skip widths above the original
    expect(resize).toContain("canvas.toBlob(resolve, mime, WB_VARIANT_QUALITY)");
    const upload = fnSource("wbUploadImage");
    expect(upload).toContain("f.size > WB_IMAGE_MAX_BYTES"); // reject > 10 MB
    expect(upload).toContain("/files?filename=${encodeURIComponent(f.name)}"); // original via POST /files
    const variants = fnSource("wbUploadVariants");
    expect(variants).toContain("/files/${fileId}/variants");
    expect(variants).toContain('"X-Image-Width": String(resized.width)');
    expect(variants).toContain('"X-Image-Height": String(resized.height)');
    expect(variants).toContain("form.append(`w${v.w}.${v.ext}`"); // parts named w480.webp, w480.jpg, ...
    expect(ADMIN).toContain('const WB_VARIANT_FORMATS = [["webp", "image/webp"], ["jpg", "image/jpeg"]];');
  });

  it("the focal picker stores style.imageFocal and PATCHes the file's focal", () => {
    const focal = fnSource("wbFocalPicker");
    expect(focal).toContain('method: "PATCH"');
    expect(focal).toContain("JSON.stringify({ focal: cur })");
    expect(focal).toContain("/files/${fileId}`");
    expect(focal).toContain('"16 / 9"');
    expect(focal).toContain('"1 / 1"');
    const style = fnSource("wbRenderStyleTab");
    expect(style).toContain("imageFocal");
    expect(style).toContain("wbImageField(");
  });

  it("the Style tab replaces the phase-1 Style row and covers every style key", () => {
    const props = fnSource("wbRenderSectionProps");
    expect(props).toContain("wbRenderStyleTab(");
    expect(props).not.toContain('legend.textContent = "Style"');
    const style = fnSource("wbRenderStyleTab");
    for (const key of ["bg", "width", "spacing", "align", "media"]) expect(style).toContain(`"${key}"`);
    expect(style).toContain("WB_PATTERN_IDS"); // pattern override
    expect(style).toContain("Reset to design defaults");
    // Tiles read the tenant roles (from --qh-* vars), not hard-coded colours.
    expect(style).toContain("wbDesignRoles()");
    expect(fnSource("wbDesignRoles")).toContain("--qh-");
  });

  it("palette-from-logo samples on a <= 32 px canvas, median-cuts to six colours, offers three candidates", () => {
    const px = fnSource("qhLogoPixels");
    expect(px).toContain("32 / Math.max(bitmap.width, bitmap.height)");
    const from = fnSource("qhPaletteFromLogo");
    expect(from).toContain("qhMedianCut(qhLogoPixels(bitmap), 6)");
    expect(from).toContain("logo_file_id");
    const cands = fnSource("qhPaletteCandidates");
    expect(cands).toContain("qhDesignColor.hexToOklch");
    expect((cands.match(/cand\("/g) || []).length).toBe(3);
    const panel = fnSource("qhDesignPanel");
    expect(panel).toContain('"From your logo"');
    expect(panel).toContain("qhPaletteFromLogo(");
    // The colour maths stays in the one labelled client port of color.ts.
    expect(ADMIN).toContain("return { normalizeHex, contrastRatio, deriveRoles, hexToOklch, oklchToHex };");
  });
});

describe("admin.html editor phase 2 — DOM only, no innerHTML templates for data", () => {
  it("none of the new functions assign innerHTML", () => {
    for (const name of NEW_FUNCTIONS) {
      expect(fnSource(name), name).not.toMatch(/innerHTML\s*=/);
      expect(fnSource(name), name).not.toMatch(/insertAdjacentHTML/);
    }
    // The section props panel (Content + Style tabs) is DOM-built too.
    expect(fnSource("wbRenderSectionProps")).not.toMatch(/innerHTML\s*=/);
    expect(fnSource("wbImageField")).not.toMatch(/innerHTML\s*=/);
  });

  it("no innerHTML assignment anywhere in the admin script interpolates a template with ${ into a new function", () => {
    for (const name of NEW_FUNCTIONS) expect(fnSource(name), name).not.toMatch(/innerHTML\s*=\s*`[^`]*\$\{/);
  });
});

describe("admin.html inline scripts parse", () => {
  const scripts = inlineScripts(ADMIN);
  it("has the two inline scripts", () => {
    expect(scripts.length).toBe(2);
  });
  it("each compiles (the vitest form of node --check)", () => {
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });

  // Parsing is not enough. `window.foo = foo;` where foo no longer exists is
  // valid syntax and a ReferenceError at load, which stops the rest of the
  // script — including sign-in. That shipped once, when a removed dialog left
  // its export line behind.
  it("every window.* export names something the script declares", () => {
    const body = scripts.join("\n");
    const declared = new Set<string>();
    const add = (list: string) => {
      for (const part of list.split(",")) {
        const id = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(part);
        if (id) declared.add(id[1]);
      }
    };
    for (const m of body.matchAll(/\n\s*(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
      declared.add(m[1]);
    }
    // A name in scope can also be a parameter or a destructured binding.
    for (const m of body.matchAll(/\n\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) add(m[1]);
    for (const m of body.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/g)) add(m[1]);
    const missing: string[] = [];
    for (const m of body.matchAll(/\n\s*window\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
      if (!declared.has(m[2])) missing.push(`window.${m[1]} = ${m[2]}`);
    }
    expect(missing, "exported but never declared").toEqual([]);
  });
});

describe("admin.html thumbnails and defaults mirror the section schema", () => {
  it("WB_THUMB_ART has art for every section type and variant", () => {
    const art = literalOf("WB_THUMB_ART") as Record<string, Record<string, string>>;
    for (const type of SECTION_TYPES) {
      expect(art[type], `thumbnail art for "${type}"`).toBeDefined();
      const variants = (SECTION_VARIANTS as Record<string, readonly string[]>)[type] ?? [""];
      for (const v of variants) {
        expect(typeof (art[type][v] ?? art[type][""]), `art for ${type}/${v || "default"}`).toBe("string");
      }
      for (const s of Object.values(art[type])) {
        for (const tok of s.trim().split(/\s+/)) expect(tok).toMatch(/^(band|block|solid|frame|line|dot|circle|pat):[\d.,]+$/);
      }
    }
  });

  it("WB_DEFAULT_STYLE mirrors DEFAULT_STYLE", () => {
    expect(literalOf("WB_DEFAULT_STYLE")).toEqual({ ...DEFAULT_STYLE });
  });

  it("the section palette is built by wbRenderPalette (search, groups, keyboard) and the classic chips stay wired", () => {
    const pal = fnSource("wbRenderPalette");
    expect(pal).toContain('search.type = "search"');
    expect(pal).toContain("cat.groups");
    expect(pal).toContain("wbSectionThumb(");
    expect(pal).toContain('"ArrowDown"');
    expect(ADMIN).toContain('document.querySelectorAll(".wb-chip:not([data-wired])").forEach((chip) => wbWireChip(chip));');
  });
});

describe("qh.css carries the editor styles", () => {
  it("has the Style tab, tiles, focal picker, palette search and upgrade dialog rules", () => {
    for (const sel of [".wb-ptabs", ".wb-tile", ".wb-tile.on", ".wb-focal-stage", ".wb-focal-mark", ".wb-crop", ".wb-pal-search", ".wb-chip--thumb", ".wb-progress", ".qh-logo-pal", ".qh-upgrade-frame"]) {
      expect(CSS, sel).toContain(sel);
    }
  });
});
