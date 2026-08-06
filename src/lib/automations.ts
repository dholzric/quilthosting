import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import { sendEmail } from "./email";
import { applyMergeFields } from "./email/merge";

export type AutomationStep = {
  delay_days: number;
  subject: string;
  body_html: string;
};

export type AutomationSequence = {
  id: string;
  tenant_id: string;
  name: string;
  trigger_event: string;
  is_active: number;
  steps_json: string;
};

export function parseSteps(raw: string | null | undefined): AutomationStep[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s: any) => ({
        delay_days: Math.max(0, Math.min(365, Math.floor(Number(s.delay_days) || 0))),
        subject: String(s.subject || "").slice(0, 200),
        body_html: String(s.body_html || s.body || "").slice(0, 50000),
      }))
      .filter((s: AutomationStep) => s.subject && s.body_html)
      .slice(0, 12);
  } catch {
    return [];
  }
}

/** Enroll a newly activated member into all active member_activated sequences. */
export async function enrollMemberActivated(
  env: Env,
  tenantId: string,
  memberId: string
): Promise<void> {
  try {
    const sequences = await all<AutomationSequence>(
      env.DB.prepare(
        `SELECT * FROM automation_sequences
         WHERE tenant_id = ? AND is_active = 1 AND trigger_event = 'member_activated'`
      ).bind(tenantId)
    );
    const now = new Date();
    for (const seq of sequences) {
      const steps = parseSteps(seq.steps_json);
      if (!steps.length) continue;
      const existing = await first(
        env.DB.prepare(
          `SELECT id FROM automation_enrollments
           WHERE sequence_id = ? AND member_id = ? AND status = 'active'`
        ).bind(seq.id, memberId)
      );
      if (existing) continue;
      const firstDelay = steps[0].delay_days;
      const next = new Date(now.getTime() + firstDelay * 86400000).toISOString();
      await env.DB.prepare(
        `INSERT INTO automation_enrollments
         (id, tenant_id, sequence_id, member_id, current_step, next_send_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 'active', ?, ?)`
      )
        .bind(generateId(), tenantId, seq.id, memberId, next, now.toISOString(), now.toISOString())
        .run();
    }
  } catch (e) {
    console.warn("enrollMemberActivated failed", e);
  }
}

export async function runAutomationJob(env: Env): Promise<{
  sent: number;
  completed: number;
  errors: string[];
}> {
  const result = { sent: 0, completed: 0, errors: [] as string[] };
  const now = new Date().toISOString();
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
      ).bind(now)
    );
  } catch (e) {
    result.errors.push(`list: ${String(e)}`);
    return result;
  }

  for (const en of enrollments) {
    try {
      const seq = await first<AutomationSequence>(
        env.DB.prepare(`SELECT * FROM automation_sequences WHERE id = ?`).bind(en.sequence_id)
      );
      if (!seq || !seq.is_active) {
        await env.DB.prepare(
          `UPDATE automation_enrollments SET status = 'cancelled', updated_at = ? WHERE id = ?`
        )
          .bind(now, en.id)
          .run();
        continue;
      }
      const steps = parseSteps(seq.steps_json);
      const step = steps[en.current_step];
      if (!step) {
        await env.DB.prepare(
          `UPDATE automation_enrollments SET status = 'completed', next_send_at = NULL, updated_at = ? WHERE id = ?`
        )
          .bind(now, en.id)
          .run();
        result.completed++;
        continue;
      }

      const member = await first<{
        id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
      }>(env.DB.prepare(`SELECT id, email, first_name, last_name FROM members WHERE id = ?`).bind(en.member_id));
      const tenant = await first<{ id: string; name: string; slug: string }>(
        env.DB.prepare(`SELECT id, name, slug FROM tenants WHERE id = ?`).bind(en.tenant_id)
      );
      if (!member?.email || !tenant) {
        await env.DB.prepare(
          `UPDATE automation_enrollments SET status = 'cancelled', updated_at = ? WHERE id = ?`
        )
          .bind(now, en.id)
          .run();
        continue;
      }

      const mergeCtx = {
        first_name: member.first_name || "",
        last_name: member.last_name || "",
        email: member.email,
        guild_name: tenant.name,
      };
      const subject = applyMergeFields(step.subject, mergeCtx);
      let html = applyMergeFields(step.body_html, mergeCtx);

      const logId = generateId();
      // Click-wrap links before send
      html = wrapLinksForTracking(html, env.APP_URL, logId);

      const sendResult = await sendEmail(env, {
        to: member.email,
        subject,
        html,
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
          now
        )
        .run();

      if (sendResult.success) result.sent++;

      const nextStep = en.current_step + 1;
      if (nextStep >= steps.length) {
        await env.DB.prepare(
          `UPDATE automation_enrollments SET current_step = ?, status = 'completed', next_send_at = NULL, updated_at = ? WHERE id = ?`
        )
          .bind(nextStep, now, en.id)
          .run();
        result.completed++;
      } else {
        const delay = steps[nextStep].delay_days;
        const nextAt = new Date(Date.now() + delay * 86400000).toISOString();
        await env.DB.prepare(
          `UPDATE automation_enrollments SET current_step = ?, next_send_at = ?, updated_at = ? WHERE id = ?`
        )
          .bind(nextStep, nextAt, now, en.id)
          .run();
      }
    } catch (e) {
      result.errors.push(`${en.id}: ${String(e)}`);
    }
  }
  return result;
}

/** Rewrite http(s) anchors to go through /t/c/:logId?u= */
export function wrapLinksForTracking(html: string, appUrl: string, logId: string): string {
  const base = appUrl.replace(/\/$/, "");
  return html.replace(
    /<a\s+([^>]*?)href=["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    (_m, pre, url, post) => {
      const tracked = `${base}/t/c/${logId}?u=${encodeURIComponent(url)}`;
      return `<a ${pre}href="${tracked}"${post}>`;
    }
  );
}
