import { Hono } from "hono";
import type { Env, Member, MembershipLevel, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";
import { generateId } from "../lib/utils/id";
import { all, first } from "../lib/db";
import { activateMembership, computeMembershipEnd } from "../lib/memberships";
import {
  assertCanActivateMember,
  countActiveMembers,
  FREE_ACTIVE_MEMBER_LIMIT,
  effectivePlan,
} from "../lib/plans";
import { MAX_EXPORT_BATCH } from "../lib/pagination";
import { listMembersPage } from "../lib/membersList";

export const memberRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables & TenantVariables;
}>();

/**
 * GET /members?q=&status=&limit=&offset=&page=
 * Paginated list — required for guilds with thousands of members.
 * Response: { members, total, limit, offset, page, total_pages, has_more }
 */
memberRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const result = await listMembersPage(c.env.DB, tenant.id, {
    status: c.req.query("status") || undefined,
    q: c.req.query("q") || undefined,
    limit: c.req.query("limit") || undefined,
    offset: c.req.query("offset") || undefined,
    page: c.req.query("page") || undefined,
  });
  return c.json(result);
});

memberRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    email: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    status?: string;
  }>();
  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }
  const existing = await first(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(tenant.id, body.email.toLowerCase())
  );
  if (existing) {
    return c.json({ error: "Member with this email already exists" }, 409);
  }
  const status = body.status ?? "pending";
  if (status === "active") {
    try {
      await assertCanActivateMember(c.env.DB, tenant, null);
    } catch (e: any) {
      return c.json(
        {
          error: e.message || "Plan limit reached",
          code: e.code || "plan_limit",
        },
        e.status || 402
      );
    }
  }
  const id = generateId();
  const now = new Date().toISOString();
  const insertMemberStmt = c.env.DB.prepare(
    `INSERT INTO members
     (id, tenant_id, email, first_name, last_name, phone, status, joined_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    tenant.id,
    body.email.toLowerCase(),
    body.first_name ?? null,
    body.last_name ?? null,
    body.phone ?? null,
    status,
    now,
    now,
    now
  );

  const { prepareEvent, scheduleDispatch } = await import("../lib/webhookOutbox");
  const ev = prepareEvent(c.env, tenant.id, "member.created", {
    member_id: id,
    email: body.email.toLowerCase(),
    first_name: body.first_name ?? null,
    last_name: body.last_name ?? null,
    status,
    source: "admin",
  });
  if (!ev) {
    // Genuine schema failure: a programming error. Nothing has been written yet.
    return c.json(
      { error: "Could not record the change event; nothing was saved.",
        code: "event_prepare_failed" },
      500
    );
  }

  // Development-only failure injection so batch atomicity is provable end to
  // end. This must break the BATCH ITSELF, not short-circuit before it runs —
  // an early return here would prove nothing about atomicity (it would pass
  // just as well against the old non-atomic .run()-then-enqueue shape). So on
  // the forced-failure header, the real outbox insert is swapped for one that
  // binds NULL into the NOT NULL tenant_id column, guaranteeing the insert —
  // and with it the whole batch, member row included — fails to commit.
  const forceFail =
    c.env.ENVIRONMENT === "development" &&
    c.req.header("X-QH-Force-Outbox-Failure") === "1";
  const outboxStmt = forceFail
    ? c.env.DB.prepare(
        `INSERT INTO webhook_outbox
         (id, tenant_id, event, schema_version, payload_json, status, attempts,
          next_attempt_at, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, 'pending', 0, ?, ?, ?)`
      ).bind(ev.id, "member.created", 1, "{}", now, now, now)
    : ev.stmt;

  try {
    await c.env.DB.batch([insertMemberStmt, outboxStmt]);
  } catch (e) {
    console.error("member create: outbox batch failed, member NOT saved", e);
    return c.json(
      { error: "Could not record the change event; nothing was saved.",
        code: "event_prepare_failed" },
      500
    );
  }
  await scheduleDispatch(c.env, c.executionCtx, ev.id);

  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ? AND tenant_id = ?").bind(
      id,
      tenant.id
    )
  );
  return c.json(member, 201);
});

// GET /api/tenants/:tenantId/members/export.csv — batched for large tenants
//
// Round-trip safety (fix round 7): the `level` and `end_date` columns below
// are emitted ONLY for a membership that is currently `active`. They used to
// fall back to the member's most recent membership of ANY status
// (ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END), so a lapsed or
// cancelled member exported with the level of a membership that had already
// ended. That is not merely cosmetic: src/lib/importMapping.ts auto-maps a
// `level` header to `level_name`, and the import treats a resolved level as
// an INSTRUCTION TO ACTIVATE (it forces the member to `active` regardless of
// the Status column -- see status_overridden_by_level). Re-importing our own
// export therefore reactivated every lapsed and cancelled member on the
// roster. A dead membership's level is not a current level and must not be
// presented as one. Members with no active membership now export with those
// two cells blank; their status column still carries `lapsed`/`cancelled`,
// and their membership history remains readable in the admin UI and API.
memberRoutes.get("/export.csv", async (c) => {
  const tenant = c.get("tenant");
  type ExportRow = Member & {
    level_name: string | null;
    membership_end: string | null;
  };
  const members: ExportRow[] = [];
  let afterId = "";
  // Keyset by id in batches (stable, index-friendly)
  for (let i = 0; i < 200; i++) {
    const batch = await all<ExportRow>(
      c.env.DB.prepare(
        `SELECT mem.id, mem.email, mem.first_name, mem.last_name, mem.phone,
                mem.status, mem.joined_at, mem.notes,
                (SELECT l.name FROM memberships m
                 JOIN membership_levels l ON l.id = m.level_id
                 WHERE m.member_id = mem.id AND m.tenant_id = mem.tenant_id
                   AND m.status = 'active'
                 ORDER BY m.created_at DESC
                 LIMIT 1) as level_name,
                (SELECT m.end_date FROM memberships m
                 WHERE m.member_id = mem.id AND m.tenant_id = mem.tenant_id
                   AND m.status = 'active'
                 ORDER BY m.created_at DESC
                 LIMIT 1) as membership_end
         FROM members mem
         WHERE mem.tenant_id = ?
           AND (? = '' OR mem.id > ?)
         ORDER BY mem.id
         LIMIT ?`
      ).bind(tenant.id, afterId, afterId, MAX_EXPORT_BATCH)
    );
    if (!batch.length) break;
    members.push(...batch);
    afterId = batch[batch.length - 1].id;
    if (batch.length < MAX_EXPORT_BATCH) break;
  }
  const csvCell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header =
    "email,first_name,last_name,phone,status,joined_at,notes,level,end_date";
  const lines = members.map((m) =>
    [
      m.email,
      m.first_name,
      m.last_name,
      m.phone,
      m.status,
      m.joined_at,
      m.notes,
      m.level_name,
      m.membership_end ? String(m.membership_end).slice(0, 10) : "",
    ]
      .map(csvCell)
      .join(",")
  );
  return new Response([header, ...lines].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="members.csv"',
    },
  });
});

// GET /api/tenants/:tenantId/members/import/batches — Task 4 import history.
//
// Route-ordering note (Task 4 review, Finding B — verified empirically, not
// assumed): this is registered ABOVE GET /:memberId below, but that
// ordering is NOT currently load-bearing. Hono's :memberId param matches
// exactly one path segment; "/import/batches" is two segments, so
// /:memberId can never capture it, in either registration order — proven
// by temporarily moving both this route and the /errors route below
// /:memberId and re-running `npm run test:import`: layer 6 (including 6d,
// "ROUTE-ORDERING TRAP") still passed. So layer 6d is NOT a regression
// guard for route order; nothing in this file currently is. This route is
// still kept above /:memberId as defensive practice — a FUTURE single-
// segment literal route (there are none today) would need the same
// ordering, and getting it right by habit now costs nothing. Same note
// applies to the /import/batches/:batchId/errors route right below.
memberRoutes.get("/import/batches", async (c) => {
  const tenant = c.get("tenant");
  const rows = await all<{
    id: string; status: string; mapping_json: string | null;
    warnings_json: string | null; total_rows: number; created_count: number;
    updated_count: number; skipped_count: number; memberships_assigned: number;
    membership_failures: number; plan_limited: number; custom_fields_created: number;
    started_at: string; finished_at: string | null;
    actor_user_id: string | null; actor_email: string | null;
  }>(
    c.env.DB.prepare(
      `SELECT id, status, mapping_json, warnings_json, total_rows,
              created_count, updated_count, skipped_count,
              memberships_assigned, membership_failures, plan_limited,
              custom_fields_created, started_at, finished_at,
              actor_user_id, actor_email
       FROM import_batches
       WHERE tenant_id = ?
       ORDER BY started_at DESC
       LIMIT 50`
    ).bind(tenant.id)
  );
  // Task 4 review, Finding A: warnings_json was being fetched and then
  // never surfaced anywhere a user could see it — the exact gap
  // migrations/0017_import_batch_warnings.sql was written to close (a
  // data-carrying ignored column produces status='partial' with ZERO rows
  // in import_batch_errors, so without this a "partial" batch can be
  // completely unexplained). Parse it into a `warnings` array here so the
  // client never has to know the column is stored as JSON text.
  const batches = rows.map((b) => {
    let warnings: unknown[] = [];
    try { warnings = b.warnings_json ? JSON.parse(b.warnings_json) : []; } catch {}
    return { ...b, warnings };
  });
  return c.json({ batches });
});

// GET /api/tenants/:tenantId/members/import/batches/:batchId/errors — the
// full per-row error report for one batch (uncapped: this is what the
// admin downloads as a CSV after a migration). Route-ordering note: see
// the comment on GET /import/batches above.
memberRoutes.get("/import/batches/:batchId/errors", async (c) => {
  const tenant = c.get("tenant");
  const batchId = c.req.param("batchId");
  const batch = await first<{ id: string; warnings_json: string | null }>(
    c.env.DB.prepare(
      "SELECT id, warnings_json FROM import_batches WHERE id = ? AND tenant_id = ?"
    ).bind(batchId, tenant.id)
  );
  if (!batch) return c.json({ error: "Import batch not found" }, 404);
  const errors = await all(
    c.env.DB.prepare(
      `SELECT id, row_number, kind, reason, email, created_at
       FROM import_batch_errors
       WHERE batch_id = ? AND tenant_id = ?
       ORDER BY row_number ASC`
    ).bind(batchId, tenant.id)
  );
  // Finding A: column-level warnings (unmapped_column, duplicate_target)
  // describe a whole column, not one row, so they never appear in
  // import_batch_errors — a batch whose only loss was a data-carrying
  // ignored column would otherwise report zero errors here with nothing
  // explaining the 'partial' status. Return them alongside the row errors.
  let warnings: unknown[] = [];
  try { warnings = batch.warnings_json ? JSON.parse(batch.warnings_json) : []; } catch {}
  return c.json({ batch_id: batchId, errors, warnings, error_kind_labels: ERROR_KIND_LABELS,
    lossy_warning_codes: [...LOSSY_WARNING_CODES] });
});

memberRoutes.get("/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!member) return c.json({ error: "Not found" }, 404);
  return c.json(member);
});

// GET /api/tenants/:tenantId/members/:memberId/memberships
memberRoutes.get("/:memberId/memberships", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const member = await first(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!member) return c.json({ error: "Member not found" }, 404);
  const rows = await all(
    c.env.DB.prepare(
      `SELECT m.id, m.level_id, m.start_date, m.end_date, m.status,
              m.amount_paid_cents, m.auto_renew, m.created_at,
              l.name as level_name, l.price_cents
       FROM memberships m
       JOIN membership_levels l ON l.id = m.level_id
       WHERE m.member_id = ? AND m.tenant_id = ?
       ORDER BY m.created_at DESC
       LIMIT 50`
    ).bind(memberId, tenant.id)
  );
  return c.json(rows);
});

/**
 * POST /api/tenants/:tenantId/members/:memberId/memberships
 * Admin assigns a level (cash/check/comp/online already paid elsewhere).
 * Body: { level_id, end_date?, start_date?, amount_paid_cents?,
 *         payment_method?: "cash"|"check"|"comp"|"other"|"card_offline", note? }
 */
memberRoutes.post("/:memberId/memberships", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const body = await c.req.json<{
    level_id: string;
    start_date?: string;
    end_date?: string | null;
    amount_paid_cents?: number;
    payment_method?: string;
    note?: string;
  }>();

  if (!body.level_id) return c.json({ error: "level_id is required" }, 400);

  const member = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!member) return c.json({ error: "Member not found" }, 404);

  const level = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(body.level_id, tenant.id)
  );
  if (!level) return c.json({ error: "Level not found" }, 404);

  try {
    await assertCanActivateMember(c.env.DB, tenant, memberId);
  } catch (e: any) {
    return c.json(
      { error: e.message || "Plan limit reached", code: e.code || "plan_limit" },
      e.status || 402
    );
  }

  const now = new Date().toISOString();
  const amount =
    body.amount_paid_cents !== undefined
      ? Math.max(0, Math.floor(Number(body.amount_paid_cents)))
      : level.price_cents;

  let endDate: string | null | undefined = body.end_date;
  if (endDate === "") endDate = null;
  if (endDate) {
    // Accept YYYY-MM-DD or full ISO
    const d = new Date(endDate);
    if (Number.isNaN(d.getTime())) {
      return c.json({ error: "Invalid end_date" }, 400);
    }
    endDate = d.toISOString();
  }

  const membershipId = await activateMembership(c.env.DB, {
    tenantId: tenant.id,
    memberId,
    level,
    amountPaidCents: amount,
    now,
    startDate: body.start_date || now,
    endDate: endDate === undefined ? undefined : endDate,
    autoRenew: false,
  });

  const method = (body.payment_method || "cash").slice(0, 40);
  const note = (body.note || "").slice(0, 200);
  const description = [
    `Offline ${method}`,
    level.name,
    note,
  ]
    .filter(Boolean)
    .join(" · ");

  if (amount > 0 || method === "comp") {
    await c.env.DB.prepare(
      `INSERT INTO payments
       (id, tenant_id, member_id, type, amount_cents, currency, status,
        description, related_id, created_at, updated_at)
       VALUES (?, ?, ?, 'dues', ?, 'usd', 'succeeded', ?, ?, ?, ?)`
    )
      .bind(
        generateId(),
        tenant.id,
        memberId,
        amount,
        description,
        membershipId,
        now,
        now
      )
      .run();
  }

  const membership = await first(
    c.env.DB.prepare(
      `SELECT m.*, l.name as level_name FROM memberships m
       JOIN membership_levels l ON l.id = m.level_id
       WHERE m.id = ?`
    ).bind(membershipId)
  );
  return c.json({ ok: true, membership }, 201);
});

/** Exported so routes/v1.ts validates against the same list rather than a copy. */
export const MEMBER_STATUSES = ["pending", "active", "lapsed", "cancelled"];

memberRoutes.patch("/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const body = await c.req.json<{
    email?: string;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    status?: string;
    notes?: string | null;
    directory_visible?: boolean;
    custom_fields?: Record<string, string>;
  }>();

  const existing = await first<Member>(
    c.env.DB.prepare(
      "SELECT * FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!existing) return c.json({ error: "Member not found" }, 404);

  if (body.status && !MEMBER_STATUSES.includes(body.status)) {
    return c.json({ error: "Invalid status" }, 400);
  }
  if (body.status === "active" && existing.status !== "active") {
    try {
      await assertCanActivateMember(c.env.DB, tenant, memberId);
    } catch (e: any) {
      return c.json(
        {
          error: e.message || "Plan limit reached",
          code: e.code || "plan_limit",
        },
        e.status || 402
      );
    }
  }
  // directory_visible handled below
  if (body.email !== undefined) {
    const email = body.email.toLowerCase().trim();
    if (!email) return c.json({ error: "email cannot be empty" }, 400);
    const dupe = await first(
      c.env.DB.prepare(
        "SELECT id FROM members WHERE tenant_id = ? AND email = ? AND id != ?"
      ).bind(tenant.id, email, memberId)
    );
    if (dupe) return c.json({ error: "Another member already uses that email" }, 409);
    body.email = email;
  }

  const fields: string[] = [];
  const params: any[] = [];
  for (const key of ["email", "first_name", "last_name", "phone", "status", "notes"] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(body[key]);
    }
  }
  if (body.directory_visible !== undefined) {
    fields.push("directory_visible = ?");
    params.push(body.directory_visible ? 1 : 0);
  }
  if (body.custom_fields && typeof body.custom_fields === "object") {
    let current: Record<string, string> = {};
    try { current = JSON.parse(existing.custom_fields_json || "{}"); } catch {}
    fields.push("custom_fields_json = ?");
    params.push(JSON.stringify({ ...current, ...body.custom_fields }));
  }
  if (!fields.length) return c.json({ error: "No fields to update" }, 400);

  const patchedAt = new Date().toISOString();
  fields.push("updated_at = ?");
  params.push(patchedAt, memberId, tenant.id);
  const updateMemberStmt = c.env.DB.prepare(
    `UPDATE members SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`
  ).bind(...params);

  // Fix round 8, critical 2: THE INVARIANT. This route used to write
  // members.status and nothing else, so an admin marking someone lapsed by
  // hand left memberships.status = 'active' behind. That is not a cosmetic
  // inconsistency -- members/export.csv reports the level of a member's
  // ACTIVE membership, and the importer treats a resolved level as an
  // instruction to activate, so exporting and re-importing resurrected
  // exactly the people an admin had deliberately lapsed. Fixing the export
  // filter alone (round 7) only papered over it: any other reader of
  // "who currently holds a membership" was lying too, and the renewal cron
  // would still have counted them. `members.status` and the membership's
  // own status move together from here.
  //
  // Only the ending direction. Moving a member back to `active` must NOT
  // resurrect a membership -- there is no defensible term to give it, and
  // inventing one is the class of bug this whole task exists to remove.
  // The verbs mirror the rest of the codebase: lapsed -> the membership
  // `expired` (what renewals.ts writes), cancelled -> `cancelled` (what
  // DELETE /:memberId writes).
  //
  // Fix round 9, item 4a: `pending` belongs here too. Round 8 covered only
  // lapsed and cancelled, which left the same bug one status narrower -- a
  // pending member kept memberships.status='active', so the export still
  // emitted their level and a re-import reactivated them. `pending` means
  // "not a member yet"; holding a live membership while pending is a
  // contradiction, and it is the state the free-plan cap puts people in, so
  // it is not a rare corner. It ends the membership as `expired`: nothing
  // was cancelled, the term simply is not current.
  const endingStatus =
    body.status === "lapsed" || body.status === "pending"
      ? "expired"
      : body.status === "cancelled"
        ? "cancelled"
        : null;
  if (endingStatus) {
    await c.env.DB.batch([
      updateMemberStmt,
      c.env.DB.prepare(
        `UPDATE memberships SET status = ?, updated_at = ?
         WHERE tenant_id = ? AND member_id = ? AND status = 'active'`
      ).bind(endingStatus, patchedAt, tenant.id, memberId),
    ]);
  } else {
    await updateMemberStmt.run();
  }

  const updated = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
  );
  const { enqueueEvent } = await import("../lib/webhookOutbox");
  await enqueueEvent(c.env, c.executionCtx, tenant.id, "member.updated", {
    member_id: memberId,
    email: updated?.email ?? existing.email,
    status: updated?.status ?? existing.status,
    previous_status: existing.status,
    // Column names the caller actually changed, so a Zap can filter on them
    // without diffing the whole record.
    changed: fields
      .map((f) => f.split(" = ")[0])
      .filter((f) => f !== "updated_at"),
    source: "admin",
  });
  return c.json(updated);
});

// "Delete" = cancel; history (payments, registrations) is preserved
memberRoutes.delete("/:memberId", async (c) => {
  const tenant = c.get("tenant");
  const memberId = c.req.param("memberId");
  const existing = await first<Member>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, tenant.id)
  );
  if (!existing) return c.json({ error: "Member not found" }, 404);
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE members SET status = 'cancelled', updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(now, memberId, tenant.id),
    c.env.DB.prepare(
      "UPDATE memberships SET status = 'cancelled', updated_at = ? WHERE member_id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(now, memberId, tenant.id),
  ]);
  return c.json({ ok: true, status: "cancelled" });
});

// Fix round 4, item 5: this used to be a bare `string`, which meant a
// typo'd literal in LOSSY_WARNING_CODES silently meant "not lossy" ->
// "completed" -- a silent-drift hazard inside the very mechanism meant to
// prevent silent drift. Now every code buildWarnings can emit is listed
// here once, and both `ImportWarning.code` and `LOSSY_WARNING_CODES` are
// checked against it, so a typo or a forgotten entry is a compile error,
// not something a future review has to catch by reading carefully.
type ImportWarningCode =
  | "unmapped_column"
  | "duplicate_target"
  | "duplicate_custom_key"
  | "unparseable_date"
  | "unparseable_join_date"
  | "joined_at_ignored_on_update"
  | "invalid_status"
  | "status_overridden_by_level"
  | "level_not_found"
  | "end_date_without_level"
  | "level_without_end_date"
  | "column_count_mismatch"
  | "plan_limit_will_hold";

type ImportWarning = {
  code: ImportWarningCode;
  message: string;
  count: number;
  sample_rows: number[];
  header?: string;
};

// The single source of truth for "this warning code means a real import
// loses or silently changes something for at least one row" -- as opposed
// to a code that is purely informational. Three codes are informational
// today:
//   - plan_limit_will_hold: a dry-run ESTIMATE superseded by the real
//     import's own plan_limited counter and per-row plan_limited error rows.
//   - level_without_end_date (fix round 7): deliberately NOT lossy. NOTHING
//     FROM THE FILE IS DISCARDED -- unlike unparseable_date (the file HAD a
//     date and we could not read it) and end_date_without_level (the file
//     HAD a date and there was nowhere to put it), here the file carried no
//     renewal information at all, so there is nothing to lose. What
//     happens instead is that WE CHOOSE a renewal date (one full term of
//     the level's duration from the import date -- see computeMembershipEnd
//     in src/lib/memberships.ts), which is a decision the guild must be
//     able to see, not a loss. It is also the single most common Wild
//     Apricot migration shape (a Level column and a "Member Since" column,
//     no expiry column), so forcing `partial` on it would make `partial`
//     fire on nearly every first migration forever -- the same "admins
//     learn partial means nothing" failure that moved
//     joined_at_ignored_on_update out of this set in fix round 5.
//     Visibility is preserved in full: the code still appears in
//     `warnings` (rendered on the completed path too -- see
//     public/admin.html) and every affected row still gets a downloadable
//     import_batch_errors row naming the exact renewal date we picked.
//   - joined_at_ignored_on_update (fix round 5): moved OUT of this set.
//     It fires on nearly every UPDATE row of a routine full-roster
//     re-export (any file that carries a "Member Since" column), so
//     treating it as lossy made `partial` fire on ~100% of routine
//     re-imports forever -- exactly the "admins learn partial means
//     nothing" failure this whole task exists to prevent. It is also not
//     a real loss: members.joined_at keeps its existing (correct) value,
//     and the file's value is used as the membership start date ONLY on
//     rows that also name a level (no level -> it is not used at all)
//     (see pendingMemberships.startDate below) when a level is present.
//     Nothing is lost -- the existing record is simply authoritative over
//     a re-import's copy of the same fact. The code, the per-row error
//     rows, and the warning message all stay -- an admin can still see
//     and download exactly which rows disagreed with what's on file -- it
//     just no longer forces `partial` by itself.
//
// A real import must never report "completed" while any lossy code fired.
// To add a new lossy condition later: add its code to ImportWarningCode
// above AND to this set -- TypeScript will refuse to compile a typo'd or
// unlisted literal in either place. Nothing else needs to change -- the
// real-import status, and the `warnings` field returned to the admin, are
// both DERIVED from this set, not enumerated separately. (This is the
// FOURTH time a lossy condition buildWarnings already knew about, or
// should have, was missing from the real-import status predicate --
// level_not_found in fix round 1, unparseable_date and invalid_status in
// fix round 2, unparseable_join_date in fix round 3, and in fix round 4:
// status_overridden_by_level, joined_at_ignored_on_update, and
// end_date_without_level, all at once. Do not grow a second,
// hand-maintained list anywhere else; extend this one.)
const LOSSY_WARNING_CODES = new Set<ImportWarningCode>([
  "level_not_found",             // member imports with no membership at all
  "unparseable_date",            // membership gets a FABRICATED end date (start + level duration), not the guild's real one
  "unparseable_join_date",       // members.joined_at is stored EXACTLY AS TYPED, unvalidated -- unlike end_date there is no fallback for a non-empty bad string (insert rows only -- see joined_at_ignored_on_update for update rows)
  "invalid_status",              // Suspended/Archived rows are coerced to active -- consumes a plan slot, gets guild email
  "status_overridden_by_level",  // a VALID file status (pending/lapsed/cancelled) is overridden to active because the row also names a level -- invalid_status's check can't see this, since the status IS valid
  "end_date_without_level",      // a perfectly good renewal/expiry date is silently dropped because the row has no level to attach a membership (and its end_date) to
  "unmapped_column",             // an entire column of data is silently discarded
  "duplicate_target",            // a column's data is silently discarded (the later of two columns claiming one target)
  "column_count_mismatch",       // the row is skipped outright
  // joined_at_ignored_on_update is deliberately NOT here -- see comment above.
  // level_without_end_date is deliberately NOT here either -- see above.
]);

// Row-level error kinds (persisted to import_batch_errors, returned as
// `errors`). Overlaps with ImportWarningCode where a warning has a
// per-row downloadable counterpart, but also includes kinds that are
// purely counted by the main loop with no corresponding buildWarnings
// warning at all (skipped, membership_failed, plan_limited -- these are
// runtime/row facts, not something buildWarnings can see from the file
// content alone).
type BatchErrorKind =
  | "skipped"
  | "membership_failed"
  | "level_not_found"
  | "plan_limited"
  | "unparseable_date"
  | "unparseable_join_date"
  | "joined_at_ignored_on_update"
  | "invalid_status"
  | "status_overridden_by_level"
  | "end_date_without_level"
  | "level_without_end_date";

// Fix round 4, item 5: server-supplied so the admin UI never has to
// hand-maintain a parallel list of error kinds. `Record<BatchErrorKind,
// string>` (not `Record<string, string>`) means adding a new kind to the
// union above WITHOUT adding a label here is a compile error, not a row
// that silently vanishes from "Needs attention" and the download with no
// error anywhere -- which is exactly what happened before this map
// existed, when public/admin.html hand-filtered `errors` by kind.
const ERROR_KIND_LABELS: Record<BatchErrorKind, string> = {
  skipped: "row(s) skipped",
  membership_failed: "membership(s) failed to assign",
  level_not_found: "row(s) named a level that wasn't found",
  plan_limited: "row(s) held at the free-plan limit",
  unparseable_date: "row(s) had an unreadable renewal date",
  unparseable_join_date: 'row(s) had an unreadable "member since" date',
  joined_at_ignored_on_update: 'row(s)\' "member since" date differs from what\'s on file (kept existing value; used as the membership start date only on rows that also name a level)',
  invalid_status: "row(s) had a status not recognized (imported as active)",
  status_overridden_by_level: "row(s) had a file status overridden to active by a level",
  end_date_without_level: "row(s) had a renewal date but no level to store it against",
  level_without_end_date: "row(s) had a level but no renewal date — we chose one (see the reason for the exact date)",
};

/**
 * The end date QuiltHosting would choose for a row that gave no usable
 * renewal date, or `null` if the row's start date is unreadable (in which
 * case computeMembershipEnd throws, the activation will throw the same way,
 * and the row surfaces as `membership_failed` -- so there is no chosen date
 * to promise the guild).
 */
function safeChosenEnd(
  startDate: string,
  level: MembershipLevel,
  now = new Date().toISOString()
): string | null {
  try {
    return computeMembershipEnd(startDate, level.duration_months, now);
  } catch {
    return null;
  }
}

/**
 * Compares two date-ish strings by CALENDAR DAY (UTC), not by raw string
 * equality -- so "2019-03-02" and "3/2/2019" are recognized as the same
 * day. Returns false (treated as "different") if either fails to parse,
 * since an unparseable value is never safely "the same as" anything.
 */
function sameCalendarDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return da.toISOString().slice(0, 10) === db.toISOString().slice(0, 10);
}

/**
 * Aggregate per-row observations into one warning per code+column.
 *
 * `phase` controls tense/wording only, never which codes fire or their
 * count/sample_rows -- "preview" (the dry run, before anything is written)
 * needs future tense ("will be..."), "applied" (the real import, after
 * writing) needs to state what ACTUALLY happened, which for some codes
 * (unparseable_date, unparseable_join_date) is not simply "the opposite
 * tense of the preview sentence" but a different fact entirely: the preview
 * can only warn that a date won't parse, but the applied phase must say
 * what happened AS A RESULT (a computed fallback end date, or a raw
 * unvalidated string), because the admin is reading this after the import
 * already ran and needs to know what to go fix.
 */
function buildWarnings(args: {
  header: string[] | undefined;
  rawRows: string[][] | undefined;
  mapping: import("../lib/importMapping").ImportMapping | null;
  unmapped: Array<{ index: number; header: string }>;
  duplicates: Array<{ index: number; header: string; target: string }>;
  normalizedRows: Array<Record<string, string>>;
  levelByName: Map<string, unknown>;
  memberStatuses: string[];
  columnMismatchRows: number[];
  planWillHold: number;
  duplicateKeys: Array<{ key: string; headers: string[]; indices: number[] }>;
  phase: "preview" | "applied";
  // Lowercased, trimmed email -> that member's CURRENT joined_at (built
  // from the same lookup the route does before either branch runs). A
  // present key means the row updates an existing member (fix round 4,
  // item 2); the value lets fix round 5 tell "file's joined_at already
  // matches the record" (nothing lost) from "it genuinely differs"
  // (informational -- see joined_at_ignored_on_update).
  existingJoinedAt: Map<string, string | null>;
}): ImportWarning[] {
  const out: ImportWarning[] = [];
  const applied = args.phase === "applied";

  // Only warn about an ignored column when it actually carries data —
  // an all-empty column in the export is noise, not a loss.
  for (const u of args.unmapped) {
    const rowsWithData: number[] = [];
    (args.rawRows || []).forEach((r, i) => {
      if ((r[u.index] || "").trim() !== "") rowsWithData.push(i + 1);
    });
    if (!rowsWithData.length) continue;
    out.push({
      code: "unmapped_column",
      header: u.header,
      message: applied
        ? `"${u.header}" was not imported`
        : `"${u.header}" will not be imported`,
      count: rowsWithData.length,
      sample_rows: rowsWithData.slice(0, 3),
    });
  }

  for (const d of args.duplicates) {
    out.push({
      code: "duplicate_target",
      header: d.header,
      message: applied
        ? `"${d.header}" also matched ${d.target}; the first column won and this one was ignored`
        : `"${d.header}" also matches ${d.target}; the first column wins and this one is ignored`,
      count: 1,
      sample_rows: [],
    });
  }

  for (const d of args.duplicateKeys) {
    // duplicate_custom_key is not in LOSSY_WARNING_CODES and can never
    // reach the applied phase: the route 400s before writing anything
    // whenever duplicateKeys is non-empty, so buildWarnings is only ever
    // called with an empty duplicateKeys on the real-import path. Left
    // single-message (preview only) rather than adding dead branching.
    out.push({
      code: "duplicate_custom_key",
      message: `"${d.headers.join('" and "')}" would both import into the same custom field. Rename one column, or set one to "Do not import".`,
      count: d.indices.length,
      sample_rows: [],
    });
  }

  const badDates: number[] = [];
  const badJoinDates: number[] = [];
  const joinedAtIgnored: number[] = [];
  const badStatus: number[] = [];
  const badLevel: number[] = [];
  const statusOverridden: number[] = [];
  const endWithoutLevel: number[] = [];
  const levelWithoutEnd: number[] = [];
  args.normalizedRows.forEach((row, i) => {
    const endRaw = row.end_date || row.expiry || row.renewal_date || row.expiration || "";
    const lv = (row.level_name || row.level || "").trim();
    const hasMatchedLevel = lv !== "" && args.levelByName.has(lv.toLowerCase());
    if (endRaw) {
      if (Number.isNaN(new Date(endRaw).getTime())) badDates.push(i + 1);
      // A perfectly good date with nowhere to go: no level means no
      // membership row, and members has no end_date column of its own.
      else if (!hasMatchedLevel) endWithoutLevel.push(i + 1);
    } else if (hasMatchedLevel) {
      // The exact inverse of end_date_without_level, and the most common
      // Wild Apricot roster shape there is: a Level column, no expiry
      // column at all. A membership WILL be created and it needs an end
      // date, so QuiltHosting picks one (a full term from today -- see
      // computeMembershipEnd). Nothing from the file is lost, but the guild
      // is entitled to know we chose their renewal date for them, and to
      // see (per row, downloadable) exactly which date we chose.
      // Informational, not lossy -- see LOSSY_WARNING_CODES.
      levelWithoutEnd.push(i + 1);
    }
    const emailNorm = (row.email || "").toLowerCase().trim();
    const isUpdateRow = args.existingJoinedAt.has(emailNorm);
    if (row.joined_at) {
      if (isUpdateRow) {
        // The UPDATE statement never writes joined_at -- but if the file's
        // value already matches what's on record (by calendar day, not
        // raw string -- "2019-03-02" and "3/2/2019" are the same day),
        // nothing was actually lost by not writing it, so stay quiet. Only
        // a genuine difference is worth a (now informational, not lossy --
        // see LOSSY_WARNING_CODES) warning.
        const existing = args.existingJoinedAt.get(emailNorm);
        if (!existing || !sameCalendarDay(row.joined_at, existing)) {
          joinedAtIgnored.push(i + 1);
        }
      } else if (Number.isNaN(new Date(row.joined_at).getTime())) {
        // Unlike endRaw, joined_at has no "|| fallback" for a non-empty
        // bad string on an INSERT -- `row.joined_at || now` only
        // substitutes `now` when the field is EMPTY. An unparseable
        // joined_at on a brand-new member is bound straight into
        // members.joined_at exactly as typed.
        badJoinDates.push(i + 1);
      }
    }
    const st = (row.status || "").toLowerCase();
    if (st && !args.memberStatuses.includes(st)) badStatus.push(i + 1);
    if (lv && !hasMatchedLevel) badLevel.push(i + 1);
    // A VALID file status (pending/lapsed/cancelled -- so badStatus above
    // never fires for it) that a level will silently override to active.
    if (hasMatchedLevel && st && args.memberStatuses.includes(st) && st !== "active") {
      statusOverridden.push(i + 1);
    }
  });

  if (badDates.length)
    out.push({ code: "unparseable_date",
      message: applied
        ? "Some renewal/expiry dates could not be read; where a level was assigned, the membership end date was computed from the level's duration instead of the date in the file"
        : "Some renewal/expiry dates could not be read and will be left blank",
      count: badDates.length, sample_rows: badDates.slice(0, 3) });
  if (endWithoutLevel.length)
    out.push({ code: "end_date_without_level",
      message: applied
        ? "Some rows had a valid renewal/expiry date but no membership level, so the date was not stored"
        : "Some rows have a valid renewal/expiry date but no membership level -- the date will not be stored",
      count: endWithoutLevel.length, sample_rows: endWithoutLevel.slice(0, 3) });
  if (levelWithoutEnd.length)
    out.push({ code: "level_without_end_date",
      message: applied
        ? "Some rows named a membership level but no renewal/expiry date, so we set each of those renewal dates to one full term of the level's duration counted from today. The member's \"member since\" date is unchanged. Download the row report to see the exact date chosen for each member, and edit any that are wrong."
        : "Some rows name a membership level but no renewal/expiry date. We will set each of those renewal dates to one full term of the level's duration counted from today (the \"member since\" date, if any, is kept as the membership's start date but is not used to date the renewal -- a historical join date would otherwise produce a renewal date that has already passed).",
      count: levelWithoutEnd.length, sample_rows: levelWithoutEnd.slice(0, 3) });
  if (badJoinDates.length)
    out.push({ code: "unparseable_join_date",
      message: applied
        ? "Some \"member since\" dates could not be read; they were stored exactly as typed, without validation"
        : "Some \"member since\" dates could not be read; they will be stored exactly as typed, without validation",
      count: badJoinDates.length, sample_rows: badJoinDates.slice(0, 3) });
  if (joinedAtIgnored.length)
    // Informational, not lossy (see LOSSY_WARNING_CODES) -- nothing is
    // actually lost: the existing member keeps their recorded joined_at,
    // and the file's value is used as the membership start date ONLY on rows
    // that also name a level (no level -> it is not used at all)
    // below when a level is present. Only fires when the file's date
    // genuinely differs from what's on record (fix round 5); an unchanged
    // re-export of the same roster stays quiet.
    out.push({ code: "joined_at_ignored_on_update",
      message: applied
        ? "Some \"member since\" dates differ from what's already on file for these existing members. members.joined_at keeps its existing value; the file's value is used as the membership start date only on rows that also name a membership level"
        : "Some \"member since\" dates differ from what's already on file for these existing members. members.joined_at will keep its existing value; the file's value will be used as the membership start date only on rows that also name a membership level",
      count: joinedAtIgnored.length, sample_rows: joinedAtIgnored.slice(0, 3) });
  if (badStatus.length)
    out.push({ code: "invalid_status",
      message: applied
        ? `Some statuses are not one of: ${args.memberStatuses.join(", ")}. Those rows were imported as active.`
        : `Some statuses are not one of: ${args.memberStatuses.join(", ")}. Those rows import as active.`,
      count: badStatus.length, sample_rows: badStatus.slice(0, 3) });
  if (statusOverridden.length)
    out.push({ code: "status_overridden_by_level",
      message: applied
        ? "Some rows had a file status (pending, lapsed, or cancelled) that was overridden to active because the row also names a membership level"
        : "Some rows have a file status (pending, lapsed, or cancelled) that will be overridden to active because the row also names a membership level",
      count: statusOverridden.length, sample_rows: statusOverridden.slice(0, 3) });
  if (badLevel.length)
    out.push({ code: "level_not_found",
      message: applied
        ? "Some membership levels do not exist in this guild; those members were imported without a membership"
        : "Some membership levels do not exist in this guild; those members import without a membership",
      count: badLevel.length, sample_rows: badLevel.slice(0, 3) });
  if (args.columnMismatchRows.length)
    out.push({ code: "column_count_mismatch",
      message: applied
        ? "Some rows had a different number of columns than the header and were skipped"
        : "Some rows have a different number of columns than the header and will be skipped",
      count: args.columnMismatchRows.length,
      sample_rows: args.columnMismatchRows.slice(0, 3) });
  if (args.planWillHold > 0)
    // plan_limit_will_hold is a dry-run ESTIMATE, superseded on the applied
    // path by the real plan_limited counter -- the real-import call site
    // passes planWillHold: 0, so this branch is preview-only in practice.
    out.push({ code: "plan_limit_will_hold",
      message: `Free plan allows ${30} active members; ${args.planWillHold} row(s) will import as pending until you upgrade`,
      count: args.planWillHold, sample_rows: [] });

  return out;
}

/**
 * POST /api/tenants/:tenantId/members/import
 * Bulk upsert by email — the Wild Apricot migration path.
 * Body: { rows: [{email, first_name?, last_name?, phone?, status?, notes?,
 *                 level_name?|level?, end_date?|expiry?|renewal_date?, joined_at?}] }
 * When level_name matches a guild level, creates/replaces an active membership.
 */
memberRoutes.post("/import", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    rows?: Array<Record<string, string>>;
    header?: string[];
    raw_rows?: string[][];
    mapping?: import("../lib/importMapping").ImportMapping;
    dry_run?: boolean;
  }>();

  const usingMapping = Array.isArray(body.raw_rows);
  if (usingMapping && Array.isArray(body.rows)) {
    return c.json(
      { error: "Send either rows or raw_rows, not both", code: "ambiguous_payload" },
      400
    );
  }
  if (usingMapping && !Array.isArray(body.header)) {
    return c.json(
      { error: "raw_rows requires header", code: "missing_header" },
      400
    );
  }
  if (!usingMapping && (!Array.isArray(body.rows) || !body.rows.length)) {
    return c.json({ error: "rows array is required" }, 400);
  }

  const rowCount = usingMapping ? body.raw_rows!.length : body.rows!.length;
  if (rowCount > 5000) {
    return c.json({ error: "Max 5000 rows per import — split larger files" }, 400);
  }

  // Existing custom-field definitions, used to recognise columns the guild
  // already models.
  let existingCustomFields: Array<{ key: string; label: string }> = [];
  try {
    const t = await first<{ settings_json: string | null }>(
      c.env.DB.prepare("SELECT settings_json FROM tenants WHERE id = ?").bind(tenant.id)
    );
    existingCustomFields = JSON.parse(t?.settings_json || "{}").custom_fields || [];
  } catch { /* no settings yet */ }

  const {
    proposeMapping, applyMapping, findDuplicateCustomKeys,
  } = await import("../lib/importMapping");

  let mapping: import("../lib/importMapping").ImportMapping | null = null;
  let unmapped: Array<{ index: number; header: string }> = [];
  let duplicates: Array<{ index: number; header: string; target: string }> = [];
  let duplicateKeys: Array<{ key: string; headers: string[]; indices: number[] }> = [];
  const columnMismatchRows: number[] = [];

  // Rows in the legacy object shape; every downstream line already expects this.
  let normalizedRows: Array<Record<string, string>>;
  let customFieldsByRow: Array<Record<string, string>> = [];

  if (usingMapping) {
    const header = body.header!;
    if (body.mapping) {
      const suppliedMapping = body.mapping;
      // Build the mapping that is actually applied. A duplicate known-target
      // column must be DEMOTED to ignore here, not just reported — applyMapping
      // writes "known" entries in ascending index order, so if both entries
      // stayed "known" the later column would silently overwrite the earlier
      // one's value, the opposite of what the duplicate_target warning below
      // tells the admin ("the first column wins and this one is ignored").
      // This mirrors proposeMapping's own semantics (importMapping.ts:96-100),
      // just applied to an admin-supplied mapping instead of a proposed one.
      const effectiveMapping: import("../lib/importMapping").ImportMapping = {
        ...suppliedMapping,
      };
      // Re-derive unmapped/duplicates from the SUPPLIED mapping (not via
      // proposeMapping, which would re-propose over the admin's explicit
      // choices). setImportTarget re-POSTs the whole mapping on every edit,
      // so this must run every time or warnings for every other column
      // silently vanish the moment one column is touched.
      const seenTargets = new Set<string>();
      header.forEach((h, index) => {
        const entry = suppliedMapping[index] || { kind: "ignore" as const };
        if (entry.kind === "ignore") {
          unmapped.push({ index, header: h });
          return;
        }
        if (entry.kind === "known") {
          if (seenTargets.has(entry.target)) {
            duplicates.push({ index, header: h, target: entry.target });
            effectiveMapping[index] = { kind: "ignore" };
            // Demoted to ignore, so it is subject to the same unmapped_column
            // warning as any other ignored column when it carries data.
            unmapped.push({ index, header: h });
          } else {
            seenTargets.add(entry.target);
          }
        }
      });
      // mapping (used below for applyMapping, custom-field creation, and the
      // dry-run response) is the EFFECTIVE mapping, never the raw supplied
      // one — so a demoted duplicate can't leak back out as if the admin had
      // chosen it, and the UI re-renders it as ignored.
      mapping = effectiveMapping;
    } else {
      const proposed = proposeMapping(header, existingCustomFields);
      mapping = proposed.mapping;
      unmapped = proposed.unmapped;
      duplicates = proposed.duplicates;
    }
    // Two headers slugifying to the same custom key would otherwise have the
    // second silently overwrite the first — report it before it can happen.
    duplicateKeys = findDuplicateCustomKeys(mapping!, header);
    normalizedRows = [];
    body.raw_rows!.forEach((raw, i) => {
      if (raw.length !== header.length) {
        // A ragged row would misalign every field after the gap. Skip it
        // loudly rather than importing shifted data.
        columnMismatchRows.push(i + 1);
        normalizedRows.push({});
        customFieldsByRow.push({});
        return;
      }
      const { member, customFields } = applyMapping(raw, mapping!);
      normalizedRows.push(member);
      customFieldsByRow.push(customFields);
    });
  } else {
    normalizedRows = body.rows!;
    customFieldsByRow = normalizedRows.map(() => ({}));
  }

  // Build email map in batches (do not SELECT entire 50k-member table)
  const byEmail = new Map<string, string>();
  // Fix round 5, item 1: the existing member's CURRENT joined_at, so the
  // update path can tell "this row's joined_at is already what's on file"
  // (nothing lost, stay quiet) from "this row's joined_at genuinely
  // differs from the record" (informational -- see joined_at_ignored_on_update).
  const existingJoinedAt = new Map<string, string | null>();
  // Fix round 6: the existing member's CURRENT status, so the free-plan cap
  // accounting below can tell "this member is ALREADY active" (re-importing
  // them asks for no NEW slot and must not demote them) from "this row is
  // asking for a slot the plan doesn't have". Prefetched here with the rest
  // rather than SELECTed per row: the cap branch needs it for every
  // status=active row, and the apply loop below writes nothing until it has
  // finished, so a snapshot taken here is exactly as current as a per-row
  // read would be -- and it lets the dry-run preview answer the same
  // question, which it previously could not.
  const existingStatus = new Map<string, string>();
  // email -> the membership that member is holding right now (`endDate:
  // null` means an open-ended membership, which the renewal cron never
  // lapses because `date(end_date) < date(?)` is NULL-safe). Absent key = no
  // active membership. See the prefetch below.
  //
  // Fix round 9: this carries the whole row, not just the end date. Round 8
  // preserved `end_date` and called that "never overwrite a membership
  // already on record" -- true of one column, false of the membership.
  // activateMembership still expired the row and inserted a fresh one with
  // amount_paid_cents 0, stripe_subscription_id NULL and auto_renew 0, which
  // are exactly the columns src/lib/renewals.ts reads: a routine Level-only
  // re-import therefore converted an auto-renewing member to manual, so
  // Stripe stopped charging them, the reminder ladder started, and they
  // lapsed -- reported as `completed` with an informational code.
  type PriorMembership = {
    id: string;
    levelId: string;
    endDate: string | null;
    autoRenew: boolean;
    stripeSubscriptionId: string | null;
    amountPaidCents: number | null;
  };
  const existingActiveEnd = new Map<string, PriorMembership>();
  const emailsInFile = [
    ...new Set(
      normalizedRows
        .map((r) => (r.email || "").toLowerCase().trim())
        .filter((e) => e.includes("@"))
    ),
  ];
  for (let i = 0; i < emailsInFile.length; i += 200) {
    const slice = emailsInFile.slice(i, i + 200);
    const placeholders = slice.map(() => "?").join(",");
    const found = await all<{
      id: string; email: string; joined_at: string | null; status: string;
    }>(
      c.env.DB.prepare(
        `SELECT id, email, joined_at, status FROM members WHERE tenant_id = ? AND email IN (${placeholders})`
      ).bind(tenant.id, ...slice)
    );
    for (const m of found) {
      byEmail.set(m.email, m.id);
      existingJoinedAt.set(m.email, m.joined_at);
      existingStatus.set(m.email, m.status);
    }
    // Fix round 8, critical 1: the membership each of these members is
    // CURRENTLY holding. Round 7 taught the importer to choose a renewal
    // date when the file had none, but it asked only the file, never the
    // database -- and activateMembership expires the member's current
    // membership before writing the new one. So a guild that had imported
    // real expiry dates (memberships running to 2029) and then re-imported
    // a hand-maintained Level-only sheet had two years of paid membership
    // deleted and replaced with today+term, reported as a clean success.
    // "Nothing from the file is discarded" was true of the file and false
    // of the database. Prefetched here rather than SELECTed per row for the
    // same reason existingStatus is: the apply loop writes nothing until
    // the scan finishes, so a snapshot here is exactly as current.
    const memberIds = found.map((m) => m.id);
    for (let j = 0; j < memberIds.length; j += 200) {
      const idSlice = memberIds.slice(j, j + 200);
      const idPlaceholders = idSlice.map(() => "?").join(",");
      const ms = await all<{
        id: string; member_id: string; level_id: string; end_date: string | null;
        auto_renew: number; stripe_subscription_id: string | null;
        amount_paid_cents: number | null;
      }>(
        c.env.DB.prepare(
          `SELECT id, member_id, level_id, end_date, auto_renew,
                  stripe_subscription_id, amount_paid_cents
           FROM memberships
           WHERE tenant_id = ? AND status = 'active' AND member_id IN (${idPlaceholders})`
        ).bind(tenant.id, ...idSlice)
      );
      const emailById = new Map(found.map((m) => [m.id, m.email]));
      for (const row of ms) {
        const key = emailById.get(row.member_id);
        if (!key) continue;
        const prior = existingActiveEnd.get(key);
        // A member should only ever hold one active membership, but if the
        // data says otherwise take the most generous end date -- NULL
        // (open-ended) beats every date, and later beats earlier. Erring
        // toward preservation is the whole point of this map.
        const better =
          !prior ||
          row.end_date === null ||
          (prior.endDate !== null &&
            new Date(row.end_date).getTime() > new Date(prior.endDate).getTime());
        if (better) {
          existingActiveEnd.set(key, {
            id: row.id,
            levelId: row.level_id,
            endDate: row.end_date,
            autoRenew: row.auto_renew === 1,
            stripeSubscriptionId: row.stripe_subscription_id,
            amountPaidCents: row.amount_paid_cents,
          });
        }
      }
    }
  }

  const levels = await all<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE tenant_id = ? AND status = 'active'"
    ).bind(tenant.id)
  );
  const levelByName = new Map(
    levels.map((l) => [l.name.toLowerCase().trim(), l])
  );

  // Free plan: stop assigning new actives once the limit would be exceeded
  let activeSlotsLeft: number | null = null;
  if (effectivePlan(tenant) === "free") {
    const active = await countActiveMembers(c.env.DB, tenant.id);
    activeSlotsLeft = Math.max(0, FREE_ACTIVE_MEMBER_LIMIT - active);
  }

  // Dry run: report exactly what a real import would do, write nothing.
  if (body.dry_run) {
    const seenEmails = new Set<string>();
    let willCreate = 0, willUpdate = 0, wantNewActive = 0;
    const skipped: Array<{ row: number; reason: string }> = [];
    const sample: Array<Record<string, string>> = [];

    normalizedRows.forEach((r, idx) => {
      if (columnMismatchRows.includes(idx + 1)) {
        skipped.push({ row: idx + 1, reason: "column count does not match header" });
        return;
      }
      const email = (r.email || "").toLowerCase().trim();
      if (!email || !email.includes("@")) {
        skipped.push({ row: idx + 1, reason: "missing or invalid email" });
        return;
      }
      if (seenEmails.has(email)) {
        skipped.push({ row: idx + 1, reason: "duplicate email in file" });
        return;
      }
      seenEmails.add(email);
      byEmail.has(email) ? willUpdate++ : willCreate++;
      // Only rows that would become a NEW active count against the free
      // plan (fix round 6, same reasoning as the apply path's cap branch):
      // a member who is already active holds their slot already, and an
      // UPDATE row that expresses no status opinion at all doesn't touch
      // status. Predicting a hold for either told a guild at its cap that
      // its own unchanged roster would be demoted -- and, before the
      // apply-path fix, that prediction came true.
      //
      // Both apply-path branches have to be modelled here, because both
      // spend from the same activeSlotsLeft counter. A row naming a level
      // that RESOLVES is forced active by activateMembership no matter what
      // the Status column says (or doesn't say), so it wants a new active
      // whenever its member isn't already active -- keying this on the
      // Status column alone scored a renewal file (existing lapsed members,
      // a Level column, no Status column) as wanting nothing and predicted
      // zero holds while the import held every row. A level name that does
      // NOT resolve is level_not_found: no membership is attempted and the
      // row falls through to the status-only reading, which is why
      // resolution (levelByName), not mere presence, is the test.
      //
      // Only the TOTAL matters, so counting is enough and the apply loop's
      // row order need not be simulated: each wanting row takes a slot in
      // order until they run out, so the number held is
      // max(0, wantNewActive - activeSlotsLeft) whatever the order.
      const rawStatusPreview = (r.status || "").toLowerCase();
      const previewLevelName = (r.level_name || r.level || "").trim();
      const namesLevel = previewLevelName
        ? levelByName.has(previewLevelName.toLowerCase())
        : false;
      const opinionGiven = namesLevel || !byEmail.has(email) || !!rawStatusPreview;
      const willBeActive =
        namesLevel ||
        (MEMBER_STATUSES.includes(rawStatusPreview) ? rawStatusPreview : "active") === "active";
      if (opinionGiven && willBeActive && existingStatus.get(email) !== "active") {
        wantNewActive++;
      }
      if (sample.length < 5) {
        sample.push({
          email,
          name: [r.first_name, r.last_name].filter(Boolean).join(" "),
          action: byEmail.has(email) ? "update" : "create",
          custom: JSON.stringify(customFieldsByRow[idx] || {}),
        });
      }
    });

    // How many rows the free plan will hold below active. Skipped rows are
    // excluded too -- they never reach the cap accounting at all.
    let planWillHold = 0;
    if (activeSlotsLeft != null) {
      planWillHold = Math.max(0, wantNewActive - activeSlotsLeft);
    }

    return c.json({
      dry_run: true,
      total_rows: normalizedRows.length,
      will_create: willCreate,
      will_update: willUpdate,
      will_skip: skipped.length,
      header: body.header ?? null,
      mapping,
      unmapped,
      warnings: buildWarnings({
        header: body.header, rawRows: body.raw_rows, mapping, unmapped, duplicates,
        normalizedRows, levelByName, memberStatuses: MEMBER_STATUSES,
        columnMismatchRows, planWillHold, duplicateKeys, phase: "preview",
        existingJoinedAt,
      }),
      // Full list, not capped: the error CSV in the UI depends on it.
      skipped,
      sample,
    });
  }

  // Refuse before writing anything: two columns mapped to the same custom
  // key would otherwise have the second silently overwrite the first, with
  // no signal anywhere that a whole column of data was lost.
  if (duplicateKeys.length) {
    const detail = duplicateKeys
      .map((d) => `"${d.headers.join('" and "')}"`)
      .join("; ");
    return c.json(
      {
        error:
          `Two or more columns map to the same custom field: ${detail}. ` +
          `Rename one column, or set one to "Do not import".`,
        code: "duplicate_custom_key",
        duplicates: duplicateKeys,
      },
      400
    );
  }

  // Additive only: append definitions for custom targets the guild does not
  // already have. Never rename, reorder, or remove — an import must not be
  // able to corrupt an existing schema.
  const customFieldsCreated: Array<{ key: string; label: string }> = [];
  if (usingMapping && mapping) {
    const takenKeys = new Set(existingCustomFields.map((f) => f.key));
    const next = [...existingCustomFields];
    for (const entry of Object.values(mapping)) {
      if (entry.kind !== "custom") continue;
      if (takenKeys.has(entry.key)) continue;
      takenKeys.add(entry.key);
      const def = { key: entry.key, label: entry.label };
      next.push(def);
      customFieldsCreated.push(def);
    }
    if (customFieldsCreated.length) {
      const t = await first<{ settings_json: string | null }>(
        c.env.DB.prepare("SELECT settings_json FROM tenants WHERE id = ?").bind(tenant.id)
      );
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(t?.settings_json || "{}"); } catch {}
      settings.custom_fields = next;
      await c.env.DB.prepare(
        "UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?"
      ).bind(JSON.stringify(settings), new Date().toISOString(), tenant.id).run();
    }
  }

  const now = new Date().toISOString();
  let created = 0,
    updated = 0,
    skipped = 0,
    membershipsAssigned = 0,
    membershipFailures = 0,
    levelNotFound = 0,
    planLimited = 0;
  // Same shape and same reason strings as the dry run — Task 5's error-CSV
  // download depends on this matching.
  const skippedRows: Array<{ row: number; reason: string }> = [];
  // Row-level errors of every kind, persisted to import_batch_errors below
  // and returned as `errors` so a partial import names exactly what was
  // lost — not just how many rows.
  const batchErrors: Array<{
    row_number: number;
    kind: BatchErrorKind;
    reason: string;
    email: string | null;
  }> = [];
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  // After batch inserts, assign memberships (need member ids)
  const pendingMemberships: Array<{
    memberId: string;
    level: MembershipLevel;
    endDate?: string;
    // The renewal date QuiltHosting chose for this row because the file
    // named a level but gave no expiry date at all. Non-null means the
    // guild is owed a level_without_end_date row saying which date we
    // picked -- emitted only once the activation succeeds, so we never
    // claim a renewal date for a membership that was never created.
    chosenEnd?: string | null;
    // The membership this member is holding right now, as of the prefetch
    // (absent = they have none). Fix round 8, critical 1: consulted before
    // any computed date is written, so a Level-only re-import can never
    // shorten or erase a membership already on record. Fix round 9, item 1:
    // widened from just the end date to the whole row, so the billing
    // columns survive too -- and so an unchanged row can be left alone.
    priorActiveEnd?: PriorMembership;
    startDate?: string;
    rowNumber: number;
    email: string;
  }> = [];

  // Development-only failure injection so the batch/error reporting can be
  // proven end to end, following the same pattern as
  // X-QH-Force-Outbox-Failure above: the env check is evaluated FIRST and
  // short-circuits before the client-controlled header is even read, so in
  // production this header does not exist as far as the code is concerned.
  const forceMembershipFail =
    c.env.ENVIRONMENT === "development" &&
    c.req.header("X-QH-Force-Membership-Failure") === "1";
  // Same pattern again: proves the whole-batch-open-to-close try/catch
  // below (which closes the batch as 'failed' on any throw) is actually
  // exercised, not just present in the source.
  const forceBatchFail =
    c.env.ENVIRONMENT === "development" &&
    c.req.header("X-QH-Force-Import-Batch-Failure") === "1";

  // Open the batch before any member statement executes. Everything from
  // here to the closing UPDATE below is wrapped in try/catch: a throw
  // anywhere in that span (a constraint violation in the member INSERT
  // batch, a failed row lookup, the error-row insert itself) is caught,
  // closes this record as status='failed' with whatever counts are known,
  // and rethrows — so it never sits at 'running' forever with no
  // reconciliation, which is what would otherwise happen (Task 4's history
  // page would show it as permanently in-flight).
  const batchId = generateId();
  // Task 4 review, Finding C: capture the actor at import time, not via a
  // live join to users.email — a live join would show a DIFFERENT email a
  // year later if the account's email changed, or go blank if the user was
  // since deleted. actor_email is a snapshot; actor_user_id is the durable
  // id kept alongside it for any future audit need.
  const actor = c.get("user");
  await c.env.DB.prepare(
    `INSERT INTO import_batches
     (id, tenant_id, status, mapping_json, total_rows, started_at,
      actor_user_id, actor_email)
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`
  )
    .bind(
      batchId,
      tenant.id,
      mapping ? JSON.stringify(mapping) : null,
      normalizedRows.length,
      now,
      actor?.id ?? null,
      actor?.email ?? null
    )
    .run();

  // Records a skipped row in both places that need it: the legacy
  // skipped_rows list (Task 5's error-CSV depends on this shape) and the
  // persisted batch_errors, which is where membership_failed rows also land.
  function pushSkip(rowNumber: number, reason: string, email: string | null) {
    skippedRows.push({ row: rowNumber, reason });
    batchErrors.push({ row_number: rowNumber, kind: "skipped", reason, email });
  }

  // Run the SAME detection buildWarnings uses for the dry-run preview, on
  // the real import too. This is what actually closes the exhaustiveness
  // gap: a condition buildWarnings already knows to warn about can no
  // longer disagree with what the real import reports, because the real
  // import now asks buildWarnings directly instead of maintaining its own
  // parallel (and repeatedly incomplete) list of what counts as lossy.
  // planWillHold is passed as 0 -- it is a dry-run ESTIMATE of how many
  // active-status rows the free-plan cap will hold back; the real import
  // below counts plan-limiting exactly, row by row, and reports it via
  // planLimited + plan_limited error rows instead, so including the
  // estimate here would just be a second, staler number for the same fact.
  const warnings = buildWarnings({
    header: body.header, rawRows: body.raw_rows, mapping, unmapped, duplicates,
    normalizedRows, levelByName, memberStatuses: MEMBER_STATUSES,
    columnMismatchRows, planWillHold: 0, duplicateKeys, phase: "applied",
    existingJoinedAt,
  });
  const lossyWarningFired = warnings.some((w) => LOSSY_WARNING_CODES.has(w.code));

  try {
    for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex++) {
      const row = normalizedRows[rowIndex];
      if (columnMismatchRows.includes(rowIndex + 1)) {
        skipped++;
        pushSkip(rowIndex + 1, "column count does not match header", null);
        continue;
      }
      const email = (row.email || "").toLowerCase().trim();
      if (!email || !email.includes("@")) {
        skipped++;
        pushSkip(rowIndex + 1, "missing or invalid email", email || null);
        continue;
      }
      if (seen.has(email)) {
        skipped++;
        pushSkip(rowIndex + 1, "duplicate email in file", email);
        continue;
      }
      seen.add(email);
      const rowCustom = customFieldsByRow[rowIndex] || {};
      const hasCustom = Object.keys(rowCustom).length > 0;
      const rawStatus = (row.status || "").toLowerCase();
      const status = MEMBER_STATUSES.includes(rawStatus) ? rawStatus : "active";
      if (rawStatus && !MEMBER_STATUSES.includes(rawStatus)) {
        // Same predicate buildWarnings uses for "invalid_status" below --
        // a status the guild's export used (Suspended, Archived, ...) that
        // isn't one QuiltHosting recognizes gets silently coerced to
        // active, which consumes a free-plan slot and starts sending guild
        // email. That coercion is unchanged by this fix; what's new is that
        // it's now visible and downloadable instead of only ever appearing
        // in the dry-run preview.
        batchErrors.push({
          row_number: rowIndex + 1,
          kind: "invalid_status",
          reason: `status "${row.status}" is not one of: ${MEMBER_STATUSES.join(", ")}; row was imported as active`,
          email,
        });
      }

      // This row's email already exists in D1 (from before this import
      // started -- a duplicate email within the same file is already
      // skipped above, so no earlier row in this same run could have
      // created it), so this row will UPDATE, not INSERT. joined_at (right
      // below) and status (further down, fix round 4 item 4) both behave
      // differently on update vs. insert.
      const isUpdate = byEmail.has(email);

      if (row.joined_at) {
        if (isUpdate) {
          // The UPDATE statement below has no joined_at column at all --
          // an existing member's joined_at is never touched by an import,
          // valid date or not. Fix round 5: only worth a signal when the
          // file's date genuinely differs (by calendar day, not raw
          // string) from what's already on record -- an unchanged
          // re-export of the same roster must stay quiet, or `partial`
          // fires on ~100% of a routine re-import's updated rows forever.
          // Also reclassified as INFORMATIONAL (see LOSSY_WARNING_CODES):
          // nothing is actually lost -- the existing record is
          // authoritative, and the file's value is still used as the
          // membership start date below when a level is present.
          const existingJoined = existingJoinedAt.get(email);
          if (!existingJoined || !sameCalendarDay(row.joined_at, existingJoined)) {
            batchErrors.push({
              row_number: rowIndex + 1,
              kind: "joined_at_ignored_on_update",
              reason: `"member since" date "${row.joined_at}" differs from what's on file (${existingJoined ?? "none"}); members.joined_at keeps its existing value. The file's value is used as the membership start date only if this row also names a membership level; otherwise it is not used at all`,
              email,
            });
          }
        } else if (Number.isNaN(new Date(row.joined_at).getTime())) {
          // Same predicate buildWarnings uses for "unparseable_join_date"
          // below. Unlike endRaw further down, there is no fallback for a
          // non-empty bad string on an INSERT -- `row.joined_at || now`
          // only substitutes `now` when the field is EMPTY, so this exact
          // string is bound straight into members.joined_at with zero
          // validation. That storage behavior is unchanged by this fix --
          // what's new is that it's surfaced instead of silent. (It was
          // previously masked whenever the row also named a level:
          // activateMembership's `new Date(startDate).toISOString()`
          // throws a RangeError on this same bad string, surfacing only as
          // an opaque membership_failed reason; rows with no level got no
          // signal at all.)
          batchErrors.push({
            row_number: rowIndex + 1,
            kind: "unparseable_join_date",
            reason: `"member since" date "${row.joined_at}" could not be read; it was stored exactly as typed, without validation`,
            email,
          });
        }
      }

      const levelName = (row.level_name || row.level || "").trim();
      const level = levelName
        ? levelByName.get(levelName.toLowerCase())
        : undefined;
      if (levelName && !level) {
        // The guild named a level -- a typo, trailing punctuation, or one
        // they've since archived (levelByName only holds status='active'
        // levels) -- but it matched nothing. The member below is still
        // created; no membership is ever attempted for this row. Previously
        // the only signal was a dry-run-only warning, so a real import with
        // a misspelled Level column produced N members, zero memberships,
        // and a "completed" response.
        levelNotFound++;
        batchErrors.push({
          row_number: rowIndex + 1,
          kind: "level_not_found",
          reason: `level "${levelName}" does not match any active membership level`,
          email,
        });
      }
      const endRaw = row.end_date || row.expiry || row.renewal_date || row.expiration || "";
      let endDate: string | undefined;
      // Set when this row names a real level but the file carried no
      // renewal/expiry date, so QuiltHosting chose one. Reported per row
      // only if the activation succeeds -- see the else-if branch below.
      let chosenEndForRow: string | null = null;
      if (endRaw) {
        const d = new Date(endRaw);
        if (!Number.isNaN(d.getTime())) {
          endDate = d.toISOString();
          if (!level) {
            // A perfectly good date, but this row has no level -- either
            // none was named, or the named one didn't match (level_not_found
            // above). There is nowhere to store it: members has no end_date
            // column, and (see below) no membership row is created without
            // a level. Silently dropped today; this makes that visible.
            batchErrors.push({
              row_number: rowIndex + 1,
              kind: "end_date_without_level",
              reason: `renewal/expiry date "${endRaw}" was provided but this row has no membership level, so it could not be stored`,
              email,
            });
          }
        } else {
          // Same predicate buildWarnings uses for "unparseable_date" below.
          // This is not merely a lost date: when `level` is set,
          // activateMembership computes endDate from the level's
          // duration_months instead, so the member gets a SUBSTITUTED
          // expiry -- which then drives renewal reminders and lapse on a
          // schedule the guild never asked for. That computed-fallback
          // behavior is unchanged by this fix; what's new is that it's
          // surfaced instead of silent.
          batchErrors.push({
            row_number: rowIndex + 1,
            kind: "unparseable_date",
            reason: `renewal/expiry date "${endRaw}" could not be read; the membership end date (if any) was computed from the level's duration instead`,
            email,
          });
          // Fix round 8, doc item 4: `endDate` stays undefined here, so this
          // row lands on exactly the same chosen-date fallback as a row with
          // no date column at all -- but the `else if (level)` below is
          // unreachable when endRaw is truthy, so it used to get NO record of
          // which date was chosen. An unreadable date is strictly worse than
          // a missing one (the guild believes they supplied one), so it needs
          // the disclosure more, not less.
          if (level) chosenEndForRow = safeChosenEnd(row.joined_at || now, level, now);
        }
      } else if (level) {
        // The inverse of end_date_without_level, and the shape a real Wild
        // Apricot migration almost always has: a Level column and no expiry
        // column anywhere in the file. A membership IS created for this row
        // and it needs an end date, so computeMembershipEnd picks one -- a
        // full term from today. Nothing from the file is lost (there was no
        // date in it to lose), which is why level_without_end_date is NOT in
        // LOSSY_WARNING_CODES; but choosing a guild's renewal date on their
        // behalf and saying nothing is how a roster quietly lapses, so name
        // the exact date we picked, per row, downloadable.
        //
        // Recorded, not pushed: the per-row error is only emitted once the
        // activation below actually SUCCEEDS (see the pendingMemberships
        // loop). A row whose membership failed, or that never got one, must
        // not be told "your renewal date was set to X" -- that would be a
        // claim about a membership that does not exist.
        chosenEndForRow = safeChosenEnd(row.joined_at || now, level, now);
      }

      if (level && status !== "active") {
        // The file explicitly said this member's status is `status`
        // (pending, lapsed, or cancelled -- a VALID MEMBER_STATUS, so
        // invalid_status's check above never fires for it), but naming a
        // level here means activateMembership will force status to
        // 'active' below regardless. Do NOT change this coercion --
        // activating on a level is existing, intentional behavior (a
        // renewal or signup with payment) -- but it consumes a free-plan
        // slot and starts sending guild email exactly like invalid_status
        // does. Make the override visible.
        batchErrors.push({
          row_number: rowIndex + 1,
          kind: "status_overridden_by_level",
          reason: `status "${status}" in the file was overridden to active because the row names level "${levelName}"`,
          email,
        });
      }

      // For an UPDATE row with no status opinion at all (the Status
      // column absent from the file entirely, or blank for this row), the
      // row says nothing about status and must not touch it -- not the
      // free-plan cap accounting below, not the final write. Previously
      // importStatus defaulted straight to "active" whenever rawStatus was
      // empty, insert or update alike, so a routine re-import that simply
      // omitted the Status column silently reactivated every lapsed and
      // cancelled member -- data corruption from a routine action.
      // Inserts are unaffected: a brand-new member with no status given
      // still defaults to active, exactly as before.
      const statusOpinionGiven = !isUpdate || !!rawStatus;

      // Cap free-plan actives when importing status=active without a level
      let importStatus = level ? "pending" : status;
      if (
        statusOpinionGiven &&
        !level &&
        importStatus === "active" &&
        activeSlotsLeft != null
      ) {
        // Ask FIRST whether this member is already active. A member who is
        // already active consumes no NEW slot -- re-importing them asks the
        // plan for nothing -- so the exhausted check below must not apply to
        // them. Fix round 6: this lookup used to live only in the `else`
        // (slots available) branch, so a free guild sitting exactly at the
        // limit started every import with activeSlotsLeft === 0 and demoted
        // its ENTIRE roster from active to pending on a re-import of its own
        // unchanged file -- the mirror image of the round-4 bug where a
        // re-import that OMITTED the Status column reactivated every lapsed
        // member. The level-naming branch below has always asked this
        // question (see its alreadyActive lookup) and never had the defect.
        const wasActive = existingStatus.get(email) === "active";
        if (wasActive) {
          // No slot spent (they already hold one), no demotion, and
          // deliberately NOT counted as plan_limited: nothing is being
          // denied them and nothing needs the guild's attention. Counting
          // them would also make a clean, fully-converged re-import report
          // 'partial' forever, since the status predicate treats
          // plan_limited > 0 as partial -- exactly the "partial on ~100% of
          // routine re-imports" failure mode round 5 fixed for
          // joined_at_ignored_on_update.
        } else if (activeSlotsLeft <= 0) {
          importStatus = "pending";
          planLimited++;
          // This row named no level (a plain status=active row), but it is
          // just as much a "held back, needs the guild's attention" row as
          // the level-naming one below -- and until now only THAT one was
          // downloadable. Both plan-limited sites push the same error kind
          // so the guild can find and re-import all of them together.
          batchErrors.push({
            row_number: rowIndex + 1,
            kind: "plan_limited",
            reason: `held at the free-plan limit (${FREE_ACTIVE_MEMBER_LIMIT} active members) -- imported as pending instead of active`,
            email,
          });
        } else {
          activeSlotsLeft--;
        }
      }

      let memberId = byEmail.get(email);
      if (memberId) {
        let mergedCustomJson: string | null = null;
        if (hasCustom) {
          const cur = await first<{ custom_fields_json: string | null }>(
            c.env.DB.prepare(
              "SELECT custom_fields_json FROM members WHERE id = ? AND tenant_id = ?"
            ).bind(memberId, tenant.id)
          );
          let existingVals: Record<string, string> = {};
          try { existingVals = JSON.parse(cur?.custom_fields_json || "{}"); } catch {}
          // Incoming values win; anything the guild typed by hand is preserved.
          mergedCustomJson = JSON.stringify({ ...existingVals, ...rowCustom });
        }
        stmts.push(
          c.env.DB.prepare(
            `UPDATE members SET
               first_name = coalesce(?, first_name), last_name = coalesce(?, last_name),
               phone = coalesce(?, phone), notes = coalesce(?, notes),
               status = coalesce(?, status),
               custom_fields_json = coalesce(?, custom_fields_json),
               updated_at = ?
             WHERE id = ?`
          ).bind(
            row.first_name || null,
            row.last_name || null,
            row.phone || null,
            row.notes || null,
            // Force status only when the row expressed a real opinion: a
            // level (which drives status via activateMembership instead --
            // see status_overridden_by_level above), or an explicit status
            // the file gave (statusOpinionGiven). Otherwise bind null so
            // coalesce(?, status) leaves the existing member's status
            // untouched.
            level ? null : (statusOpinionGiven ? importStatus : null),
            mergedCustomJson,
            now,
            memberId
          )
        );
        // Fix round 8, critical 2: the same invariant PATCH /:memberId now
        // enforces. A status-only row that ends someone's membership must
        // end the MEMBERSHIP too, not just flip members.status -- otherwise
        // memberships.status stays 'active', the export still reports their
        // level, and the next re-import of that export reactivates them.
        // Only on rows with no level (a level goes through
        // activateMembership, which expires prior actives itself) and only
        // when the file actually expressed the status.
        // `pending` is included for the same reason PATCH includes it (fix
        // round 9, item 4a) -- but ONLY when the file said so. A row held
        // back by the free-plan cap also lands on importStatus "pending",
        // and ending an existing member's membership because our plan limit
        // bit would be a demotion the guild never asked for; that path is
        // excluded because it only ever applies where `level` is falsy AND
        // the file expressed a status, and the cap rewrites importStatus for
        // rows whose file status was `active`, not pending.
        const endsMembership =
          importStatus === "lapsed" ||
          importStatus === "cancelled" ||
          (importStatus === "pending" && rawStatus === "pending");
        if (!level && statusOpinionGiven && endsMembership) {
          stmts.push(
            c.env.DB.prepare(
              `UPDATE memberships SET status = ?, updated_at = ?
               WHERE tenant_id = ? AND member_id = ? AND status = 'active'`
            ).bind(
              importStatus === "cancelled" ? "cancelled" : "expired",
              now,
              tenant.id,
              memberId
            )
          );
        }
        updated++;
      } else {
        // No per-row member.created here: a 500-row import would write 500 outbox
        // rows and 500 queue sends inside one invocation. A members.import.completed
        // summary event is planned (see wildapricot-master-program.md Phase 3).
        memberId = generateId();
        byEmail.set(email, memberId);
        stmts.push(
          c.env.DB.prepare(
            `INSERT INTO members (id, tenant_id, email, first_name, last_name, phone, notes, status, custom_fields_json, joined_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            memberId,
            tenant.id,
            email,
            row.first_name || null,
            row.last_name || null,
            row.phone || null,
            row.notes || null,
            importStatus, // activateMembership flips to active when level set
            hasCustom ? JSON.stringify(rowCustom) : "{}",
            row.joined_at || now,
            now,
            now
          )
        );
        created++;
      }

      if (level && memberId) {
        if (activeSlotsLeft != null) {
          // Count only members who aren't already active toward the free
          // limit. Reads the same tenant-filtered existingStatus prefetch the
          // no-level branch uses (fix round 6 review): this was a per-row
          // `SELECT status FROM members WHERE id = ?` with no tenant_id
          // filter, and it answered exactly the question the prefetch
          // already answers. A member INSERTed earlier in this same run is
          // absent from the map and reads as not-already-active, which is
          // what the old query returned too -- the statements are still
          // queued, so it could not have seen them either.
          if (existingStatus.get(email) !== "active") {
            if (activeSlotsLeft <= 0) {
              // Unlike the no-level plan-limited branch above, this row DID
              // name a real level -- it must be recorded so
              // memberships_assigned + membership_failures + these
              // plan-limited rows accounts for every row naming a real
              // level. Otherwise a free-plan cap silently breaks that
              // invariant with no per-row record of who was held back.
              planLimited++;
              batchErrors.push({
                row_number: rowIndex + 1,
                kind: "plan_limited",
                reason: `held at the free-plan limit (${FREE_ACTIVE_MEMBER_LIMIT} active members) -- membership not assigned`,
                email,
              });
              continue;
            }
            activeSlotsLeft--;
          }
        }
        pendingMemberships.push({
          memberId,
          level,
          endDate,
          chosenEnd: chosenEndForRow,
          priorActiveEnd: existingActiveEnd.get(email),
          startDate: row.joined_at || undefined,
          rowNumber: rowIndex + 1,
          email,
        });
      }
    }

    if (forceBatchFail && stmts.length) {
      // Binds NULL into the NOT NULL members.tenant_id column, guaranteeing
      // this D1 batch (atomic — see the outbox-failure comment on the
      // single-member POST route above) fails to commit, so the crash path
      // below is exercised for real rather than merely present in the code.
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO members (id, tenant_id, email, status, joined_at, created_at, updated_at)
           VALUES (?, NULL, ?, 'active', ?, ?, ?)`
        ).bind(generateId(), "forced-batch-failure@example.test", now, now, now)
      );
    }

    for (let i = 0; i < stmts.length; i += 50) {
      await c.env.DB.batch(stmts.slice(i, i + 50));
    }

    for (const pm of pendingMemberships) {
      try {
        // Forced-failure injection (dev only, see forceMembershipFail above):
        // point activation at a level id that cannot exist so the INSERT trips
        // the real FOREIGN KEY constraint on memberships.level_id — the same
        // failure mode a genuine data problem would produce, not a fake
        // short-circuit that would pass even against the old unguarded code.
        const level = forceMembershipFail
          ? { ...pm.level, id: "qh-forced-invalid-level-id" }
          : pm.level;

        // ---- Fix round 8, critical 1: never write over a membership that
        // is already better than the one we would compute. activateMembership
        // expires the member's current membership before inserting the new
        // one and consults nothing, so this is the only place the question
        // can be asked. The rule, in order:
        //
        //   1. The file gave a usable date  -> the file wins, always. (One
        //      refinement: if it names the SAME CALENDAR DAY as the stored
        //      end date, keep the stored instant. Our own export truncates
        //      end_date to YYYY-MM-DD, so a plain round trip would otherwise
        //      re-parse as UTC midnight and quietly move every expiry
        //      earlier by its time of day.)
        //   2. No usable date, and the member holds a membership ending
        //      LATER than the term we would compute -- or an OPEN-ENDED one
        //      (end_date IS NULL, which the renewal cron never lapses) ->
        //      keep what they have.
        //   3. Otherwise -> use the computed term. When that replaces an
        //      EARLIER end date it is a renewal/extension, not a loss, and
        //      the per-row record names both dates.
        //
        // Deliberately NOT pushed down into activateMembership: this rule is
        // right for an import row, which merely ASSERTS membership, and
        // wrong for a payment (routes/webhooks.ts, and the admin's manual
        // assignment), where a member who buys another year while holding
        // one must get the extra year rather than have it swallowed.
        const prior = pm.priorActiveEnd;
        let finalEnd: string | null | undefined = pm.endDate;
        let disclosure: string | null = null;
        if (pm.endDate !== undefined) {
          if (prior && prior.endDate && sameCalendarDay(pm.endDate, prior.endDate)) {
            finalEnd = prior.endDate;
          }
        } else if (pm.chosenEnd) {
          // Compared as instants, not strings: a stored end_date may be a
          // bare "YYYY-MM-DD" (seed data, an older write) while the computed
          // one is a full ISO timestamp, and lexicographic order lies about
          // those two on the same day.
          const priorTime = prior && prior.endDate ? new Date(prior.endDate).getTime() : NaN;
          const priorWins =
            !!prior &&
            (prior.endDate === null ||
              (!Number.isNaN(priorTime) && priorTime > new Date(pm.chosenEnd).getTime()));
          if (priorWins) {
            finalEnd = prior!.endDate;
            disclosure =
              prior!.endDate === null
                ? `the file gave no renewal/expiry date we could use. This member already had an open-ended membership (no renewal date), so it was kept as is rather than being given a ${pm.level.duration_months || 12}-month term`
                : `the file gave no renewal/expiry date we could use. This member's existing renewal date of ${prior!.endDate.slice(0, 10)} is later than the ${pm.level.duration_months || 12}-month term we would have set (${pm.chosenEnd.slice(0, 10)}), so the existing date was KEPT and nothing was shortened`;
          } else {
            finalEnd = pm.chosenEnd;
            // Fix round 9, item 2: this was `pm.startDate > now`, a
            // LEXICOGRAPHIC compare on the RAW FILE VALUE. For any non-ISO
            // but parseable join date ("3/2/2019", "March 2, 2019") the
            // string test is true, so the reason read "set to 2027-08-11
            // (12 months from 3/2/2019)" -- internally contradictory, and it
            // re-asserted to the guild the exact join-date-drives-the-term
            // belief this whole task exists to kill. The stored data was
            // always right (computeMembershipEnd does real Date math); only
            // the disclosure lied, which is the worse place for it. Compare
            // instants, and print the RESOLVED base, not the raw cell.
            const startTime = pm.startDate ? new Date(pm.startDate).getTime() : NaN;
            const base =
              !Number.isNaN(startTime) && startTime > new Date(now).getTime()
                ? new Date(startTime).toISOString()
                : now;
            disclosure =
              `the file gave no renewal/expiry date we could use, so the renewal date was set to ${pm.chosenEnd.slice(0, 10)} (${pm.level.duration_months || 12} month(s) from ${base.slice(0, 10)}, the "${pm.level.name}" term)` +
              // Fix round 10, item 4a: gated on STRICTLY earlier, not merely
              // `prior`. priorWins above needs `>`, so an end date equal to
              // the computed one to the millisecond falls into this branch --
              // where it is also a no-op (same level, same end date), so the
              // row wrote nothing and "this row renewed them" was false.
              // Practically unreachable, but a disclosure that is wrong in
              // the rare case is worse than one that stays quiet.
              (prior &&
              prior.endDate &&
              new Date(prior.endDate).getTime() < new Date(pm.chosenEnd).getTime()
                ? `, replacing an earlier one of ${prior.endDate.slice(0, 10)} -- this row renewed them`
                : "") +
              `. The "member since" date is unchanged. Edit this member if that date is wrong`;
          }
        }

        // ---- Fix round 9, item 1: re-asserting a membership must not
        // strip it. Round 8 preserved `end_date` and stopped there; the
        // INSERT still hardcoded amount_paid_cents 0, stripe_subscription_id
        // NULL and auto_renew 0 -- the exact columns src/lib/renewals.ts
        // reads to decide who gets charged and who gets the reminder ladder.
        // So the very workflow our admin guide recommends silently
        // unsubscribed every auto-renewing member on the roster.
        //
        // Two changes, and the first is the shape fix:
        //
        //   NO-OP. A row that asserts what is already true changes nothing.
        //   If the member already holds an active membership at this level
        //   with this end date, leave the row completely alone -- no expire,
        //   no insert. Beyond keeping the billing columns intact by
        //   construction, this stops the ledger churning: every re-import
        //   used to expire one row and insert another, so a guild
        //   re-importing 500 members five times accumulated 2,500 membership
        //   rows, four of them dead, per member.
        //
        //   CARRY FORWARD. When something DID change (a new level, a new
        //   term), the billing relationship still belongs to the member, not
        //   to the term: auto_renew and stripe_subscription_id move to the
        //   new row. amount_paid_cents moves only when the term is unchanged
        //   -- it records what was paid for THIS term, so copying it onto a
        //   NEW term would invent a payment that never happened.
        const sameEnd =
          (finalEnd ?? null) === null
            ? (prior?.endDate ?? null) === null
            : prior?.endDate != null &&
              new Date(finalEnd as string).getTime() === new Date(prior.endDate).getTime();
        const unchanged = !!prior && prior.levelId === level.id && sameEnd;

        if (unchanged) {
          // Still make sure the member themself reads as active: an import
          // row naming a level asserts membership, and a member holding an
          // active membership while flagged pending/lapsed is the very
          // inconsistency fix round 8 went after from the other side.
          if (existingStatus.get(pm.email) !== "active") {
            await c.env.DB.prepare(
              "UPDATE members SET status = 'active', updated_at = ? WHERE id = ? AND tenant_id = ?"
            )
              .bind(now, pm.memberId, tenant.id)
              .run();
          }
        } else {
          await activateMembership(c.env.DB, {
            tenantId: tenant.id,
            memberId: pm.memberId,
            level,
            amountPaidCents: (prior && sameEnd && prior.amountPaidCents) || 0,
            now,
            startDate: pm.startDate,
            endDate: finalEnd,
            stripeSubscriptionId: prior ? prior.stripeSubscriptionId : null,
            autoRenew: prior ? prior.autoRenew : false,
          });
        }
        membershipsAssigned++;
        if (disclosure) {
          // The membership really exists now, so we can truthfully say what
          // happened to its renewal date (fix round 7, corrected in round 8).
          // Informational, not a loss -- see LOSSY_WARNING_CODES -- but it is
          // a decision made on the guild's behalf, so it is itemized per row
          // and lands in the downloadable report like any other.
          batchErrors.push({
            row_number: pm.rowNumber,
            kind: "level_without_end_date",
            reason: disclosure,
            email: pm.email,
          });
        }
      } catch (e) {
        // Previously this was console.warn only, so a member could be created
        // without their membership and the import still reported clean success.
        // NOTE (known limitation, not fixed here): if pm corresponds to an
        // EXISTING active member being re-imported, expireActiveMemberships
        // inside activateMembership already ran and expired their prior
        // membership before this INSERT failed -- so a re-import that trips
        // this catch can leave a previously-active member with NO active
        // membership at all, which is worse than "not assigned". The row
        // still surfaces here as membership_failed either way.
        membershipFailures++;
        batchErrors.push({
          row_number: pm.rowNumber,
          kind: "membership_failed",
          reason: (e as Error)?.message?.slice(0, 300) || "membership assignment failed",
          email: pm.email,
        });
      }
    }

    // completed only when nothing was lost. The hand-counted conditions
    // (skipped, membership failures, plan-limited, level-not-found) are
    // kept because they carry information the warnings array doesn't
    // (exact counts, downloadable per-row errors) -- but `lossyWarningFired`
    // is the actual fix: it derives from LOSSY_WARNING_CODES/buildWarnings,
    // so any lossy condition buildWarnings knows about (now or added
    // later) forces partial even if nobody remembered to also hand-count
    // it here.
    const status =
      skippedRows.length === 0 &&
      membershipFailures === 0 &&
      planLimited === 0 &&
      levelNotFound === 0 &&
      !lossyWarningFired
        ? "completed"
        : "partial";

    const errorStmts: D1PreparedStatement[] = batchErrors.map((be) =>
      c.env.DB.prepare(
        `INSERT INTO import_batch_errors
         (id, batch_id, tenant_id, row_number, kind, reason, email)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(generateId(), batchId, tenant.id, be.row_number, be.kind, be.reason, be.email)
    );
    for (let i = 0; i < errorStmts.length; i += 50) {
      await c.env.DB.batch(errorStmts.slice(i, i + 50));
    }

    const finishedAt = new Date().toISOString();
    // Persist the warnings array too -- unmapped_column and duplicate_target
    // derive status='partial' with no accompanying import_batch_errors row
    // (they describe a whole column, not one row), so without this a
    // history page reading import_batches later would show a stored
    // 'partial' batch with nothing explaining why.
    const warningsJson = warnings.length ? JSON.stringify(warnings) : null;
    await c.env.DB.prepare(
      `UPDATE import_batches SET
         status = ?, created_count = ?, updated_count = ?, skipped_count = ?,
         memberships_assigned = ?, membership_failures = ?, plan_limited = ?,
         custom_fields_created = ?, warnings_json = ?, finished_at = ?
       WHERE id = ? AND tenant_id = ?`
    )
      .bind(
        status,
        created,
        updated,
        skipped,
        membershipsAssigned,
        membershipFailures,
        planLimited,
        customFieldsCreated.length,
        warningsJson,
        finishedAt,
        batchId,
        tenant.id
      )
      .run();

    return c.json({
      ok: true,
      batch_id: batchId,
      status,
      created,
      updated,
      skipped,
      memberships_assigned: membershipsAssigned,
      membership_failures: membershipFailures,
      level_not_found: levelNotFound,
      plan_limited: planLimited,
      custom_fields_created: customFieldsCreated,
      skipped_rows: skippedRows,
      errors: batchErrors,
      warnings,
      // Fix round 4, item 5: lets the admin UI itemize `errors` generically
      // (group by kind, look up the label) instead of hand-writing a
      // filter per kind -- see ERROR_KIND_LABELS above for why this can't
      // silently fall out of sync with BatchErrorKind.
      error_kind_labels: ERROR_KIND_LABELS,
      // Fix round 8, important 3: the client must be able to tell an
      // INFORMATIONAL warning from a lossy one. public/admin.html used to
      // approximate that with `warnings.length === 0`, which was fine until
      // level_without_end_date started firing on every Level-column file --
      // then a free guild at its cap saw "Import finished with problems" for
      // a file with nothing wrong with it, contradicting both admin guides.
      // Published from the same Set the server derives `status` from, for
      // exactly the reason error_kind_labels is: a second hand-maintained
      // copy in the client is how these drift.
      lossy_warning_codes: [...LOSSY_WARNING_CODES],
    });
  } catch (e) {
    // Whatever went wrong (a constraint violation in the member statement
    // batch, a failed lookup, the error-row insert itself), the batch must
    // not be left at 'running' forever with nothing to reconcile it. Close
    // it as 'failed' with whatever counts are known, best-effort, then
    // rethrow so the existing error response (Hono's default 500) is
    // unchanged.
    try {
      await c.env.DB.prepare(
        `UPDATE import_batches SET
           status = 'failed', created_count = ?, updated_count = ?, skipped_count = ?,
           memberships_assigned = ?, membership_failures = ?, plan_limited = ?,
           custom_fields_created = ?, warnings_json = ?, finished_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
        .bind(
          created,
          updated,
          skipped,
          membershipsAssigned,
          membershipFailures,
          planLimited,
          customFieldsCreated.length,
          warnings.length ? JSON.stringify(warnings) : null,
          new Date().toISOString(),
          batchId,
          tenant.id
        )
        .run();
    } catch (closeErr) {
      console.error("import batch: failed to mark batch as failed", batchId, closeErr);
    }
    throw e;
  }
});
