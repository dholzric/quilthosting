import { Hono } from "hono";
import type { Env, Event, MembershipLevel, Member, Tenant } from "../types";
import { all, first } from "../lib/db";
import { buildIcs, icsResponse } from "../lib/ical";
import { generateId, generateTicketCode } from "../lib/utils/id";
import { createCheckoutSession } from "../lib/stripe";
import { sendEmail, welcomeEmail, eventConfirmationEmail } from "../lib/email";
import { formatMoney } from "../lib/utils/money";
import { activateMembership, portalUrl } from "../lib/memberships";
import { assertCanActivateMember } from "../lib/plans";
import { rateLimit } from "../middleware/rateLimit";
import {
  parseEventSettings,
  validateAnswers,
} from "../lib/eventQuestions";
import { getTenantByHost, tenantPublicBaseUrl } from "../lib/tenantHost";
import { readTenantTheme, deriveLegacyTheme } from "../lib/site/themeMigrate";
import { escapeHtml } from "../lib/blocks";
import { computeEstimate } from "../lib/projects/pricing";
import { mintAccessToken, hashToken } from "../lib/projects/token";
import { buildReference } from "../lib/projects/reference";
import { PROJECT_TYPES } from "../lib/projects/types";
import type { ProjectType, LongarmRates } from "../lib/projects/types";
import { sniffImageType } from "../lib/projects/imageSniff";

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
      // The row commits BEFORE any email is attempted. A Resend outage must
      // never lose a customer's submission.
      await c.env.DB.prepare(
        `INSERT INTO projects
           (id, tenant_id, project_type, status, reference, customer_name, customer_email,
            customer_phone, intake_json, subtotal_cents, total_cents,
            access_token_hash, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id, tenant.id, projectType, reference, name, email,
          String(body.customer_phone || "").slice(0, 50) || null,
          JSON.stringify(sanitizedIntake),
          ballpark.suppressed ? 0 : ballpark.subtotalCents,
          ballpark.suppressed ? 0 : ballpark.totalCents,
          tokenHash, expires, now, now
        )
        .run();
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

  if (!ballpark.suppressed) {
    for (let i = 0; i < ballpark.lines.length; i++) {
      const l = ballpark.lines[i];
      await c.env.DB.prepare(
        `INSERT INTO project_lines
           (id, project_id, kind, description, quantity, unit_cents, amount_cents, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(generateId(), id, l.kind, l.description, l.quantity, l.unitCents, l.amountCents, i).run();
    }
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

  const fileIds: string[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      return c.json({ error: "Each photo must be under 10MB" }, 400);
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const contentType = sniffImageType(buf);
    if (!contentType) {
      return c.json({ error: "Photos must be PNG, JPEG, GIF, WebP or AVIF" }, 400);
    }
    const fileId = generateId();
    const key = `${tenant.id}/${fileId}/${file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)}`;
    await c.env.FILES.put(key, buf);
    await c.env.DB.prepare(
      `INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(fileId, tenant.id, key, file.name.slice(0, 200), contentType, buf.byteLength)
      .run();
    fileIds.push(fileId);
  }

  // Bind the photos to the project by appending to intake_json rather than
  // adding a table: they are intake data, and intake_json is where
  // type-varying intake data lives.
  const row = await first<{ intake_json: string }>(
    c.env.DB.prepare(`SELECT intake_json FROM projects WHERE id = ? AND tenant_id = ?`)
      .bind(project.id, tenant.id)
  );
  let intake: Record<string, unknown> = {};
  try { intake = JSON.parse(row?.intake_json || "{}"); } catch { intake = {}; }
  const existing = Array.isArray(intake.photoFileIds) ? intake.photoFileIds : [];
  intake.photoFileIds = [...existing, ...fileIds].slice(0, MAX_FILES);
  await c.env.DB.prepare(
    `UPDATE projects SET intake_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
  ).bind(JSON.stringify(intake), new Date().toISOString(), project.id, tenant.id).run();

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
publicRoutes.get("/:slug/levels", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const levels = await all<MembershipLevel>(
    c.env.DB.prepare(
      `SELECT id, name, description, price_cents, duration_months, benefits_json, sort_order
       FROM membership_levels
       WHERE tenant_id = ? AND status = 'active' AND is_public = 1
       ORDER BY sort_order, name`
    ).bind(tenant.id)
  );

  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    levels,
  });
});

// GET /public/:slug/events
publicRoutes.get("/:slug/events", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  // ?month=YYYY-MM returns that whole month (for calendar views);
  // default stays "next 50 upcoming".
  const month = c.req.query("month");
  let events: Event[];
  if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    events = await all<Event>(
      c.env.DB.prepare(
        `SELECT id, title, description, location, start_at, end_at,
                member_price_cents, non_member_price_cents, capacity, registration_open,
                settings_json
         FROM events
         WHERE tenant_id = ? AND is_public = 1
           AND substr(start_at, 1, 7) = ?
         ORDER BY start_at ASC
         LIMIT 200`
      ).bind(tenant.id, month)
    );
  } else {
    events = await all<Event>(
      c.env.DB.prepare(
        `SELECT id, title, description, location, start_at, end_at,
                member_price_cents, non_member_price_cents, capacity, registration_open,
                settings_json
         FROM events
         WHERE tenant_id = ? AND is_public = 1 AND start_at >= datetime('now')
         ORDER BY start_at ASC
         LIMIT 50`
      ).bind(tenant.id)
    );
  }

  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    events: events.map((e) => ({
      ...e,
      questions: parseEventSettings(e.settings_json).questions || [],
    })),
  });
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

  // Free membership — activate immediately
  if (level.price_cents === 0) {
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
    });

    const { subject, html } = welcomeEmail({
      guildName: tenant.name,
      firstName: member.first_name ?? undefined,
      portalUrl: portalUrl(c.env.APP_URL, tenant.slug),
    });
    await sendEmail(c.env, { to: email, subject, html });
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
    amountCents: level.price_cents,
    description: `${tenant.name} – ${level.name} Membership`,
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

  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const event = await first<Event>(
    c.env.DB.prepare(
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

  // Member pricing is decided server-side: only active members qualify
  const memberRow = await first<{ id: string; status: string }>(
    c.env.DB.prepare(
      "SELECT id, status FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, email)
  );
  const memberId = memberRow?.id ?? null;
  const priceCents =
    memberRow?.status === "active"
      ? event.member_price_cents
      : event.non_member_price_cents;

  // Capacity check — hold seats for pending Stripe checkouts too
  if (event.capacity) {
    const countRow = await first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM event_registrations
         WHERE event_id = ? AND tenant_id = ? AND status IN ('registered', 'checked_in', 'pending_payment')`
      ).bind(eventId, tenant.id)
    );
    const current = countRow?.cnt ?? 0;
    if (current >= event.capacity) {
      if (event.waitlist_enabled) {
        // Fall through to waitlist
      } else {
        return c.json({ error: "Event is full" }, 400);
      }
    }
  }

  // Already registered?
  const existing = await first(
    c.env.DB.prepare(
      `SELECT id FROM event_registrations
       WHERE event_id = ? AND tenant_id = ? AND email = ?
         AND status IN ('registered', 'waitlist', 'checked_in')`
    ).bind(eventId, tenant.id, email)
  );
  if (existing) {
    return c.json({ error: "Already registered for this event" }, 409);
  }

  const now = new Date().toISOString();
  const regId = generateId();
  const ticketCode = generateTicketCode("EV");

  // Determine status (waitlist if full) — count pending_payment so paid seats are held
  let status = "registered";
  if (event.capacity) {
    const countRow = await first<{ cnt: number }>(
      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM event_registrations
         WHERE event_id = ? AND tenant_id = ? AND status IN ('registered', 'checked_in', 'pending_payment')`
      ).bind(eventId, tenant.id)
    );
    if ((countRow?.cnt ?? 0) >= event.capacity && event.waitlist_enabled) {
      status = "waitlist";
    } else if ((countRow?.cnt ?? 0) >= event.capacity) {
      return c.json({ error: "Event is full" }, 400);
    }
  }

  // Free or waitlist — register immediately
  if (priceCents === 0 || status === "waitlist") {
    const insertRegStmt = c.env.DB.prepare(
      `INSERT INTO event_registrations
       (id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents, ticket_code, custom_answers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).bind(
      regId,
      tenant.id,
      eventId,
      memberId,
      email,
      body.name ?? null,
      status,
      ticketCode,
      answersJson,
      now,
      now
    );

    {
      const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
      const ev = prepareEvent(c.env, tenant.id, "event.registration", {
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
        await c.env.DB.batch([insertRegStmt, ev.stmt]);
      } catch (e) {
        console.error(
          "event registration: outbox batch failed, registration NOT saved",
          e
        );
        return c.json(
          {
            error: "Could not record the change event; nothing was saved.",
            code: "event_prepare_failed",
          },
          500
        );
      }
      await scheduleDispatch(c.env, c.executionCtx, ev.id);
    }

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
    }

    return c.json({
      status,
      registration_id: regId,
      ticket_code: ticketCode,
      message:
        status === "waitlist"
          ? "Added to waitlist"
          : "Registered successfully",
    });
  }

  // Paid registration — Stripe Checkout
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  // Drop any stale unpaid attempt for this email so retries aren't blocked
  await c.env.DB.prepare(
    `DELETE FROM event_registrations
     WHERE event_id = ? AND tenant_id = ? AND email = ? AND status = 'pending_payment'`
  )
    .bind(eventId, tenant.id, email)
    .run();

  // Held as pending_payment until the Stripe webhook confirms payment
  await c.env.DB.prepare(
    `INSERT INTO event_registrations
     (id, tenant_id, event_id, member_id, email, name, status, amount_paid_cents, ticket_code, custom_answers_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', 0, ?, ?, ?, ?)`
  )
    .bind(
      regId,
      tenant.id,
      eventId,
      memberId,
      email,
      body.name ?? null,
      ticketCode,
      answersJson,
      now,
      now
    )
    .run();

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
    });
  } catch (err) {
    await c.env.DB.prepare(
      "DELETE FROM event_registrations WHERE id = ? AND tenant_id = ?"
    )
      .bind(regId, tenant.id)
      .run();
    console.error("Checkout session failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }

  return c.json({
    status: "checkout",
    checkout_url: session.url,
    session_id: session.id,
    registration_id: regId,
    ticket_code: ticketCode,
  });
});

// GET /public/:slug/pages — published public pages (no members-only; not blog posts)
publicRoutes.get("/:slug/pages", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  const { contentFromPage } = await import("../lib/blocks");
  try {
    const rows = await all<{
      slug: string;
      title: string;
      content_json: string;
      blocks_json?: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT slug, title, content_json, blocks_json FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(page_type, 'page') = 'page'
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      pages: rows.map((p) => ({
        slug: p.slug,
        title: p.title,
        html: contentFromPage(p).html,
      })),
    });
  } catch {
    const rows = await all<{ slug: string; title: string; content_json: string }>(
      c.env.DB.prepare(
        `SELECT slug, title, content_json FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      pages: rows.map((p) => ({
        slug: p.slug,
        title: p.title,
        html: (JSON.parse(p.content_json || "{}").html as string) || "",
      })),
    });
  }
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
publicRoutes.get("/:slug/products", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  try {
    const rows = await all<{
      id: string;
      name: string;
      description: string | null;
      price_cents: number;
      inventory: number | null;
    }>(
      c.env.DB.prepare(
        `SELECT id, name, description, price_cents, inventory FROM products
         WHERE tenant_id = ? AND is_active = 1
           AND (inventory IS NULL OR inventory > 0)
         ORDER BY sort_order, name`
      ).bind(tenant.id)
    );
    return c.json({
      tenant: { name: tenant.name, slug: tenant.slug },
      products: rows,
    });
  } catch {
    return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, products: [] });
  }
});

/**
 * POST /public/:slug/products/:productId/buy
 */
publicRoutes.post("/:slug/products/:productId/buy", async (c) => {
  const slug = c.req.param("slug");
  const productId = c.req.param("productId");
  const tenant = await getTenantBySlug(c.env.DB, slug);
  if (!tenant) return c.json({ error: "Guild not found" }, 404);

  const product = await first<{
    id: string;
    name: string;
    price_cents: number;
    inventory: number | null;
    is_active: number;
  }>(
    c.env.DB.prepare(
      "SELECT * FROM products WHERE id = ? AND tenant_id = ?"
    ).bind(productId, tenant.id)
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

  if (product.price_cents === 0) {
    // Free item — record payment-like fulfillment and decrement stock
    const now = new Date().toISOString();
    if (product.inventory !== null) {
      await c.env.DB.prepare(
        `UPDATE products SET inventory = inventory - ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND inventory >= ?`
      )
        .bind(qty, now, product.id, tenant.id, qty)
        .run();
    }
    let memberId: string | null = null;
    const member = await first<{ id: string }>(
      c.env.DB.prepare(
        "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
      ).bind(tenant.id, email)
    );
    memberId = member?.id ?? null;
    await c.env.DB.prepare(
      `INSERT INTO payments
       (id, tenant_id, member_id, type, amount_cents, currency, status, description, related_id, created_at, updated_at)
       VALUES (?, ?, ?, 'store', 0, 'usd', 'succeeded', ?, ?, ?, ?)`
    )
      .bind(
        generateId(),
        tenant.id,
        memberId,
        `${product.name} × ${qty} (free)`,
        product.id,
        now,
        now
      )
      .run();
    return c.json({
      status: "fulfilled",
      message: `You're all set — ${product.name} is free.`,
    });
  }

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
  }

  let memberId: string | undefined;
  const member = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, email)
  );
  memberId = member?.id;

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const amount = product.price_cents * qty;
  try {
    const session = await createCheckoutSession(c.env, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      memberId,
      email,
      name: body.name,
      amountCents: amount,
      description:
        qty > 1
          ? `${tenant.name} – ${product.name} × ${qty}`
          : `${tenant.name} – ${product.name}`,
      type: "store",
      relatedId: product.id,
      quantity: qty,
      successUrl: `${baseUrl}/g/${tenant.slug}?purchased=1`,
      cancelUrl: `${baseUrl}/g/${tenant.slug}?cancelled=1`,
      mode: "payment",
      stripeAccountId: tenant.stripe_account_id,
    });
    return c.json({
      status: "checkout",
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error("Store checkout failed", err);
    return c.json({ error: "Payment session could not be created" }, 502);
  }
});

/**
 * GET /public/:slug/info — guild profile for the public page:
 * description, contact, links, join custom fields, logo.
 */
publicRoutes.get("/:slug/info", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  let settings: any = {};
  try { settings = JSON.parse(tenant.settings_json || "{}"); } catch {}
  const profile = settings.profile || {};
  const joinFields = (settings.custom_fields || []).filter(
    (f: any) => f && f.key && f.show_on_join
  );
  const logoUrl = profile.logo_file_id
    ? `/public/${tenant.slug}/logo`
    : null;
  return c.json({
    tenant: { name: tenant.name, slug: tenant.slug },
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
  });
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
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type || "image/png",
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
        `SELECT id, first_name, last_name, bio, photo_file_id, showcase_json FROM members
         WHERE tenant_id = ? AND status = 'active'
           AND coalesce(directory_visible, 1) = 1
         ORDER BY last_name, first_name LIMIT 500`
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
        `SELECT first_name, last_name FROM members
         WHERE tenant_id = ? AND status = 'active'
           AND coalesce(directory_visible, 1) = 1
         ORDER BY last_name, first_name LIMIT 500`
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
      `SELECT id FROM members WHERE tenant_id = ? AND photo_file_id = ?
         AND coalesce(directory_visible, 1) = 1 AND status = 'active'`
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
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

/** Site theme + nav for public guild page */
publicRoutes.get("/:slug/site", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  let settings: any = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {}
  let navPages: Array<{ slug: string; title: string; nav_label: string | null }> = [];
  try {
    navPages = await all(
      c.env.DB.prepare(
        `SELECT slug, title, nav_label FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(show_in_nav, 1) = 1 AND coalesce(page_type, 'page') = 'page'
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
  } catch {
    navPages = [];
  }
  const taxRateBps = Number(settings.store?.tax_rate_bps || 0) || 0;
  const { theme: tokens, fonts } = readTenantTheme(tenant.settings_json);
  return c.json({
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
  });
});

/** Blog posts (public pages with page_type=blog_post) */
publicRoutes.get("/:slug/blog", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant) return c.json({ error: "Guild not found" }, 404);
  try {
    const posts = await all(
      c.env.DB.prepare(
        `SELECT slug, title, content_json, blocks_json, updated_at, created_at
         FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(page_type, 'page') = 'blog_post'
         ORDER BY created_at DESC LIMIT 50`
      ).bind(tenant.id)
    );
    const { contentFromPage } = await import("../lib/blocks");
    return c.json({
      posts: posts.map((p: any) => ({
        slug: p.slug,
        title: p.title,
        html: contentFromPage(p).html,
        updated_at: p.updated_at,
        created_at: p.created_at,
      })),
    });
  } catch {
    return c.json({ posts: [] });
  }
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
  return c.json({ ok: true, id }, 201);
});

/**
 * POST /public/:slug/cart/checkout — multi-SKU cart with tax
 */
publicRoutes.post("/:slug/cart/checkout", async (c) => {
  const slug = c.req.param("slug");
  const tenant = await getTenantBySlug(c.env.DB, slug);
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

  const cartLines: Array<{
    product_id: string;
    name: string;
    quantity: number;
    unit_cents: number;
    taxable: boolean;
    line_cents: number;
  }> = [];

  for (const raw of body.items.slice(0, 20)) {
    const product = await first<{
      id: string;
      name: string;
      price_cents: number;
      inventory: number | null;
      is_active: number;
      taxable?: number;
    }>(
      c.env.DB.prepare(
        `SELECT * FROM products WHERE id = ? AND tenant_id = ?`
      ).bind(raw.product_id, tenant.id)
    );
    if (!product || !product.is_active) {
      return c.json({ error: `Product not found: ${raw.product_id}` }, 400);
    }
    const qty = Math.min(20, Math.max(1, Math.floor(Number(raw.quantity) || 1)));
    if (product.inventory !== null && qty > product.inventory) {
      return c.json({ error: `Only ${product.inventory} left of ${product.name}` }, 400);
    }
    cartLines.push({
      product_id: product.id,
      name: product.name,
      quantity: qty,
      unit_cents: product.price_cents,
      taxable: product.taxable !== 0,
      line_cents: product.price_cents * qty,
    });
  }

  const subtotal = cartLines.reduce((s, l) => s + l.line_cents, 0);
  const taxableBase = cartLines
    .filter((l) => l.taxable)
    .reduce((s, l) => s + l.line_cents, 0);
  const taxCents = Math.floor((taxableBase * taxRateBps) / 10000);
  const total = subtotal + taxCents;

  const orderId = generateId();
  const now = new Date().toISOString();
  let memberId: string | undefined;
  const member = await first<{ id: string }>(
    c.env.DB.prepare(
      `SELECT id FROM members WHERE tenant_id = ? AND email = ?`
    ).bind(tenant.id, email)
  );
  memberId = member?.id;

  await c.env.DB.prepare(
    `INSERT INTO store_orders
     (id, tenant_id, member_id, email, status, subtotal_cents, tax_cents, total_cents, items_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      orderId,
      tenant.id,
      memberId ?? null,
      email,
      subtotal,
      taxCents,
      total,
      JSON.stringify(cartLines),
      now,
      now
    )
    .run();

  if (total === 0) {
    await c.env.DB.prepare(
      `UPDATE store_orders SET status = 'paid', updated_at = ? WHERE id = ?`
    )
      .bind(now, orderId)
      .run();
    for (const l of cartLines) {
      await c.env.DB.prepare(
        `UPDATE products SET inventory = inventory - ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND inventory IS NOT NULL AND inventory >= ?`
      )
        .bind(l.quantity, now, l.product_id, tenant.id, l.quantity)
        .run();
    }
    return c.json({ status: "fulfilled", order_id: orderId, message: "Order complete (free)." });
  }

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments not configured" }, 503);
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
      memberId,
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
    });
    await c.env.DB.prepare(
      `UPDATE store_orders SET stripe_session_id = ?, updated_at = ? WHERE id = ?`
    )
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
    });
  } catch (err) {
    console.error("Cart checkout failed", err);
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
  }>(
    c.env.DB.prepare(
      `SELECT g.id, g.slug, g.title, g.description,
              (SELECT COUNT(*) FROM gallery_photos p WHERE p.gallery_id = g.id) photo_count,
              (SELECT p.id FROM gallery_photos p WHERE p.gallery_id = g.id ORDER BY p.sort_order LIMIT 1) cover_photo_id
       FROM galleries g
       WHERE g.tenant_id = ? AND g.published = 1 AND g.is_members_only = 0
       ORDER BY g.sort_order, g.created_at DESC`
    ).bind(tenant.id)
  );
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
  }>(
    c.env.DB.prepare(
      `SELECT id, slug, title, description FROM galleries
       WHERE tenant_id = ? AND slug = ? AND published = 1 AND is_members_only = 0`
    ).bind(tenant.id, c.req.param("gallerySlug"))
  );
  if (!gallery) return c.json({ error: "Gallery not found" }, 404);
  const photos = await all<{ id: string; caption: string | null; credit: string | null }>(
    c.env.DB.prepare(
      `SELECT id, caption, credit FROM gallery_photos
       WHERE tenant_id = ? AND gallery_id = ? ORDER BY sort_order, created_at`
    ).bind(tenant.id, gallery.id)
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
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: "Photo data missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
});
