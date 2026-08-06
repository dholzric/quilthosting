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
  await c.env.DB.prepare(
    `INSERT INTO members
     (id, tenant_id, email, first_name, last_name, phone, status, joined_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
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
    )
    .run();
  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id)
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

const MEMBER_STATUSES = ["pending", "active", "lapsed", "cancelled"];

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
    rows: Array<Record<string, string>>;
    dry_run?: boolean;
  }>();
  if (!Array.isArray(body.rows) || !body.rows.length) {
    return c.json({ error: "rows array is required" }, 400);
  }
  // 5k rows/request; clients can loop for larger migrations
  if (body.rows.length > 5000) {
    return c.json({ error: "Max 5000 rows per import — split larger files" }, 400);
  }

  // Build email map in batches (do not SELECT entire 50k-member table)
  const byEmail = new Map<string, string>();
  const emailsInFile = [
    ...new Set(
      body.rows
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

  // Dry run: report exactly what a real import would do, write nothing.
  if (body.dry_run) {
    const seenEmails = new Set<string>();
    let willCreate = 0;
    let willUpdate = 0;
    const skipped: Array<{ row: number; reason: string }> = [];
    const sample: Array<Record<string, string>> = [];
    body.rows.forEach((r, idx) => {
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
      const existing = byEmail.has(email);
      if (existing) willUpdate++;
      else willCreate++;
      if (sample.length < 5) {
        sample.push({
          email,
          name: [r.first_name, r.last_name].filter(Boolean).join(" "),
          action: existing ? "update" : "create",
        });
      }
    });
    return c.json({
      dry_run: true,
      total_rows: body.rows.length,
      will_create: willCreate,
      will_update: willUpdate,
      will_skip: skipped.length,
      skipped: skipped.slice(0, 20),
      sample,
    });
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

  const now = new Date().toISOString();
  let created = 0,
    updated = 0,
    skipped = 0,
    membershipsAssigned = 0,
    planLimited = 0;
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  // After batch inserts, assign memberships (need member ids)
  const pendingMemberships: Array<{
    memberId: string;
    level: MembershipLevel;
    endDate?: string;
    startDate?: string;
  }> = [];

  for (const row of body.rows) {
    const email = (row.email || "").toLowerCase().trim();
    if (!email || !email.includes("@") || seen.has(email)) {
      skipped++;
      continue;
    }
    seen.add(email);
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
      stmts.push(
        c.env.DB.prepare(
          `UPDATE members SET
             first_name = coalesce(?, first_name), last_name = coalesce(?, last_name),
             phone = coalesce(?, phone), notes = coalesce(?, notes),
             status = coalesce(?, status), updated_at = ?
           WHERE id = ?`
        ).bind(
          row.first_name || null,
          row.last_name || null,
          row.phone || null,
          row.notes || null,
          // Only force status when no level will set active via membership
          level ? null : importStatus,
          now,
          memberId
        )
      );
      updated++;
    } else {
      memberId = generateId();
      byEmail.set(email, memberId);
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO members (id, tenant_id, email, first_name, last_name, phone, notes, status, joined_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          memberId,
          tenant.id,
          email,
          row.first_name || null,
          row.last_name || null,
          row.phone || null,
          row.notes || null,
          importStatus, // activateMembership flips to active when level set
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
  });
});
