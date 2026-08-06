import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import { sendEmail } from "./email";

type RegRow = {
  id: string;
  email: string;
  name: string | null;
  event_id: string;
  event_title: string;
  start_at: string;
  location: string | null;
  tenant_id: string;
  tenant_name: string;
  ticket_code: string | null;
};

/** Days before event start to send a reminder. */
const EVENT_REMINDER_DAYS = [7, 1] as const;

/**
 * Email registered attendees before upcoming events.
 * Deduped with email_logs.template = event_reminder_{eventId}_{days}d
 */
export async function runEventReminderJob(env: Env): Promise<{
  reminders_sent: number;
  errors: string[];
}> {
  const result = { reminders_sent: 0, errors: [] as string[] };
  const now = new Date();

  for (const days of EVENT_REMINDER_DAYS) {
    const target = new Date(now);
    target.setUTCDate(target.getUTCDate() + days);
    const targetDate = target.toISOString().slice(0, 10);

    try {
      const rows = await all<RegRow>(
        env.DB.prepare(
          `SELECT r.id, r.email, r.name, r.event_id, r.ticket_code,
                  e.title as event_title, e.start_at, e.location,
                  e.tenant_id, t.name as tenant_name
           FROM event_registrations r
           JOIN events e ON e.id = r.event_id
           JOIN tenants t ON t.id = e.tenant_id
           WHERE r.status IN ('registered', 'checked_in')
             AND t.status = 'active'
             AND date(e.start_at) = date(?)`
        ).bind(targetDate)
      );

      for (const row of rows) {
        const templateKey = `event_reminder_${row.event_id}_${days}d`;
        const dup = await first(
          env.DB.prepare(
            `SELECT id FROM email_logs
             WHERE tenant_id = ? AND to_email = ? AND template = ?
             LIMIT 1`
          ).bind(row.tenant_id, row.email, templateKey)
        );
        if (dup) continue;

        const when = new Date(row.start_at).toLocaleString("en-US", {
          dateStyle: "full",
          timeStyle: "short",
        });
        const firstName = row.name?.split(" ")[0] || "there";
        const subject =
          days === 1
            ? `Reminder: ${row.event_title} is tomorrow`
            : `Reminder: ${row.event_title} in ${days} days`;
        const html = `
          <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;line-height:1.6">
            <h1 style="font-size:1.35rem;color:#221f1a">Coming up: ${escape(row.event_title)}</h1>
            <p>Hi ${escape(firstName)},</p>
            <p>This is a friendly reminder from <strong>${escape(row.tenant_name)}</strong>.</p>
            <p>
              <strong>When:</strong> ${escape(when)}<br/>
              ${row.location ? `<strong>Where:</strong> ${escape(row.location)}<br/>` : ""}
              ${row.ticket_code ? `<strong>Ticket:</strong> ${escape(row.ticket_code)}` : ""}
            </p>
            <p style="color:#8a847a;font-size:14px">— ${escape(row.tenant_name)}</p>
          </div>
        `;

        const sendResult = await sendEmail(env, {
          to: row.email,
          subject,
          html,
          tags: [
            { name: "template", value: `event_reminder_${days}d` },
          ],
        });

        try {
          await env.DB.prepare(
            `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
             VALUES (?, ?, null, ?, ?, ?, ?, ?)`
          )
            .bind(
              generateId(),
              row.tenant_id,
              row.email,
              templateKey,
              sendResult.id || null,
              sendResult.success ? "sent" : "failed",
              new Date().toISOString()
            )
            .run();
        } catch (e) {
          console.warn("email_logs insert failed", e);
        }

        if (sendResult.success) result.reminders_sent++;
        else result.errors.push(`${row.email}: ${sendResult.error}`);
      }
    } catch (e) {
      result.errors.push(`event reminder day ${days}: ${String(e)}`);
    }
  }

  return result;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
