import { Hono } from "hono";
import type { Env, Event, MembershipLevel, Member, Tenant } from "../types";
import { all, first } from "../lib/db";
import { buildIcs, icsResponse } from "../lib/ical";
import { generateId, generateTicketCode } from "../lib/utils/id";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  checkoutHoldExpiry,
  PayoutsNotConnectedError,
} from "../lib/stripe";
import { extractBearer, verifyJwt } from "../lib/auth";
import {
  SEAT_COUNT_SQL,
  buildReleaseSeatStatement,
  buildReserveStockStatements,
  buildReleaseOrderStatements,
  normalizeOrderLines,
  type OrderLine,
} from "../lib/fulfillment";
import { prepareEvent, scheduleDispatch } from "../lib/webhookOutbox";
import { enqueueTrigger } from "../lib/automations/triggers";
import type { Context } from "hono";
import { sendEmail, welcomeEmail, eventConfirmationEmail } from "../lib/email";
import { formatMoney } from "../lib/utils/money";
import { activateMembership, portalUrl } from "../lib/memberships";
import { readDuesPolicy, prorateCents, describePolicy } from "../lib/dues";
import { assertCanActivateMember } from "../lib/plans";
import {
  activeMembershipFilter,
  buildCreateHouseholdStatements,
  emailsAlreadyInHousehold,
  householdMax,
  householdPriceCents,
  isActiveMember,
  isHouseholdLevel,
  MAX_HOUSEHOLD_PEOPLE,
} from "../lib/households";
import { rateLimit } from "../middleware/rateLimit";
import {
  parseEventSettings,
  validateAnswers,
} from "../lib/eventQuestions";
import { getTenantByHost, tenantPublicBaseUrl } from "../lib/tenantHost";
import { readTenantTheme, deriveLegacyTheme } from "../lib/site/themeMigrate";
import { escapeHtml, contentFromPage } from "../lib/blocks";
import { computeEstimate } from "../lib/projects/pricing";
import { mintAccessToken, hashToken } from "../lib/projects/token";
import { buildReference } from "../lib/projects/reference";
import { PROJECT_TYPES } from "../lib/projects/types";
import type { ProjectType, LongarmRates } from "../lib/projects/types";
import { sniffImageType } from "../lib/projects/imageSniff";
import { ALLOWED_IMAGE_TYPES } from "./site";
import { IMAGE_ROW_COLUMNS, serveImage, type ImageRow } from "../lib/images";
import { listRedirects } from "../lib/pageDrafts";

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.use("/:slug/join", rateLimit({ keyPrefix: "join", limit: 30, windowSeconds: 600 }));
publicRoutes.use("/:slug/donate", rateLimit({ keyPrefix: "donate", limit: 20, windowSeconds: 600 }));
publicRoutes.use(
  "/:slug/events/:eventId/register",
  rateLimit({ keyPrefix: "ereg", limit: 40, windowSeconds: 600 })
);
publicRoutes.use(
  "/:slug/products/:productId/buy",
  rateLimit({ keyPrefix: "buy", limit: 30, windowSeconds: 600 })
);
publicRoutes.use(
  "/:slug/projects/intake",
  rateLimit({ keyPrefix: "intake", limit: 20, windowSeconds: 600 })
);
publicRoutes.use(
  "/:slug/projects/:projectRef/photos",
  rateLimit({ keyPrefix: "intakephoto", limit: 40, windowSeconds: 600 })
);
publicRoutes.use("/:slug/newsletter", rateLimit({ keyPrefix: "newsletter", limit: 10, windowSeconds: 600 }));

/** Hono throws when no ExecutionContext is attached (unit tests); treat as absent. */
function execCtx(
  c: Context<{ Bindings: Env }>
): { waitUntil(p: Promise<unknown>): void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

async function getTenantBySlug(db: D1Database, slug: string) {
  return first<Tenant>(
    db
      .prepare("SELECT * FROM tenants WHERE slug = ? AND status = 'active'")
      .bind(slug)
  );
}

// Everything stored in intake_json comes from exactly these keys — an
// allowlist, not a filter — so an anonymous caller cannot smuggle arbitrary
// extra keys or deeply nested structures into the row no matter what shape
// body.intake arrives in.
type SanitizedIntake = {
  widthIn?: number;
  heightIn?: number;
  serviceLevel: "edge_to_edge" | "custom";
  batting: boolean;
  thread: boolean;
  binding: boolean;
  backingPrep: boolean;
  rush: boolean;
  blockCount?: number;
};

const MAX_INTAKE_RAW_BYTES = 8192;

/** UTF-8 byte length (JS string .length is UTF-16 code units, not bytes). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// POST /public/:slug/projects/intake
// Reachable unauthenticated on a launched business tenant's own host via
// siteGate rule 4 (/public/<own-slug>/...), the same rule under which /join
// and /cart/checkout already accept unauthenticated writes. No new gate rule.
publicRoutes.post("/:slug/projects/intake", async (c) => {
  // getTenantBySlug is the existing helper above — it takes the D1 binding,
  // not env.
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant || tenant.tenant_type !== "business") {
    return c.json({ error: "Not found" }, 404);
  }

  type IntakeBody = {
    project_type?: string;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string;
    intake?: Record<string, unknown>;
  };
  // A missing/unparseable body must not throw — it must fall through to the
  // validation below and come back as a 400, the same idiom used by the
  // other public routes in this file.
  const body = await c.req.json<IntakeBody>().catch(() => ({}) as IntakeBody);

  const projectType = PROJECT_TYPES.includes(body.project_type as ProjectType)
    ? (body.project_type as ProjectType)
    : null;
  const name = String(body.customer_name || "").trim().slice(0, 200);
  // Lowercased for consistency with every other public write in this file
  // (/join, /donate, /events/:id/register, /products/:id/buy, /cart/checkout,
  // /forms/:slug all do this) — matters once send-estimate's case-insensitive
  // member lookup creates a NEW member row from this value verbatim.
  const email = String(body.customer_email || "").trim().toLowerCase().slice(0, 320);
  if (!projectType) return c.json({ error: "Choose a project type" }, 400);
  if (!name) return c.json({ error: "Name is required" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "A valid email is required" }, 400);
  }

  const intakeRaw = (body.intake && typeof body.intake === "object") ? body.intake : {};
  // Reject grossly oversized or padded intake payloads before doing any
  // further work with them. Checked on the RAW parsed object rather than the
  // sanitized one below: once stripped to the fixed allowlist of scalar
  // fields, the sanitized object can never itself approach this size, so
  // checking post-strip would be dead code. This is what actually stops an
  // anonymous caller from making the worker serialize/store an unbounded
  // blob — the allowlist stripping below is what stops arbitrary/nested
  // KEYS from reaching storage; this stops an arbitrarily large one.
  let intakeRawJson: string;
  try {
    intakeRawJson = JSON.stringify(intakeRaw);
  } catch {
    return c.json({ error: "Invalid intake details" }, 400);
  }
  if (byteLength(intakeRawJson) > MAX_INTAKE_RAW_BYTES) {
    return c.json({ error: "Intake details are too large" }, 400);
  }

  const widthIn = Number(intakeRaw.widthIn);
  const heightIn = Number(intakeRaw.heightIn);
  // Sane bounds: a quilt wider than 200in does not exist, and a negative one
  // would sail straight into the area multiplication.
  const dimsOk = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 200;
  if (projectType !== "tshirt_quilt" && (!dimsOk(widthIn) || !dimsOk(heightIn))) {
    return c.json({ error: "Enter the quilt's width and height in inches" }, 400);
  }

  // blockCount feeds a straight multiplication against a per-block rate with
  // no other ceiling in computeEstimate, unlike width/height's 200in bound —
  // an unbounded value here is the one numeric input that could reach the
  // database unchecked. A caller that supplies one must supply a sane one;
  // omitting it entirely is fine (tshirt_quilt without it just suppresses).
  let blockCount: number | undefined;
  if (intakeRaw.blockCount !== undefined && intakeRaw.blockCount !== null) {
    const bc = Number(intakeRaw.blockCount);
    if (!Number.isFinite(bc) || bc < 1 || bc > 500) {
      return c.json({ error: "Block count must be between 1 and 500" }, 400);
    }
    blockCount = bc;
  }

  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(tenant.settings_json || "{}"); } catch { settings = {}; }
  const rates = ((settings.longarm as LongarmRates) || {}) as LongarmRates;

  const sanitizedIntake: SanitizedIntake = {
    widthIn: dimsOk(widthIn) ? widthIn : undefined,
    heightIn: dimsOk(heightIn) ? heightIn : undefined,
    serviceLevel: intakeRaw.serviceLevel === "custom" ? "custom" : "edge_to_edge",
    batting: !!intakeRaw.batting,
    thread: !!intakeRaw.thread,
    binding: !!intakeRaw.binding,
    backingPrep: !!intakeRaw.backingPrep,
    rush: !!intakeRaw.rush,
    blockCount,
  };

  const ballpark = computeEstimate({ projectType, ...sanitizedIntake }, rates);

  const token = mintAccessToken();
  const tokenHash = await hashToken(token);
  const id = generateId();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

  // Allocate the reference with a single atomic RETURNING statement: the
  // increment and the read of its new value happen as one D1 round trip, so
  // there is no window between them for a concurrent submission to read the
  // same next_number (the failure mode a two-statement UPSERT-then-SELECT
  // has — verified against local D1 that RETURNING is supported and gives
  // the atomically-incremented value back). Retried a bounded number of
  // times so that IF a reference collision still somehow reaches the
  // `projects` insert (e.g. a hand-edited counter row), the customer gets a
  // fresh reference instead of an unhandled 500 losing their submission.
  const MAX_REFERENCE_ATTEMPTS = 3;
  let reference = "";
  let inserted = false;
  let lastInsertErr: unknown;
  for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS && !inserted; attempt++) {
    const counter = await first<{ next_number: number }>(
      c.env.DB.prepare(
        `INSERT INTO project_counters (tenant_id, next_number) VALUES (?, 1)
         ON CONFLICT(tenant_id) DO UPDATE SET next_number = next_number + 1
         RETURNING next_number`
      ).bind(tenant.id)
    );
    reference = buildReference(rates.referencePrefix, tenant.slug, counter?.next_number ?? 1);

    try {
      const projectInsertStmt = c.env.DB.prepare(
        `INSERT INTO projects
           (id, tenant_id, project_type, status, reference, customer_name, customer_email,
            customer_phone, intake_json, subtotal_cents, total_cents,
            access_token_hash, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, tenant.id, projectType, reference, name, email,
        String(body.customer_phone || "").slice(0, 50) || null,
        JSON.stringify(sanitizedIntake),
        ballpark.suppressed ? 0 : ballpark.subtotalCents,
        ballpark.suppressed ? 0 : ballpark.totalCents,
        tokenHash, expires, now, now
      );
      // The project row and every ballpark line row commit as ONE D1 batch
      // (same idiom as PUT /projects/:id/lines' rewrite), not as the
      // project INSERT followed by N independent .run() calls — a partial
      // failure used to be able to leave project_lines summing to less
      // than the total_cents already committed on the project row, and the
      // quote page reads lines from one write and the total from the
      // other before freezing both into the signature (final review, F5).
      // This also runs BEFORE any email is attempted, same as before — a
      // Resend outage must never lose a customer's submission.
      const lineInsertStmts = ballpark.suppressed
        ? []
        : ballpark.lines.map((l, i) =>
            c.env.DB.prepare(
              `INSERT INTO project_lines
                 (id, project_id, kind, description, quantity, unit_cents, amount_cents, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(generateId(), id, l.kind, l.description, l.quantity, l.unitCents, l.amountCents, i)
          );
      await c.env.DB.batch([projectInsertStmt, ...lineInsertStmts]);
      inserted = true;
    } catch (err) {
      lastInsertErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry the specific failure this loop exists to recover from —
      // a reference collision. Any other insert failure is a real error and
      // must surface, not be silently retried away.
      //
      // Matched against the REAL D1 runtime error text, not a guess: a
      // genuine UNIQUE(tenant_id, reference) collision, provoked against
      // local D1 through the actual Worker (not the wrangler CLI, which
      // formats errors differently), throws exactly:
      //   D1_ERROR: UNIQUE constraint failed: projects.tenant_id,
      //   projects.reference: SQLITE_CONSTRAINT (extended:
      //   SQLITE_CONSTRAINT_UNIQUE)
      // Anchored on the extended result code (SQLITE_CONSTRAINT_UNIQUE) —
      // a stable SQLite constant — plus the column name, rather than on the
      // surrounding sentence wording, which is D1/Workers-runtime-owned and
      // not something this codebase controls.
      if (!(/SQLITE_CONSTRAINT_UNIQUE/i.test(msg) && /\breference\b/i.test(msg))) {
        throw err;
      }
    }
  }
  if (!inserted) {
    console.error("intake: could not allocate a unique reference after retries", lastInsertErr);
    return c.json({ error: "Could not process your request. Please try again." }, 500);
  }

  // Acknowledgement only. The ballpark is NEVER emailed as a price — it is
  // shown on screen to convert a browsing visitor, and only the estimate
  // Linda has reviewed goes out.
  await sendEmail(c.env, {
    to: email,
    subject: `We received your quilt request (${reference})`,
    html: `<p>Thanks ${escapeHtml(name)} — we have your request, reference <strong>${reference}</strong>.</p>
           <p>We'll review the details and send your estimate shortly.</p>`,
  }).catch(() => undefined);

  const ownerEmail = (settings.business as { email?: string } | undefined)?.email;
  if (ownerEmail) {
    await sendEmail(c.env, {
      to: ownerEmail,
      subject: `New ${projectType.replace("_", " ")} intake — ${reference}`,
      html: `<p>${escapeHtml(name)} (${escapeHtml(email)}) submitted ${reference}.</p>`,
    }).catch(() => undefined);
  }

  return c.json({
    ok: true,
    reference,
    ballpark: {
      suppressed: ballpark.suppressed,
      total_cents: ballpark.totalCents,
      lines: ballpark.lines,
    },
  });
});

// POST /public/:slug/projects/:projectRef/photos
// Deliberately open to the internet — a T-shirt quilt cannot be quoted
// without seeing the shirts. Bounded by: the rate limit registered above
// (Task 7), a hard file count and size cap, and magic-byte type detection.
// The stored content_type is decided from BYTES via sniffImageType, never
// from the client's Content-Type header — the files this endpoint writes
// are also servable through portal.ts / galleries.ts / public.ts:photo,
// none of which allowlist content_type or set X-Content-Type-Options on the
// way out (unlike site.ts's /img/:fileId), so this route is the only line
// of defence against stored XSS for rows it creates.
const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;

publicRoutes.post("/:slug/projects/:projectRef/photos", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant || tenant.tenant_type !== "business") {
    return c.json({ error: "Not found" }, 404);
  }
  const project = await first<{ id: string }>(
    c.env.DB.prepare(
      `SELECT id FROM projects WHERE tenant_id = ? AND reference = ? AND status = 'submitted'`
    ).bind(tenant.id, c.req.param("projectRef"))
  );
  if (!project) return c.json({ error: "Not found" }, 404);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Expected multipart form data" }, 400);

  const files = form.getAll("photos").filter((f): f is File => f instanceof File);
  if (!files.length) return c.json({ error: "No photos supplied" }, 400);
  if (files.length > MAX_FILES) {
    return c.json({ error: `At most ${MAX_FILES} photos` }, 400);
  }

  // Pass 1: validate every file — count cap (above), per-file size cap, and
  // magic-byte sniff — before writing anything. A batch that fails partway
  // through must not leave earlier files in the same batch permanently
  // orphaned in R2/D1 (nothing links them to a project until after this
  // whole handler succeeds, and nothing ever sweeps them). Holds up to
  // MAX_FILES (5) buffers of up to MAX_BYTES (10MB) each in memory at once
  // — see task-8-report.md for why that ceiling was judged acceptable.
  const validated: Array<{ file: File; buf: Uint8Array; contentType: string }> = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      return c.json({ error: "Each photo must be under 10MB" }, 400);
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const contentType = sniffImageType(buf);
    if (!contentType) {
      return c.json({ error: "Photos must be PNG, JPEG, GIF, WebP or AVIF" }, 400);
    }
    validated.push({ file, buf, contentType });
  }

  function readPhotoFileIds(intakeJson: string | null | undefined): string[] {
    try {
      const parsed = JSON.parse(intakeJson || "{}");
      return Array.isArray(parsed.photoFileIds) ? parsed.photoFileIds : [];
    } catch {
      return [];
    }
  }

  // Reject up front, before anything is written, when this project doesn't
  // have room for this many more photos. The alternative — slicing the
  // merged array down to MAX_FILES after writing — silently drops some of
  // THIS request's just-committed ids while still telling the caller they
  // were all linked. Rejecting first means a caller who's over the cap
  // learns before any R2/D1 write happens, and file_ids in the response is
  // always exactly what's linked.
  const preCheckRow = await first<{ intake_json: string }>(
    c.env.DB.prepare(`SELECT intake_json FROM projects WHERE id = ? AND tenant_id = ?`)
      .bind(project.id, tenant.id)
  );
  if (readPhotoFileIds(preCheckRow?.intake_json).length + validated.length > MAX_FILES) {
    return c.json(
      { error: `This project can have at most ${MAX_FILES} photos attached in total` },
      400
    );
  }

  // Pass 2: every file passed validation and there's room for all of
  // them — now write. If the D1 insert for a file fails after its R2
  // object is already written, best-effort delete that one object rather
  // than leave it dangling; do not attempt to unwind files already
  // committed earlier in this same pass (see task-8-report.md for the
  // residue that leaves open).
  const fileIds: string[] = [];
  for (const { file, buf, contentType } of validated) {
    const fileId = generateId();
    const key = `${tenant.id}/${fileId}/${file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)}`;
    await c.env.FILES.put(key, buf);
    try {
      await c.env.DB.prepare(
        `INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
        .bind(fileId, tenant.id, key, file.name.slice(0, 200), contentType, buf.byteLength)
        .run();
    } catch (err) {
      // Best-effort cleanup of the object we just orphaned. Wrapped so a
      // delete failure can never mask the original D1 error below.
      try {
        await c.env.FILES.delete(key);
      } catch (cleanupErr) {
        console.error("intake photos: R2 cleanup failed after D1 insert error", cleanupErr);
      }
      throw err;
    }
    fileIds.push(fileId);
  }

  // Bind the photos to the project by appending to intake_json rather than
  // adding a table: they are intake data, and intake_json is where
  // type-varying intake data lives.
  //
  // Read-modify-write, so it's raced by any other concurrent write to the
  // same project's intake_json (another overlapping upload, a client
  // retry racing the original request). Closed with optimistic
  // concurrency: the UPDATE's WHERE clause pins the exact intake_json
  // string this attempt read, so it only lands if nothing changed
  // underneath it — the same shape as the reference-counter fix in
  // /projects/intake. Verified against a real D1 Worker binding (not just
  // the wrangler CLI, whose `d1 execute` output doesn't surface
  // meta.changes at all) via a temporary debug route + `wrangler dev
  // --local`: a matching guard returned meta.changes:1 / changed_db:true;
  // a stale guard on the same row returned meta.changes:0 /
  // changed_db:false. That's the field this checks below.
  const MAX_LINK_ATTEMPTS = 3;
  let linked = false;
  for (let attempt = 0; attempt < MAX_LINK_ATTEMPTS && !linked; attempt++) {
    const row = await first<{ intake_json: string }>(
      c.env.DB.prepare(`SELECT intake_json FROM projects WHERE id = ? AND tenant_id = ?`)
        .bind(project.id, tenant.id)
    );
    const beforeJson = row?.intake_json ?? "{}";
    const existing = readPhotoFileIds(beforeJson);
    if (existing.length + fileIds.length > MAX_FILES) {
      // A concurrent upload used up the remaining capacity between the
      // pre-check above and this attempt. Nothing in this handler ever
      // removes ids, so capacity only shrinks from here — retrying again
      // will not help. Fall through to the loud failure below rather than
      // silently dropping any of fileIds (which the response promises are
      // linked) or exceeding MAX_FILES.
      break;
    }
    let intake: Record<string, unknown> = {};
    try { intake = JSON.parse(beforeJson || "{}"); } catch { intake = {}; }
    intake.photoFileIds = [...existing, ...fileIds];
    const result = await c.env.DB.prepare(
      `UPDATE projects SET intake_json = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND intake_json = ?`
    )
      .bind(JSON.stringify(intake), new Date().toISOString(), project.id, tenant.id, beforeJson)
      .run();
    if (result.meta.changes > 0) {
      linked = true;
    }
  }

  if (!linked) {
    // The photos themselves are already safely committed to R2 + files
    // (see the residue note above and in task-8-report.md) but this
    // request could not safely record them against the project without
    // risking a silent lost update or exceeding MAX_FILES. Fail loudly —
    // returning ok:true here would be exactly the silent-drop failure
    // this fix exists to close.
    console.error("intake photos: could not link file ids to project after retries", {
      tenantId: tenant.id,
      projectId: project.id,
      fileIds,
    });
    return c.json(
      { error: "Could not save these photos to the project. Please try again." },
      500
    );
  }

  return c.json({ ok: true, file_ids: fileIds });
});

/**
 * GET /public/_host — resolve tenant from Host (custom domain or subdomain).
 * Used by guild.html when served at / on a tenant hostname.
 */
publicRoutes.get("/_host", async (c) => {
  const tenant = await getTenantByHost(
    c.env.DB,
    c.req.header("host") || "",
    c.env.APP_URL
  );
  if (!tenant) {
    return c.json({ error: "Not a guild host", slug: null }, 404);
  }
  return c.json({
    slug: tenant.slug,
    name: tenant.name,
    custom_domain: tenant.custom_domain,
    public_base_url: tenantPublicBaseUrl(
      c.env,
      tenant,
      c.req.header("host") || undefined
    ),
  });
});

// GET /public/:slug/levels
// ---------------------------------------------------------------------------
// Guild site boot payloads.
//
// guild.html fetches /levels, /events, /info, /products, /site, /blog and
// /pages in parallel at boot. Each of those handlers is a thin wrapper over
// one of the *Payload functions below so that GET /:slug/site-bootstrap can
// return all seven bodies in ONE response without duplicating any SQL.
// ---------------------------------------------------------------------------

function tenantSummary(tenant: Tenant) {
  return { name: tenant.name, slug: tenant.slug };
}

// Statement builders are exported so src/lib/site/data.ts can batch the
// exact same SQL for the server-rendered site (one D1 round trip per page)
// without duplicating the query text here.

/** Public membership levels: active, public, in display order. */
export function levelsStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, name, description, price_cents, duration_months, benefits_json, sort_order,
              term_mode, term_anchor, proration, grace_days
       FROM membership_levels
       WHERE tenant_id = ? AND status = 'active' AND is_public = 1
       ORDER BY sort_order, name`
    )
    .bind(tenantId);
}

/**
 * Each public level, plus what a NEW member would pay today and the policy
 * in words. `price_now_cents` is what someone who has never held this level
 * pays right now — on a January-to-December level with half-year proration
 * that is half the price from July 1 on. It is a display figure: the join
 * route recomputes it server-side and additionally checks whether THIS
 * person has held the level before (proration is a first-term concession,
 * so a returning member pays full price).
 */
async function levelsPayload(env: Env, tenant: Tenant) {
  const rows = await all<MembershipLevel>(levelsStatement(env.DB, tenant.id));
  const now = new Date().toISOString();
  const levels = rows.map((level) => {
    const policy = readDuesPolicy(level);
    return {
      ...level,
      price_now_cents: prorateCents(policy, level.price_cents, now),
      dues_note: describePolicy(policy),
    };
  });
  return { tenant: tenantSummary(tenant), levels };
}

publicRoutes.get("/:slug/levels", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  return c.json(await levelsPayload(c.env, tenant));
});

/**
 * Public events. `month` (YYYY-MM, already validated by the caller) returns
 * that whole month for calendar views; otherwise the next `limit` upcoming
 * public events ordered by start.
 */
export function eventsStatement(
  db: D1Database,
  tenantId: string,
  opts: { month?: string; limit?: number } = {}
): D1PreparedStatement {
  if (opts.month) {
    return db
      .prepare(
        `SELECT id, title, description, location, start_at, end_at,
                member_price_cents, non_member_price_cents, capacity, registration_open,
                settings_json
         FROM events
         WHERE tenant_id = ? AND is_public = 1
           AND substr(start_at, 1, 7) = ?
         ORDER BY start_at ASC
         LIMIT 200`
      )
      .bind(tenantId, opts.month);
  }
  return db
    .prepare(
      `SELECT id, title, description, location, start_at, end_at,
              member_price_cents, non_member_price_cents, capacity, registration_open,
              settings_json
       FROM events
       WHERE tenant_id = ? AND is_public = 1 AND start_at >= datetime('now')
       ORDER BY start_at ASC
       LIMIT ?`
    )
    .bind(tenantId, opts.limit ?? 50);
}

/** ?month=YYYY-MM returns that whole month (calendar views); default is "next 50 upcoming". */
async function eventsPayload(env: Env, tenant: Tenant, month?: string) {
  const validMonth = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : undefined;
  const events = await all<Event>(eventsStatement(env.DB, tenant.id, { month: validMonth }));

  return {
    tenant: tenantSummary(tenant),
    events: events.map((e) => ({
      ...e,
      questions: parseEventSettings(e.settings_json).questions || [],
    })),
  };
}

// GET /public/:slug/events
publicRoutes.get("/:slug/events", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  return c.json(await eventsPayload(c.env, tenant, c.req.query("month")));
});

// GET /public/:slug/events/:eventId
publicRoutes.get("/:slug/events/:eventId", async (c) => {
  const slug = c.req.param("slug");
  const eventId = c.req.param("eventId");

  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const event = await first<Event>(
    c.env.DB.prepare(
      "SELECT * FROM events WHERE id = ? AND tenant_id = ? AND is_public = 1"
    ).bind(eventId, tenant.id)
  );

  if (!event) return c.json({ error: "Event not found" }, 404);
  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    event: {
      ...event,
      questions: parseEventSettings(event.settings_json).questions || [],
    },
  });
});

/**
 * POST /public/:slug/join
 * Creates (or finds) a member and starts Stripe Checkout for dues.
 */
// Legacy checkout return URLs (older Stripe sessions still point here)
publicRoutes.get("/:slug/join/success", (c) =>
  c.redirect(`/g/${c.req.param("slug")}?joined=1`)
);
publicRoutes.get("/:slug/join", (c) =>
  c.redirect(`/g/${c.req.param("slug")}${c.req.query("cancelled") ? "?cancelled=1" : ""}`)
);

publicRoutes.post("/:slug/join", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const body = await c.req.json<{
    level_id: string;
    email: string;
    first_name?: string;
    last_name?: string;
    custom_fields?: Record<string, string>;
    /** Household levels only: the other people this one payment covers. */
    people?: Array<{ email?: unknown; first_name?: unknown; last_name?: unknown }>;
    /** What the guild calls this household on the roster. */
    household_name?: string;
  }>();

  // Only keep answers for fields this guild actually defined
  let customJson = "{}";
  if (body.custom_fields && typeof body.custom_fields === "object") {
    let settings: any = {};
    try { settings = JSON.parse(tenant.settings_json || "{}"); } catch {}
    const allowed = new Set(
      (settings.custom_fields || []).map((f: any) => f && f.key).filter(Boolean)
    );
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.custom_fields)) {
      if (allowed.has(k) && typeof v === "string") filtered[k] = v.slice(0, 500);
    }
    customJson = JSON.stringify(filtered);
  }

  if (!body.level_id || !body.email) {
    return c.json({ error: "level_id and email are required" }, 400);
  }

  const email = body.email.toLowerCase().trim();

  const level = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(body.level_id, tenant.id)
  );
  if (!level) {
    return c.json({ error: "Membership level not found" }, 404);
  }

  /* ——— Household join (spec §4.3; the engine is src/lib/households.ts) ———
   *
   * A level with household_max > 1 sells "one payment, two quilters at the
   * same address": the payer plus up to household_max - 1 named people, each
   * of whom gets their own login, directory entry and member pricing.
   *
   * Everything is validated BEFORE any row is written, because a half-made
   * household — a member row created for a spouse whose email turned out to
   * be someone else's already — is worse than a rejected form.
   */
  const maxPeople = householdMax(level);
  const rawPeople = Array.isArray(body.people) ? body.people : [];
  const people: Array<{ email: string; first_name: string | null; last_name: string | null }> = [];
  const seen = new Set<string>([email]);
  for (const raw of rawPeople) {
    const e = typeof raw?.email === "string" ? raw.email.toLowerCase().trim() : "";
    if (!e) continue;
    if (!e.includes("@") || e.length > 254) {
      return c.json({ error: `"${e}" is not an email address.`, code: "bad_person_email" }, 400);
    }
    if (seen.has(e)) {
      return c.json(
        { error: "Each person needs their own email address.", code: "duplicate_person_email" },
        400
      );
    }
    seen.add(e);
    people.push({
      email: e,
      first_name: typeof raw.first_name === "string" ? raw.first_name.trim().slice(0, 80) : null,
      last_name: typeof raw.last_name === "string" ? raw.last_name.trim().slice(0, 80) : null,
    });
  }

  if (people.length && !isHouseholdLevel(level)) {
    return c.json(
      { error: "This membership is for one person.", code: "not_a_household_level" },
      400
    );
  }
  if (people.length > maxPeople - 1) {
    return c.json(
      {
        error: `This membership covers ${maxPeople} ${maxPeople === 1 ? "person" : "people"}.`,
        code: "household_too_many",
      },
      400
    );
  }

  // Somebody already on another household cannot be double-counted onto this
  // one: their membership would derive from two payers at once and the plan
  // cap would count them twice.
  if (people.length) {
    const taken = await emailsAlreadyInHousehold(
      c.env.DB,
      tenant.id,
      [email, ...people.map((p) => p.email)]
    );
    if (taken.length) {
      return c.json(
        {
          error: `${taken.join(", ")} ${
            taken.length === 1 ? "is" : "are"
          } already part of a household membership here.`,
          code: "already_in_household",
        },
        409
      );
    }
  }

  // Find or create member
  let member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, email)
  );

  const now = new Date().toISOString();

  if (!member) {
    const memberId = generateId();
    const insertMemberStmt = c.env.DB.prepare(
      `INSERT INTO members
       (id, tenant_id, email, first_name, last_name, custom_fields_json, status, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(
      memberId,
      tenant.id,
      email,
      body.first_name ?? null,
      body.last_name ?? null,
      customJson,
      now,
      now,
      now
    );

    const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
    const ev = prepareEvent(c.env, tenant.id, "member.created", {
      member_id: memberId,
      email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      status: "pending",
      source: "join_form",
    });
    if (!ev) {
      return c.json(
        {
          error: "Could not record the change event; nothing was saved.",
          code: "event_prepare_failed",
        },
        500
      );
    }
    try {
      await c.env.DB.batch([insertMemberStmt, ev.stmt]);
    } catch (e) {
      console.error("join: member-create outbox batch failed, member NOT saved", e);
      return c.json(
        {
          error: "Could not record the change event; nothing was saved.",
          code: "event_prepare_failed",
        },
        500
      );
    }
    await scheduleDispatch(c.env, c.executionCtx, ev.id);

    member = await first<Member>(
      c.env.DB.prepare("SELECT * FROM members WHERE id = ? AND tenant_id = ?").bind(
        memberId,
        tenant.id
      )
    );
  } else if (customJson !== "{}") {
    let current: Record<string, string> = {};
    try { current = JSON.parse(member.custom_fields_json || "{}"); } catch {}
    await c.env.DB.prepare(
      "UPDATE members SET custom_fields_json = ?, updated_at = ? WHERE id = ?"
    )
      .bind(JSON.stringify({ ...current, ...JSON.parse(customJson) }), now, member.id)
      .run();
  }

  if (!member) {
    return c.json({ error: "Failed to create member" }, 500);
  }

  /* ——— The household, written before any money moves ———
   *
   * The payer's own member row has always been created here as 'pending'
   * before Stripe Checkout opens; the people on their household are created
   * the same way, in ONE batch with the households and household_members
   * rows, so a browser that dies mid-checkout leaves either a complete
   * pending household or nothing at all. Nobody is active until the payment
   * clears — `buildActivateMembershipStatements` (src/lib/fulfillment.ts)
   * flips the whole household in the fulfillment batch.
   */
  let householdId: string | null = null;
  if (people.length) {
    const stmts: D1PreparedStatement[] = [];
    const memberIds: string[] = [];
    for (const person of people) {
      const existing = await first<Member>(
        c.env.DB.prepare("SELECT * FROM members WHERE tenant_id = ? AND email = ?").bind(
          tenant.id,
          person.email
        )
      );
      if (existing) {
        memberIds.push(existing.id);
        continue;
      }
      const personId = generateId();
      memberIds.push(personId);
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO members
           (id, tenant_id, email, first_name, last_name, status, joined_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
        ).bind(
          personId,
          tenant.id,
          person.email,
          person.first_name,
          person.last_name,
          now,
          now,
          now
        )
      );
    }
    householdId = generateId();
    const householdName =
      (typeof body.household_name === "string" && body.household_name.trim().slice(0, 120)) ||
      `${body.last_name || body.first_name || email} household`;
    stmts.push(
      ...buildCreateHouseholdStatements(c.env.DB, {
        tenantId: tenant.id,
        householdId,
        name: householdName,
        payerMemberId: member.id,
        memberIds,
        now,
      })
    );
    try {
      await c.env.DB.batch(stmts);
    } catch (e) {
      // The UNIQUE (member_id) index on household_members is the real guard
      // against a person joining two households; the pre-flight check above
      // only makes the common case a readable message.
      console.error("join: household batch failed, nothing saved", e);
      return c.json(
        {
          error: "One of those people is already part of a household membership here.",
          code: "already_in_household",
        },
        409
      );
    }
  }

  /* ——— What this person pays today (src/lib/dues.ts) ———
   *
   * On an anniversary level (every level nobody has edited) this is the
   * level price, unchanged. On a fixed-year level with proration it is the
   * share of the year they are actually buying — but ONLY the first time
   * they hold this level: proration is a joining concession, not a
   * permanent discount, so anyone with any prior membership at this level
   * (active, expired or cancelled) pays full price.
   *
   * Auto-renew levels are excluded on purpose. Stripe repeats a
   * subscription's amount every cycle, so charging a prorated first year
   * through `mode: "subscription"` would quietly make the discount
   * permanent. Those levels charge full price until there is a real
   * two-phase subscription schedule to hang the first term on.
   */
  const policy = readDuesPolicy(level);
  // The household price is the level price plus the extra-person add-on for
  // everyone past the payer; on an individual level it IS the level price.
  const fullPriceCents = householdPriceCents(level, 1 + people.length);
  let chargeCents = fullPriceCents;
  if (policy.proration !== "none" && level.renewal_type !== "auto" && fullPriceCents > 0) {
    const prior = await first<{ id: string }>(
      c.env.DB.prepare(
        `SELECT id FROM memberships
         WHERE tenant_id = ? AND member_id = ? AND level_id = ? LIMIT 1`
      ).bind(tenant.id, member.id, level.id)
    );
    if (!prior) chargeCents = prorateCents(policy, fullPriceCents, now);
  }

  // Free membership — activate immediately. Keyed on what they OWE, so a
  // level whose proration works out to nothing this year does not open a
  // Stripe Checkout for $0.00.
  if (chargeCents === 0) {
    try {
      await assertCanActivateMember(c.env.DB, tenant, member.id);
    } catch (e: any) {
      return c.json(
        { error: e.message || "Plan limit reached", code: e.code || "plan_limit" },
        e.status || 402
      );
    }
    const membershipId = await activateMembership(c.env.DB, {
      tenantId: tenant.id,
      memberId: member.id,
      level,
      amountPaidCents: 0,
      now,
      policy,
    });

    // A free household: tie the one membership to the household and let the
    // people it covers in. The paid path does the same work inside the
    // fulfillment batch (src/lib/fulfillment.ts).
    if (householdId) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE memberships SET household_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
        ).bind(householdId, now, membershipId, tenant.id),
        c.env.DB.prepare(
          `UPDATE members SET status = 'active', joined_at = coalesce(joined_at, ?), updated_at = ?
           WHERE tenant_id = ? AND id IN (
             SELECT hm.member_id FROM household_members hm WHERE hm.household_id = ?
           )`
        ).bind(now, now, tenant.id, householdId),
      ]);
    }

    const { subject, html } = welcomeEmail({
      guildName: tenant.name,
      firstName: member.first_name ?? undefined,
      portalUrl: portalUrl(c.env.APP_URL, tenant.slug),
    });
    await sendEmail(c.env, { to: email, subject, html });
    if (householdId) {
      // Each person gets their OWN magic-link sign-in. Only the payer's mail
      // carries anything about the payment.
      const { sendHouseholdWelcomes } = await import("../lib/households");
      await sendHouseholdWelcomes(c.env, {
        tenantId: tenant.id,
        payerMemberId: member.id,
        guildName: tenant.name,
        slug: tenant.slug,
      });
    }
    try {
      const { enrollMemberActivated } = await import("../lib/automations");
      await enrollMemberActivated(c.env, tenant.id, member.id);
    } catch {
      /* optional */
    }

    // Order mirrors the Stripe path in routes/webhooks.ts: membership.activated
    // carries the level metadata, member.activated is the coarser signal.
    //
    // NOT fully atomic: activateMembership() above already ran and committed
    // its own three statements (expire prior actives, insert membership,
    // flip member status) as separate .run() calls before we ever get here —
    // decomposing it into pre-built statements this route could batch would
    // mean threading that change through every one of its five call sites
    // (members.ts import + CSV-import paths, portal.ts, webhooks.ts), which
    // is a bigger and riskier refactor than this task's scope. What we CAN
    // still guarantee is that these two events land together: either both
    // outbox rows commit or neither does, so a subscriber never sees
    // member.activated without membership.activated (or vice versa) even
    // though the activation itself happened moments earlier and outside
    // this batch.
    const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
    const membershipEv = prepareEvent(c.env, tenant.id, "membership.activated", {
      member_id: member.id,
      email,
      level_id: level.id,
      level_name: level.name,
      membership_id: membershipId,
      source: "join_form",
    });
    const memberEv = prepareEvent(c.env, tenant.id, "member.activated", {
      member_id: member.id,
      email,
      level_id: level.id,
      source: "join_form",
    });
    if (!membershipEv || !memberEv) {
      console.error(
        "join: free-activation event prepare failed; activation already committed, events lost",
        { hasMembershipEv: !!membershipEv, hasMemberEv: !!memberEv }
      );
    } else {
      try {
        await c.env.DB.batch([membershipEv.stmt, memberEv.stmt]);
        await scheduleDispatch(c.env, c.executionCtx, membershipEv.id);
        await scheduleDispatch(c.env, c.executionCtx, memberEv.id);
      } catch (e) {
        console.error(
          "join: free-activation outbox batch failed; activation already committed, events lost",
          e
        );
      }
    }

    return c.json({
      status: "active",
      member_id: member.id,
      membership_id: membershipId,
      message: "Membership activated (free level)",
    });
  }

  // Paid — Stripe Checkout (Connect destination when guild has linked account)
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(
      { error: "Payments not configured. Set STRIPE_SECRET_KEY." },
      503
    );
  }

  try {
    await assertCanActivateMember(c.env.DB, tenant, member.id);
  } catch (e: any) {
    return c.json(
      { error: e.message || "Plan limit reached", code: e.code || "plan_limit" },
      e.status || 402
    );
  }

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const session = await createCheckoutSession(c.env, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    memberId: member.id,
    email,
    name:
      [body.first_name, body.last_name].filter(Boolean).join(" ") || undefined,
    amountCents: chargeCents,
    description:
      chargeCents !== fullPriceCents
        ? `${tenant.name} – ${level.name} Membership (rest of the membership year)`
        : `${tenant.name} – ${level.name} Membership`,
    type: "dues",
    relatedId: level.id,
    successUrl: `${baseUrl}/g/${tenant.slug}?joined=1`,
    cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
    mode: level.renewal_type === "auto" ? "subscription" : "payment",
    interval: level.duration_months >= 12 ? "year" : "month",
    stripeAccountId: tenant.stripe_account_id,
  });

  return c.json({
    status: "checkout",
    checkout_url: session.url,
    session_id: session.id,
    member_id: member.id,
  });
});

/**
 * POST /public/:slug/events/:eventId/register
 * Register for an event (free or paid via Stripe).
 */
publicRoutes.post("/:slug/events/:eventId/register", async (c) => {
  const slug = c.req.param("slug");
  const eventId = c.req.param("eventId");
  const db = c.env.DB;

  const tenant = await getTenantBySlug(db, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const event = await first<Event>(
    db.prepare(
      "SELECT * FROM events WHERE id = ? AND tenant_id = ? AND is_public = 1"
    ).bind(eventId, tenant.id)
  );
  if (!event) return c.json({ error: "Event not found" }, 404);
  if (!event.registration_open) {
    return c.json({ error: "Registration is closed" }, 400);
  }

  const body = await c.req.json<{
    email: string;
    name?: string;
    custom_answers?: Record<string, string>;
  }>();

  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }

  const email = body.email.toLowerCase().trim();

  const questions = parseEventSettings(event.settings_json).questions || [];
  const validated = validateAnswers(questions, body.custom_answers);
  if (!validated.ok) {
    return c.json({ error: validated.error }, 400);
  }
  const answersJson = JSON.stringify(validated.answers);

  // Member pricing is decided server-side: only active members qualify.
  // member_price_verified records HOW we know: 1 = a portal session token
  // for this member accompanied the request; 0 = the submitted email merely
  // matches an active member (unverified claim, visible to admins);
  // NULL = non-member price applied.
  const memberRow = await first<{ id: string; status: string; user_id: string | null }>(
    db.prepare(
      "SELECT id, status, user_id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, email)
  );
  const memberId = memberRow?.id ?? null;
  // Derived, not read off members.status: the second quilter on a household
  // membership pays the member price at the door like anybody else, and a
  // household member whose payer lapsed does not. src/lib/households.ts.
  const memberIsActive = memberId ? await isActiveMember(db, tenant.id, memberId) : false;
  let memberPriceVerified: number | null = null;
  if (memberIsActive && memberRow) {
    memberPriceVerified = 0;
    const token = extractBearer(c.req.header("Authorization"));
    if (token && c.env.JWT_SECRET) {
      const jwt = await verifyJwt(token, c.env.JWT_SECRET);
      if (
        jwt &&
        (jwt.email.toLowerCase().trim() === email ||
          (memberRow.user_id != null && jwt.sub === memberRow.user_id))
      ) {
        memberPriceVerified = 1;
      }
    }
  }
  const priceCents = memberIsActive
    ? event.member_price_cents
    : event.non_member_price_cents;

  const now = new Date().toISOString();

  // Retire this email's EXPIRED payment holds first, so they neither block
  // the duplicate check below nor occupy a seat in the capacity count.
  await db
    .prepare(
      `UPDATE event_registrations SET status = 'cancelled', updated_at = ?
       WHERE event_id = ? AND tenant_id = ? AND email = ?
         AND status = 'pending_payment' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?`
    )
    .bind(now, eventId, tenant.id, email, now)
    .run();

  // Already registered? A live (unexpired) payment hold counts too: hand the
  // same Checkout back instead of taking a second seat.
  const existing = await first<{
    id: string;
    status: string;
    stripe_session_id: string | null;
    ticket_code: string | null;
  }>(
    db
      .prepare(
        `SELECT id, status, stripe_session_id, ticket_code FROM event_registrations
         WHERE event_id = ? AND tenant_id = ? AND email = ?
           AND (
             status IN ('registered', 'waitlist', 'checked_in')
             OR (status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > ?))
           )
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(eventId, tenant.id, email, now)
  );
  if (existing) {
    if (existing.status !== "pending_payment") {
      return c.json({ error: "Already registered for this event" }, 409);
    }
    if (existing.stripe_session_id && c.env.STRIPE_SECRET_KEY) {
      const open = await retrieveCheckoutSession(c.env, existing.stripe_session_id);
      if (open && open.status === "open" && open.url) {
        return c.json({
          status: "checkout",
          checkout_url: open.url,
          session_id: open.id,
          registration_id: existing.id,
          ticket_code: existing.ticket_code,
          reused: true,
        });
      }
    }
    // The session is gone (expired, completed elsewhere, or unreachable):
    // release the stale hold and take a fresh one below.
    await buildReleaseSeatStatement(db, tenant.id, existing.id, now).run();
  }

  const regId = generateId();
  const ticketCode = generateTicketCode("EV");
  const wantsPayment = priceCents > 0;
  const guarded = !!event.capacity;
  const hold = checkoutHoldExpiry(new Date(now));

  /**
   * The seat claim. With a capacity, the INSERT is conditional on the live
   * seat count (confirmed + unexpired holds) still being below capacity —
   * evaluated inside the same statement, so two concurrent requests cannot
   * both pass a stale count. meta.changes === 0 means "full".
   */
  const insertRegistration = (status: string, withCapacityGuard: boolean) => {
    const cols = `(id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents,
       ticket_code, custom_answers_json, hold_expires_at, member_price_verified, created_at, updated_at)`;
    const binds = [
      regId,
      tenant.id,
      eventId,
      memberId,
      email,
      body.name ?? null,
      status,
      ticketCode,
      answersJson,
      status === "pending_payment" ? hold.iso : null,
      memberPriceVerified,
      now,
      now,
    ];
    if (!withCapacityGuard) {
      return db
        .prepare(
          `INSERT INTO event_registrations ${cols}
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
        )
        .bind(...binds);
    }
    return db
      .prepare(
        `INSERT INTO event_registrations ${cols}
         SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?
         WHERE ${SEAT_COUNT_SQL} < ?`
      )
      .bind(...binds, eventId, tenant.id, now, event.capacity);
  };

  const registrationEvent = (status: string) =>
    prepareEvent(c.env, tenant.id, "event.registration", {
      registration_id: regId,
      event_id: eventId,
      event_title: event.title,
      email,
      name: body.name ?? null,
      status,
      amount_paid_cents: 0,
      ticket_code: ticketCode,
      source: "public",
    });

  const prepareFailed = () =>
    c.json(
      {
        error: "Could not record the change event; nothing was saved.",
        code: "event_prepare_failed",
      },
      500
    );

  /**
   * Commit a free/waitlist registration together with its outbox event.
   * Returns "full" when the guarded INSERT claimed no seat; in that case the
   * outbox row that rode along in the batch is removed again (the batch is
   * atomic but not conditional as a whole).
   */
  const commitImmediate = async (
    status: string,
    withCapacityGuard: boolean
  ): Promise<"ok" | "full" | "error"> => {
    const ev = registrationEvent(status);
    if (!ev) return "error";
    let results: D1Result[];
    try {
      results = await db.batch([insertRegistration(status, withCapacityGuard), ev.stmt]);
    } catch (e) {
      console.error("event registration: outbox batch failed, registration NOT saved", e);
      return "error";
    }
    const claimed = !withCapacityGuard || (results[0]?.meta?.changes ?? 0) > 0;
    if (!claimed) {
      await db
        .prepare(`DELETE FROM webhook_outbox WHERE id = ? AND status = 'pending'`)
        .bind(ev.id)
        .run();
      return "full";
    }
    await scheduleDispatch(c.env, execCtx(c), ev.id);
    return "ok";
  };

  const respondImmediate = async (status: string) => {
    if (status === "registered") {
      const eventDate = new Date(event.start_at).toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "short",
      });
      const { subject, html } = eventConfirmationEmail({
        guildName: tenant.name,
        firstName: body.name?.split(" ")[0],
        eventTitle: event.title,
        eventDate,
        eventLocation: event.location ?? undefined,
        ticketCode,
      });
      await sendEmail(c.env, { to: email, subject, html });
      // Additive: enqueueTrigger never throws, so an automation cannot cost
      // someone the seat they just claimed.
      await enqueueTrigger(c.env, tenant.id, "event_registered", { id: regId, eventId });
    }
    return c.json({
      status,
      registration_id: regId,
      ticket_code: ticketCode,
      message: status === "waitlist" ? "Added to waitlist" : "Registered successfully",
    });
  };

  // Free — register immediately (waitlist if the seat claim fails)
  if (!wantsPayment) {
    let outcome = await commitImmediate("registered", guarded);
    if (outcome === "full") {
      if (!event.waitlist_enabled) return c.json({ error: "Event is full" }, 409);
      outcome = await commitImmediate("waitlist", false);
      if (outcome === "ok") return respondImmediate("waitlist");
    }
    if (outcome !== "ok") return prepareFailed();
    return respondImmediate("registered");
  }

  // Paid registration — Stripe Checkout
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  // Take the seat as a pending_payment hold that expires with the session.
  const claim = await insertRegistration("pending_payment", guarded).run();
  if (guarded && (claim.meta?.changes ?? 0) === 0) {
    if (!event.waitlist_enabled) return c.json({ error: "Event is full" }, 409);
    const outcome = await commitImmediate("waitlist", false);
    if (outcome !== "ok") return prepareFailed();
    return respondImmediate("waitlist");
  }

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  let session;
  try {
    session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId: memberId ?? undefined,
      email,
      name: body.name,
      amountCents: priceCents,
      description: `${tenant.name} – ${event.title}`,
      type: "event",
      relatedId: regId,
      successUrl: `${baseUrl}/g/${tenant.slug}?registered=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
      stripeAccountId: tenant.stripe_account_id,
      expiresAt: hold.unix,
    });
  } catch (err) {
    // No session exists, so nothing can ever pay for this hold: drop it.
    await db
      .prepare(
        "DELETE FROM event_registrations WHERE id = ? AND tenant_id = ? AND status = 'pending_payment'"
      )
      .bind(regId, tenant.id)
      .run();
    // A guild that never connected payouts cannot be allowed to sell: the
    // charge would land in the platform balance and the guild would never
    // see it. Say so plainly instead of failing as an unexplained 502.
    if (err instanceof PayoutsNotConnectedError) {
      return c.json({ error: "This guild has not finished setting up payments, so paid registration is not available yet. Please contact the guild." }, 503);
    }
    console.error("Checkout session failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }

  await db
    .prepare(
      `UPDATE event_registrations SET stripe_session_id = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    )
    .bind(session.id, now, regId, tenant.id)
    .run();

  return c.json({
    status: "checkout",
    checkout_url: session.url,
    session_id: session.id,
    registration_id: regId,
    ticket_code: ticketCode,
    hold_expires_at: hold.iso,
  });
});

// GET /public/:slug/pages — published public pages (no members-only; not blog posts)
/**
 * Published, public, non-trashed pages plus the slug-rename redirect map
 * (`redirects: { from: to }`) so guild.html can send a stale /p/<old-slug>
 * link to the page's new slug. No pre-migration fallback: every migration
 * through 0025 is applied in production, so a failure here is a real error.
 */
async function pagesPayload(env: Env, tenant: Tenant) {
  const [rows, redirects] = await Promise.all([
    all<{
      slug: string;
      title: string;
      content_json: string;
      blocks_json?: string | null;
    }>(
      env.DB.prepare(
        `SELECT slug, title, content_json, blocks_json FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND deleted_at IS NULL
           AND coalesce(page_type, 'page') = 'page'
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    ),
    listRedirects(env.DB, tenant.id),
  ]);
  return {
    tenant: tenantSummary(tenant),
    pages: rows.map((p) => ({
      slug: p.slug,
      title: p.title,
      // contentFromPage sanitizes legacy content_json.html and prefers
      // blocks_json when present (same output as the SSR renderer).
      html: contentFromPage(p).html,
    })),
    redirects,
  };
}

publicRoutes.get("/:slug/pages", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  return c.json(await pagesPayload(c.env, tenant));
});

/**
 * GET /public/:slug/img/:fileId — a tenant's uploaded image, inline, for
 * guild pages (the business site serves the same thing at /img/:fileId on
 * its own host; see site.ts). Same allowlist + nosniff + immutable caching;
 * files.tenant_id in the WHERE clause is what stops one guild's file id
 * from reading another's.
 */
publicRoutes.get("/:slug/img/:fileId", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Not found" }, 404);
  const fileId = c.req.param("fileId");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(fileId)) return c.json({ error: "Not found" }, 404);
  const row = await first<ImageRow>(
    c.env.DB.prepare(
      `SELECT ${IMAGE_ROW_COLUMNS} FROM files WHERE id = ? AND tenant_id = ?`
    ).bind(fileId, tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  // serveImage enforces the raster allowlist (a stored text/html or
  // image/svg+xml file must never execute on this origin), picks a stored
  // variant for ?w= / ?f= / Accept, and sets nosniff + immutable caching.
  const res = await serveImage(c.env, row, new URL(c.req.url), c.req.header("accept"));
  return res ?? c.json({ error: "Not found" }, 404);
});

/**
 * GET /public/:slug/site-bootstrap — everything guild.html fetches at boot,
 * in one round trip. Each key is exactly the body the corresponding
 * endpoint returns (same functions, same SQL).
 */
publicRoutes.get("/:slug/site-bootstrap", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const [levels, events, info, products, site, blog, pages] = await Promise.all([
    levelsPayload(c.env, tenant),
    eventsPayload(c.env, tenant),
    infoPayload(tenant),
    productsPayload(c.env, tenant),
    sitePayload(c.env, tenant),
    blogPayload(c.env, tenant),
    pagesPayload(c.env, tenant),
  ]);
  return c.json({ levels, events, info, products, site, blog, pages });
});

/**
 * POST /public/:slug/donate — one-off donation via Stripe Checkout
 */
publicRoutes.post("/:slug/donate", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const body = await c.req.json<{ amount_cents: number; email?: string; name?: string }>();
  const amount = Math.floor(Number(body.amount_cents));
  if (!Number.isFinite(amount) || amount < 100 || amount > 1000000) {
    return c.json({ error: "Amount must be between $1 and $10,000" }, 400);
  }
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }
  const email = (body.email || "").toLowerCase().trim();
  let memberId: string | undefined;
  if (email) {
    const member = await first<{ id: string }>(
      c.env.DB.prepare(
        "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
      ).bind(tenant.id, email)
    );
    memberId = member?.id;
  }
  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  let session;
  try {
    session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId,
      email: email || "donor@example.com",
      name: body.name,
      amountCents: amount,
      description: `Donation to ${tenant.name}`,
      type: "donation",
      successUrl: `${baseUrl}/g/${tenant.slug}?donated=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
      stripeAccountId: tenant.stripe_account_id,
    });
  } catch (err) {
    console.error("Donation checkout failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }
  return c.json({ status: "checkout", checkout_url: session.url });
});

/**
 * GET /public/:slug/products — active store items
 */
/** Public store items: active and in stock (or untracked inventory). */
export function productsStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, name, description, price_cents, inventory FROM products
       WHERE tenant_id = ? AND is_active = 1
         AND (inventory IS NULL OR inventory > 0)
       ORDER BY sort_order, name`
    )
    .bind(tenantId);
}

async function productsPayload(env: Env, tenant: Tenant) {
  try {
    const rows = await all<{
      id: string;
      name: string;
      description: string | null;
      price_cents: number;
      inventory: number | null;
    }>(productsStatement(env.DB, tenant.id));
    return { tenant: tenantSummary(tenant), products: rows };
  } catch {
    return { tenant: tenantSummary(tenant), products: [] };
  }
}

publicRoutes.get("/:slug/products", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  return c.json(await productsPayload(c.env, tenant));
});

/**
 * POST /public/:slug/products/:productId/buy
 */
// ---------------------------------------------------------------------------
// Store orders — stock is RESERVED at checkout time (PAY-2)
// ---------------------------------------------------------------------------

type StoreCartLine = {
  product_id: string;
  name: string;
  quantity: number;
  unit_cents: number;
  taxable: boolean;
  line_cents: number;
  /** false when products.inventory IS NULL (untracked): nothing to reserve. */
  tracked: boolean;
};

type ReserveOutcome = { ok: true } | { ok: false; outOfStock: string[] };

/**
 * Insert the order and reserve its stock in ONE batch of conditional
 * decrements, then check every statement's meta.changes. If any tracked line
 * could not be reserved, the lines that DID decrement are put back and the
 * order is cancelled in a second (compensating) batch, and the caller gets
 * the product ids that ran out. The order row is inside the first batch on
 * purpose: if the compensation is interrupted, the reservation is still
 * tracked by a pending reserved order, which sweepExpiredHolds() releases.
 */
async function reserveStoreOrder(
  db: D1Database,
  params: {
    tenantId: string;
    orderId: string;
    memberId: string | null;
    email: string;
    lines: StoreCartLine[];
    subtotal: number;
    taxCents: number;
    total: number;
    now: string;
    holdExpiresAt: string;
  }
): Promise<ReserveOutcome> {
  const { tenantId, orderId, lines, now } = params;
  const tracked = lines.filter((l) => l.tracked);
  const reservations = buildReserveStockStatements(db, tenantId, tracked, now);
  const orderInsert = db
    .prepare(
      `INSERT INTO store_orders
       (id, tenant_id, member_id, email, status, subtotal_cents, tax_cents, total_cents,
        items_json, reserved_at, hold_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      orderId,
      tenantId,
      params.memberId,
      params.email,
      params.subtotal,
      params.taxCents,
      params.total,
      JSON.stringify(
        lines.map(({ tracked: _t, ...rest }) => rest)
      ),
      now,
      params.holdExpiresAt,
      now,
      now
    );

  const results = await db.batch([orderInsert, ...reservations.map((r) => r.stmt)]);

  const outOfStock: string[] = [];
  const reserved: OrderLine[] = [];
  reservations.forEach((r, i) => {
    const changes = results[i + 1]?.meta?.changes ?? 0;
    if (changes > 0) reserved.push(r.line);
    else outOfStock.push(r.line.product_id);
  });
  if (!outOfStock.length) return { ok: true };

  await db.batch(
    buildReleaseOrderStatements(db, {
      tenantId,
      orderId,
      lines: reserved,
      now,
      status: "cancelled",
    })
  );
  return { ok: false, outOfStock };
}

/** Put a reserved order's stock back and cancel it (checkout could not start). */
async function releaseStoreOrder(
  db: D1Database,
  tenantId: string,
  orderId: string,
  lines: StoreCartLine[],
  now: string
): Promise<void> {
  await db.batch(
    buildReleaseOrderStatements(db, {
      tenantId,
      orderId,
      lines: lines.filter((l) => l.tracked),
      now,
      status: "cancelled",
    })
  );
}

/** Free order: flip to paid and record a $0 payment, atomically. */
async function fulfillFreeStoreOrder(
  db: D1Database,
  params: {
    tenantId: string;
    orderId: string;
    memberId: string | null;
    description: string;
    now: string;
  }
): Promise<void> {
  const { tenantId, orderId, now } = params;
  await db.batch([
    db
      .prepare(
        `UPDATE store_orders SET status = 'paid', fulfilled_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending'`
      )
      .bind(now, now, orderId, tenantId),
    db
      .prepare(
        `INSERT INTO payments
         (id, tenant_id, member_id, type, amount_cents, currency, status, description,
          related_id, fulfilled_at, created_at, updated_at)
         VALUES (?, ?, ?, 'store', 0, 'usd', 'succeeded', ?, ?, ?, ?, ?)`
      )
      .bind(generateId(), tenantId, params.memberId, params.description, orderId, now, now, now),
  ]);
}

publicRoutes.post("/:slug/products/:productId/buy", async (c) => {
  const slug = c.req.param("slug");
  const productId = c.req.param("productId");
  const db = c.env.DB;
  const tenant = await getTenantBySlug(db, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const product = await first<{
    id: string;
    name: string;
    price_cents: number;
    inventory: number | null;
    is_active: number;
  }>(
    db.prepare("SELECT * FROM products WHERE id = ? AND tenant_id = ?").bind(productId, tenant.id)
  );
  if (!product || !product.is_active) {
    return c.json({ error: "Product not found" }, 404);
  }
  if (product.inventory !== null && product.inventory <= 0) {
    return c.json({ error: "Sold out" }, 400);
  }

  const body = await c.req.json<{
    email: string;
    name?: string;
    quantity?: number;
  }>();
  const email = (body.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) {
    return c.json({ error: "email is required" }, 400);
  }
  const qty = Math.min(10, Math.max(1, Math.floor(Number(body.quantity) || 1)));
  if (product.inventory !== null && qty > product.inventory) {
    return c.json({ error: `Only ${product.inventory} left` }, 400);
  }

  const amount = product.price_cents * qty;
  if (amount > 0 && !c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  const member = await first<{ id: string }>(
    db.prepare("SELECT id FROM members WHERE tenant_id = ? AND email = ?").bind(tenant.id, email)
  );
  const memberId = member?.id ?? null;

  const now = new Date().toISOString();
  const hold = checkoutHoldExpiry(new Date(now));
  const orderId = generateId();
  const lines: StoreCartLine[] = [
    {
      product_id: product.id,
      name: product.name,
      quantity: qty,
      unit_cents: product.price_cents,
      taxable: false,
      line_cents: amount,
      tracked: product.inventory !== null,
    },
  ];

  const reserved = await reserveStoreOrder(db, {
    tenantId: tenant.id,
    orderId,
    memberId,
    email,
    lines,
    subtotal: amount,
    taxCents: 0,
    total: amount,
    now,
    holdExpiresAt: hold.iso,
  });
  if (!reserved.ok) {
    return c.json({ error: "Sold out", out_of_stock: reserved.outOfStock }, 409);
  }

  if (amount === 0) {
    await fulfillFreeStoreOrder(db, {
      tenantId: tenant.id,
      orderId,
      memberId,
      description: `${product.name} × ${qty} (free)`,
      now,
    });
    return c.json({
      status: "fulfilled",
      order_id: orderId,
      message: `You're all set — ${product.name} is free.`,
    });
  }

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  try {
    const session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId: memberId ?? undefined,
      email,
      name: body.name,
      amountCents: amount,
      description:
        qty > 1
          ? `${tenant.name} – ${product.name} × ${qty}`
          : `${tenant.name} – ${product.name}`,
      type: "store",
      relatedId: orderId,
      quantity: qty,
      extraMetadata: { order_id: orderId },
      successUrl: `${baseUrl}/g/${tenant.slug}?purchased=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
      stripeAccountId: tenant.stripe_account_id,
      expiresAt: hold.unix,
    });
    await db
      .prepare(`UPDATE store_orders SET stripe_session_id = ?, updated_at = ? WHERE id = ?`)
      .bind(session.id, now, orderId)
      .run();
    return c.json({
      status: "checkout",
      checkout_url: session.url,
      session_id: session.id,
      order_id: orderId,
    });
  } catch (err) {
    console.error("Store checkout failed", err);
    await releaseStoreOrder(db, tenant.id, orderId, lines, now);
    return c.json({ error: "Payment session could not be created" }, 502);
  }
});

/**
 * GET /public/:slug/info — guild profile for the public page:
 * description, contact, links, join custom fields, logo.
 */
function infoPayload(tenant: Tenant) {
  let settings: any = {};
  try { settings = JSON.parse(tenant.settings_json || "{}"); } catch {}
  const profile = settings.profile || {};
  const joinFields = (settings.custom_fields || []).filter(
    (f: any) => f && f.key && f.show_on_join
  );
  const logoUrl = profile.logo_file_id
    ? `/public/${tenant.slug}/logo`
    : null;
  return {
    tenant: tenantSummary(tenant),
    profile: {
      description: profile.description || "",
      contact_email: profile.contact_email || "",
      location: profile.location || "",
      website: profile.website || "",
      facebook: profile.facebook || "",
      meeting_info: profile.meeting_info || "",
      donations_enabled: profile.donations_enabled !== false,
      directory_public: !!profile.directory_public,
      logo_file_id: profile.logo_file_id || null,
      logo_url: logoUrl,
    },
    join_fields: joinFields,
  };
}

publicRoutes.get("/:slug/info", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  return c.json(infoPayload(tenant));
});

/**
 * GET /public/:slug/logo — public guild logo image
 */
publicRoutes.get("/:slug/logo", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Not found" }, 404);
  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  const logoFileId = settings.profile?.logo_file_id as string | undefined;
  if (!logoFileId) return c.json({ error: "No logo" }, 404);
  const row = await first<{ r2_key: string; content_type: string | null }>(
    c.env.DB.prepare(
      `SELECT r2_key, content_type FROM files WHERE id = ? AND tenant_id = ?`
    ).bind(logoFileId, tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  // Only raster image types are served inline: a legacy SVG logo stored
  // before upload sniffing existed must never execute on this origin.
  const logoType = row.content_type || "";
  if (!ALLOWED_IMAGE_TYPES.has(logoType)) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": logoType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

/**
 * GET /public/:slug/directory — optional public member directory (with showcase)
 */
publicRoutes.get("/:slug/directory", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  if (!settings.profile?.directory_public) {
    return c.json({ error: "Directory is not public" }, 403);
  }
  try {
    const members = await all<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      bio: string | null;
      photo_file_id: string | null;
      showcase_json: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT m.id, m.first_name, m.last_name, m.bio, m.photo_file_id, m.showcase_json
           FROM members m
          WHERE m.tenant_id = ? AND ${activeMembershipFilter("m")}
            AND coalesce(m.directory_visible, 1) = 1
          ORDER BY m.last_name, m.first_name LIMIT 500`
      ).bind(tenant.id)
    );
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      members: members.map((m) => {
        let showcase: Record<string, string> = {};
        try {
          showcase = JSON.parse(m.showcase_json || "{}");
        } catch {}
        return {
          id: m.id,
          first_name: m.first_name,
          last_name: m.last_name,
          bio: m.bio,
          photo_url: m.photo_file_id
            ? `/public/${tenant.slug}/member-photo/${m.photo_file_id}`
            : null,
          showcase,
        };
      }),
    });
  } catch {
    const members = await all<{
      first_name: string | null;
      last_name: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT m.first_name, m.last_name FROM members m
          WHERE m.tenant_id = ? AND ${activeMembershipFilter("m")}
            AND coalesce(m.directory_visible, 1) = 1
          ORDER BY m.last_name, m.first_name LIMIT 500`
      ).bind(tenant.id)
    );
    return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, members });
  }
});

/** Public photo file (member showcase) */
publicRoutes.get("/:slug/member-photo/:fileId", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Not found" }, 404);
  const fileId = c.req.param("fileId");
  const member = await first(
    c.env.DB.prepare(
      `SELECT m.id FROM members m WHERE m.tenant_id = ? AND m.photo_file_id = ?
         AND coalesce(m.directory_visible, 1) = 1 AND ${activeMembershipFilter("m")}`
    ).bind(tenant.id, fileId)
  );
  if (!member) return c.json({ error: "Not found" }, 404);
  const row = await first<{ r2_key: string; content_type: string | null }>(
    c.env.DB.prepare(
      `SELECT r2_key, content_type FROM files WHERE id = ? AND tenant_id = ?`
    ).bind(fileId, tenant.id)
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const photoType = row.content_type || "";
  if (!ALLOWED_IMAGE_TYPES.has(photoType)) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": photoType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

/** Site theme + nav for public guild page */
async function sitePayload(env: Env, tenant: Tenant) {
  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  let navPages: Array<{ slug: string; title: string; nav_label: string | null }> = [];
  try {
    navPages = await all(
      env.DB.prepare(
        `SELECT slug, title, nav_label FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND deleted_at IS NULL
           AND coalesce(show_in_nav, 1) = 1 AND coalesce(page_type, 'page') = 'page'
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
  } catch {
    navPages = [];
  }
  const taxRateBps = Number(settings.store?.tax_rate_bps || 0) || 0;
  const { theme: tokens, fonts } = readTenantTheme(tenant.settings_json);
  return {
    // guild.html reads theme.primary, theme.font, and theme.style directly
    // (confirmed by grep of public/guild.html; accent/headerBg are kept for
    // shape-compatibility though nothing reads them today). Presence-based
    // against the stored settings.theme: an unconfigured tenant must get {}
    // back, not DEFAULT_THEME's colors, or every unconfigured guild site
    // gets repainted with the wrong brand color (see deriveLegacyTheme).
    theme: deriveLegacyTheme(tokens, settings.theme),
    // Full token set + fonts for the server renderer and the new admin.
    theme_tokens: tokens,
    fonts,
    nav: settings.nav || [],
    nav_pages: navPages,
    store: {
      tax_rate_bps: taxRateBps,
      tax_label: settings.store?.tax_label || "Sales tax",
    },
  };
}

publicRoutes.get("/:slug/site", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  return c.json(await sitePayload(c.env, tenant));
});

/** Public blog posts (pages with page_type=blog_post), newest first. */
export function blogStatement(db: D1Database, tenantId: string, limit = 50): D1PreparedStatement {
  return db
    .prepare(
      `SELECT slug, title, content_json, blocks_json, updated_at, created_at
       FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         AND deleted_at IS NULL
         AND coalesce(page_type, 'page') = 'blog_post'
       ORDER BY created_at DESC LIMIT ?`
    )
    .bind(tenantId, limit);
}

/** Blog posts (public pages with page_type=blog_post) */
async function blogPayload(env: Env, tenant: Tenant) {
  try {
    const posts = await all<{
      slug: string;
      title: string;
      content_json: string | null;
      blocks_json: string | null;
      updated_at: string;
      created_at: string;
    }>(blogStatement(env.DB, tenant.id));
    return {
      posts: posts.map((p) => ({
        slug: p.slug,
        title: p.title,
        html: contentFromPage(p).html,
        updated_at: p.updated_at,
        created_at: p.created_at,
      })),
    };
  } catch {
    return { posts: [] };
  }
}

publicRoutes.get("/:slug/blog", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  return c.json(await blogPayload(c.env, tenant));
});

/** Public form / survey by slug */
publicRoutes.get("/:slug/forms/:formSlug", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const form = await first<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    fields_json: string;
    form_type: string;
  }>(
    c.env.DB.prepare(
      `SELECT id, name, slug, description, fields_json, form_type FROM forms
       WHERE tenant_id = ? AND slug = ? AND published = 1 AND is_public = 1`
    ).bind(tenant.id, c.req.param("formSlug"))
  );
  if (!form) return c.json({ error: "Form not found" }, 404);
  let fields = [];
  try {
    fields = JSON.parse(form.fields_json || "[]");
  } catch {}
  return c.json({
    form: {
      id: form.id,
      name: form.name,
      slug: form.slug,
      description: form.description,
      form_type: form.form_type,
      fields,
    },
  });
});

publicRoutes.post("/:slug/forms/:formSlug", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const form = await first<{ id: string; fields_json: string }>(
    c.env.DB.prepare(
      `SELECT id, fields_json FROM forms
       WHERE tenant_id = ? AND slug = ? AND published = 1 AND is_public = 1`
    ).bind(tenant.id, c.req.param("formSlug"))
  );
  if (!form) return c.json({ error: "Form not found" }, 404);
  const { normalizeFormFields, validateFormAnswers } = await import("../lib/forms");
  let fields = normalizeFormFields([]);
  try {
    fields = normalizeFormFields(JSON.parse(form.fields_json || "[]"));
  } catch {}
  const body = await c.req.json<{
    email?: string;
    name?: string;
    answers?: unknown;
  }>();
  const validated = validateFormAnswers(fields, body.answers || body);
  if (!validated.ok) return c.json({ error: validated.error }, 400);
  const id = generateId();
  const now = new Date().toISOString();
  let memberId: string | null = null;
  const email = (body.email || "").toLowerCase().trim();
  if (email) {
    const m = await first<{ id: string }>(
      c.env.DB.prepare(
        `SELECT id FROM members WHERE tenant_id = ? AND email = ?`
      ).bind(tenant.id, email)
    );
    memberId = m?.id ?? null;
  }
  const insertResponseStmt = c.env.DB.prepare(
    `INSERT INTO form_responses (id, tenant_id, form_id, member_id, email, name, answers_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    tenant.id,
    form.id,
    memberId,
    email || null,
    body.name?.trim() || null,
    JSON.stringify(validated.answers),
    now
  );
  const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
  const ev = prepareEvent(c.env, tenant.id, "form.response", {
    form_id: form.id,
    response_id: id,
    email: email || null,
    answers: validated.answers,
    source: "public",
  });
  if (!ev) {
    return c.json(
      {
        error: "Could not record the change event; nothing was saved.",
        code: "event_prepare_failed",
      },
      500
    );
  }
  try {
    await c.env.DB.batch([insertResponseStmt, ev.stmt]);
  } catch (e) {
    console.error("form response: outbox batch failed, response NOT saved", e);
    return c.json(
      {
        error: "Could not record the change event; nothing was saved.",
        code: "event_prepare_failed",
      },
      500
    );
  }
  await scheduleDispatch(c.env, c.executionCtx, ev.id);
  // Additive, after the response is committed; enqueueTrigger never throws.
  await enqueueTrigger(c.env, tenant.id, "form_submitted", { id, formId: form.id });
  return c.json({ ok: true, id }, 201);
});

// ---------------------------------------------------------------------------
// POST /public/:slug/newsletter { email, name? } — the newsletter_signup
// section (src/lib/site/sections/render.ts, island initNewsletter in
// public/qh-site.js). Records the address in newsletter_signups (migration
// 0027). Idempotent per (tenant, email): a repeat signup is a no-op that
// still answers 201, so a visitor never sees "already subscribed". Rate
// limited per IP above (10 per 10 min). Reachable on a launched tenant's own
// host through siteGate rule 4 like /join and /forms/*.
// ---------------------------------------------------------------------------
const NEWSLETTER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NEWSLETTER_EMAIL_MAX = 200;
const NEWSLETTER_NAME_MAX = 120;

publicRoutes.post("/:slug/newsletter", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  let body: { email?: unknown; name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body with an email address" }, 400);
  }
  if (!body || typeof body !== "object") return c.json({ error: "Expected a JSON body with an email address" }, 400);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > NEWSLETTER_EMAIL_MAX || !NEWSLETTER_EMAIL_RE.test(email)) {
    return c.json({ error: "Please enter a valid email address" }, 400);
  }
  const nameRaw = typeof body.name === "string" ? body.name.trim() : "";
  if (nameRaw.length > NEWSLETTER_NAME_MAX) return c.json({ error: `Name must be ${NEWSLETTER_NAME_MAX} characters or fewer` }, 400);
  const name = nameRaw || null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO newsletter_signups (id, tenant_id, email, name, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, email) DO UPDATE SET name = COALESCE(excluded.name, newsletter_signups.name)`
    )
      .bind(generateId(), tenant.id, email, name, "site", new Date().toISOString())
      .run();
  } catch (e) {
    console.error("newsletter signup failed", { tenantId: tenant.id, error: e instanceof Error ? e.message : String(e) });
    return c.json({ error: "We couldn't save your address. Please try again." }, 500);
  }
  return c.json({ ok: true, message: "Thanks — you're on the list." }, 201);
});

/**
 * POST /public/:slug/cart/checkout — multi-SKU cart with tax
 */
publicRoutes.post("/:slug/cart/checkout", async (c) => {
  const slug = c.req.param("slug");
  const db = c.env.DB;
  const tenant = await getTenantBySlug(db, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const body = await c.req.json<{
    email: string;
    name?: string;
    items: Array<{ product_id: string; quantity?: number }>;
  }>();
  const email = (body.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) {
    return c.json({ error: "email is required" }, 400);
  }
  if (!Array.isArray(body.items) || !body.items.length) {
    return c.json({ error: "Cart is empty" }, 400);
  }

  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  const taxRateBps = Math.max(0, Math.min(2500, Number(settings.store?.tax_rate_bps) || 0));

  // Repeated SKUs are summed into one line each (max 20 per line, 20 lines)
  // so the same unit of stock cannot pass two separate checks.
  const wanted = normalizeOrderLines(body.items, 20).slice(0, 20);
  if (!wanted.length) {
    return c.json({ error: "Cart is empty" }, 400);
  }

  const cartLines: StoreCartLine[] = [];
  for (const raw of wanted) {
    const product = await first<{
      id: string;
      name: string;
      price_cents: number;
      inventory: number | null;
      is_active: number;
      taxable?: number;
    }>(
      db.prepare(`SELECT * FROM products WHERE id = ? AND tenant_id = ?`).bind(
        raw.product_id,
        tenant.id
      )
    );
    if (!product || !product.is_active) {
      return c.json({ error: `Product not found: ${raw.product_id}` }, 400);
    }
    // Friendly early message; the reservation below is what actually decides.
    if (product.inventory !== null && raw.quantity > product.inventory) {
      return c.json(
        {
          error: `Only ${product.inventory} left of ${product.name}`,
          out_of_stock: [product.id],
        },
        409
      );
    }
    cartLines.push({
      product_id: product.id,
      name: product.name,
      quantity: raw.quantity,
      unit_cents: product.price_cents,
      taxable: product.taxable !== 0,
      line_cents: product.price_cents * raw.quantity,
      tracked: product.inventory !== null,
    });
  }

  const subtotal = cartLines.reduce((s, l) => s + l.line_cents, 0);
  const taxableBase = cartLines.filter((l) => l.taxable).reduce((s, l) => s + l.line_cents, 0);
  const taxCents = Math.floor((taxableBase * taxRateBps) / 10000);
  const total = subtotal + taxCents;

  if (total > 0 && !c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  const orderId = generateId();
  const now = new Date().toISOString();
  const hold = checkoutHoldExpiry(new Date(now));
  const member = await first<{ id: string }>(
    db.prepare(`SELECT id FROM members WHERE tenant_id = ? AND email = ?`).bind(tenant.id, email)
  );
  const memberId = member?.id ?? null;

  const reserved = await reserveStoreOrder(db, {
    tenantId: tenant.id,
    orderId,
    memberId,
    email,
    lines: cartLines,
    subtotal,
    taxCents,
    total,
    now,
    holdExpiresAt: hold.iso,
  });
  if (!reserved.ok) {
    return c.json(
      { error: "Some items are no longer in stock", out_of_stock: reserved.outOfStock },
      409
    );
  }

  if (total === 0) {
    await fulfillFreeStoreOrder(db, {
      tenantId: tenant.id,
      orderId,
      memberId,
      description: `Store order ${orderId} (free)`,
      now,
    });
    return c.json({ status: "fulfilled", order_id: orderId, message: "Order complete (free)." });
  }

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const lineItems = cartLines.map((l) => ({
    name: l.name,
    amountCents: l.unit_cents,
    quantity: l.quantity,
  }));
  if (taxCents > 0) {
    lineItems.push({
      name: settings.store?.tax_label || "Sales tax",
      amountCents: taxCents,
      quantity: 1,
    });
  }

  try {
    const session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId: memberId ?? undefined,
      email,
      name: body.name,
      amountCents: total,
      description: `${tenant.name} store order`,
      type: "store",
      relatedId: orderId,
      lineItems,
      extraMetadata: {
        order_id: orderId,
        tax_cents: String(taxCents),
        subtotal_cents: String(subtotal),
      },
      successUrl: `${baseUrl}/g/${tenant.slug}?purchased=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
      stripeAccountId: tenant.stripe_account_id,
      expiresAt: hold.unix,
    });
    await db
      .prepare(`UPDATE store_orders SET stripe_session_id = ?, updated_at = ? WHERE id = ?`)
      .bind(session.id, now, orderId)
      .run();
    return c.json({
      status: "checkout",
      checkout_url: session.url,
      session_id: session.id,
      order_id: orderId,
      subtotal_cents: subtotal,
      tax_cents: taxCents,
      total_cents: total,
      hold_expires_at: hold.iso,
    });
  } catch (err) {
    console.error("Cart checkout failed", err);
    await releaseStoreOrder(db, tenant.id, orderId, cartLines, now);
    return c.json({ error: "Payment session could not be created" }, 502);
  }
});

// ---------------------------------------------------------------------------
// Calendar feeds (.ics) — subscribe in Google/Apple Calendar
// ---------------------------------------------------------------------------

/** GET /public/:slug/events.ics — whole-guild subscribable feed */
publicRoutes.get("/:slug/events.ics", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const events = await all<{
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    start_at: string;
    end_at: string | null;
    updated_at: string;
  }>(
    c.env.DB.prepare(
      `SELECT id, title, description, location, start_at, end_at, updated_at
       FROM events
       WHERE tenant_id = ? AND is_public = 1
         AND start_at >= datetime('now', '-90 days')
       ORDER BY start_at ASC LIMIT 500`
    ).bind(tenant.id)
  );
  const base = c.env.APP_URL || "https://quilthosting.com";
  const ics = buildIcs(
    tenant.name + " Events",
    events.map((e) => ({ ...e, url: `${base}/g/${tenant.slug}/events/${e.id}` }))
  );
  return icsResponse(ics, `${tenant.slug}-events.ics`);
});

/** GET /public/:slug/events/:eventId/ics — single event download */
publicRoutes.get("/:slug/events/:eventId/ics", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const ev = await first<{
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    start_at: string;
    end_at: string | null;
    updated_at: string;
  }>(
    c.env.DB.prepare(
      `SELECT id, title, description, location, start_at, end_at, updated_at
       FROM events WHERE id = ? AND tenant_id = ? AND is_public = 1`
    ).bind(c.req.param("eventId"), tenant.id)
  );
  if (!ev) return c.json({ error: "Event not found" }, 404);
  const base = c.env.APP_URL || "https://quilthosting.com";
  const ics = buildIcs(ev.title, [
    { ...ev, url: `${base}/g/${tenant.slug}/events/${ev.id}` },
  ]);
  return icsResponse(ics, "event.ics");
});

// ---------------------------------------------------------------------------
// Volunteer sign-up sheets (public side)
// ---------------------------------------------------------------------------

/** GET /public/:slug/events/:eventId/volunteers — slots + filled counts (no emails) */
publicRoutes.get("/:slug/events/:eventId/volunteers", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const eventId = c.req.param("eventId");
  const slots = await all<{
    id: string;
    title: string;
    description: string | null;
    needed: number;
    starts_at: string | null;
    sort_order: number;
  }>(
    c.env.DB.prepare(
      `SELECT id, title, description, needed, starts_at, sort_order
       FROM volunteer_slots WHERE tenant_id = ? AND event_id = ?
       ORDER BY sort_order, title`
    ).bind(tenant.id, eventId)
  );
  if (!slots.length) return c.json({ slots: [] });
  const counts = await all<{ slot_id: string; taken: number; names: string | null }>(
    c.env.DB.prepare(
      `SELECT slot_id, COUNT(*) taken, group_concat(name, ', ') names
       FROM volunteer_signups WHERE tenant_id = ? AND event_id = ?
       GROUP BY slot_id`
    ).bind(tenant.id, eventId)
  );
  const byId = new Map(counts.map((r) => [r.slot_id, r]));
  return c.json({
    slots: slots.map((s) => {
      const cnt = byId.get(s.id);
      return {
        ...s,
        taken: cnt?.taken || 0,
        // First names only keeps the sheet social without exposing contacts
        volunteers: (cnt?.names || "")
          .split(", ")
          .filter(Boolean)
          .map((n) => n.split(" ")[0]),
      };
    }),
  });
});

/** POST /public/:slug/events/:eventId/volunteer — claim a slot */
publicRoutes.post("/:slug/events/:eventId/volunteer", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    slot_id: string;
    name?: string;
    email: string;
    phone?: string;
    note?: string;
  }>();
  if (!body.slot_id || !body.email) {
    return c.json({ error: "slot_id and email are required" }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const slot = await first<{ id: string; title: string; needed: number }>(
    c.env.DB.prepare(
      "SELECT id, title, needed FROM volunteer_slots WHERE id = ? AND tenant_id = ? AND event_id = ?"
    ).bind(body.slot_id, tenant.id, eventId)
  );
  if (!slot) return c.json({ error: "Sign-up slot not found" }, 404);

  const taken = await first<{ cnt: number }>(
    c.env.DB.prepare(
      "SELECT COUNT(*) cnt FROM volunteer_signups WHERE tenant_id = ? AND slot_id = ?"
    ).bind(tenant.id, slot.id)
  );
  const dupe = await first(
    c.env.DB.prepare(
      "SELECT id FROM volunteer_signups WHERE slot_id = ? AND email = ?"
    ).bind(slot.id, email)
  );
  if (dupe) return c.json({ error: "You have already signed up for this slot" }, 409);
  if ((taken?.cnt ?? 0) >= slot.needed) {
    return c.json({ error: "That slot is already full" }, 409);
  }

  const member = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, email)
  );
  await c.env.DB.prepare(
    `INSERT INTO volunteer_signups
     (id, tenant_id, slot_id, event_id, member_id, name, email, phone, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      generateId(), tenant.id, slot.id, eventId, member?.id ?? null,
      body.name ?? null, email, body.phone ?? null, body.note ?? null,
      new Date().toISOString()
    )
    .run();
  return c.json({ ok: true, slot: slot.title });
});

// ---------------------------------------------------------------------------
// Photo galleries (public)
// ---------------------------------------------------------------------------

/** Public galleries with photo count and cover, in display order. */
export function galleriesStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT g.id, g.slug, g.title, g.description,
              (SELECT COUNT(*) FROM gallery_photos p WHERE p.gallery_id = g.id) photo_count,
              (SELECT p.id FROM gallery_photos p WHERE p.gallery_id = g.id ORDER BY p.sort_order LIMIT 1) cover_photo_id
       FROM galleries g
       WHERE g.tenant_id = ? AND g.published = 1 AND g.is_members_only = 0
       ORDER BY g.sort_order, g.created_at DESC`
    )
    .bind(tenantId);
}

/** One public gallery by slug. */
export function galleryStatement(db: D1Database, tenantId: string, gallerySlug: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, slug, title, description FROM galleries
       WHERE tenant_id = ? AND slug = ? AND published = 1 AND is_members_only = 0`
    )
    .bind(tenantId, gallerySlug);
}

/** Photos of one gallery (by gallery id), in display order. */
export function galleryPhotosStatement(db: D1Database, tenantId: string, galleryId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, caption, credit FROM gallery_photos
       WHERE tenant_id = ? AND gallery_id = ? ORDER BY sort_order, created_at`
    )
    .bind(tenantId, galleryId);
}

publicRoutes.get("/:slug/galleries", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const rows = await all<{
    id: string;
    slug: string;
    title: string;
    description: string | null;
    photo_count: number;
    cover_photo_id: string | null;
  }>(galleriesStatement(c.env.DB, tenant.id));
  return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, galleries: rows });
});

publicRoutes.get("/:slug/galleries/:gallerySlug", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const gallery = await first<{
    id: string;
    slug: string;
    title: string;
    description: string | null;
  }>(galleryStatement(c.env.DB, tenant.id, c.req.param("gallerySlug")));
  if (!gallery) return c.json({ error: "Gallery not found" }, 404);
  const photos = await all<{ id: string; caption: string | null; credit: string | null }>(
    galleryPhotosStatement(c.env.DB, tenant.id, gallery.id)
  );
  return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, gallery, photos });
});

/** GET /public/:slug/photo/:photoId — serve a gallery image from R2 */
publicRoutes.get("/:slug/photo/:photoId", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const row = await first<{ r2_key: string; content_type: string | null; members_only: number }>(
    c.env.DB.prepare(
      `SELECT f.r2_key, f.content_type, g.is_members_only members_only
       FROM gallery_photos p
       JOIN files f ON f.id = p.file_id
       JOIN galleries g ON g.id = p.gallery_id
       WHERE p.id = ? AND p.tenant_id = ? AND g.published = 1`
    ).bind(c.req.param("photoId"), tenant.id)
  );
  if (!row || row.members_only) return c.json({ error: "Photo not found" }, 404);
  // Same reasoning as site.ts's /img/:fileId and galleries.ts's raw photo
  // route: this serves from the shared `files` table, which now also holds
  // anonymous public-intake uploads. Allowlist real raster image types and
  // 404 on anything else, plus nosniff, so a stored non-image content_type
  // can never be echoed back and executed as same-origin content.
  const contentType = row.content_type || "";
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    return c.json({ error: "Photo not found" }, 404);
  }
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "Photo data missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
