/**
 * Process queued/sending blasts in chunks so 50k audiences fit Worker limits.
 *
 * Guarantees (migration 0023):
 *   - Lease: only one processor works a blast at a time. processBlastChunk
 *     takes `blasts.lease_until` with a conditional UPDATE and exits with
 *     {claimed:false} when someone else holds it. The lease is renewed after
 *     every chunk and released at the end.
 *   - Bounded concurrency (10) with retry/backoff on 429/5xx/network (3
 *     attempts, honouring Retry-After).
 *   - Per-recipient outcome rows in email_logs (blast_id + delivery_status
 *     accepted|failed). A recipient that still fails after retries is
 *     recorded as failed; the blast finishes as 'partial' (not 'sent') and
 *     can be re-run over just the failed rows via queueFailedRetry().
 *   - If an entire page fails with retryable errors (provider down, key
 *     revoked mid-run) the cursor is NOT advanced: nothing is recorded, the
 *     lease is released, and the next tick retries the same page.
 *   - Suppressed / opted-out recipients are excluded by the audience query
 *     and, as a belt-and-braces check, by sendEmail(kind:'marketing');
 *     those count as skipped_count.
 *   - Every recipient gets an HMAC one-click unsubscribe link
 *     ({{unsubscribe_url}} in the template, else an appended footer) and
 *     List-Unsubscribe headers.
 */
import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";
import { sendEmail, trackingPixelHtml, type SendEmailParams, type SendEmailResult } from "./email";
import {
  applyMergeFields,
  wrapEmailLayout,
  type EmailLayout,
} from "./email/merge";
import { fetchAudiencePage, type AudienceMember } from "./audience";
import { wrapLinksForTracking } from "./automations";
import { unsubscribeUrl } from "./suppression";

const PAGE = 40; // recipients fetched per page
const CONCURRENCY = 10; // in-flight sends
const MAX_PAGES_PER_RUN = 5; // up to ~200 emails per cron tick / waitUntil
const MAX_ATTEMPTS = 3;
const LEASE_MS = 3 * 60 * 1000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

/** Sentinel merged into templates, swapped for the real link after tracking-wrap. */
const UNSUB_SENTINEL = "QH_UNSUBSCRIBE_URL_SENTINEL";

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
  skipped_count: number | null;
  retry_failed: number | null;
  cursor_email: string | null;
  status: string;
};

export type BlastChunkResult = {
  sent: number;
  done: boolean;
  errors: number;
  skipped: number;
  /** false when another processor holds the lease (nothing was done). */
  claimed: boolean;
  /** true when a whole page failed with retryable errors and the cursor was held. */
  stalled?: boolean;
};

export type BlastSendOptions = {
  /** Injectable for tests. */
  send?: (env: Env, params: SendEmailParams) => Promise<SendEmailResult>;
  sleep?: (ms: number) => Promise<void>;
  owner?: string;
  now?: () => number;
};

function mergeCtx(m: AudienceMember, guildName: string) {
  return {
    first_name: m.first_name,
    last_name: m.last_name,
    email: m.email,
    guild_name: guildName,
    level_name: m.level_name,
    end_date: m.end_date,
    unsubscribe_url: UNSUB_SENTINEL,
  };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** sendEmail with bounded retries on 429/5xx/network. */
export async function sendWithRetry(
  env: Env,
  params: SendEmailParams,
  opts: { send?: BlastSendOptions["send"]; sleep?: BlastSendOptions["sleep"] } = {}
): Promise<SendEmailResult & { attempts: number }> {
  const send = opts.send || sendEmail;
  const sleep = opts.sleep || defaultSleep;
  let last: SendEmailResult = { id: "", success: false, error: "not attempted" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await send(env, params);
    if (last.success || last.suppressed || !last.retryable) {
      return { ...last, attempts: attempt };
    }
    if (attempt < MAX_ATTEMPTS) {
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
      const wait = last.retryAfterMs != null ? Math.min(30_000, last.retryAfterMs) : backoff;
      await sleep(wait + Math.floor(Math.random() * 100));
    }
  }
  return { ...last, attempts: MAX_ATTEMPTS };
}

/**
 * Take the sending lease. Returns true only when this caller now owns it.
 * A lease is available when unset or expired.
 */
export async function acquireBlastLease(
  db: D1Database,
  blastId: string,
  owner: string,
  nowMs = Date.now()
): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString();
  const until = new Date(nowMs + LEASE_MS).toISOString();
  const res = await db
    .prepare(
      `UPDATE blasts SET lease_until = ?, lease_owner = ?
       WHERE id = ? AND status IN ('queued', 'sending')
         AND (lease_until IS NULL OR lease_until < ?)`
    )
    .bind(until, owner, blastId, nowIso)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

async function renewLease(db: D1Database, blastId: string, owner: string, nowMs: number) {
  await db
    .prepare(`UPDATE blasts SET lease_until = ? WHERE id = ? AND lease_owner = ?`)
    .bind(new Date(nowMs + LEASE_MS).toISOString(), blastId, owner)
    .run();
}

async function releaseLease(db: D1Database, blastId: string, owner: string) {
  await db
    .prepare(
      `UPDATE blasts SET lease_until = NULL, lease_owner = NULL WHERE id = ? AND lease_owner = ?`
    )
    .bind(blastId, owner)
    .run();
}

/** Recipients whose last attempt failed, for retry_failed runs (keyset on email). */
async function fetchFailedPage(
  db: D1Database,
  blastId: string,
  afterEmail: string,
  limit: number
): Promise<(AudienceMember & { log_id: string })[]> {
  return all<AudienceMember & { log_id: string }>(
    db
      .prepare(
        `SELECT l.id as log_id, m.id, m.email, m.first_name, m.last_name,
                null as level_name, null as end_date
         FROM email_logs l
         JOIN members m ON m.id = l.member_id
         WHERE l.blast_id = ? AND l.delivery_status = 'failed'
           AND m.status != 'cancelled' AND m.email_opt_out_at IS NULL
           AND (? = '' OR m.email > ?)
         ORDER BY m.email
         LIMIT ?`
      )
      .bind(blastId, afterEmail, afterEmail, limit)
  );
}

/**
 * Re-queue a 'partial' (or 'sent' with failures) blast so the next run sends
 * only to recipients whose log row is delivery_status='failed'.
 */
export async function queueFailedRetry(
  env: Env,
  blastId: string
): Promise<{ queued: boolean }> {
  const res = await env.DB.prepare(
    `UPDATE blasts SET status = 'queued', retry_failed = 1, cursor_email = NULL,
        lease_until = NULL, lease_owner = NULL
     WHERE id = ? AND status IN ('partial', 'sent', 'failed') AND error_count > 0`
  )
    .bind(blastId)
    .run();
  return { queued: (res.meta?.changes ?? 0) === 1 };
}

export async function processBlastChunk(
  env: Env,
  blastId: string,
  opts: BlastSendOptions = {}
): Promise<BlastChunkResult> {
  const now = opts.now || Date.now;
  const owner = opts.owner || `w:${generateId().slice(0, 8)}`;
  const idle: BlastChunkResult = { sent: 0, done: true, errors: 0, skipped: 0, claimed: true };

  const blast = await first<BlastRow>(
    env.DB.prepare(`SELECT * FROM blasts WHERE id = ?`).bind(blastId)
  );
  if (!blast || (blast.status !== "queued" && blast.status !== "sending")) {
    return idle;
  }

  if (!(await acquireBlastLease(env.DB, blastId, owner, now()))) {
    return { ...idle, done: false, claimed: false };
  }

  try {
    const tenant = await first<{ id: string; name: string }>(
      env.DB.prepare(`SELECT id, name FROM tenants WHERE id = ?`).bind(blast.tenant_id)
    );
    if (!tenant) {
      await env.DB.prepare(
        `UPDATE blasts SET status = 'failed', cursor_email = NULL, last_error = 'tenant missing' WHERE id = ?`
      )
        .bind(blastId)
        .run();
      return idle;
    }

    await env.DB.prepare(
      `UPDATE blasts SET status = 'sending' WHERE id = ? AND status = 'queued'`
    )
      .bind(blastId)
      .run();

    const layout: EmailLayout =
      blast.layout === "newsletter" || blast.layout === "announcement"
        ? (blast.layout as EmailLayout)
        : "plain";
    const retryMode = Boolean(blast.retry_failed);

    let cursor = blast.cursor_email || "";
    let sentThis = 0;
    let errorsThis = 0;
    let skippedThis = 0;
    let recoveredThis = 0; // retry-mode: previously failed rows now accepted
    let done = false;
    let stalled = false;
    let lastError: string | null = null;

    for (let p = 0; p < MAX_PAGES_PER_RUN; p++) {
      const page: (AudienceMember & { log_id?: string })[] = retryMode
        ? await fetchFailedPage(env.DB, blastId, cursor, PAGE)
        : await fetchAudiencePage(env.DB, blast.tenant_id, blast.segment, {
            limit: PAGE,
            afterEmail: cursor || null,
          });
      if (!page.length) {
        done = true;
        break;
      }

      const nowIso = new Date(now()).toISOString();
      const results = await mapBounded(page, CONCURRENCY, async (m) => {
        const logId = m.log_id || generateId();
        const unsubUrl = await unsubscribeUrl(
          env.APP_URL,
          env.JWT_SECRET,
          blast.tenant_id,
          m.email
        );
        const ctx = mergeCtx(m, tenant.name);
        const subject = applyMergeFields(blast.subject, ctx);
        let html = wrapEmailLayout(layout, {
          guildName: tenant.name,
          subject,
          bodyHtml: applyMergeFields(blast.body_html, ctx),
        });
        html = wrapLinksForTracking(html, env.APP_URL, logId);
        html += trackingPixelHtml(env.APP_URL, logId);
        html = html.split(UNSUB_SENTINEL).join(unsubUrl);
        const text = blast.body_text
          ? applyMergeFields(blast.body_text, ctx).split(UNSUB_SENTINEL).join(unsubUrl)
          : undefined;
        const res = await sendWithRetry(
          env,
          {
            to: m.email,
            subject,
            html,
            text,
            kind: "marketing",
            tenantId: blast.tenant_id,
            unsubscribeUrl: unsubUrl,
            guildName: tenant.name,
            tags: [
              { name: "template", value: "blast" },
              { name: "blast", value: blast.id.slice(0, 32) },
            ],
          },
          opts
        );
        return { m, res, logId };
      });

      // Whole page failed for retryable reasons: hold the cursor, record
      // nothing, let the next tick retry the same recipients.
      const retryableFailures = results.filter(
        (r) => !r.res.success && !r.res.suppressed && r.res.retryable
      );
      if (retryableFailures.length === results.length) {
        lastError = retryableFailures[0].res.error || "provider unavailable";
        stalled = true;
        break;
      }

      const writes: D1PreparedStatement[] = [];
      for (const { m, res, logId } of results) {
        if (res.success) {
          sentThis++;
          if (retryMode) recoveredThis++;
        } else if (res.suppressed) {
          skippedThis++;
          if (retryMode) recoveredThis++; // no longer a pending failure
        } else {
          errorsThis++;
          lastError = res.error || lastError;
        }
        const deliveryStatus = res.success ? "accepted" : res.suppressed ? "skipped" : "failed";
        const legacyStatus = res.success ? "sent" : res.suppressed ? "skipped" : "failed";
        const err = res.success ? null : (res.error || res.reason || "failed").slice(0, 500);
        if (retryMode && m.log_id) {
          writes.push(
            env.DB.prepare(
              `UPDATE email_logs SET status = ?, delivery_status = ?, delivery_error = ?,
                  resend_id = COALESCE(?, resend_id), provider_message_id = COALESCE(?, provider_message_id)
               WHERE id = ?`
            ).bind(legacyStatus, deliveryStatus, err, res.id || null, res.id || null, m.log_id)
          );
        } else {
          writes.push(
            env.DB.prepare(
              `INSERT INTO email_logs
                 (id, tenant_id, member_id, to_email, template, resend_id, status, created_at,
                  blast_id, delivery_status, provider_message_id, delivery_error)
               VALUES (?, ?, ?, ?, 'blast', ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              logId,
              blast.tenant_id,
              m.id,
              m.email,
              res.id || null,
              legacyStatus,
              nowIso,
              blast.id,
              deliveryStatus,
              res.id || null,
              err
            )
          );
        }
      }
      if (writes.length) await env.DB.batch(writes);

      cursor = page[page.length - 1].email;
      await env.DB.prepare(
        `UPDATE blasts SET cursor_email = ?, sent_count = sent_count + ?, error_count = error_count + ?,
            skipped_count = COALESCE(skipped_count, 0) + ?, last_error = ?
         WHERE id = ?`
      )
        .bind(cursor, sentThis, errorsThis, skippedThis, lastError, blastId)
        .run();
      // Counters are now persisted; reset the per-page deltas. (In retry
      // mode error_count is recomputed from the failed rows at the end.)
      sentThis = errorsThis = skippedThis = 0;
      await renewLease(env.DB, blastId, owner, now());

      if (page.length < PAGE) {
        done = true;
        break;
      }
    }

    if (stalled) {
      await env.DB.prepare(
        `UPDATE blasts SET status = 'sending', last_error = ? WHERE id = ?`
      )
        .bind(lastError, blastId)
        .run();
      return { sent: 0, done: false, errors: 0, skipped: 0, claimed: true, stalled: true };
    }

    // Read back the persisted totals to decide the final status.
    const totals = await first<{ sent_count: number; error_count: number; skipped_count: number }>(
      env.DB.prepare(`SELECT sent_count, error_count, skipped_count FROM blasts WHERE id = ?`).bind(
        blastId
      )
    );
    const sentTotal = totals?.sent_count ?? 0;
    let errTotal = totals?.error_count ?? 0;

    if (done) {
      if (retryMode) {
        // error_count = remaining failed rows (a retry that succeeded
        // removed the row from the failed set).
        const remaining = await first<{ cnt: number }>(
          env.DB.prepare(
            `SELECT COUNT(*) as cnt FROM email_logs WHERE blast_id = ? AND delivery_status = 'failed'`
          ).bind(blastId)
        );
        errTotal = remaining?.cnt ?? 0;
      }
      const status = errTotal > 0 ? "partial" : "sent";
      await env.DB.prepare(
        `UPDATE blasts SET status = ?, error_count = ?, cursor_email = NULL, retry_failed = 0
         WHERE id = ?`
      )
        .bind(status, errTotal, blastId)
        .run();
    }

    return {
      sent: sentTotal - (blast.sent_count || 0),
      done,
      errors: done ? errTotal : (totals?.error_count ?? 0) - (blast.error_count || 0),
      skipped: (totals?.skipped_count ?? 0) - (blast.skipped_count || 0),
      claimed: true,
    };
  } finally {
    try {
      await releaseLease(env.DB, blastId, owner);
    } catch (e) {
      console.warn("blast lease release", e);
    }
  }
}

/** Drain queued/sending blasts across tenants (cron). */
export async function processQueuedBlasts(
  env: Env,
  opts: BlastSendOptions = {}
): Promise<{
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
      const result = await processBlastChunk(env, r.id, opts);
      if (!result.claimed) continue;
      blasts++;
      emails += result.sent;
    }
  } catch (e) {
    console.warn("processQueuedBlasts", e);
  }
  return { blasts, emails };
}
