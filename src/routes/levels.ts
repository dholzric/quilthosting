import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env, MembershipLevel, TenantVariables } from "../types";
import { generateId } from "../lib/utils/id";
import { all, first } from "../lib/db";
import {
  TERM_MODES,
  PRORATIONS,
  MAX_GRACE_DAYS,
  isValidTermAnchor,
  type TermMode,
  type Proration,
} from "../lib/dues";
import { MAX_HOUSEHOLD_PEOPLE } from "../lib/households";

export const levelRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

// price_cents is integer cents (the admin UI converts from dollars);
// duration_months 1..120 (ten years) keeps computeMembershipEnd sane.
const priceCentsSchema = z
  .number({ invalid_type_error: "price_cents must be a whole number of cents" })
  .int("price_cents must be a whole number of cents")
  .min(0, "price_cents cannot be negative")
  .max(100_000_000, "price_cents is too large");
const durationSchema = z
  .number({ invalid_type_error: "duration_months must be a whole number" })
  .int("duration_months must be a whole number")
  .min(1, "duration_months must be between 1 and 120")
  .max(120, "duration_months must be between 1 and 120");
const nameSchema = z.string().trim().min(1, "name is required").max(120);
const descriptionSchema = z.string().max(2000).nullable();
const renewalSchema = z.enum(["manual", "auto"]);


/* ——— Dues policy (migration 0030; the engine is src/lib/dues.ts) ———
 *
 * The shape is validated here; the MEANING lives in one module so the join
 * page, the renewal cron and the admin's plain-language sentence cannot
 * disagree. A level that never sends these fields keeps the anniversary
 * term it has always had.
 */
const termModeSchema = z.enum(TERM_MODES as unknown as [TermMode, ...TermMode[]]);
const prorationSchema = z.enum(PRORATIONS as unknown as [Proration, ...Proration[]]);
// 'MM-DD'. February 29 is a real date in leap years (dues.ts clamps it to
// the 28th in the others); February 30 and April 31 are not dates at all.
const termAnchorSchema = z
  .string()
  .refine((v) => isValidTermAnchor(v), "term_anchor must be a real month and day, as MM-DD")
  .nullable();
const graceDaysSchema = z
  .number({ invalid_type_error: "grace_days must be a whole number of days" })
  .int("grace_days must be a whole number of days")
  .min(0, "grace_days cannot be negative")
  .max(MAX_GRACE_DAYS, `grace_days cannot be more than ${MAX_GRACE_DAYS}`);

/* ——— Household (migration 0031; the engine is src/lib/households.ts) ———
 *
 * household_max = 1 is an ordinary individual level — every level that
 * existed before 0031 — and > 1 turns the public join form into "the payer
 * plus up to household_max - 1 more people, one payment".
 * household_add_cents is the flat add-on per extra person; 0 means the
 * household costs one membership, which is what "couples join together" is.
 */
const householdMaxSchema = z
  .number({ invalid_type_error: "household_max must be a whole number of people" })
  .int("household_max must be a whole number of people")
  .min(1, `household_max must be between 1 and ${MAX_HOUSEHOLD_PEOPLE}`)
  .max(MAX_HOUSEHOLD_PEOPLE, `household_max must be between 1 and ${MAX_HOUSEHOLD_PEOPLE}`);
const householdAddCentsSchema = z
  .number({ invalid_type_error: "household_add_cents must be a whole number of cents" })
  .int("household_add_cents must be a whole number of cents")
  .min(0, "household_add_cents cannot be negative")
  .max(100_000_000, "household_add_cents is too large");

const createLevelSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  price_cents: priceCentsSchema.optional(),
  duration_months: durationSchema.optional(),
  renewal_type: renewalSchema.optional(),
  is_public: z.boolean().optional(),
  term_mode: termModeSchema.optional(),
  term_anchor: termAnchorSchema.optional(),
  proration: prorationSchema.optional(),
  grace_days: graceDaysSchema.optional(),
  household_max: householdMaxSchema.optional(),
  household_add_cents: householdAddCentsSchema.optional(),
});
const patchLevelSchema = createLevelSchema.partial();

/** What the level row stores for its dues policy, after the route resolves it. */
type PolicyColumns = {
  term_mode: TermMode;
  term_anchor: string | null;
  proration: Proration;
  grace_days: number;
};

/**
 * Merge the submitted policy fields over what the level already stores and
 * enforce the two cross-field rules zod cannot see on a PATCH:
 *
 *   - fixed_date needs an anchor (there is nothing to compute a year from
 *     without one), and
 *   - anniversary and calendar must NOT keep a stale anchor: switching a
 *     July-year level to the calendar year has to clear '07-01', which is
 *     why these columns are bound directly instead of through coalesce().
 *
 * Proration is left as sent even for anniversary; dues.ts normalizes it
 * away when it reads the row, so a level toggled anniversary -> calendar
 * and back keeps the officer's choice rather than silently losing it.
 */
function resolvePolicy(
  body: Partial<PolicyColumns> & { term_anchor?: string | null },
  existing: Partial<PolicyColumns>
): { policy: PolicyColumns } | { error: string } {
  const term_mode = (body.term_mode ?? existing.term_mode ?? "anniversary") as TermMode;
  const anchorGiven = body.term_anchor !== undefined;
  let term_anchor = anchorGiven ? body.term_anchor ?? null : existing.term_anchor ?? null;
  const proration = (body.proration ?? existing.proration ?? "none") as Proration;
  const grace_days = body.grace_days ?? existing.grace_days ?? 0;

  if (term_mode === "fixed_date") {
    if (!isValidTermAnchor(term_anchor)) {
      return {
        error:
          "term_anchor: a month and day (MM-DD) is required when term_mode is fixed_date",
      };
    }
  } else {
    term_anchor = null;
  }
  return { policy: { term_mode, term_anchor, proration, grace_days } };
}

function validationError(c: Context, error: z.ZodError) {
  const first = error.issues[0];
  return c.json(
    {
      error: first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request body",
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
    400
  );
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

levelRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const levels = await all<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE tenant_id = ? AND status = 'active' ORDER BY sort_order, name"
    ).bind(tenant.id)
  );
  return c.json(levels);
});

levelRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const parsed = createLevelSchema.safeParse(await readJson(c));
  if (!parsed.success) return validationError(c, parsed.error);
  const body = parsed.data;
  const resolved = resolvePolicy(body, {});
  if ("error" in resolved) return c.json({ error: resolved.error }, 400);
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO membership_levels
     (id, tenant_id, name, description, price_cents, duration_months, renewal_type, is_public,
      term_mode, term_anchor, proration, grace_days,
      household_max, household_add_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      body.name,
      body.description ?? null,
      body.price_cents ?? 0,
      body.duration_months ?? 12,
      body.renewal_type ?? "manual",
      body.is_public === false ? 0 : 1,
      resolved.policy.term_mode,
      resolved.policy.term_anchor,
      resolved.policy.proration,
      resolved.policy.grace_days,
      body.household_max ?? 1,
      body.household_add_cents ?? 0,
      now,
      now
    )
    .run();
  const level = await first<MembershipLevel>(
    c.env.DB.prepare("SELECT * FROM membership_levels WHERE id = ?").bind(id)
  );
  return c.json(level, 201);
});

levelRoutes.get("/:levelId", async (c) => {
  const tenant = c.get("tenant");
  const levelId = c.req.param("levelId");
  const level = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?"
    ).bind(levelId, tenant.id)
  );
  if (!level) return c.json({ error: "Not found" }, 404);
  return c.json(level);
});

levelRoutes.patch("/:levelId", async (c) => {
  const tenant = c.get("tenant");
  const levelId = c.req.param("levelId");
  const parsed = patchLevelSchema.safeParse(await readJson(c));
  if (!parsed.success) return validationError(c, parsed.error);
  const body = parsed.data;
  const existing = await first<MembershipLevel>(
    c.env.DB.prepare(
      "SELECT * FROM membership_levels WHERE id = ? AND tenant_id = ?"
    ).bind(levelId, tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  // The policy columns are bound directly rather than through coalesce()
  // because switching a fixed-date level to the calendar year has to CLEAR
  // term_anchor, and coalesce(?, term_anchor) can never write a NULL.
  const resolved = resolvePolicy(body, existing as unknown as Partial<PolicyColumns>);
  if ("error" in resolved) return c.json({ error: resolved.error }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE membership_levels SET
       name = coalesce(?, name),
       description = coalesce(?, description),
       price_cents = coalesce(?, price_cents),
       duration_months = coalesce(?, duration_months),
       renewal_type = coalesce(?, renewal_type),
       is_public = coalesce(?, is_public),
       term_mode = ?,
       term_anchor = ?,
       proration = ?,
       grace_days = ?,
       household_max = coalesce(?, household_max),
       household_add_cents = coalesce(?, household_add_cents),
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.name ?? null,
      body.description ?? null,
      body.price_cents ?? null,
      body.duration_months ?? null,
      body.renewal_type ?? null,
      body.is_public !== undefined ? (body.is_public ? 1 : 0) : null,
      resolved.policy.term_mode,
      resolved.policy.term_anchor,
      resolved.policy.proration,
      resolved.policy.grace_days,
      body.household_max ?? null,
      body.household_add_cents ?? null,
      now,
      levelId,
      tenant.id
    )
    .run();
  const updated = await first<MembershipLevel>(
    c.env.DB.prepare("SELECT * FROM membership_levels WHERE id = ?").bind(levelId)
  );
  return c.json(updated);
});

// Soft-archive level (hide from public/join; keep history)
levelRoutes.delete("/:levelId", async (c) => {
  const tenant = c.get("tenant");
  const levelId = c.req.param("levelId");
  const res = await c.env.DB.prepare(
    `UPDATE membership_levels SET status = 'archived', updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'active'`
  )
    .bind(new Date().toISOString(), levelId, tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Level not found" }, 404);
  return c.json({ ok: true, status: "archived" });
});
