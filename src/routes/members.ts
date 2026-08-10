import { Hono } from "hono";
import type { Env, Member, MembershipLevel, TenantVariables } from "../types";
import { generateId } from "../lib/utils/id";
import { all, first } from "../lib/db";
import { activateMembership } from "../lib/memberships";
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
  Variables: TenantVariables;
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
                 ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.created_at DESC
                 LIMIT 1) as level_name,
                (SELECT m.end_date FROM memberships m
                 WHERE m.member_id = mem.id AND m.tenant_id = mem.tenant_id
                 ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.created_at DESC
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

  fields.push("updated_at = ?");
  params.push(new Date().toISOString(), memberId, tenant.id);
  await c.env.DB.prepare(
    `UPDATE members SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`
  )
    .bind(...params)
    .run();

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

type ImportWarning = {
  code: string;
  message: string;
  count: number;
  sample_rows: number[];
  header?: string;
};

/** Aggregate per-row observations into one warning per code+column. */
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
}): ImportWarning[] {
  const out: ImportWarning[] = [];

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
      message: `"${u.header}" will not be imported`,
      count: rowsWithData.length,
      sample_rows: rowsWithData.slice(0, 3),
    });
  }

  for (const d of args.duplicates) {
    out.push({
      code: "duplicate_target",
      header: d.header,
      message: `"${d.header}" also matches ${d.target}; the first column wins and this one is ignored`,
      count: 1,
      sample_rows: [],
    });
  }

  for (const d of args.duplicateKeys) {
    out.push({
      code: "duplicate_custom_key",
      message: `"${d.headers.join('" and "')}" would both import into the same custom field. Rename one column, or set one to "Do not import".`,
      count: d.indices.length,
      sample_rows: [],
    });
  }

  const badDates: number[] = [];
  const badStatus: number[] = [];
  const badLevel: number[] = [];
  args.normalizedRows.forEach((row, i) => {
    const endRaw = row.end_date || row.expiry || row.renewal_date || row.expiration || "";
    if (endRaw && Number.isNaN(new Date(endRaw).getTime())) badDates.push(i + 1);
    const st = (row.status || "").toLowerCase();
    if (st && !args.memberStatuses.includes(st)) badStatus.push(i + 1);
    const lv = (row.level_name || row.level || "").trim();
    if (lv && !args.levelByName.has(lv.toLowerCase())) badLevel.push(i + 1);
  });

  if (badDates.length)
    out.push({ code: "unparseable_date",
      message: "Some renewal/expiry dates could not be read and will be left blank",
      count: badDates.length, sample_rows: badDates.slice(0, 3) });
  if (badStatus.length)
    out.push({ code: "invalid_status",
      message: `Some statuses are not one of: ${args.memberStatuses.join(", ")}. Those rows import as active.`,
      count: badStatus.length, sample_rows: badStatus.slice(0, 3) });
  if (badLevel.length)
    out.push({ code: "level_not_found",
      message: "Some membership levels do not exist in this guild; those members import without a membership",
      count: badLevel.length, sample_rows: badLevel.slice(0, 3) });
  if (args.columnMismatchRows.length)
    out.push({ code: "column_count_mismatch",
      message: "Some rows have a different number of columns than the header and will be skipped",
      count: args.columnMismatchRows.length,
      sample_rows: args.columnMismatchRows.slice(0, 3) });
  if (args.planWillHold > 0)
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
    const found = await all<{ id: string; email: string }>(
      c.env.DB.prepare(
        `SELECT id, email FROM members WHERE tenant_id = ? AND email IN (${placeholders})`
      ).bind(tenant.id, ...slice)
    );
    for (const m of found) byEmail.set(m.email, m.id);
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
    let willCreate = 0, willUpdate = 0;
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
      if (sample.length < 5) {
        sample.push({
          email,
          name: [r.first_name, r.last_name].filter(Boolean).join(" "),
          action: byEmail.has(email) ? "update" : "create",
          custom: JSON.stringify(customFieldsByRow[idx] || {}),
        });
      }
    });

    // How many rows the free plan will hold below active.
    let planWillHold = 0;
    if (activeSlotsLeft != null) {
      const wantActive = normalizedRows.filter(
        (r) => ((r.status || "active").toLowerCase() === "active")
      ).length;
      planWillHold = Math.max(0, wantActive - activeSlotsLeft);
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
        columnMismatchRows, planWillHold, duplicateKeys,
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
    return c.json(
      {
        error: "Two or more columns map to the same custom field.",
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
    planLimited = 0;
  // Same shape and same reason strings as the dry run — Task 5's error-CSV
  // download depends on this matching.
  const skippedRows: Array<{ row: number; reason: string }> = [];
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  // After batch inserts, assign memberships (need member ids)
  const pendingMemberships: Array<{
    memberId: string;
    level: MembershipLevel;
    endDate?: string;
    startDate?: string;
  }> = [];

  for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex++) {
    const row = normalizedRows[rowIndex];
    if (columnMismatchRows.includes(rowIndex + 1)) {
      skipped++;
      skippedRows.push({ row: rowIndex + 1, reason: "column count does not match header" });
      continue;
    }
    const email = (row.email || "").toLowerCase().trim();
    if (!email || !email.includes("@")) {
      skipped++;
      skippedRows.push({ row: rowIndex + 1, reason: "missing or invalid email" });
      continue;
    }
    if (seen.has(email)) {
      skipped++;
      skippedRows.push({ row: rowIndex + 1, reason: "duplicate email in file" });
      continue;
    }
    seen.add(email);
    const rowCustom = customFieldsByRow[rowIndex] || {};
    const hasCustom = Object.keys(rowCustom).length > 0;
    const status = MEMBER_STATUSES.includes((row.status || "").toLowerCase())
      ? (row.status || "").toLowerCase()
      : "active";

    const levelName = (row.level_name || row.level || "").trim();
    const level = levelName
      ? levelByName.get(levelName.toLowerCase())
      : undefined;
    const endRaw = row.end_date || row.expiry || row.renewal_date || row.expiration || "";
    let endDate: string | undefined;
    if (endRaw) {
      const d = new Date(endRaw);
      if (!Number.isNaN(d.getTime())) endDate = d.toISOString();
    }

    // Cap free-plan actives when importing status=active without a level
    let importStatus = level ? "pending" : status;
    if (
      !level &&
      importStatus === "active" &&
      activeSlotsLeft != null
    ) {
      if (activeSlotsLeft <= 0) {
        importStatus = "pending";
        planLimited++;
      } else {
        const existingId = byEmail.get(email);
        let wasActive = false;
        if (existingId) {
          const cur = await first<{ status: string }>(
            c.env.DB.prepare("SELECT status FROM members WHERE id = ?").bind(
              existingId
            )
          );
          wasActive = cur?.status === "active";
        }
        if (!wasActive) activeSlotsLeft--;
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
          // Only force status when no level will set active via membership
          level ? null : importStatus,
          mergedCustomJson,
          now,
          memberId
        )
      );
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
        // Count only members who aren't already active toward the free limit
        const alreadyActive = await first<{ status: string }>(
          c.env.DB.prepare(
            "SELECT status FROM members WHERE id = ?"
          ).bind(memberId)
        );
        if (alreadyActive?.status !== "active") {
          if (activeSlotsLeft <= 0) {
            planLimited++;
            continue;
          }
          activeSlotsLeft--;
        }
      }
      pendingMemberships.push({
        memberId,
        level,
        endDate,
        startDate: row.joined_at || undefined,
      });
    }
  }

  for (let i = 0; i < stmts.length; i += 50) {
    await c.env.DB.batch(stmts.slice(i, i + 50));
  }

  for (const pm of pendingMemberships) {
    try {
      await activateMembership(c.env.DB, {
        tenantId: tenant.id,
        memberId: pm.memberId,
        level: pm.level,
        amountPaidCents: 0,
        now,
        startDate: pm.startDate,
        endDate: pm.endDate,
        autoRenew: false,
      });
      membershipsAssigned++;
    } catch (e) {
      console.warn("import membership assign failed", pm.memberId, e);
    }
  }

  return c.json({
    ok: true,
    created,
    updated,
    skipped,
    memberships_assigned: membershipsAssigned,
    plan_limited: planLimited,
    custom_fields_created: customFieldsCreated,
    skipped_rows: skippedRows,
  });
});
