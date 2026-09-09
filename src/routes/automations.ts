import { Hono } from "hono";
import type { Env, TenantVariables } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { parseSteps, serializeSteps } from "../lib/automations";
import {
  TRIGGERS,
  TRIGGER_LABELS,
  isTrigger,
  parseConditions,
  parseTriggerConfig,
  type TriggerName,
} from "../lib/automations/triggers";
import { hasFeature } from "../lib/features";
import { RECIPES, findRecipe, recipeToSequence } from "../lib/automations/recipes";

export const automationRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

/**
 * Every trigger with a real call site (see lib/automations/triggers.ts, whose
 * enqueueTrigger is called from the renewal job, Stripe fulfilment, the public
 * form submit and the public event register; event_ended is swept by
 * sweepEndedEvents). Nothing advertised here is dead.
 *
 * The BUILDER for the five newer ones is behind features.automations_v2, so a
 * guild that has not turned it on sees precisely the pre-Task-E behaviour:
 * member_activated only, with the same 400 body for anything else.
 */
export const AUTOMATION_TRIGGERS = TRIGGERS;

/** Triggers this tenant may currently store on a sequence. */
function allowedTriggers(settingsJson: string | null | undefined): TriggerName[] {
  return hasFeature(settingsJson, "automations_v2")
    ? [...TRIGGERS]
    : ["member_activated"];
}

function unsupportedTrigger(value: unknown, valid: TriggerName[]) {
  return {
    error: `Unsupported trigger_event "${String(value)}".`,
    code: "unsupported_trigger",
    valid,
  };
}

/** JSON column value for a body field: undefined = leave, null = clear. */
function jsonColumn(
  value: unknown,
  parse: (raw: string) => Record<string, unknown>
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const cleaned = parse(JSON.stringify(value));
  return Object.keys(cleaned).length ? JSON.stringify(cleaned) : null;
}

automationRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT * FROM automation_sequences WHERE tenant_id = ? ORDER BY created_at DESC`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

/** The trigger picker for the step editor. */
automationRoutes.get("/triggers", (c) => {
  const tenant = c.get("tenant");
  const v2 = hasFeature(tenant.settings_json, "automations_v2");
  return c.json({
    automations_v2: v2,
    triggers: allowedTriggers(tenant.settings_json).map((value) => ({
      value,
      label: TRIGGER_LABELS[value],
    })),
  });
});

/**
 * Recipe cards. `installed` is true when a sequence already carries this
 * recipe id in trigger_config_json, which is what makes the second install a
 * 409 rather than a duplicate.
 */
automationRoutes.get("/recipes", async (c) => {
  const tenant = c.get("tenant");
  if (!hasFeature(tenant.settings_json, "recipes")) {
    return c.json({ enabled: false, recipes: [] });
  }
  let installed = new Set<string>();
  try {
    installed = await installedRecipeIds(c.env, tenant.id);
  } catch {
    /* pre-0029 database: show everything as available */
  }
  return c.json({
    enabled: true,
    recipes: RECIPES.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      trigger: r.trigger,
      trigger_label: TRIGGER_LABELS[r.trigger],
      steps: r.steps.length,
      installed: installed.has(r.id),
    })),
  });
});

async function installedRecipeIds(env: Env, tenantId: string): Promise<Set<string>> {
  const rows = await all<{ trigger_config_json: string | null }>(
    env.DB.prepare(
      `SELECT trigger_config_json FROM automation_sequences
        WHERE tenant_id = ? AND trigger_config_json IS NOT NULL`
    ).bind(tenantId)
  );
  const out = new Set<string>();
  for (const r of rows) {
    const recipe = parseTriggerConfig(r.trigger_config_json).recipe;
    if (recipe) out.add(recipe);
  }
  return out;
}

/**
 * One-click install. Writes an ordinary sequence row — the guild can rename,
 * rewrite, pause or delete it afterwards. Recipes are exempt from the
 * automations_v2 trigger gate: a recipe is the way a guild uses the newer
 * triggers without opening the builder.
 */
automationRoutes.post("/recipes/:recipeId/install", async (c) => {
  const tenant = c.get("tenant");
  if (!hasFeature(tenant.settings_json, "recipes")) {
    return c.json({ error: "Recipes are turned off for this guild.", code: "recipes_disabled" }, 403);
  }
  const recipe = findRecipe(c.req.param("recipeId"));
  if (!recipe) return c.json({ error: "Not found" }, 404);

  if ((await installedRecipeIds(c.env, tenant.id)).has(recipe.id)) {
    return c.json(
      {
        error: `"${recipe.name}" is already installed. Edit the sequence instead.`,
        code: "already_installed",
      },
      409
    );
  }

  const body = recipeToSequence(recipe);
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO automation_sequences
       (id, tenant_id, name, trigger_event, is_active, steps_json, conditions_json,
        trigger_config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      body.name,
      body.trigger_event,
      serializeSteps(body.steps),
      JSON.stringify(body.trigger_config),
      now,
      now
    )
    .run();
  const row = await first(
    c.env.DB.prepare(`SELECT * FROM automation_sequences WHERE id = ?`).bind(id)
  );
  return c.json(row, 201);
});

automationRoutes.post("/", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    name: string;
    trigger_event?: string;
    is_active?: boolean;
    steps?: unknown;
    conditions?: unknown;
    trigger_config?: unknown;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  // A sequence stored with an unwired (or not-yet-enabled) trigger would sit
  // there enrolling nobody — exactly the advertised-but-dead failure the
  // webhook catalog was built to prevent. Reject rather than coerce.
  const valid = allowedTriggers(tenant.settings_json);
  const trigger = body.trigger_event ?? "member_activated";
  if (!isTrigger(trigger) || !valid.includes(trigger)) {
    return c.json(unsupportedTrigger(body.trigger_event, valid), 400);
  }

  const steps = parseSteps(JSON.stringify(body.steps || []));
  if (!steps.length) {
    return c.json({ error: "At least one step with subject and body is required" }, 400);
  }

  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO automation_sequences
     (id, tenant_id, name, trigger_event, is_active, steps_json, conditions_json,
      trigger_config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant.id,
      name,
      trigger,
      body.is_active === false ? 0 : 1,
      serializeSteps(steps),
      jsonColumn(body.conditions, parseConditions) ?? null,
      jsonColumn(body.trigger_config, parseTriggerConfig) ?? null,
      now,
      now
    )
    .run();
  const row = await first(
    c.env.DB.prepare(`SELECT * FROM automation_sequences WHERE id = ?`).bind(id)
  );
  return c.json(row, 201);
});

automationRoutes.patch("/:seqId", async (c) => {
  const tenant = c.get("tenant");
  const existing = await first<{
    id: string;
    steps_json: string;
    trigger_event: string;
    conditions_json: string | null;
    trigger_config_json: string | null;
  }>(
    c.env.DB.prepare(
      `SELECT * FROM automation_sequences WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("seqId"), tenant.id)
  );
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    is_active?: boolean;
    steps?: unknown;
    trigger_event?: string;
    conditions?: unknown;
    trigger_config?: unknown;
  }>();

  let trigger = existing.trigger_event;
  if (body.trigger_event !== undefined && body.trigger_event !== existing.trigger_event) {
    const valid = allowedTriggers(tenant.settings_json);
    if (!isTrigger(body.trigger_event) || !valid.includes(body.trigger_event)) {
      return c.json(unsupportedTrigger(body.trigger_event, valid), 400);
    }
    trigger = body.trigger_event;
  }

  const steps =
    body.steps !== undefined
      ? serializeSteps(parseSteps(JSON.stringify(body.steps)))
      : existing.steps_json;
  const conditions = jsonColumn(body.conditions, parseConditions);
  const triggerConfig = jsonColumn(body.trigger_config, parseTriggerConfig);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `UPDATE automation_sequences SET
       name = coalesce(?, name),
       is_active = coalesce(?, is_active),
       trigger_event = ?,
       steps_json = ?,
       conditions_json = ?,
       trigger_config_json = ?,
       updated_at = ?
     WHERE id = ?`
  )
    .bind(
      body.name?.trim() || null,
      body.is_active !== undefined ? (body.is_active ? 1 : 0) : null,
      trigger,
      steps,
      conditions === undefined ? existing.conditions_json : conditions,
      triggerConfig === undefined ? existing.trigger_config_json : triggerConfig,
      now,
      existing.id
    )
    .run();
  const row = await first(
    c.env.DB.prepare(`SELECT * FROM automation_sequences WHERE id = ?`).bind(existing.id)
  );
  return c.json(row);
});

automationRoutes.delete("/:seqId", async (c) => {
  const tenant = c.get("tenant");
  const res = await c.env.DB.prepare(
    `DELETE FROM automation_sequences WHERE id = ? AND tenant_id = ?`
  )
    .bind(c.req.param("seqId"), tenant.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/** Who is currently travelling through this sequence, and where they are. */
automationRoutes.get("/:seqId/runs", async (c) => {
  const tenant = c.get("tenant");
  const seq = await first(
    c.env.DB.prepare(
      `SELECT id FROM automation_sequences WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("seqId"), tenant.id)
  );
  if (!seq) return c.json({ error: "Not found" }, 404);
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT id, subject_type, subject_id, step, status, scheduled_at, sent_at,
                error, attempts, created_at
           FROM automation_runs
          WHERE sequence_id = ? AND tenant_id = ?
          ORDER BY created_at DESC LIMIT 200`
      ).bind(c.req.param("seqId"), tenant.id)
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

/** Pre-0029 enrollments, kept so the screen still shows in-flight members. */
automationRoutes.get("/:seqId/enrollments", async (c) => {
  const tenant = c.get("tenant");
  const seq = await first(
    c.env.DB.prepare(
      `SELECT id FROM automation_sequences WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("seqId"), tenant.id)
  );
  if (!seq) return c.json({ error: "Not found" }, 404);
  const rows = await all(
    c.env.DB.prepare(
      `SELECT e.*, m.email, m.first_name, m.last_name
       FROM automation_enrollments e
       LEFT JOIN members m ON m.id = e.member_id
       WHERE e.sequence_id = ?
       ORDER BY e.created_at DESC LIMIT 200`
    ).bind(c.req.param("seqId"))
  );
  return c.json(rows);
});
