/**
 * Process queued/sending blasts in chunks so 50k audiences fit Worker limits.
 */
import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import { sendEmail, trackingPixelHtml } from "./email";
import {
  applyMergeFields,
  wrapEmailLayout,
  type EmailLayout,
} from "./email/merge";
import { fetchAudiencePage, type AudienceMember } from "./audience";
import { wrapLinksForTracking } from "./automations";

const CHUNK = 40; // parallel sends per invocation
const MAX_CHUNKS_PER_RUN = 5; // up to ~200 emails per cron tick / waitUntil

type BlastRow = {
  id: string;
  tenant_id: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  segment: string;
  layout: string;
  recipients: number;
  sent_count: number;
  error_count: number;
  cursor_email: string | null;
  status: string;
};

function mergeCtx(m: AudienceMember, guildName: string) {
  return {
    first_name: m.first_name,
    last_name: m.last_name,
    email: m.email,
    guild_name: guildName,
    level_name: m.level_name,
    end_date: m.end_date,
  };
}

export async function processBlastChunk(
  env: Env,
  blastId: string
): Promise<{ sent: number; done: boolean; errors: number }> {
  const blast = await first<BlastRow>(
    env.DB.prepare(`SELECT * FROM blasts WHERE id = ?`).bind(blastId)
  );
  if (!blast || (blast.status !== "queued" && blast.status !== "sending")) {
    return { sent: 0, done: true, errors: 0 };
  }

  const tenant = await first<{ id: string; name: string }>(
    env.DB.prepare(`SELECT id, name FROM tenants WHERE id = ?`).bind(blast.tenant_id)
  );
  if (!tenant) {
    await env.DB.prepare(
      `UPDATE blasts SET status = 'failed', cursor_email = null WHERE id = ?`
    )
      .bind(blastId)
      .run();
    return { sent: 0, done: true, errors: 0 };
  }

  await env.DB.prepare(`UPDATE blasts SET status = 'sending' WHERE id = ? AND status = 'queued'`)
    .bind(blastId)
    .run();

  const layout: EmailLayout =
    blast.layout === "newsletter" || blast.layout === "announcement"
      ? (blast.layout as EmailLayout)
      : "plain";

  let cursor = blast.cursor_email || "";
  let sentThis = 0;
  let errorsThis = 0;
  let done = false;

  for (let c = 0; c < MAX_CHUNKS_PER_RUN; c++) {
    const page = await fetchAudiencePage(env.DB, blast.tenant_id, blast.segment, {
      limit: CHUNK,
      afterEmail: cursor || null,
    });
    if (!page.length) {
      done = true;
      break;
    }

    const now = new Date().toISOString();
    const results = await Promise.all(
      page.map(async (m) => {
        const logId = generateId();
        const ctx = mergeCtx(m, tenant.name);
        const subject = applyMergeFields(blast.subject, ctx);
        let html = wrapEmailLayout(layout, {
          guildName: tenant.name,
          subject,
          bodyHtml: applyMergeFields(blast.body_html, ctx),
        });
        html = wrapLinksForTracking(html, env.APP_URL, logId);
        html += trackingPixelHtml(env.APP_URL, logId);
        const text = blast.body_text
          ? applyMergeFields(blast.body_text, ctx)
          : undefined;
        const res = await sendEmail(env, { to: m.email, subject, html, text });
        return { m, res, logId, subject };
      })
    );

    const inserts = results.map(({ m, res, logId }) => {
      if (res.success) sentThis++;
      else errorsThis++;
      return env.DB.prepare(
        `INSERT INTO email_logs (id, tenant_id, member_id, to_email, template, resend_id, status, created_at)
         VALUES (?, ?, ?, ?, 'blast', ?, ?, ?)`
      ).bind(
        logId,
        blast.tenant_id,
        m.id,
        m.email,
        res.id || null,
        res.success ? "sent" : "failed",
        now
      );
    });
    await env.DB.batch(inserts);

    cursor = page[page.length - 1].email;
    if (page.length < CHUNK) {
      done = true;
      break;
    }
  }

  const newSent = (blast.sent_count || 0) + sentThis;
  const newErr = (blast.error_count || 0) + errorsThis;

  if (done) {
    await env.DB.prepare(
      `UPDATE blasts SET status = 'sent', sent_count = ?, error_count = ?, cursor_email = null WHERE id = ?`
    )
      .bind(newSent, newErr, blastId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE blasts SET status = 'sending', sent_count = ?, error_count = ?, cursor_email = ? WHERE id = ?`
    )
      .bind(newSent, newErr, cursor, blastId)
      .run();
  }

  return { sent: sentThis, done, errors: errorsThis };
}

/** Drain queued/sending blasts across tenants (cron). */
export async function processQueuedBlasts(env: Env): Promise<{
  blasts: number;
  emails: number;
}> {
  let blasts = 0;
  let emails = 0;
  try {
    const rows = await all<{ id: string }>(
      env.DB.prepare(
        `SELECT id FROM blasts
         WHERE status IN ('queued', 'sending')
         ORDER BY created_at ASC
         LIMIT 10`
      )
    );
    for (const r of rows) {
      const result = await processBlastChunk(env, r.id);
      blasts++;
      emails += result.sent;
    }
  } catch (e) {
    console.warn("processQueuedBlasts", e);
  }
  return { blasts, emails };
}
