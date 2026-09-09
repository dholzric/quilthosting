/**
 * Section schema for the server-rendered tenant site.
 *
 * A section replaces a page block: it carries a `type`, an optional
 * `variant`, a `style` (background, width, spacing, alignment, media side,
 * optional background image), a stable `id`, and the content fields for its
 * type. The schema is frozen at the end of phase 1 -- later phases only add
 * types and variants (see docs/superpowers/specs/2026-09-08-site-design-system-and-kits-design.md §4.3).
 *
 * `parseSections` is the single entry point for anything that reads a
 * section document: it accepts a legacy block array (delegating to
 * `parseBlocks` + `blocksToSections`) as well as a section array, validates
 * with zod, sanitizes every rich-HTML field and URL, and reports issues with
 * a `sections.N.field` path instead of throwing.
 */

import { z } from "zod";
import { parseBlocks } from "../../blocks";
import { sanitizeHtml, sanitizeUrl } from "../../sanitize";
import { blocksToSections, isLegacyBlockItem } from "./normalize";

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

export type SectionStyle = {
  bg: "none" | "tint" | "brand" | "dark" | "image" | "pattern";
  width: "narrow" | "normal" | "wide" | "full";
  spacing: "tight" | "normal" | "airy";
  align: "left" | "center";
  media: "left" | "right" | "top";
  /** files.id, served at /public/:slug/img/:id (platform host) or /img/:id (tenant host). */
  imageId?: string;
  /** 0..1 focal point for `bg: "image"`; default [0.5, 0.5]. */
  imageFocal?: [number, number];
};

export const DEFAULT_STYLE: SectionStyle = Object.freeze({
  bg: "none",
  width: "normal",
  spacing: "normal",
  align: "left",
  media: "right",
}) as SectionStyle;

/** Matches the id shape used by files.id and section ids alike. */
const ID_RE = /^[a-z0-9_-]{1,40}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Kits reference generated quilt-block art as "pattern:<id>" (see kits/apply.ts).
const IMAGE_REF_RE = new RegExp("^(?:pattern:(?:nine-patch|flying-geese|log-cabin|churn-dash|bear-paw)|" + /^[A-Za-z0-9_-]{1,64}$/.source + ")$");

const styleSchema = z
  .object({
    bg: z.enum(["none", "tint", "brand", "dark", "image", "pattern"]).default(DEFAULT_STYLE.bg),
    width: z.enum(["narrow", "normal", "wide", "full"]).default(DEFAULT_STYLE.width),
    spacing: z.enum(["tight", "normal", "airy"]).default(DEFAULT_STYLE.spacing),
    align: z.enum(["left", "center"]).default(DEFAULT_STYLE.align),
    media: z.enum(["left", "right", "top"]).default(DEFAULT_STYLE.media),
    imageId: z.string().regex(IMAGE_REF_RE).optional(),
    imageFocal: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  })
  .strip();

// ---------------------------------------------------------------------------
// Section union
// ---------------------------------------------------------------------------

export type Section =
  | {
      type: "hero";
      variant: "image" | "split" | "pattern" | "minimal" | "stats";
      eyebrow?: string;
      title: string;
      subtitle?: string;
      ctaLabel?: string;
      ctaHref?: string;
      secondaryLabel?: string;
      secondaryHref?: string;
      stats?: { value: string; label: string }[];
      style: SectionStyle;
      id: string;
    }
  | { type: "rich_text"; variant: "prose" | "two_column" | "with_image"; heading?: string; html: string; style: SectionStyle; id: string }
  | {
      type: "image";
      variant: "single" | "full_bleed" | "duo";
      items: { imageId?: string; url?: string; alt: string; caption?: string }[];
      style: SectionStyle;
      id: string;
    }
  | {
      type: "feature_grid";
      variant: "cards" | "icons" | "numbered";
      heading?: string;
      items: { icon?: string; title: string; body?: string; href?: string; price?: string }[];
      style: SectionStyle;
      id: string;
    }
  | { type: "faq"; heading?: string; items: { q: string; a: string }[]; style: SectionStyle; id: string }
  | { type: "testimonials"; variant: "grid" | "single"; items: { quote: string; author?: string }[]; style: SectionStyle; id: string }
  | {
      type: "gallery";
      variant: "grid" | "masonry";
      source: "manual" | "gallery";
      gallerySlug?: string;
      items: { imageId?: string; url?: string; alt?: string; caption?: string }[];
      style: SectionStyle;
      id: string;
    }
  | { type: "events"; variant: "cards" | "list" | "calendar" | "next_up"; heading?: string; limit: number; style: SectionStyle; id: string }
  | { type: "membership_levels"; variant: "cards" | "compact"; heading?: string; style: SectionStyle; id: string }
  | { type: "join_band"; title: string; body?: string; ctaLabel: string; style: SectionStyle; id: string }
  | {
      type: "meeting_info";
      heading?: string;
      when: string;
      where: string;
      address?: string;
      mapUrl?: string;
      note?: string;
      style: SectionStyle;
      id: string;
    }
  | { type: "store_teaser"; heading?: string; limit: number; style: SectionStyle; id: string }
  | { type: "blog_teaser"; heading?: string; limit: number; style: SectionStyle; id: string }
  | { type: "contact"; heading?: string; formSlug?: string; showDetails: boolean; style: SectionStyle; id: string }
  | { type: "quote_cta"; projectType: string; heading?: string; submitLabel?: string; style: SectionStyle; id: string }
  | { type: "cta"; label: string; href: string; kind: "primary" | "secondary"; style: SectionStyle; id: string }
  | { type: "divider"; style: SectionStyle; id: string }
  | { type: "spacer"; height: number; style: SectionStyle; id: string }
  | { type: "embed"; html: string; style: SectionStyle; id: string }
  // Phase 2 additions (docs/superpowers/plans/2026-09-08-site-sections-imagery-phase2.md Task A)
  | { type: "timeline"; heading?: string; items: { year: string; title: string; body?: string }[]; style: SectionStyle; id: string }
  | { type: "quote"; quote: string; author?: string; style: SectionStyle; id: string }
  | {
      type: "officers";
      heading?: string;
      items: { name: string; role: string; email?: string; imageId?: string }[];
      style: SectionStyle;
      id: string;
    }
  | { type: "benefits"; heading?: string; items: { title: string; body?: string }[]; style: SectionStyle; id: string }
  | { type: "event_spotlight"; eventId?: string; heading?: string; style: SectionStyle; id: string }
  | {
      type: "projects";
      heading?: string;
      items: { title: string; body?: string; imageId?: string; href?: string; stat?: string }[];
      style: SectionStyle;
      id: string;
    }
  | { type: "sponsors"; heading?: string; items: { name: string; imageId?: string; href?: string }[]; style: SectionStyle; id: string }
  | { type: "newsletter_signup"; heading?: string; body?: string; buttonLabel?: string; style: SectionStyle; id: string }
  | {
      type: "services";
      variant: "cards" | "table";
      heading?: string;
      items: { title: string; body?: string; price?: string; unit?: string }[];
      style: SectionStyle;
      id: string;
    }
  | {
      type: "portfolio";
      variant: "grid" | "featured";
      heading?: string;
      items: { imageId?: string; url?: string; title?: string; caption?: string }[];
      style: SectionStyle;
      id: string;
    }
  | {
      type: "hours_location";
      heading?: string;
      hours: { day: string; open: string }[];
      address?: string;
      mapUrl?: string;
      phone?: string;
      email?: string;
      note?: string;
      style: SectionStyle;
      id: string;
    }
  | { type: "process"; heading?: string; items: { title: string; body?: string }[]; style: SectionStyle; id: string }
  | { type: "documents"; heading?: string; limit: number; style: SectionStyle; id: string }
  | { type: "donate"; heading?: string; body?: string; amounts: number[]; style: SectionStyle; id: string };

export type SectionType = Section["type"];

export const SECTION_TYPES: readonly SectionType[] = Object.freeze([
  "hero",
  "rich_text",
  "image",
  "feature_grid",
  "faq",
  "testimonials",
  "gallery",
  "events",
  "membership_levels",
  "join_band",
  "meeting_info",
  "store_teaser",
  "blog_teaser",
  "contact",
  "quote_cta",
  "cta",
  "divider",
  "spacer",
  "embed",
  "timeline",
  "quote",
  "officers",
  "benefits",
  "event_spotlight",
  "projects",
  "sponsors",
  "newsletter_signup",
  "services",
  "portfolio",
  "hours_location",
  "process",
  "documents",
  "donate",
] as const);

/** type -> allowed variants; `[""]` for types that have no variant. */
export const SECTION_VARIANTS: Record<SectionType, readonly string[]> = Object.freeze({
  hero: ["image", "split", "pattern", "minimal", "stats"],
  rich_text: ["prose", "two_column", "with_image"],
  image: ["single", "full_bleed", "duo"],
  feature_grid: ["cards", "icons", "numbered"],
  faq: [""],
  testimonials: ["grid", "single"],
  gallery: ["grid", "masonry"],
  events: ["cards", "list", "calendar", "next_up"],
  membership_levels: ["cards", "compact"],
  join_band: [""],
  meeting_info: [""],
  store_teaser: [""],
  blog_teaser: [""],
  contact: [""],
  quote_cta: [""],
  cta: [""],
  divider: [""],
  spacer: [""],
  embed: [""],
  timeline: [""],
  quote: [""],
  officers: [""],
  benefits: [""],
  event_spotlight: [""],
  projects: [""],
  sponsors: [""],
  newsletter_signup: [""],
  services: ["cards", "table"],
  portfolio: ["grid", "featured"],
  hours_location: [""],
  process: [""],
  documents: [""],
  donate: [""],
});

const SECTION_TYPE_SET: ReadonlySet<string> = new Set(SECTION_TYPES);

// ---------------------------------------------------------------------------
// Zod schemas (one per type)
// ---------------------------------------------------------------------------

const short = (max: number) => z.string().max(max);
const optShort = (max: number) => z.string().max(max).optional();
/** Optional string where "" means "not set". */
const optText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const base = {
  id: z.string().optional(),
  style: styleSchema.default(DEFAULT_STYLE),
};

const heroSchema = z.object({
  ...base,
  type: z.literal("hero"),
  variant: z.enum(["image", "split", "pattern", "minimal", "stats"]).default("minimal"),
  eyebrow: optText(80),
  title: short(160),
  subtitle: optText(300),
  ctaLabel: optText(60),
  ctaHref: optText(2000),
  secondaryLabel: optText(60),
  secondaryHref: optText(2000),
  stats: z.array(z.object({ value: short(40), label: short(80) })).max(6).optional(),
});

const richTextSchema = z.object({
  ...base,
  type: z.literal("rich_text"),
  variant: z.enum(["prose", "two_column", "with_image"]).default("prose"),
  heading: optText(160),
  html: short(50000),
});

const mediaItemSchema = z.object({
  imageId: z.string().regex(IMAGE_REF_RE).optional(),
  url: optText(2000),
  alt: short(200).default(""),
  caption: optText(300),
});

const imageSchema = z.object({
  ...base,
  type: z.literal("image"),
  variant: z.enum(["single", "full_bleed", "duo"]).default("single"),
  items: z.array(mediaItemSchema).max(2).default([]),
});

const featureGridSchema = z.object({
  ...base,
  type: z.literal("feature_grid"),
  variant: z.enum(["cards", "icons", "numbered"]).default("cards"),
  heading: optText(160),
  items: z
    .array(
      z.object({
        icon: optText(8),
        title: short(120),
        body: optText(600),
        href: optText(2000),
        price: optText(40),
      })
    )
    .max(12)
    .default([]),
});

const faqSchema = z.object({
  ...base,
  type: z.literal("faq"),
  heading: optText(160),
  items: z.array(z.object({ q: short(300), a: short(2000) })).max(30).default([]),
});

const testimonialsSchema = z.object({
  ...base,
  type: z.literal("testimonials"),
  variant: z.enum(["grid", "single"]).default("grid"),
  items: z.array(z.object({ quote: short(800), author: optText(120) })).max(20).default([]),
});

const gallerySchema = z.object({
  ...base,
  type: z.literal("gallery"),
  variant: z.enum(["grid", "masonry"]).default("grid"),
  source: z.enum(["manual", "gallery"]).default("manual"),
  gallerySlug: optText(100),
  items: z
    .array(
      z.object({
        imageId: z.string().regex(IMAGE_REF_RE).optional(),
        url: optText(2000),
        alt: optText(200),
        caption: optText(300),
      })
    )
    .max(60)
    .default([]),
});

const eventsSchema = z.object({
  ...base,
  type: z.literal("events"),
  variant: z.enum(["cards", "list", "calendar", "next_up"]).default("cards"),
  heading: optText(160),
  limit: z.number().int().min(1).max(50).default(6),
});

const membershipLevelsSchema = z.object({
  ...base,
  type: z.literal("membership_levels"),
  variant: z.enum(["cards", "compact"]).default("cards"),
  heading: optText(160),
});

const joinBandSchema = z.object({
  ...base,
  type: z.literal("join_band"),
  title: short(120),
  body: optText(500),
  ctaLabel: short(60).default("Join"),
});

const meetingInfoSchema = z.object({
  ...base,
  type: z.literal("meeting_info"),
  heading: optText(160),
  when: short(200),
  where: short(200),
  address: optText(300),
  mapUrl: optText(2000),
  note: optText(500),
});

const storeTeaserSchema = z.object({
  ...base,
  type: z.literal("store_teaser"),
  heading: optText(160),
  limit: z.number().int().min(1).max(50).default(6),
});

const blogTeaserSchema = z.object({
  ...base,
  type: z.literal("blog_teaser"),
  heading: optText(160),
  limit: z.number().int().min(1).max(50).default(3),
});

const contactSchema = z.object({
  ...base,
  type: z.literal("contact"),
  heading: optText(160),
  formSlug: optText(100),
  showDetails: z.boolean().default(true),
});

const quoteCtaSchema = z.object({
  ...base,
  type: z.literal("quote_cta"),
  projectType: short(60).default("longarm"),
  heading: optText(120),
  submitLabel: optText(60),
});

const ctaSchema = z.object({
  ...base,
  type: z.literal("cta"),
  label: short(80),
  href: short(2000),
  kind: z.enum(["primary", "secondary"]).default("primary"),
});

const dividerSchema = z.object({ ...base, type: z.literal("divider") });

const spacerSchema = z.object({
  ...base,
  type: z.literal("spacer"),
  height: z.number().int().min(8).max(160).default(24),
});

const embedSchema = z.object({
  ...base,
  type: z.literal("embed"),
  html: short(50000),
});

// ---- Phase 2 types --------------------------------------------------------

const titleBodyItem = z.object({ title: short(120), body: optText(600) });

const timelineSchema = z.object({
  ...base,
  type: z.literal("timeline"),
  heading: optText(160),
  items: z.array(z.object({ year: short(20), title: short(120), body: optText(600) })).max(30).default([]),
});

const quoteSchema = z.object({
  ...base,
  type: z.literal("quote"),
  quote: short(600),
  author: optText(120),
});

const officersSchema = z.object({
  ...base,
  type: z.literal("officers"),
  heading: optText(160),
  items: z
    .array(
      z.object({
        name: short(120),
        role: short(120),
        email: optText(200),
        imageId: z.string().regex(IMAGE_REF_RE).optional(),
      })
    )
    .max(30)
    .default([]),
});

const benefitsSchema = z.object({
  ...base,
  type: z.literal("benefits"),
  heading: optText(160),
  items: z.array(titleBodyItem).max(20).default([]),
});

const eventSpotlightSchema = z.object({
  ...base,
  type: z.literal("event_spotlight"),
  eventId: optText(64),
  heading: optText(160),
});

const projectsSchema = z.object({
  ...base,
  type: z.literal("projects"),
  heading: optText(160),
  items: z
    .array(
      z.object({
        title: short(120),
        body: optText(600),
        imageId: z.string().regex(IMAGE_REF_RE).optional(),
        href: optText(2000),
        stat: optText(80),
      })
    )
    .max(12)
    .default([]),
});

const sponsorsSchema = z.object({
  ...base,
  type: z.literal("sponsors"),
  heading: optText(160),
  items: z
    .array(z.object({ name: short(120), imageId: z.string().regex(IMAGE_REF_RE).optional(), href: optText(2000) }))
    .max(30)
    .default([]),
});

const newsletterSignupSchema = z.object({
  ...base,
  type: z.literal("newsletter_signup"),
  heading: optText(160),
  body: optText(500),
  buttonLabel: optText(60),
});

const servicesSchema = z.object({
  ...base,
  type: z.literal("services"),
  variant: z.enum(["cards", "table"]).default("cards"),
  heading: optText(160),
  items: z.array(z.object({ title: short(120), body: optText(600), price: optText(40), unit: optText(40) })).max(20).default([]),
});

const portfolioSchema = z.object({
  ...base,
  type: z.literal("portfolio"),
  variant: z.enum(["grid", "featured"]).default("grid"),
  heading: optText(160),
  items: z
    .array(
      z.object({
        imageId: z.string().regex(IMAGE_REF_RE).optional(),
        url: optText(2000),
        title: optText(120),
        caption: optText(300),
      })
    )
    .max(60)
    .default([]),
});

const hoursLocationSchema = z.object({
  ...base,
  type: z.literal("hours_location"),
  heading: optText(160),
  hours: z.array(z.object({ day: short(40), open: short(60) })).max(14).default([]),
  address: optText(300),
  mapUrl: optText(2000),
  phone: optText(40),
  email: optText(200),
  note: optText(500),
});

const processSchema = z.object({
  ...base,
  type: z.literal("process"),
  heading: optText(160),
  items: z.array(titleBodyItem).max(12).default([]),
});

const documentsSchema = z.object({
  ...base,
  type: z.literal("documents"),
  heading: optText(160),
  limit: z.number().int().min(1).max(50).default(10),
});

/** Suggested donation amounts in cents; the island prompts for a custom amount via the "Other" button. */
export const DEFAULT_DONATE_AMOUNTS: readonly number[] = Object.freeze([1000, 2500, 5000, 10000]);

const donateSchema = z.object({
  ...base,
  type: z.literal("donate"),
  heading: optText(160),
  body: optText(500),
  amounts: z
    .array(z.number().int().min(100).max(1000000))
    .max(6)
    .default([...DEFAULT_DONATE_AMOUNTS]),
});

export const sectionSchema = z.discriminatedUnion("type", [
  heroSchema,
  richTextSchema,
  imageSchema,
  featureGridSchema,
  faqSchema,
  testimonialsSchema,
  gallerySchema,
  eventsSchema,
  membershipLevelsSchema,
  joinBandSchema,
  meetingInfoSchema,
  storeTeaserSchema,
  blogTeaserSchema,
  contactSchema,
  quoteCtaSchema,
  ctaSchema,
  dividerSchema,
  spacerSchema,
  embedSchema,
  timelineSchema,
  quoteSchema,
  officersSchema,
  benefitsSchema,
  eventSpotlightSchema,
  projectsSchema,
  sponsorsSchema,
  newsletterSignupSchema,
  servicesSchema,
  portfolioSchema,
  hoursLocationSchema,
  processSchema,
  documentsSchema,
  donateSchema,
]);

type ParsedSection = z.infer<typeof sectionSchema>;

// Compile-time check: the zod union and the hand-written `Section` type agree
// on the set of `type` literals. If one grows without the other, this fails.
type _ZodTypes = ParsedSection["type"];
type _Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _typesAgree: _Exact<_ZodTypes, SectionType> = true;
void _typesAgree;

// ---------------------------------------------------------------------------
// Post-validation cleanup: sanitize rich HTML, validate URLs, assign ids
// ---------------------------------------------------------------------------

const link = (u: string | undefined): string | undefined => (u ? sanitizeUrl(u, "link") ?? undefined : undefined);
const image = (u: string | undefined): string | undefined => (u ? sanitizeUrl(u, "image") ?? undefined : undefined);

function finalize(p: ParsedSection, id: string): Section {
  const style = { ...p.style } as SectionStyle;
  switch (p.type) {
    case "hero":
      return { ...p, id, style, ctaHref: link(p.ctaHref), secondaryHref: link(p.secondaryHref) };
    case "rich_text":
      return { ...p, id, style, html: sanitizeHtml(p.html) };
    case "image":
      return {
        ...p,
        id,
        style,
        items: p.items.map((it) => ({ ...it, url: image(it.url) })).filter((it) => it.url || it.imageId),
      };
    case "feature_grid":
      return { ...p, id, style, items: p.items.map((it) => ({ ...it, href: link(it.href) })) };
    case "faq":
      return { ...p, id, style, items: p.items.map((it) => ({ q: it.q, a: sanitizeHtml(it.a) })) };
    case "gallery":
      return {
        ...p,
        id,
        style,
        items: p.items.map((it) => ({ ...it, url: image(it.url) })).filter((it) => it.url || it.imageId),
      };
    case "meeting_info":
      return { ...p, id, style, mapUrl: link(p.mapUrl) };
    case "cta":
      return { ...p, id, style, href: link(p.href) ?? "#" };
    case "embed":
      return { ...p, id, style, html: sanitizeHtml(p.html, { allowEmbeds: true }) };
    case "projects":
      return { ...p, id, style, items: p.items.map((it) => ({ ...it, href: link(it.href) })) };
    case "sponsors":
      return { ...p, id, style, items: p.items.map((it) => ({ ...it, href: link(it.href) })) };
    case "portfolio":
      return {
        ...p,
        id,
        style,
        items: p.items.map((it) => ({ ...it, url: image(it.url) })).filter((it) => it.url || it.imageId),
      };
    case "hours_location":
      return { ...p, id, style, mapUrl: link(p.mapUrl) };
    default:
      return { ...p, id, style } as Section;
  }
}

/** Keep a provided id when it is well-formed and unused; otherwise `s_<index>`. */
function pickId(provided: unknown, index: number, seen: Set<string>): string {
  const candidate = typeof provided === "string" && ID_RE.test(provided) && !seen.has(provided) ? provided : `s_${index}`;
  seen.add(candidate);
  return candidate;
}

export type SectionIssue = { path: string; message: string };

const MAX_SECTIONS = 80;

/**
 * Parse a stored section document. Accepts both a legacy block array
 * (`parseBlocks` shapes) and a section array; items are classified one by
 * one so mixed documents and sections without `style` still parse. Unknown
 * types are dropped with an issue; invalid items are dropped with the zod
 * issue path prefixed `sections.N.`.
 */
export function parseSections(raw: unknown): { sections: Section[]; issues: SectionIssue[] } {
  const issues: SectionIssue[] = [];
  if (!Array.isArray(raw)) {
    return { sections: [], issues: [{ path: "sections", message: "Expected an array of sections" }] };
  }
  const sections: Section[] = [];
  const seen = new Set<string>();
  const items = raw.slice(0, MAX_SECTIONS);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push({ path: `sections.${i}`, message: "Expected a section object" });
      continue;
    }
    const obj = item as Record<string, unknown>;
    const type = String(obj.type ?? "");

    if (isLegacyBlockItem(obj)) {
      const blocks = parseBlocks([obj]);
      if (!blocks.length) {
        issues.push({ path: `sections.${i}.type`, message: `Unsupported section type "${type}"` });
        continue;
      }
      const [legacy] = blocksToSections(blocks);
      legacy.id = pickId(obj.id, i, seen);
      sections.push(legacy);
      continue;
    }

    if (!SECTION_TYPE_SET.has(type)) {
      issues.push({ path: `sections.${i}.type`, message: `Unsupported section type "${type}"` });
      continue;
    }
    const parsed = sectionSchema.safeParse(obj);
    if (!parsed.success) {
      for (const iss of parsed.error.issues) {
        issues.push({ path: `sections.${i}${iss.path.length ? "." + iss.path.join(".") : ""}`, message: iss.message });
      }
      continue;
    }
    sections.push(finalize(parsed.data, pickId(obj.id, i, seen)));
  }
  return { sections, issues };
}
