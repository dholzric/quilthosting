/**
 * Kit schema and validator.
 *
 * A kit is data: a design (palette, type pair, shape, rhythm, header, footer,
 * pattern) plus pages made of sections with real sample copy. Kits are
 * authored as JSON (`src/lib/site/kits/<id>.json`, see QuiltHostingTemplates.md
 * at the repo root) and `validateKit` is the gate: schema, section type and
 * variant existence, palette and type-pair ids, imagery references, reserved
 * slugs, internal links, copy rules, the sample marker, and the contrast of
 * the default palette. Every issue carries the JSON path an author can act on.
 *
 * The kit schema is frozen at the end of phase 1; later phases only add
 * section types and variants (docs/superpowers/specs/2026-09-08-site-design-system-and-kits-design.md §4.6).
 */

import { z } from "zod";
import { RESERVED_SLUGS } from "../../../routes/pages";
import { contrastRatio } from "../design/color";
import { stockPhoto } from "../photos";
import { paletteById } from "../design/palettes";
import { deriveRoles, siteDesignSchema } from "../design/tokens";
import type { SiteDesign } from "../design/tokens";
import { typePairById } from "../design/typePairs";
import { SECTION_TYPES, parseSections } from "../sections/schema";
import type { Section } from "../sections/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Same shape the shell renderer's `buildMenu` produces from settings.nav. */
export type SiteMenuItem = { label: string; href: string; external?: boolean; children?: SiteMenuItem[] };

export type KitImage = { id: string; kind: "pattern" | "photo"; alt: string; src?: string };

export type KitPage = {
  slug: string;
  title: string;
  nav: boolean;
  navLabel?: string;
  membersOnly?: boolean;
  sections: Section[];
};

export type KitDefaults = Omit<SiteDesign, "palette"> & { palette: string };

export type Kit = {
  id: string;
  name: string;
  audience: "guild" | "business" | "both";
  character: string;
  defaults: KitDefaults;
  pages: KitPage[];
  menu?: SiteMenuItem[];
  imagery: KitImage[];
  previewSeed: { guildName: string; city: string };
};

export type KitIssue = { path: string; message: string };

/**
 * Visible prefix on every sample paragraph a kit ships. Re-exported by
 * src/lib/starterSite.ts (its historical home) and detected with a LIKE in
 * src/lib/onboarding.ts. Defined here so the kits module does not depend on
 * starterSite, which depends on the kits.
 */
export const SAMPLE_MARKER = "Sample text — replace me:";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SECTION_ID_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * Root paths the platform renders itself (system pages, Task 7 of the phase-1
 * plan) plus the member portal. An internal kit link must point at one of
 * these or at a page in the kit.
 */
export const KIT_SYSTEM_PATHS: readonly string[] = Object.freeze([
  "membership",
  "join",
  "events",
  "calendar",
  "galleries",
  "photos",
  "blog",
  "portal",
]);

/** Words that mean the copy is filler, not sample guild copy. */
const FORBIDDEN_COPY: readonly { re: RegExp; message: string }[] = [
  { re: /lorem/i, message: 'Copy contains "lorem" -- write real sample copy' },
  { re: /ipsum/i, message: 'Copy contains "ipsum" -- write real sample copy' },
  { re: /\[placeholder\]/i, message: 'Copy contains "[placeholder]" -- use {{guild_name}}, {{city}}, {{meeting_info}} or real sample copy' },
  { re: /world[- ]class|best[- ]in[- ]class|premier\b|unparalleled/i, message: "Copy contains a superlative -- say what the guild does instead" },
  { re: /!/, message: "Copy contains an exclamation mark -- the copy rules forbid them" },
];

/** String fields that are identifiers or URLs, not copy. */
const NON_COPY_KEYS = new Set([
  "id", "src", "href", "ctaHref", "secondaryHref", "mapUrl", "url", "imageId", "gallerySlug", "formSlug",
  "slug", "palette", "typePair", "kind", "type", "variant", "source", "projectType", "icon", "audience",
]);

const SECTION_TYPE_SET: ReadonlySet<string> = new Set(SECTION_TYPES);

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * `defaults` is validated by the site design schema (so the enums can never
 * drift from `SiteDesign`), with `palette` as a library id instead of an
 * `{id, input}` object.
 */
const defaultsSchema = z
  .object({ palette: z.string().min(1, "palette id is required") })
  .passthrough()
  .transform((d, ctx) => {
    const r = siteDesignSchema.safeParse({ ...d, palette: { id: d.palette } });
    if (!r.success) {
      for (const iss of r.error.issues) {
        // paletteSchema reports under palette.id; the kit field is `palette`.
        const p = iss.path[0] === "palette" ? ["palette"] : iss.path;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: p, message: iss.message });
      }
      return z.NEVER;
    }
    const out: KitDefaults = { ...r.data, palette: d.palette };
    return out;
  });

/**
 * Sections are validated by `parseSections` (the same code path the page
 * editor uses). Legacy block types are rejected outright so a kit can never
 * depend on the block -> section normalization.
 */
const sectionsSchema = z
  .array(z.unknown())
  .min(1, "A page needs at least one section")
  .max(80)
  .transform((raw, ctx) => {
    let bad = false;
    const ids = new Set<string>();
    raw.forEach((item, i) => {
      if (!isRecord(item)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: "Expected a section object" });
        bad = true;
        return;
      }
      const type = String(item.type ?? "");
      if (!SECTION_TYPE_SET.has(type)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "type"], message: `Unsupported section type "${type}"` });
        bad = true;
        return;
      }
      if (item.id !== undefined) {
        const id = String(item.id);
        if (!SECTION_ID_RE.test(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "id"], message: "Section id must be kebab-case (a-z, 0-9, -, _), at most 40 characters" });
          bad = true;
        } else if (ids.has(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "id"], message: `Duplicate section id "${id}"` });
          bad = true;
        }
        ids.add(id);
      }
    });
    if (bad) return z.NEVER;
    const r = parseSections(raw);
    if (r.issues.length) {
      for (const iss of r.issues) {
        // "sections.N.field" -> [N, "field"], relative to this array.
        const rel = iss.path.split(".").slice(1).map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: rel, message: iss.message });
      }
      return z.NEVER;
    }
    return r.sections;
  });

const pageSchema = z.object({
  slug: z.string().regex(KEBAB_RE, "Slug must be kebab-case (a-z, 0-9, -)").max(60),
  title: z.string().min(1).max(80),
  nav: z.boolean().default(true),
  navLabel: z.string().min(1).max(40).optional(),
  membersOnly: z.boolean().optional(),
  sections: sectionsSchema,
});

const menuLeafSchema = z.object({
  label: z.string().min(1).max(40),
  href: z.string().min(1).max(500),
  external: z.boolean().optional(),
});

const menuItemSchema: z.ZodType<SiteMenuItem, z.ZodTypeDef, unknown> = menuLeafSchema.extend({
  children: z.array(menuLeafSchema).max(12).optional(),
});

const imageSchema = z.object({
  id: z.string().regex(KEBAB_RE, "Image id must be kebab-case").max(64),
  kind: z.enum(["pattern", "photo"]),
  alt: z.string().max(200).default(""),
  src: z.string().max(300).optional(),
});

export const kitSchema: z.ZodType<Kit, z.ZodTypeDef, unknown> = z.object({
  id: z.string().regex(KEBAB_RE, "Kit id must be kebab-case and match the file name").max(40),
  name: z.string().min(1).max(60),
  audience: z.enum(["guild", "business", "both"]),
  character: z.string().min(1).max(200),
  defaults: defaultsSchema,
  pages: z.array(pageSchema).min(1).max(30),
  menu: z.array(menuItemSchema).max(12).optional(),
  imagery: z.array(imageSchema).max(60).default([]),
  previewSeed: z.object({
    guildName: z.string().min(1).max(80),
    city: z.string().min(1).max(80),
  }),
});

// ---------------------------------------------------------------------------
// Cross-field checks (things zod cannot express per field)
// ---------------------------------------------------------------------------

const MAX_TOP_LEVEL_MENU = 7;

/** Walk every string in `value`, reporting `path` for each. */
function walkStrings(value: unknown, path: string, visit: (path: string, key: string, s: string) => void, key = ""): void {
  if (typeof value === "string") {
    visit(path, key, value);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, `${path}.${i}`, visit, key));
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, visit, k);
  }
}

function checkCopy(raw: Record<string, unknown>, issues: KitIssue[]): void {
  walkStrings(raw, "", (path, key, s) => {
    if (NON_COPY_KEYS.has(key)) return;
    if (path === "id" || path === "name" || path.startsWith("previewSeed")) return;
    for (const rule of FORBIDDEN_COPY) {
      if (rule.re.test(s)) {
        issues.push({ path, message: rule.message });
        break;
      }
    }
  });
}

function internalTarget(href: string): string | null {
  if (!href.startsWith("/")) return null; // external, mailto, tel, #anchor: not ours to check
  return href.slice(1).split(/[/?#]/)[0];
}

function checkLink(href: string | undefined, path: string, pageSlugs: Set<string>, issues: KitIssue[]): void {
  if (!href) return;
  const target = internalTarget(href);
  if (target === null || target === "") return;
  if (pageSlugs.has(target) || KIT_SYSTEM_PATHS.includes(target)) return;
  issues.push({
    path,
    message: `Links to "/${target}", which is neither a page in this kit nor a system page (${KIT_SYSTEM_PATHS.map((p) => "/" + p).join(", ")})`,
  });
}

function checkSections(kit: Kit, issues: KitIssue[]): void {
  const imageIds = new Set(kit.imagery.map((i) => i.id));
  const pageSlugs = new Set(kit.pages.map((p) => p.slug));
  kit.pages.forEach((page, pi) => {
    const base = `pages.${pi}.sections`;
    if (!JSON.stringify(page.sections).includes(SAMPLE_MARKER)) {
      issues.push({ path: base, message: `Page "${page.slug}" has no sample marker ("${SAMPLE_MARKER}") -- mark the copy the officer must replace` });
    }
    page.sections.forEach((s, si) => {
      const sp = `${base}.${si}`;
      if (s.style.imageId && !imageIds.has(s.style.imageId)) {
        issues.push({ path: `${sp}.style.imageId`, message: `Image "${s.style.imageId}" is not declared in imagery` });
      }
      if (s.style.bg === "image" && !s.style.imageId) {
        issues.push({ path: `${sp}.style.imageId`, message: 'style.bg "image" needs style.imageId' });
      }
      switch (s.type) {
        case "hero":
          checkLink(s.ctaHref, `${sp}.ctaHref`, pageSlugs, issues);
          checkLink(s.secondaryHref, `${sp}.secondaryHref`, pageSlugs, issues);
          if (s.variant === "image" && !s.style.imageId) {
            issues.push({ path: `${sp}.style.imageId`, message: 'hero variant "image" needs style.imageId' });
          }
          break;
        case "image":
        case "gallery":
          s.items.forEach((it, ii) => {
            if (it.imageId && !imageIds.has(it.imageId)) {
              issues.push({ path: `${sp}.items.${ii}.imageId`, message: `Image "${it.imageId}" is not declared in imagery` });
            }
          });
          break;
        case "feature_grid":
          s.items.forEach((it, ii) => checkLink(it.href, `${sp}.items.${ii}.href`, pageSlugs, issues));
          break;
        case "cta":
          checkLink(s.href, `${sp}.href`, pageSlugs, issues);
          break;
        default:
          break;
      }
    });
  });
}

function checkPages(kit: Kit, issues: KitIssue[]): void {
  const seen = new Set<string>();
  kit.pages.forEach((p, i) => {
    if (RESERVED_SLUGS.has(p.slug)) {
      issues.push({ path: `pages.${i}.slug`, message: `"${p.slug}" is a reserved path (a system page or platform route); link to it instead` });
    }
    if (seen.has(p.slug)) issues.push({ path: `pages.${i}.slug`, message: `Duplicate page slug "${p.slug}"` });
    seen.add(p.slug);
  });
  if (!seen.has("home")) issues.push({ path: "pages", message: 'A kit needs a page with slug "home"' });
  const navCount = kit.menu ? kit.menu.length : kit.pages.filter((p) => p.nav).length;
  if (navCount > MAX_TOP_LEVEL_MENU) {
    issues.push({
      path: kit.menu ? "menu" : "pages",
      message: `${navCount} top-level navigation items; keep it to ${MAX_TOP_LEVEL_MENU} or fewer and nest the rest`,
    });
  }
}

function checkMenu(kit: Kit, issues: KitIssue[]): void {
  if (!kit.menu) return;
  const pageSlugs = new Set(kit.pages.map((p) => p.slug));
  kit.menu.forEach((item, i) => {
    checkLink(item.href, `menu.${i}.href`, pageSlugs, issues);
    item.children?.forEach((child, ci) => checkLink(child.href, `menu.${i}.children.${ci}.href`, pageSlugs, issues));
  });
}

function checkImagery(kit: Kit, issues: KitIssue[]): void {
  const seen = new Set<string>();
  const prefix = `public/kit-assets/${kit.id}/`;
  kit.imagery.forEach((img, i) => {
    if (seen.has(img.id)) issues.push({ path: `imagery.${i}.id`, message: `Duplicate image id "${img.id}"` });
    seen.add(img.id);
    if (img.kind === "photo") {
      // Two ways to hold a photo, and no third: a file the kit ships, or a
      // reference to the stock library (src/lib/site/photos.ts), whose ids are
      // fixed and verified. Checking membership is stricter than checking a
      // path — a stock ref cannot point anywhere we have not already looked.
      if (!img.src) {
        issues.push({ path: `imagery.${i}.src`, message: `Photo "${img.id}" needs src under ${prefix}, or a "photo:<id>" from the stock library` });
      } else if (img.src.startsWith("photo:")) {
        if (!stockPhoto(img.src)) {
          issues.push({ path: `imagery.${i}.src`, message: `Photo "${img.src}" is not in the stock library (src/lib/site/photos.ts)` });
        }
      } else if (!img.src.startsWith(prefix) || img.src.includes("..")) {
        issues.push({ path: `imagery.${i}.src`, message: `Photo src must live under ${prefix}, or be a "photo:<id>" from the stock library` });
      }
      if (!img.alt) issues.push({ path: `imagery.${i}.alt`, message: `Photo "${img.id}" needs alt text` });
    }
  });
}

/** Every derived text pairing of the default palette must pass WCAG AA. */
function checkContrast(kit: Kit, issues: KitIssue[]): void {
  const palette = paletteById(kit.defaults.palette);
  if (!palette) return; // already reported by the schema
  const r = deriveRoles(palette.input, palette.dark, palette.ground);
  const pairs: [string, string, string, number][] = [
    ["ink/bg", r.ink, r.bg, 4.5],
    ["ink/surface", r.ink, r.surface, 4.5],
    ["ink/surfaceAlt", r.ink, r.surfaceAlt, 4.5],
    ["ink/tint", r.ink, r.tint, 4.5],
    ["inkMuted/bg", r.inkMuted, r.bg, 4.5],
    ["onPrimary/primary", r.onPrimary, r.primary, 4.5],
    ["onPrimary/primaryHover", r.onPrimary, r.primaryHover, 4.5],
    ["onAccent/accent", r.onAccent, r.accent, 4.5],
    ["onDark/dark", r.onDark, r.dark, 4.5],
    ["primary/bg", r.primary, r.bg, 3],
  ];
  for (const [label, a, b, min] of pairs) {
    const ratio = contrastRatio(a, b);
    if (ratio < min) {
      issues.push({ path: "defaults.palette", message: `Palette "${kit.defaults.palette}" fails contrast for ${label} (${ratio.toFixed(2)}:1, needs ${min}:1)` });
    }
  }
  // Belt and braces: the type pair must resolve (the schema already refines it).
  if (typePairById(kit.defaults.typePair).id !== kit.defaults.typePair) {
    issues.push({ path: "defaults.typePair", message: `Unknown type pair "${kit.defaults.typePair}"` });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate a raw kit document. Never throws. When the schema passes, the
 * cross-field checks run and `kit` is returned even if they report issues,
 * so tooling can still show what the kit would look like.
 */
export function validateKit(raw: unknown): { kit?: Kit; issues: KitIssue[] } {
  const issues: KitIssue[] = [];
  if (!isRecord(raw)) {
    return { issues: [{ path: "kit", message: "Expected a kit object" }] };
  }
  const parsed = kitSchema.safeParse(raw);
  if (!parsed.success) {
    for (const iss of parsed.error.issues) {
      issues.push({ path: iss.path.join(".") || "kit", message: iss.message });
    }
    return { issues: dedupe(issues) };
  }
  const kit = parsed.data;
  checkPages(kit, issues);
  checkCopy(raw, issues);
  checkSections(kit, issues);
  checkMenu(kit, issues);
  checkImagery(kit, issues);
  checkContrast(kit, issues);
  return { kit, issues: dedupe(issues) };
}

function dedupe(issues: KitIssue[]): KitIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.path} ${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
