/**
 * Automation sequences: enqueue (see automations/triggers.ts), then send.
 *
 * Two units of work exist side by side:
 *
 *   automation_runs (migration 0029, current) — one row per subject per
 *     sequence, carrying the step pointer, the due time of the next step and a
 *     retry counter. Leased before sending, exactly the way blastSend leases a
 *     blast: a conditional UPDATE whose changes count decides the winner.
 *
 *   automation_enrollments (migration 0008, legacy) — the pre-0029 table. No
 *     new rows are written. runAutomationJob still drains whatever was in
 *     flight at the 0029 deploy, and cancels any enrollment whose member
 *     already has a run for the same sequence so nobody gets two copies.
 *
 * The runs state machine:
 *
 *   pending --(due, leased)--> sending --+-- sent, more steps --> pending(step+1)
 *                                       +-- sent, last step ----> completed
 *                                       +-- send failed --------> pending(same
 *                                       |     step, attempts+1, backoff)
 *                                       +-- 3rd failure --------> failed
 *                                       +-- suppressed / no
 *                                             sequence / no
 *                                             recipient -------> cancelled
 *
 * A failure NEVER advances `step`, so a retry re-sends the same step and can
 * never skip one. `sent_at` only ever moves forward on a real send.
 */
import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import { sendEmail, type SendEmailParams, type SendEmailResult } from "./email";
import { applyMergeFields } from "./email/merge";
import { unsubscribeUrl } from "./suppression";
import { parseSteps, serializeSteps, type AutomationStep } from "./automations/steps";
import {
  enqueueTrigger,
  TRIGGER_SUBJECT,
  type SubjectType,
  type TriggerName,
} from "./automations/triggers";

export { parseSteps, serializeSteps };
export type { AutomationStep };

export type AutomationSequence = {
  id: string;
  tenant_id: string;
  name: string;
  trigger_event: string;
  is_active: number;
  steps_json: string;
  conditions_json?: string | null;
  trigger_config_json?: string | null;
};

export type AutomationRun = {
  id: string;
  tenant_id: string;
  sequence_id: string;
  subject_type: SubjectType;
  subject_id: string;
  step: number;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  error: string | null;
  attempts: number;
};

/** Injection points so the tests can drive the clock and the mailer. */
export type AutomationJobOptions = {
  send?: (env: Env, params: SendEmailParams) => Promise<SendEmailResult>;
  now?: () => number;
  owner?: string;
  /** Max runs claimed per tick. */
  limit?: number;
};

const RUN_LEASE_MS = 3 * 60 * 1000;
const RUN_LIMIT = 100;
const RUN_CONCURRENCY = 5;
const MAX_RUN_ATTEMPTS = 3;
/** 15 minutes, then 30, then the run is marked failed. */
const RETRY_BACKOFF_MS = 15 * 60 * 1000;
/** How far back the event_ended sweep looks; the unique index makes it safe. */
const ENDED_WINDOW_MS = 2 * 86400000;
const ENDED_EVENT_LIMIT = 25;
const ENDED_REG_LIMIT = 500;

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    })
  );
}

/**
 * Enrol a newly activated member into every active member_activated sequence.
 *
 * Signature unchanged; the storage moved to automation_runs. Requires
 * migration 0029 — on an un-migrated database enqueueTrigger logs and returns,
 * and the member simply does not enter the sequence.
 */
export async function enrollMemberActivated(
  env: Env,
  tenantId: string,
  memberId: string
): Promise<void> {
  await enqueueTrigger(env, tenantId, "member_activated", {
    id: memberId,
    memberId,
  });
}

/**
 * Take the sending lease on a run. True only when this caller now owns it.
 * A lease is available when unset or expired, which is also how a run left
 * 'sending' by a crashed worker gets picked up again.
 */
export async function acquireRunLease(
  db: D1Database,
  runId: string,
  owner: string,
  nowMs = Date.now()
): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString();
  const until = new Date(nowMs + RUN_LEASE_MS).toISOString();
  const res = await db
    .prepare(
      `UPDATE automation_runs
          SET status = 'sending', lease_until = ?, lease_owner = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'sending')
          AND (lease_until IS NULL OR lease_until < ?)`
    )
    .bind(until, owner, nowIso, runId, nowIso)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

type Recipient = {
  email: string;
  memberId: string | null;
  merge: Record<string, string>;
};

function splitName(name: string | null | undefined): [string, string] {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return ["", ""];
  return [parts[0], parts.slice(1).join(" ")];
}

/**
 * Who this run is about, and the merge fields for it. Resolved at send time
 * rather than stored on the run so a corrected email address or a renamed
 * event is picked up by later steps.
 */
async function resolveSubject(
  db: D1Database,
  run: AutomationRun,
  guildName: string
): Promise<Recipient | null> {
  const base = { guild_name: guildName };
  if (run.subject_type === "member") {
    const m = await first<{
      id: string;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
    }>(
      db
        .prepare(
          `SELECT id, email, first_name, last_name FROM members WHERE id = ? AND tenant_id = ?`
        )
        .bind(run.subject_id, run.tenant_id)
    );
    if (!m?.email) return null;
    return {
      email: m.email,
      memberId: m.id,
      merge: {
        ...base,
        first_name: m.first_name || "",
        last_name: m.last_name || "",
        email: m.email,
      },
    };
  }
  if (run.subject_type === "registration") {
    const r = await first<{
      email: string | null;
      name: string | null;
      member_id: string | null;
      event_title: string | null;
    }>(
      db
        .prepare(
          `SELECT r.email, r.name, r.member_id, e.title as event_title
             FROM event_registrations r
             LEFT JOIN events e ON e.id = r.event_id
            WHERE r.id = ? AND r.tenant_id = ?`
        )
        .bind(run.subject_id, run.tenant_id)
    );
    if (!r?.email) return null;
    const [firstName, lastName] = splitName(r.name);
    return {
      email: r.email,
      memberId: r.member_id,
      merge: {
        ...base,
        first_name: firstName,
        last_name: lastName,
        email: r.email,
        event_title: r.event_title || "",
      },
    };
  }
  if (run.subject_type === "form_response") {
    const f = await first<{
      email: string | null;
      name: string | null;
      member_id: string | null;
      form_name: string | null;
    }>(
      db
        .prepare(
          `SELECT fr.email, fr.name, fr.member_id, f.name as form_name
             FROM form_responses fr
             LEFT JOIN forms f ON f.id = fr.form_id
            WHERE fr.id = ? AND fr.tenant_id = ?`
        )
        .bind(run.subject_id, run.tenant_id)
    );
    if (!f?.email) return null;
    const [firstName, lastName] = splitName(f.name);
    return {
      email: f.email,
      memberId: f.member_id,
      merge: {
        ...base,
        first_name: firstName,
        last_name: lastName,
        email: f.email,
        form_name: f.form_name || "",
      },
    };
  }
  // payment
  const p = await first<{
    member_id: string | null;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    db
      .prepare(
        `SELECT p.member_id, m.email, m.first_name, m.last_name
           FROM payments p
           LEFT JOIN members m ON m.id = p.member_id
          WHERE p.id = ? AND p.tenant_id = ?`
      )
      .bind(run.subject_id, run.tenant_id)
  );
  if (!p?.email) return null;
  return {
    email: p.email,
    memberId: p.member_id,
    merge: {
      ...base,
      first_name: p.first_name || "",
      last_name: p.last_name || "",
      email: p.email,
    },
  };
}

async function finishRun(
  db: D1Database,
  runId: string,
  fields: {
    status: string;
    step?: number;
    scheduledAt?: string | null;
    sentAt?: string | null;
    error?: string | null;
    attempts?: number;
  },
  nowIso: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE automation_runs
          SET status = ?,
              step = COALESCE(?, step),
              scheduled_at = ?,
              sent_at = COALESCE(?, sent_at),
              error = ?,
              attempts = COALESCE(?, attempts),
              lease_until = NULL,
              lease_owner = NULL,
              updated_at = ?
        WHERE id = ?`
    )
    .bind(
      fields.status,
      fields.step ?? null,
      fields.scheduledAt ?? null,
      fields.sentAt ?? null,
      fields.error ?? null,
      fields.attempts ?? null,
      nowIso,
      runId
    )
    .run();
}

export type RunsResult = {
  /** Runs this call actually claimed (others were held elsewhere). */
  claimed: number;
  sent: number;
  completed: number;
  /** Sends that failed and were rescheduled on the same step. */
  retried: number;
  /** Runs that hit MAX_RUN_ATTEMPTS. */
  failed: number;
  cancelled: number;
  errors: string[];
};

/**
 * Send every due automation step. One lease per run, bounded concurrency,
 * retry by rescheduling (the cron is the retry timer, not an in-process sleep).
 */
export async function processAutomationRuns(
  env: Env,
  opts: AutomationJobOptions = {}
): Promise<RunsResult> {
  const send = opts.send || sendEmail;
  const now = opts.now || Date.now;
  const ownerBase = opts.owner || `w:${generateId().slice(0, 8)}`;
  const result: RunsResult = {
    claimed: 0,
    sent: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    cancelled: 0,
    errors: [],
  };

  let due: AutomationRun[] = [];
  try {
    due = await all<AutomationRun>(
      env.DB.prepare(
        `SELECT id, tenant_id, sequence_id, subject_type, subject_id, step, status,
                scheduled_at, sent_at, error, attempts
           FROM automation_runs
          WHERE status IN ('pending', 'sending')
            AND scheduled_at IS NOT NULL AND scheduled_at <= ?
          ORDER BY scheduled_at
          LIMIT ?`
      ).bind(new Date(now()).toISOString(), opts.limit || RUN_LIMIT)
    );
  } catch (e) {
    result.errors.push(`runs list: ${String(e)}`);
    return result;
  }
  if (!due.length) return result;

  await mapBounded(due, RUN_CONCURRENCY, async (run) => {
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    try {
      if (!(await acquireRunLease(env.DB, run.id, ownerBase, nowMs))) return;
      result.claimed++;

      const seq = await first<AutomationSequence>(
        env.DB.prepare(
          `SELECT id, tenant_id, name, trigger_event, is_active, steps_json
             FROM automation_sequences WHERE id = ?`
        ).bind(run.sequence_id)
      );
      if (!seq || !seq.is_active) {
        await finishRun(
          env.DB,
          run.id,
          { status: "cancelled", error: "sequence paused or deleted" },
          nowIso
        );
        result.cancelled++;
        return;
      }

      const steps = parseSteps(seq.steps_json);
      const step = steps[run.step];
      if (!step) {
        await finishRun(env.DB, run.id, { status: "completed" }, nowIso);
        result.completed++;
        return;
      }

      const tenant = await first<{ id: string; name: string }>(
        env.DB.prepare(`SELECT id, name FROM tenants WHERE id = ?`).bind(run.tenant_id)
      );
      if (!tenant) {
        await finishRun(
          env.DB,
          run.id,
          { status: "cancelled", error: "tenant missing" },
          nowIso
        );
        result.cancelled++;
        return;
      }

      const who = await resolveSubject(env.DB, run, tenant.name);
      if (!who) {
        await finishRun(
          env.DB,
          run.id,
          { status: "cancelled", error: "no recipient" },
          nowIso
        );
        result.cancelled++;
        return;
      }

      const logId = generateId();
      const unsubUrl = await unsubscribeUrl(
        env.APP_URL,
        env.JWT_SECRET,
        run.tenant_id,
        who.email
      );
      const subject = applyMergeFields(step.subject, who.merge);
      const html = wrapLinksForTracking(
        applyMergeFields(step.bodyHtml, { ...who.merge, unsubscribe_url: unsubUrl }),
        env.APP_URL,
        logId
      );

      // Same contract as blastSend: marketing mail, scoped to the tenant, with
      // the log row id so suppression and delivery state line up.
      const res = await send(env, {
        to: who.email,
        subject,
        html,
        kind: "marketing",
        tenantId: run.tenant_id,
        unsubscribeUrl: unsubUrl,
        guildName: tenant.name,
        emailLogId: logId,
        tags: [
          { name: "template", value: "automation" },
          { name: "sequence", value: seq.id.slice(0, 32) },
        ],
      });

      try {
        await env.DB.prepare(
          `INSERT INTO email_logs
             (id, tenant_id, member_id, to_email, template, resend_id, status, created_at,
              delivery_status, provider_message_id, delivery_error)
           VALUES (?, ?, ?, ?, 'automation', ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            logId,
            run.tenant_id,
            who.memberId,
            who.email,
            res.id || null,
            res.success ? "sent" : res.suppressed ? "skipped" : "failed",
            nowIso,
            res.success ? "accepted" : res.suppressed ? "skipped" : "failed",
            res.id || null,
            res.success ? null : (res.error || res.reason || "failed").slice(0, 500)
          )
          .run();
      } catch (e) {
        console.warn("automation email_logs insert failed", e);
      }

      if (res.suppressed) {
        // Every later step would be suppressed too — stop the run rather than
        // grinding through it.
        await finishRun(
          env.DB,
          run.id,
          { status: "cancelled", error: `suppressed: ${res.reason || "opt-out"}` },
          nowIso
        );
        result.cancelled++;
        return;
      }

      if (!res.success) {
        const attempts = run.attempts + 1;
        if (attempts >= MAX_RUN_ATTEMPTS) {
          await finishRun(
            env.DB,
            run.id,
            {
              status: "failed",
              attempts,
              error: (res.error || "send failed").slice(0, 500),
            },
            nowIso
          );
          result.failed++;
        } else {
          // Same step, later. Never advance on failure.
          await finishRun(
            env.DB,
            run.id,
            {
              status: "pending",
              attempts,
              scheduledAt: new Date(
                nowMs + RETRY_BACKOFF_MS * 2 ** (attempts - 1)
              ).toISOString(),
              error: (res.error || "send failed").slice(0, 500),
            },
            nowIso
          );
          result.retried++;
        }
        return;
      }

      result.sent++;
      const nextStep = run.step + 1;
      if (nextStep >= steps.length) {
        await finishRun(
          env.DB,
          run.id,
          { status: "completed", step: nextStep, sentAt: nowIso, attempts: 0 },
          nowIso
        );
        result.completed++;
      } else {
        await finishRun(
          env.DB,
          run.id,
          {
            status: "pending",
            step: nextStep,
            attempts: 0,
            sentAt: nowIso,
            scheduledAt: new Date(
              nowMs + steps[nextStep].waitDays * 86400000
            ).toISOString(),
          },
          nowIso
        );
      }
    } catch (e) {
      result.errors.push(`${run.id}: ${String(e)}`);
      try {
        await env.DB.prepare(
          `UPDATE automation_runs SET status = 'pending', lease_until = NULL, lease_owner = NULL
            WHERE id = ? AND status = 'sending'`
        )
          .bind(run.id)
          .run();
      } catch {
        /* the lease expires on its own */
      }
    }
  });

  return result;
}

/**
 * event_ended has no natural call site — nothing happens when an event stops.
 * Sweep for it instead: events that finished in the last two days, for tenants
 * that actually have an active event_ended sequence. Re-running is free
 * because enqueueTrigger's unique index absorbs the duplicates.
 */
export async function sweepEndedEvents(
  env: Env,
  opts: { now?: () => number } = {}
): Promise<{ enqueued: number; errors: string[] }> {
  const now = opts.now || Date.now;
  const out = { enqueued: 0, errors: [] as string[] };
  try {
    const tenants = await all<{ tenant_id: string }>(
      env.DB.prepare(
        `SELECT DISTINCT tenant_id FROM automation_sequences
          WHERE is_active = 1 AND trigger_event = 'event_ended'`
      )
    );
    if (!tenants.length) return out;

    const nowMs = now();
    const until = new Date(nowMs).toISOString();
    const since = new Date(nowMs - ENDED_WINDOW_MS).toISOString();

    for (const t of tenants) {
      const events = await all<{ id: string; ended_at: string }>(
        env.DB.prepare(
          `SELECT id, COALESCE(end_at, start_at) as ended_at FROM events
            WHERE tenant_id = ?
              AND COALESCE(end_at, start_at) > ?
              AND COALESCE(end_at, start_at) <= ?
            ORDER BY ended_at DESC LIMIT ?`
        ).bind(t.tenant_id, since, until, ENDED_EVENT_LIMIT)
      );
      for (const ev of events) {
        const regs = await all<{ id: string }>(
          env.DB.prepare(
            `SELECT id FROM event_registrations
              WHERE tenant_id = ? AND event_id = ? AND status IN ('registered', 'attended')
              LIMIT ?`
          ).bind(t.tenant_id, ev.id, ENDED_REG_LIMIT)
        );
        for (const reg of regs) {
          const res = await enqueueTrigger(env, t.tenant_id, "event_ended", {
            id: reg.id,
            eventId: ev.id,
            occurredAt: ev.ended_at,
          });
          out.enqueued += res.enqueued;
          if (res.error) out.errors.push(`event_ended ${ev.id}: ${res.error}`);
        }
      }
    }
  } catch (e) {
    out.errors.push(`sweepEndedEvents: ${String(e)}`);
  }
  return out;
}

/**
 * Drain automation_enrollments rows left over from before migration 0029.
 * No new rows are ever written here. An enrollment whose member already has a
 * run for the same sequence is cancelled rather than sent, so the changeover
 * cannot produce two copies of a step.
 */
async function drainLegacyEnrollments(
  env: Env,
  opts: AutomationJobOptions
): Promise<{ sent: number; completed: number; errors: string[] }> {
  const send = opts.send || sendEmail;
  const now = opts.now || Date.now;
  const result = { sent: 0, completed: 0, errors: [] as string[] };
  const nowIso = new Date(now()).toISOString();

  let enrollments: Array<{
    id: string;
    tenant_id: string;
    sequence_id: string;
    member_id: string;
    current_step: number;
  }> = [];
  try {
    enrollments = await all(
      env.DB.prepare(
        `SELECT id, tenant_id, sequence_id, member_id, current_step
           FROM automation_enrollments
          WHERE status = 'active' AND next_send_at IS NOT NULL AND next_send_at <= ?
          ORDER BY next_send_at LIMIT 100`
      ).bind(nowIso)
    );
  } catch (e) {
    result.errors.push(`list: ${String(e)}`);
    return result;
  }

  const cancel = (id: string) =>
    env.DB.prepare(
      `UPDATE automation_enrollments SET status = 'cancelled', updated_at = ? WHERE id = ?`
    )
      .bind(nowIso, id)
      .run();

  for (const en of enrollments) {
    try {
      const superseded = await first(
        env.DB.prepare(
          `SELECT id FROM automation_runs
            WHERE sequence_id = ? AND subject_type = 'member' AND subject_id = ?`
        ).bind(en.sequence_id, en.member_id)
      );
      if (superseded) {
        await cancel(en.id);
        continue;
      }

      const seq = await first<AutomationSequence>(
        env.DB.prepare(
          `SELECT id, tenant_id, name, trigger_event, is_active, steps_json
             FROM automation_sequences WHERE id = ?`
        ).bind(en.sequence_id)
      );
      if (!seq || !seq.is_active) {
        await cancel(en.id);
        continue;
      }
      const steps = parseSteps(seq.steps_json);
      const step = steps[en.current_step];
      if (!step) {
        await env.DB.prepare(
          `UPDATE automation_enrollments SET status = 'completed', next_send_at = NULL, updated_at = ? WHERE id = ?`
        )
          .bind(nowIso, en.id)
          .run();
        result.completed++;
        continue;
      }

      const member = await first<{
        id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
      }>(
        env.DB.prepare(
          `SELECT id, email, first_name, last_name FROM members WHERE id = ?`
        ).bind(en.member_id)
      );
      const tenant = await first<{ id: string; name: string; slug: string }>(
        env.DB.prepare(`SELECT id, name, slug FROM tenants WHERE id = ?`).bind(en.tenant_id)
      );
      if (!member?.email || !tenant) {
        await cancel(en.id);
        continue;
      }

      const mergeCtx = {
        first_name: member.first_name || "",
        last_name: member.last_name || "",
        email: member.email,
        guild_name: tenant.name,
      };
      const logId = generateId();
      const unsubUrl = await unsubscribeUrl(
        env.APP_URL,
        env.JWT_SECRET,
        en.tenant_id,
        member.email
      );
      const subject = applyMergeFields(step.subject, mergeCtx);
      const html = wrapLinksForTracking(
        applyMergeFields(step.bodyHtml, { ...mergeCtx, unsubscribe_url: unsubUrl }),
        env.APP_URL,
        logId
      );

      const sendResult = await send(env, {
        to: member.email,
        subject,
        html,
        kind: "marketing",
        tenantId: en.tenant_id,
        unsubscribeUrl: unsubUrl,
        guildName: tenant.name,
        emailLogId: logId,
        tags: [
          { name: "template", value: "automation" },
          { name: "sequence", value: seq.id.slice(0, 32) },
        ],
      });

      await env.DB.prepare(
        `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
         VALUES (?, ?, ?, ?, 'automation', ?, ?, ?)`
      )
        .bind(
          logId,
          en.tenant_id,
          member.id,
          member.email,
          sendResult.id || null,
          sendResult.success ? "sent" : "failed",
          nowIso
        )
        .run();

      if (sendResult.success) result.sent++;

      const nextStep = en.current_step + 1;
      if (nextStep >= steps.length) {
        await env.DB.prepare(
          `UPDATE automation_enrollments SET current_step = ?, status = 'completed', next_send_at = NULL, updated_at = ? WHERE id = ?`
        )
          .bind(nextStep, nowIso, en.id)
          .run();
        result.completed++;
      } else {
        const nextAt = new Date(
          now() + steps[nextStep].waitDays * 86400000
        ).toISOString();
        await env.DB.prepare(
          `UPDATE automation_enrollments SET current_step = ?, next_send_at = ?, updated_at = ? WHERE id = ?`
        )
          .bind(nextStep, nextAt, nowIso, en.id)
          .run();
      }
    } catch (e) {
      result.errors.push(`${en.id}: ${String(e)}`);
    }
  }
  return result;
}

export async function runAutomationJob(
  env: Env,
  opts: AutomationJobOptions = {}
): Promise<{
  sent: number;
  completed: number;
  errors: string[];
}> {
  const result = { sent: 0, completed: 0, errors: [] as string[] };

  const swept = await sweepEndedEvents(env, opts);
  result.errors.push(...swept.errors);

  const runs = await processAutomationRuns(env, opts);
  result.sent += runs.sent;
  result.completed += runs.completed;
  result.errors.push(...runs.errors);

  const legacy = await drainLegacyEnrollments(env, opts);
  result.sent += legacy.sent;
  result.completed += legacy.completed;
  result.errors.push(...legacy.errors);

  return result;
}

/** Rewrite http(s) anchors to go through /t/c/:logId?u= */
export function wrapLinksForTracking(html: string, appUrl: string, logId: string): string {
  const base = (appUrl || "").replace(/\/$/, "");
  return html.replace(
    /<a\s+([^>]*?)href=["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    (_m, pre, url, post) => {
      const tracked = `${base}/t/c/${logId}?u=${encodeURIComponent(url)}`;
      return `<a ${pre}href="${tracked}"${post}>`;
    }
  );
}

export { enqueueTrigger, TRIGGER_SUBJECT };
export type { TriggerName, SubjectType };
