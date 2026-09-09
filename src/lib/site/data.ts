/**
 * Data loaders for the dynamic sections of the server-rendered site.
 *
 * `needsFor` walks a page's section stack and returns the set of data it
 * needs; `loadSiteData` satisfies that set with ONE `env.DB.batch([...])`
 * (D1 serialises per-request queries, so one round trip per page is the
 * perf rule from commit 115cd50). The SQL is the same the public JSON
 * endpoints run -- the statement builders live in src/routes/public.ts and
 * are reused here rather than copied -- so the site and the API can never
 * disagree about which levels, events, products, posts or galleries are
 * public.
 *
 * `profile` is read from `tenant.settings_json.profile` and never queries.
 */

import type { Env, Tenant } from "../../types";
import { contentFromPage } from "../blocks";
import { activeMembershipFilter } from "../households";
import {
  levelsStatement,
  eventsStatement,
  productsStatement,
  blogStatement,
  galleriesStatement,
  galleryStatement,
} from "../../routes/public";
import type { Section } from "./sections/schema";
import type {
  SiteData,
  DataNeed,
  SiteLevel,
  SiteEvent,
  SiteProduct,
  SitePost,
  SiteGallerySummary,
  SiteGallery,
  SiteProfile,
  SiteDocument,
  SiteDirectoryMember,
} from "./data.types";

export type { SiteData, DataNeed, SiteLevel, SiteEvent, SiteProduct, SitePost, SiteGallerySummary, SiteGallery, SiteProfile, SiteDocument, SiteDirectoryMember };

/** Most members the `directory` loader returns (same cap as GET /public/:slug/directory). */
export const DIRECTORY_MAX = 500;

/** Most shared files the `documents` loader returns (the section's own `limit` trims further). */
export const DOCUMENTS_MAX = 50;

/** Default number of upcoming events / posts fetched when the caller gives no limit. */
export const DEFAULT_LIMIT = 12;

/** Longest excerpt (characters) built for a blog post; longer text is cut at a word and ends with an ellipsis. */
export const EXCERPT_MAX = 200;

// ---------------------------------------------------------------------------
// needsFor
// ---------------------------------------------------------------------------

/**
 * Which data a section stack needs. Manual galleries and every static
 * section need nothing. A `gallery` section with `source: "gallery"` needs
 * the single gallery when it names a slug, otherwise the galleries list.
 * `meeting_info` needs the profile; callers rendering a `meeting` footer add
 * `"profile"` themselves (the footer is not a section).
 */
export function needsFor(sections: Section[]): Set<DataNeed> {
  const needs = new Set<DataNeed>();
  for (const s of sections) {
    switch (s.type) {
      case "events":
      case "event_spotlight":
        needs.add("events");
        break;
      case "documents":
        needs.add("documents");
        break;
      case "membership_levels":
        needs.add("levels");
        break;
      case "store_teaser":
        needs.add("products");
        break;
      case "blog_teaser":
        needs.add("posts");
        break;
      case "meeting_info":
        needs.add("profile");
        break;
      case "gallery":
        if (s.source === "gallery") needs.add(s.gallerySlug ? "gallery" : "galleries");
        break;
      default:
        break;
    }
  }
  return needs;
}

// ---------------------------------------------------------------------------
// loadSiteData
// ---------------------------------------------------------------------------

export type LoadOpts = {
  /** Required to satisfy the `gallery` need; without it that need is skipped. */
  gallerySlug?: string;
  /** Upcoming events / posts to fetch (default DEFAULT_LIMIT). */
  limit?: number;
  /**
   * The viewer is a signed-in member of this tenant. Only then is the
   * `documents` need satisfied (members-only shared files); public renders
   * leave `data.documents` undefined and the section shows a sign-in prompt.
   */
  memberView?: boolean;
  /**
   * Event detail: satisfy the `events` need with this ONE public event by id
   * (past or upcoming -- the detail page must outlive the listing window)
   * plus its volunteer slot count, instead of the upcoming list. `data.events`
   * is `[event]` or `[]` when the id is unknown / not public.
   */
  eventId?: string;
};

type DocumentRow = { id: string; filename: string; size: number | null };
type DirectoryRow = { id: string; first_name: string | null; last_name: string | null; bio: string | null; photo_file_id: string | null; showcase_json: string | null };

/** Same SELECT as GET /public/:slug/directory (src/routes/public.ts): active, directory-visible members. */
function directoryStatement(db: D1Database, tenantId: string, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT m.id, m.first_name, m.last_name, m.bio, m.photo_file_id, m.showcase_json
         FROM members m
        WHERE m.tenant_id = ? AND ${activeMembershipFilter("m")}
          AND coalesce(directory_visible, 1) = 1
        ORDER BY m.last_name, m.first_name LIMIT ?`
    )
    .bind(tenantId, limit);
}

/** One public event by id; the same columns as `eventsStatement`, minus the listing window. */
function eventByIdStatement(db: D1Database, tenantId: string, eventId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, title, description, location, start_at, end_at,
              member_price_cents, non_member_price_cents, capacity, registration_open,
              settings_json
       FROM events WHERE id = ? AND tenant_id = ? AND is_public = 1`
    )
    .bind(eventId, tenantId);
}

/** How many volunteer sign-up slots an event has (migrations/0012, `volunteer_slots`). */
function volunteerSlotCountStatement(db: D1Database, tenantId: string, eventId: string): D1PreparedStatement {
  return db.prepare(`SELECT COUNT(*) AS n FROM volunteer_slots WHERE tenant_id = ? AND event_id = ?`).bind(tenantId, eventId);
}

/** Shared files members can download: staff uploads only (same predicate as the portal's file list). */
function documentsStatement(db: D1Database, tenantId: string, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, filename, size
       FROM files WHERE tenant_id = ? AND uploaded_by IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .bind(tenantId, limit);
}

type LevelRow = { id: string; name: string; description: string | null; price_cents: number; duration_months: number; renewal_type?: string };
type EventRow = Omit<SiteEvent, never> & { settings_json?: string | null };
type ProductRow = { id: string; name: string; description: string | null; price_cents: number; inventory: number | null };
type PostRow = { slug: string; title: string; content_json: string | null; blocks_json: string | null; updated_at: string; created_at: string };
type GalleryRow = { id: string; slug: string; title: string; description: string | null; photo_count: number; cover_photo_id: string | null };
type GalleryOneRow = { id: string; slug: string; title: string; description: string | null };
type PhotoRow = { id: string; caption: string | null; credit?: string | null };

/**
 * Photos of one public gallery keyed by the gallery's slug, so the gallery
 * row and its photos can travel in the same batch (the id-keyed statement
 * the JSON endpoint uses would need the row first).
 */
function galleryPhotosBySlugStatement(db: D1Database, tenantId: string, gallerySlug: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT p.id, p.caption, p.credit
       FROM gallery_photos p
       JOIN galleries g ON g.id = p.gallery_id
       WHERE p.tenant_id = ? AND g.slug = ? AND g.published = 1 AND g.is_members_only = 0
       ORDER BY p.sort_order, p.created_at`
    )
    .bind(tenantId, gallerySlug);
}

/** Batch slot order. Fixed so results can be read back positionally. */
const NEED_ORDER: readonly Exclude<DataNeed, "profile">[] = ["levels", "events", "products", "posts", "galleries", "gallery", "documents", "directory"];

export async function loadSiteData(env: Env, tenant: Tenant, needs: Set<DataNeed>, opts: LoadOpts = {}): Promise<SiteData> {
  const data: SiteData = {};
  if (needs.has("profile")) data.profile = readProfile(tenant.settings_json);

  const limit = clampLimit(opts.limit);
  const statements: D1PreparedStatement[] = [];
  const slots: { need: Exclude<DataNeed, "profile">; index: number }[] = [];

  for (const need of NEED_ORDER) {
    if (!needs.has(need)) continue;
    switch (need) {
      case "levels":
        slots.push({ need, index: statements.push(levelsStatement(env.DB, tenant.id)) - 1 });
        break;
      case "events": {
        if (opts.eventId) {
          // Two statements back to back: the event row, then its slot count.
          const index = statements.push(eventByIdStatement(env.DB, tenant.id, opts.eventId)) - 1;
          statements.push(volunteerSlotCountStatement(env.DB, tenant.id, opts.eventId));
          slots.push({ need, index });
          break;
        }
        slots.push({ need, index: statements.push(eventsStatement(env.DB, tenant.id, { limit })) - 1 });
        break;
      }
      case "products":
        slots.push({ need, index: statements.push(productsStatement(env.DB, tenant.id)) - 1 });
        break;
      case "posts":
        slots.push({ need, index: statements.push(blogStatement(env.DB, tenant.id, limit)) - 1 });
        break;
      case "galleries":
        slots.push({ need, index: statements.push(galleriesStatement(env.DB, tenant.id)) - 1 });
        break;
      case "gallery": {
        const slug = opts.gallerySlug;
        if (!slug) break;
        // Two statements back to back: the gallery row, then its photos.
        const index = statements.push(galleryStatement(env.DB, tenant.id, slug)) - 1;
        statements.push(galleryPhotosBySlugStatement(env.DB, tenant.id, slug));
        slots.push({ need, index });
        break;
      }
      case "documents":
        if (!opts.memberView) break;
        slots.push({ need, index: statements.push(documentsStatement(env.DB, tenant.id, DOCUMENTS_MAX)) - 1 });
        break;
      case "directory":
        // Same gate as the JSON endpoint: no query at all unless the guild opted in.
        if (!readProfile(tenant.settings_json).directory_public) break;
        slots.push({ need, index: statements.push(directoryStatement(env.DB, tenant.id, DIRECTORY_MAX)) - 1 });
        break;
    }
  }

  if (statements.length === 0) return data;

  const results = await env.DB.batch(statements);
  const rowsAt = <T>(i: number): T[] => (results[i]?.results ?? []) as T[];

  for (const { need, index } of slots) {
    switch (need) {
      case "levels":
        data.levels = rowsAt<LevelRow>(index).map(toLevel);
        break;
      case "events":
        data.events = rowsAt<EventRow>(index).map(toEvent);
        if (opts.eventId) {
          const count = rowsAt<{ n: number | string | null }>(index + 1)[0];
          const n = Number(count?.n) || 0;
          for (const ev of data.events) ev.volunteer_slots = n;
        }
        break;
      case "products":
        data.products = rowsAt<ProductRow>(index).map(toProduct);
        break;
      case "posts":
        data.posts = rowsAt<PostRow>(index).map(toPost);
        break;
      case "galleries":
        data.galleries = rowsAt<GalleryRow>(index).map(toGallerySummary);
        break;
      case "gallery": {
        const row = rowsAt<GalleryOneRow>(index)[0];
        if (!row) break;
        const photos = rowsAt<PhotoRow>(index + 1);
        data.gallery = {
          slug: row.slug,
          title: row.title,
          description: row.description ?? null,
          photos: photos.map((p) => ({ id: p.id, caption: p.caption ?? null })),
        };
        break;
      }
      case "documents":
        data.documents = rowsAt<DocumentRow>(index).map(toDocument);
        break;
      case "directory":
        data.directory = rowsAt<DirectoryRow>(index).map(toDirectoryMember);
        break;
    }
  }

  return data;
}

function toDocument(r: DocumentRow): SiteDocument {
  return { id: r.id, filename: r.filename, size: r.size == null ? null : Number(r.size) };
}

function toDirectoryMember(r: DirectoryRow): SiteDirectoryMember {
  const showcase: SiteDirectoryMember["showcase"] = {};
  try {
    const parsed = JSON.parse(r.showcase_json || "{}") as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of ["headline", "interests", "website"] as const) {
        const v = parsed[key];
        if (typeof v === "string" && v.trim()) showcase[key] = v.trim();
      }
    }
  } catch {
    // junk showcase_json: no showcase
  }
  return {
    id: r.id,
    first_name: r.first_name ?? null,
    last_name: r.last_name ?? null,
    bio: r.bio ?? null,
    photo_file_id: r.photo_file_id ?? null,
    showcase,
  };
}

// ---------------------------------------------------------------------------
// Row -> site shape mappers
// ---------------------------------------------------------------------------

function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(200, Math.max(1, Math.floor(n)));
}

function toLevel(r: LevelRow): SiteLevel {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    price_cents: Number(r.price_cents) || 0,
    duration_months: Number(r.duration_months) || 0,
    // The public levels SQL does not select renewal_type; "manual" is the
    // column default (migrations/0001_initial.sql).
    renewal_type: r.renewal_type ?? "manual",
  };
}

function toEvent(r: EventRow): SiteEvent {
  return {
    id: r.id,
    title: r.title,
    start_at: r.start_at,
    end_at: r.end_at ?? null,
    location: r.location ?? null,
    description: r.description ?? null,
    member_price_cents: Number(r.member_price_cents) || 0,
    non_member_price_cents: Number(r.non_member_price_cents) || 0,
    registration_open: Number(r.registration_open) || 0,
    capacity: r.capacity == null ? null : Number(r.capacity),
  };
}

function toProduct(r: ProductRow): SiteProduct {
  return {
    id: r.id,
    name: r.name,
    price_cents: Number(r.price_cents) || 0,
    description: r.description ?? null,
    // products has no image column yet (migrations/0006_products.sql).
    image_file_id: null,
    stock: r.inventory == null ? null : Number(r.inventory),
  };
}

function toPost(r: PostRow): SitePost {
  return {
    slug: r.slug,
    title: r.title,
    published_at: r.created_at,
    excerpt: excerptFromHtml(contentFromPage(r).html),
  };
}

function toGallerySummary(r: GalleryRow): SiteGallerySummary {
  return {
    slug: r.slug,
    title: r.title,
    cover_photo_id: r.cover_photo_id ?? null,
    count: Number(r.photo_count) || 0,
  };
}

/** Plain-text excerpt: tags stripped, entities decoded, whitespace collapsed, cut at a word. */
export function excerptFromHtml(html: string, max = EXCERPT_MAX): string {
  const text = String(html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|blockquote|tr)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const atWord = cut.lastIndexOf(" ");
  return (atWord > max / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

/** `settings_json.profile` in the site shape; tolerant of junk JSON. */
export function readProfile(settingsJson: string | null | undefined): SiteProfile {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(settingsJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // fall through to an empty profile
  }
  const raw = settings.profile;
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  const profile: SiteProfile = {};
  const description = str(p.description);
  const meeting = str(p.meeting_info);
  const location = str(p.location);
  const website = str(p.website);
  const email = str(p.contact_email) ?? str(p.email);
  if (description) profile.description = description;
  if (meeting) profile.meeting_info = meeting;
  if (location) profile.location = location;
  if (website) profile.website = website;
  if (email) profile.email = email;
  // Same defaults as public.ts infoPayload: donations on unless explicitly off.
  profile.donations_enabled = p.donations_enabled !== false;
  profile.directory_public = !!p.directory_public;
  return profile;
}
