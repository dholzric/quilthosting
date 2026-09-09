/**
 * Automation triggers (phase 3, Task E).
 *
 * One exported entry point, `enqueueTrigger`, is called from the four places
 * these things already happen (the renewal job, Stripe fulfilment, the public
 * form submit, the public event register). It is additive and total: it never
 * throws, so a trigger can never break the payment or registration path it
 * hangs off.
 *
 * Idempotency is the database's job, not ours. We INSERT OR IGNORE against the
 * unique index on (sequence_id, subject_type, subject_id) from migration 0029
 * — no pre-read, so two concurrent webhook retries for the same payment cannot
 * both enrol it.
 */
import type { Env } from "../../types";
import { all } from "../db";
import { generateId } from "../utils/id";
import { parseSteps } from "./steps";

export const TRIGGERS = [
  "member_activated",
  "membership_lapsed",
  "event_registered",
  "event_ended",
  "form_submitted",
  "payment_received",
] as const;

export type TriggerName = (typeof TRIGGERS)[number];

export const TRIGGER_LABELS: Record<TriggerName, string> = {
  member_activated: "A member joins or renews",
  membership_lapsed: "A membership lapses",
  // KNOWN GAP: fired from the free/immediate branch of the public register
  // (routes/public.ts). A PAID registration is confirmed in the Stripe webhook,
  // which fires payment_received but not this. Closing it means enqueuing from
  // handleCheckoutCompleted's event branch with reg.event_id in hand.
  // Post-event follow-up is unaffected — event_ended sweeps every confirmed
  // registration, paid or not.
  event_registered: "Someone registers for an event",
  event_ended: "An event finishes",
  form_submitted: "A form is submitted",
  payment_received: "A payment is received",
};

export function isTrigger(v: unknown): v is TriggerName {
  return typeof v === "string" && (TRIGGERS as readonly string[]).includes(v);
}

/** Row kind `subject_id` points at; decides how the recipient is resolved. */
export const SUBJECT_TYPES = [
  "member",
  "registration",
  "form_response",
  "payment",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const TRIGGER_SUBJECT: Record<TriggerName, SubjectType> = {
  member_activated: "member",
  membership_lapsed: "member",
  event_registered: "registration",
  event_ended: "registration",
  form_submitted: "form_response",
  payment_received: "payment",
};

/**
 * What fired. `id` is the primary key of the row named by TRIGGER_SUBJECT and
 * doubles as the idempotency key; everything else is only used to evaluate
 * conditions, so a caller that does not have a value can leave it out.
 */
export type TriggerSubject = {
  id: string;
  memberId?: string | null;
  levelId?: string | null;
  eventId?: string | null;
  formId?: string | null;
  amountCents?: number | null;
  /** ISO time the thing happened; defaults to now. Compared to active_from. */
  occurredAt?: string | null;
};

/** Optional narrowing stored on the sequence as conditions_json. */
export type SequenceConditions = {
  level_ids?: string[];
  event_ids?: string[];
  form_ids?: string[];
  min_amount_cents?: number;
};

/** Optional per-trigger settings stored as trigger_config_json. */
export type TriggerConfig = {
  /** Extra days between the trigger firing and step 1. */
  delay_days?: number;
  /**
   * Ignore subjects older than this ISO timestamp. Recipes set it to install
   * time so a one-click install never back-fills years of history.
   */
  active_from?: string;
  /** Recipe this sequence was installed from, for the "installed" badge. */
  recipe?: string;
};

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x) => typeof x === "string" && x).map((x) => String(x));
  return out.length ? out : undefined;
}

export function parseConditions(
  raw: string | null | undefined
): SequenceConditions {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: SequenceConditions = {};
    const levels = stringList((o as any).level_ids);
    if (levels) out.level_ids = levels;
    const events = stringList((o as any).event_ids);
    if (events) out.event_ids = events;
    const forms = stringList((o as any).form_ids);
    if (forms) out.form_ids = forms;
    const min = Number((o as any).min_amount_cents);
    if (Number.isFinite(min) && min > 0) out.min_amount_cents = Math.floor(min);
    return out;
  } catch {
    return {};
  }
}

export function parseTriggerConfig(
  raw: string | null | undefined
): TriggerConfig {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: TriggerConfig = {};
    const delay = Number((o as any).delay_days);
    if (Number.isFinite(delay) && delay > 0) {
      out.delay_days = Math.min(365, Math.floor(delay));
    }
    if (typeof (o as any).active_from === "string" && (o as any).active_from) {
      out.active_from = String((o as any).active_from);
    }
    if (typeof (o as any).recipe === "string" && (o as any).recipe) {
      out.recipe = String((o as any).recipe).slice(0, 64);
    }
    return out;
  } catch {
    return {};
  }
}

/** True when every condition present on the sequence is satisfied. */
export function conditionsMatch(
  cond: SequenceConditions,
  subject: TriggerSubject
): boolean {
  if (cond.level_ids && !cond.level_ids.includes(subject.levelId || "")) {
    return false;
  }
  if (cond.event_ids && !cond.event_ids.includes(subject.eventId || "")) {
    return false;
  }
  if (cond.form_ids && !cond.form_ids.includes(subject.formId || "")) {
    return false;
  }
  if (
    cond.min_amount_cents !== undefined &&
    (subject.amountCents ?? 0) < cond.min_amount_cents
  ) {
    return false;
  }
  return true;
}

export type EnqueueResult = {
  /** Runs actually created (a duplicate subject counts as skipped). */
  enqueued: number;
  /** Sequences that matched the trigger but did not produce a run. */
  skipped: number;
  /** Set when the database refused the write; the caller carries on. */
  error?: string;
};

type SequenceRow = {
  id: string;
  steps_json: string;
  conditions_json: string | null;
  trigger_config_json: string | null;
};

/**
 * Enrol `subject` into every active sequence on `trigger` for this tenant.
 *
 * Never throws: callers sit inside payment fulfilment and public registration,
 * where an automation problem must not roll back the thing the member paid for.
 */
export async function enqueueTrigger(
  env: Env,
  tenantId: string,
  trigger: TriggerName,
  subject: TriggerSubject
): Promise<EnqueueResult> {
  const result: EnqueueResult = { enqueued: 0, skipped: 0 };
  if (!tenantId || !isTrigger(trigger) || !subject || !subject.id) return result;
  try {
    const sequences = await all<SequenceRow>(
      env.DB.prepare(
        `SELECT id, steps_json, conditions_json, trigger_config_json
           FROM automation_sequences
          WHERE tenant_id = ? AND is_active = 1 AND trigger_event = ?`
      ).bind(tenantId, trigger)
    );
    if (!sequences.length) return result;

    const subjectType = TRIGGER_SUBJECT[trigger];
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const occurredAt = subject.occurredAt || nowIso;

    const stmts: D1PreparedStatement[] = [];
    for (const seq of sequences) {
      const steps = parseSteps(seq.steps_json);
      if (!steps.length) {
        result.skipped++;
        continue;
      }
      if (!conditionsMatch(parseConditions(seq.conditions_json), subject)) {
        result.skipped++;
        continue;
      }
      const cfg = parseTriggerConfig(seq.trigger_config_json);
      if (cfg.active_from && occurredAt < cfg.active_from) {
        result.skipped++;
        continue;
      }
      const waitDays = steps[0].waitDays + (cfg.delay_days || 0);
      const scheduledAt = new Date(nowMs + waitDays * 86400000).toISOString();
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO automation_runs
             (id, tenant_id, sequence_id, subject_type, subject_id, step, status,
              scheduled_at, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, 0, ?, ?)`
        ).bind(
          generateId(),
          tenantId,
          seq.id,
          subjectType,
          subject.id,
          scheduledAt,
          nowIso,
          nowIso
        )
      );
    }
    if (!stmts.length) return result;

    const written = await env.DB.batch(stmts);
    for (const r of written) {
      if ((r?.meta?.changes ?? 0) > 0) result.enqueued++;
      else result.skipped++;
    }
    return result;
  } catch (e) {
    // Enqueue is best-effort by design — see the module comment.
    console.warn("enqueueTrigger failed", trigger, e);
    return { ...result, error: String(e) };
  }
}
