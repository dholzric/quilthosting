import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import { sendEmail, renewalReminderEmail, winBackEmail } from "./email";
import { formatMoney } from "./utils/money";

type MembershipRow = {
  id: string;
  tenant_id: string;
  member_id: string;
  level_id: string;
  end_date: string;
  status: string;
  auto_renew: number;
  amount_paid_cents: number | null;
  email: string;
  first_name: string | null;
  level_name: string;
  price_cents: number;
  duration_months: number;
  tenant_name: string;
  tenant_slug: string;
};

const REMINDER_DAYS = [30, 14, 7, 1] as const;

export async function runRenewalJob(env: Env): Promise<{
  reminders_sent: number;
  expired: number;
  winbacks_sent: number;
  trials_ended: number;
  errors: string[];
}> {
  const result = {
    reminders_sent: 0,
    expired: 0,
    winbacks_sent: 0,
    trials_ended: 0,
    errors: [] as string[],
  };
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  for (const days of REMINDER_DAYS) {
    const target = new Date(now);
    target.setUTCDate(target.getUTCDate() + days);
    const targetDate = target.toISOString().slice(0, 10);

    try {
      const rows = await all<MembershipRow>(
        env.DB.prepare(
          `SELECT m.id, m.tenant_id, m.member_id, m.level_id, m.end_date, m.status,
                  m.auto_renew, m.amount_paid_cents,
                  mem.email, mem.first_name,
                  l.name as level_name, l.price_cents, l.duration_months,
                  t.name as tenant_name, t.slug as tenant_slug
           FROM memberships m
           JOIN members mem ON mem.id = m.member_id
           JOIN membership_levels l ON l.id = m.level_id
           JOIN tenants t ON t.id = m.tenant_id
           WHERE m.status = 'active'
             AND date(m.end_date) = date(?)
             AND t.status = 'active'
             AND coalesce(t.tenant_type, 'guild') = 'guild'`
        ).bind(targetDate)
      );

      for (const row of rows) {
        const already = await first(
          env.DB.prepare(
            `SELECT id FROM email_logs
             WHERE tenant_id = ? AND member_id = ?
               AND template = ?
               AND date(created_at) = date(?)`
          ).bind(row.tenant_id, row.member_id, `renewal_${days}d`, today)
        );
        if (already) continue;

        const renewUrl = `${env.APP_URL.replace(/\/$/, "")}/portal?slug=${encodeURIComponent(row.tenant_slug)}&renew=1`;
        const { subject, html } = renewalReminderEmail({
          guildName: row.tenant_name,
          firstName: row.first_name ?? undefined,
          daysLeft: days,
          renewUrl,
          amountFormatted: formatMoney(row.price_cents),
        });

        const sendResult = await sendEmail(env, {
          to: row.email,
          subject,
          html,
          tags: [
            { name: "template", value: `renewal_${days}d` },
            { name: "tenant", value: row.tenant_slug },
          ],
        });

        try {
          await env.DB.prepare(
            `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              generateId(),
              row.tenant_id,
              row.member_id,
              row.email,
              `renewal_${days}d`,
              sendResult.id || null,
              sendResult.success ? "sent" : "failed",
              new Date().toISOString()
            )
            .run();
        } catch (e) {
          console.warn("email_logs insert failed", e);
        }

        if (sendResult.success) result.reminders_sent++;
        else result.errors.push(`reminder ${row.email}: ${sendResult.error}`);
      }
    } catch (e) {
      result.errors.push(`reminder day ${days}: ${String(e)}`);
    }
  }

  try {
    const expired = await all<{ id: string; member_id: string; tenant_id: string }>(
      env.DB.prepare(
        `SELECT m.id, m.member_id, m.tenant_id
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.status = 'active' AND date(m.end_date) < date(?)
           AND coalesce(t.tenant_type, 'guild') = 'guild'`
      ).bind(today)
    );

    for (const row of expired) {
      await env.DB.prepare(
        `UPDATE memberships SET status = 'expired', updated_at = ? WHERE id = ?`
      )
        .bind(new Date().toISOString(), row.id)
        .run();

      const other = await first(
        env.DB.prepare(
          `SELECT id FROM memberships
           WHERE member_id = ? AND status = 'active' AND id != ?`
        ).bind(row.member_id, row.id)
      );
      if (!other) {
        await env.DB.prepare(
          `UPDATE members SET status = 'lapsed', updated_at = ? WHERE id = ?`
        )
          .bind(new Date().toISOString(), row.member_id)
          .run();
      }
      result.expired++;
    }
  } catch (e) {
    result.errors.push(`expire: ${String(e)}`);
  }

  // Win-back: members who lapsed 7 days ago (one-time)
  try {
    const winTarget = new Date(now);
    winTarget.setUTCDate(winTarget.getUTCDate() - 7);
    const winDate = winTarget.toISOString().slice(0, 10);
    const lapsed = await all<{
      id: string;
      email: string;
      first_name: string | null;
      tenant_id: string;
      tenant_name: string;
      tenant_slug: string;
    }>(
      env.DB.prepare(
        `SELECT mem.id, mem.email, mem.first_name, mem.tenant_id,
                t.name as tenant_name, t.slug as tenant_slug
         FROM members mem
         JOIN tenants t ON t.id = mem.tenant_id
         WHERE mem.status = 'lapsed' AND t.status = 'active'
           AND date(mem.updated_at) = date(?)
           AND coalesce(t.tenant_type, 'guild') = 'guild'`
      ).bind(winDate)
    );
    for (const row of lapsed) {
      const already = await first(
        env.DB.prepare(
          `SELECT id FROM email_logs
           WHERE tenant_id = ? AND member_id = ? AND template = 'winback_7d'
           LIMIT 1`
        ).bind(row.tenant_id, row.id)
      );
      if (already) continue;
      const renewUrl = `${env.APP_URL.replace(/\/$/, "")}/portal?slug=${encodeURIComponent(row.tenant_slug)}&renew=1`;
      const { subject, html } = winBackEmail({
        guildName: row.tenant_name,
        firstName: row.first_name ?? undefined,
        renewUrl,
      });
      const sendResult = await sendEmail(env, {
        to: row.email,
        subject,
        html,
        tags: [{ name: "template", value: "winback_7d" }],
      });
      try {
        await env.DB.prepare(
          `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
           VALUES (?, ?, ?, ?, 'winback_7d', ?, ?, ?)`
        )
          .bind(
            generateId(),
            row.tenant_id,
            row.id,
            row.email,
            sendResult.id || null,
            sendResult.success ? "sent" : "failed",
            new Date().toISOString()
          )
          .run();
      } catch {}
      if (sendResult.success) result.winbacks_sent++;
    }
  } catch (e) {
    result.errors.push(`winback: ${String(e)}`);
  }

  // End platform trials without paid subscription
  try {
    const expiredTrials = await all<{ id: string }>(
      env.DB.prepare(
        `SELECT id FROM tenants
         WHERE trial_ends_at IS NOT NULL
           AND date(trial_ends_at) < date(?)
           AND plan = 'free'
           AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')
           AND coalesce(tenant_type, 'guild') = 'guild'`
      ).bind(today)
    );
    for (const t of expiredTrials) {
      await env.DB.prepare(
        `UPDATE tenants SET trial_ends_at = null, updated_at = ? WHERE id = ?`
      )
        .bind(new Date().toISOString(), t.id)
        .run();
      result.trials_ended++;
    }
  } catch (e) {
    // column may not exist pre-migration
    result.errors.push(`trials: ${String(e)}`);
  }

  return result;
}
