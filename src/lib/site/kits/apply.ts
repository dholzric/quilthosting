/**
 * Applying a kit to a tenant.
 *
 * - `substitutePlaceholders` fills `{{guild_name}}`, `{{city}}` and
 *   `{{meeting_info}}`: HTML-escaped inside rich-HTML fields (rich_text.html,
 *   faq answers, embed.html), raw in plain-text fields, which every renderer
 *   escapes at output time.
 * - `kitPageRows` produces the rows the `INSERT INTO pages` in
 *   src/routes/tenants.ts binds (blocks_json holds the section document;
 *   content_json a plain-HTML fallback).
 * - `kitSettingsJson` produces settings_json: the kit's design expanded from
 *   the palette library, plus `site.renderer = "sections"` for serveSite.
 * - `sectionsToLegacyBlocks` downgrades sections to the block model that
 *   guild.html and the guild website builder render, for the legacy starter
 *   site (src/lib/starterSite.ts) until every guild is on the new renderer.
 */

import { blocksToHtml, escapeHtml, parseBlocks } from "../../blocks";
import type { PageBlock } from "../../blocks";
import { paletteById } from "../design/palettes";
import type { SiteDesign } from "../design/tokens";
import type { Section } from "../sections/schema";
import type { Kit } from "./schema";

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

export type KitVars = {
  guildName: string;
  city?: string | null;
  meetingInfo?: string | null;
};

/** Used for `{{city}}` when the tenant has not given one. */
export const CITY_FALLBACK = "your town";
/** Used for `{{meeting_info}}` when the tenant has not given one; reads after "We meet". */
export const MEETING_INFO_FALLBACK = "on the second Tuesday of every month at 6:30 pm";

const PLACEHOLDER_RE = /\{\{\s*(guild_name|city|meeting_info)\s*\}\}/g;

/** Field names whose value is sanitized HTML rather than plain text. */
const HTML_KEYS = new Set(["html"]);

function resolveVars(vars: KitVars): Record<string, string> {
  const name = String(vars.guildName ?? "").trim() || "our guild";
  const city = String(vars.city ?? "").trim() || CITY_FALLBACK;
  const meeting = String(vars.meetingInfo ?? "").trim() || MEETING_INFO_FALLBACK;
  return { guild_name: name, city, meeting_info: meeting };
}

function fill(s: string, vars: Record<string, string>, html: boolean): string {
  return s.replace(PLACEHOLDER_RE, (_m, key: string) => (html ? escapeHtml(vars[key]) : vars[key]));
}

function deepFill(value: unknown, vars: Record<string, string>, html: boolean, ownerType: string): unknown {
  if (typeof value === "string") return fill(value, vars, html);
  if (Array.isArray(value)) return value.map((v) => deepFill(v, vars, html, ownerType));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const rec = value as Record<string, unknown>;
    const type = typeof rec.type === "string" ? String(rec.type) : ownerType;
    for (const [k, v] of Object.entries(rec)) {
      const isHtml = HTML_KEYS.has(k) || (type === "faq" && k === "a");
      out[k] = deepFill(v, vars, isHtml, type);
    }
    return out;
  }
  return value;
}

/** Returns new sections; the input is not mutated. Unknown `{{tokens}}` are left as-is. */
export function substitutePlaceholders(sections: Section[], vars: KitVars): Section[] {
  const resolved = resolveVars(vars);
  return sections.map((s) => deepFill(s, resolved, false, s.type) as Section);
}

// ---------------------------------------------------------------------------
// Design and settings
// ---------------------------------------------------------------------------

/** The kit's default design with the palette expanded from the library. */
export function kitDesign(kit: Kit): SiteDesign {
  const { palette: paletteId, ...rest } = kit.defaults;
  const lib = paletteById(paletteId);
  if (!lib) throw new Error(`Kit "${kit.id}" uses unknown palette "${paletteId}"`);
  return {
    ...rest,
    shape: { ...rest.shape },
    rhythm: { ...rest.rhythm },
    header: { ...rest.header },
    footer: { ...rest.footer },
    pattern: { ...rest.pattern },
    palette: { id: lib.id, input: { ...lib.input } },
  };
}

/** settings_json for a tenant on this kit: design + renderer flag (+ nav when the kit defines a menu). */
export function kitSettingsJson(kit: Kit): string {
  const settings: Record<string, unknown> = {
    design: kitDesign(kit),
    site: { renderer: "sections", kit: kit.id },
  };
  if (kit.menu && kit.menu.length) settings.nav = kit.menu;
  return JSON.stringify(settings);
}

// ---------------------------------------------------------------------------
// Page rows
// ---------------------------------------------------------------------------

export type KitTenant = { id: string; name: string; city?: string | null; meetingInfo?: string | null };

/** Column values for the pages INSERT in tenants.ts (a superset of starterPageRow's). */
export type PageInsert = {
  tenant_id: string;
  slug: string;
  title: string;
  content_json: string;
  blocks_json: string;
  sort_order: number;
  show_in_nav: 0 | 1;
  nav_label: string | null;
  is_members_only: 0 | 1;
  created_at: string;
  updated_at: string;
};

/**
 * Kit imagery of kind "pattern" is generated art, not a file. Rewrite every
 * reference to it as `pattern:<id>` (the kit's default pattern, or log-cabin
 * when the kit has none) so the renderer draws a tile instead of a broken
 * image. Photo imagery keeps its id (uploaded as a file at apply time).
 */
export function resolveKitImagery(sections: Section[], kit: Kit): Section[] {
  const patternIds = new Set(kit.imagery.filter((im) => im.kind === "pattern").map((im) => im.id));
  if (!patternIds.size) return sections;
  const pid = kit.defaults.pattern?.id && kit.defaults.pattern.id !== "none" ? kit.defaults.pattern.id : "log-cabin";
  const ref = `pattern:${pid}`;
  const fix = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = k === "imageId" && typeof val === "string" && patternIds.has(val) ? ref : fix(val);
      }
      return out;
    }
    return v;
  };
  return fix(sections) as Section[];
}

export function kitPageRows(kit: Kit, tenant: KitTenant, now: string): PageInsert[] {
  const vars: KitVars = { guildName: tenant.name, city: tenant.city, meetingInfo: tenant.meetingInfo };
  return kit.pages.map((page, i) => {
    const sections = resolveKitImagery(substitutePlaceholders(page.sections, vars), kit);
    const fallback = blocksToHtml(sectionsToLegacyBlocks(sections));
    return {
      tenant_id: tenant.id,
      slug: page.slug,
      title: page.title,
      content_json: JSON.stringify({ html: fallback }),
      blocks_json: JSON.stringify(sections),
      sort_order: i,
      show_in_nav: page.nav ? 1 : 0,
      nav_label: page.navLabel ?? null,
      is_members_only: page.membersOnly ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
  });
}

// ---------------------------------------------------------------------------
// Legacy downgrade
// ---------------------------------------------------------------------------

const p = (html: string): string => `<p>${html}</p>`;
const text = (html: string): PageBlock => ({ type: "text", html });
const heading = (t: string, level: 1 | 2 | 3): PageBlock => ({ type: "heading", text: t, level });
const button = (label: string, href: string, style: "primary" | "secondary" = "primary"): PageBlock => ({ type: "button", label, href, style });

/**
 * Sections -> legacy blocks (heading, text, button, divider, join_cta,
 * spacer, image, html, project_intake). Plain-text section fields are
 * HTML-escaped on the way into `text` blocks; heading text stays raw because
 * blocksToHtml escapes it. Dynamic sections the legacy shell cannot render
 * become a link to the matching built-in route (events, membership,
 * galleries) or are dropped (blog/store teasers, contact form). The result
 * is normalized through parseBlocks so what is stored equals what the page
 * editor reads back.
 */
export function sectionsToLegacyBlocks(sections: Section[]): PageBlock[] {
  const out: PageBlock[] = [];
  for (const s of sections) {
    switch (s.type) {
      case "hero":
        out.push(heading(s.title, 1));
        if (s.eyebrow) out.push(text(p(`<small>${escapeHtml(s.eyebrow)}</small>`)));
        if (s.subtitle) out.push(text(p(escapeHtml(s.subtitle))));
        if (s.stats?.length) {
          out.push(text(`<ul>${s.stats.map((st) => `<li><strong>${escapeHtml(st.value)}</strong> ${escapeHtml(st.label)}</li>`).join("")}</ul>`));
        }
        if (s.ctaLabel && s.ctaHref) out.push(button(s.ctaLabel, s.ctaHref));
        if (s.secondaryLabel && s.secondaryHref) out.push(button(s.secondaryLabel, s.secondaryHref, "secondary"));
        break;
      case "rich_text":
        if (s.heading) out.push(heading(s.heading, 2));
        out.push(text(s.html));
        break;
      case "image":
        for (const it of s.items) if (it.url) out.push({ type: "image", url: it.url, alt: it.alt, caption: it.caption });
        break;
      case "feature_grid": {
        if (s.heading) out.push(heading(s.heading, 2));
        const items = s.items.map((it) => {
          const title = it.href ? `<a href="${escapeHtml(it.href)}">${escapeHtml(it.title)}</a>` : escapeHtml(it.title);
          const price = it.price ? ` (${escapeHtml(it.price)})` : "";
          const body = it.body ? ` — ${escapeHtml(it.body)}` : "";
          return `<li><strong>${title}</strong>${price}${body}</li>`;
        });
        if (items.length) out.push(text(`<ul>${items.join("")}</ul>`));
        break;
      }
      case "faq":
        if (s.heading) out.push(heading(s.heading, 2));
        for (const it of s.items) out.push(text(p(`<strong>${escapeHtml(it.q)}</strong><br>${it.a}`)));
        break;
      case "testimonials":
        for (const it of s.items) {
          const by = it.author ? p(`— ${escapeHtml(it.author)}`) : "";
          out.push(text(`<blockquote>${p(escapeHtml(it.quote))}${by}</blockquote>`));
        }
        break;
      case "gallery":
        if (s.source === "gallery") {
          out.push(button("Browse the galleries", "/galleries", "secondary"));
        } else {
          for (const it of s.items) if (it.url) out.push({ type: "image", url: it.url, alt: it.alt ?? "", caption: it.caption });
        }
        break;
      case "events":
        out.push(button(s.heading || "See upcoming events", "/events", "secondary"));
        break;
      case "membership_levels":
        out.push({ type: "join_cta", title: s.heading || "Become a member", body: "" });
        break;
      case "join_band":
        out.push({ type: "join_cta", title: s.title, body: s.body ?? "" });
        break;
      case "meeting_info": {
        out.push(heading(s.heading || "When we meet", 2));
        const lines = [`<strong>When:</strong> ${escapeHtml(s.when)}`, `<strong>Where:</strong> ${escapeHtml(s.where)}`];
        if (s.address) lines.push(`<strong>Address:</strong> ${escapeHtml(s.address)}`);
        out.push(text(p(lines.join("<br>"))));
        if (s.note) out.push(text(p(escapeHtml(s.note))));
        if (s.mapUrl) out.push(button("Map and directions", s.mapUrl, "secondary"));
        break;
      }
      case "cta":
        out.push(button(s.label, s.href, s.kind));
        break;
      case "divider":
        out.push({ type: "divider" });
        break;
      case "spacer":
        out.push({ type: "spacer", height: s.height });
        break;
      case "embed":
        out.push({ type: "html", html: s.html });
        break;
      case "quote_cta":
        out.push({ type: "project_intake", projectType: s.projectType, heading: s.heading, submitLabel: s.submitLabel });
        break;
      case "store_teaser":
      case "blog_teaser":
      case "contact":
        // No legacy equivalent (store_list/events_list are not on the guild builder canvas;
        // contact_form needs a forms row). The page's rich text carries the details.
        break;
      default:
        break;
    }
  }
  return parseBlocks(out);
}
