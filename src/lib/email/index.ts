import type { Env } from "../../types";
import { isSuppressed, normalizeEmail, unsubscribeUrl as buildUnsubscribeUrl } from "../suppression";
import { unsubscribeFooterHtml } from "./merge";

const RESEND_API = "https://api.resend.com/emails";

export type EmailKind = "transactional" | "marketing";

export type SendEmailParams = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
  /**
   * transactional (default): receipts, magic links, renewal notices — only
   * blocked by scope='all' suppressions (hard bounces).
   * marketing: blasts/automations — also blocked by member opt-out and
   * marketing suppressions, and gets List-Unsubscribe headers + footer.
   */
  kind?: EmailKind;
  /** Tenant the mail is sent on behalf of (needed for opt-out lookup + unsubscribe link). */
  tenantId?: string | null;
  /** Precomputed per-recipient unsubscribe URL; derived from tenantId + to when omitted. */
  unsubscribeUrl?: string;
  /** Shown in the appended unsubscribe footer. */
  guildName?: string | null;
  /** email_logs row to stamp with provider_message_id + delivery_status='accepted'. */
  emailLogId?: string;
  /** Caller already ran isSuppressed (e.g. audience selection) — skip the lookup. */
  skipSuppressionCheck?: boolean;
  /** Extra SMTP headers passed through to the provider. */
  headers?: Record<string, string>;
};

export type SendEmailResult = {
  /** Provider message id ("" on failure). */
  id: string;
  /** Provider accepted the message. Delivery is reported later via webhook. */
  success: boolean;
  error?: string;
  /** Not sent because the recipient is suppressed / opted out. */
  suppressed?: boolean;
  /** Suppression reason (bounce|complaint|unsubscribe|manual|opt_out). */
  reason?: string;
  /** HTTP status from the provider, when a request was made. */
  status?: number;
  /** 429 / 5xx / network — worth retrying with backoff. */
  retryable?: boolean;
  /** Provider Retry-After, in ms, when present. */
  retryAfterMs?: number;
  /** The unsubscribe URL that was embedded (marketing only). */
  unsubscribeUrl?: string;
};

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(h);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function unsubscribeMailto(appUrl: string): string {
  let host = "quilthosting.com";
  try {
    host = new URL(appUrl).hostname;
  } catch {
    /* keep default */
  }
  return `mailto:unsubscribe@${host}?subject=unsubscribe`;
}

export async function sendEmail(
  env: Env,
  params: SendEmailParams
): Promise<SendEmailResult> {
  const kind: EmailKind = params.kind === "marketing" ? "marketing" : "transactional";
  const recipients = (Array.isArray(params.to) ? params.to : [params.to])
    .map(normalizeEmail)
    .filter(Boolean);
  if (!recipients.length) {
    return { id: "", success: false, error: "No recipient" };
  }

  // Permission check first: a suppressed address is never sent, configured
  // provider or not.
  if (!params.skipSuppressionCheck && env.DB) {
    const kept: string[] = [];
    let lastReason: string | undefined;
    for (const addr of recipients) {
      let check: { suppressed: boolean; reason?: string };
      try {
        check = await isSuppressed(env.DB, params.tenantId ?? null, addr, kind);
      } catch (e) {
        // Pre-migration schema: fail open for transactional mail only.
        console.warn("suppression lookup failed", e);
        check = { suppressed: kind === "marketing", reason: "suppression_unavailable" };
      }
      if (check.suppressed) lastReason = check.reason;
      else kept.push(addr);
    }
    if (!kept.length) {
      return {
        id: "",
        success: false,
        suppressed: true,
        reason: lastReason,
        error: `Recipient suppressed (${lastReason || "unknown"})`,
      };
    }
    recipients.splice(0, recipients.length, ...kept);
  }

  // Never fake success: callers log `status='failed'` when this is false.
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — email not sent");
    return { id: "", success: false, error: "Email not configured", status: 0 };
  }

  const from =
    params.from || env.EMAIL_FROM || "QuiltHosting <noreply@quilthosting.com>";

  let html = params.html;
  let text = params.text;
  const headers: Record<string, string> = { ...(params.headers || {}) };
  let unsubUrl = params.unsubscribeUrl;

  if (kind === "marketing") {
    if (!unsubUrl && params.tenantId && recipients.length === 1 && env.JWT_SECRET) {
      unsubUrl = await buildUnsubscribeUrl(
        env.APP_URL,
        env.JWT_SECRET,
        params.tenantId,
        recipients[0]
      );
    }
    if (unsubUrl) {
      headers["List-Unsubscribe"] = `<${unsubUrl}>, <${unsubscribeMailto(env.APP_URL)}>`;
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      if (!html.includes(unsubUrl)) {
        html += unsubscribeFooterHtml(unsubUrl, params.guildName);
      }
      if (text && !text.includes(unsubUrl)) {
        text += `\n\nUnsubscribe: ${unsubUrl}`;
      }
    }
  }

  const body: Record<string, unknown> = {
    from,
    to: recipients,
    subject: params.subject,
    html,
    text,
    reply_to: params.replyTo,
    tags: params.tags,
  };
  if (Object.keys(headers).length) body.headers = headers;

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    let data: { id?: string; message?: string } = {};
    try {
      data = (await res.json()) as { id?: string; message?: string };
    } catch {
      data = {};
    }

    if (!res.ok) {
      console.error("Resend error", res.status, data);
      return {
        id: "",
        success: false,
        error: data.message || `Failed to send email (HTTP ${res.status})`,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")),
        unsubscribeUrl: unsubUrl,
      };
    }

    const id = data.id || "";
    if (params.emailLogId && env.DB && id) {
      try {
        await env.DB.prepare(
          `UPDATE email_logs SET provider_message_id = ?, delivery_status = 'accepted',
             resend_id = COALESCE(resend_id, ?)
           WHERE id = ?`
        )
          .bind(id, id, params.emailLogId)
          .run();
      } catch (e) {
        console.warn("email_logs stamp failed", e);
      }
    }
    return { id, success: true, status: res.status, unsubscribeUrl: unsubUrl };
  } catch (err) {
    console.error("Resend fetch error", err);
    return {
      id: "",
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
      retryable: true,
      unsubscribeUrl: unsubUrl,
    };
  }
}

/** 1×1 transparent GIF open-tracking pixel */
export function trackingPixelHtml(appUrl: string, emailLogId: string): string {
  const base = appUrl.replace(/\/$/, "");
  return `<img src="${base}/t/o/${encodeURIComponent(emailLogId)}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
}

export function welcomeEmail(opts: {
  guildName: string;
  firstName?: string;
  portalUrl: string;
}): { subject: string; html: string } {
  const name = opts.firstName || "there";
  return {
    subject: `Welcome to ${opts.guildName}!`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">Welcome, ${name}!</h1>
        <p>You're now a member of <strong>${opts.guildName}</strong>.</p>
        <p>You can manage your membership, view upcoming events, and update your profile anytime:</p>
        <p style="margin: 24px 0;">
          <a href="${opts.portalUrl}"
             style="background: #c45c26; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Go to Member Portal
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">See you at the next meeting!</p>
      </div>
    `,
  };
}

export function renewalReminderEmail(opts: {
  guildName: string;
  firstName?: string;
  daysLeft: number;
  renewUrl: string;
  amountFormatted: string;
}): { subject: string; html: string } {
  const name = opts.firstName || "there";
  return {
    subject: `Your ${opts.guildName} membership renews in ${opts.daysLeft} days`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">Membership renewal coming up</h1>
        <p>Hi ${name},</p>
        <p>Your membership with <strong>${opts.guildName}</strong> renews in <strong>${opts.daysLeft} days</strong>.</p>
        <p>Amount due: <strong>${opts.amountFormatted}</strong></p>
        <p style="margin: 24px 0;">
          <a href="${opts.renewUrl}"
             style="background: #c45c26; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Renew Now
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">Thank you for being part of our guild.</p>
      </div>
    `,
  };
}

/**
 * Transactional notice for an auto-renew charge Stripe could not collect
 * (invoice.payment_failed). Points at the portal renew page so the member
 * can pay with a new card before the membership lapses.
 */
export function paymentFailedEmail(opts: {
  guildName: string;
  firstName?: string;
  amountFormatted: string;
  renewUrl: string;
}): { subject: string; html: string } {
  const name = opts.firstName || "there";
  return {
    subject: `Action needed: your ${opts.guildName} membership payment failed`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">We couldn't process your renewal</h1>
        <p>Hi ${name},</p>
        <p>The automatic renewal payment of <strong>${opts.amountFormatted}</strong> for your membership with <strong>${opts.guildName}</strong> did not go through. This usually means the card on file has expired or was declined.</p>
        <p>Please update your card or pay your dues so your membership stays active:</p>
        <p style="margin: 24px 0;">
          <a href="${opts.renewUrl}"
             style="background: #c45c26; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Update payment
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">If you have already paid, you can ignore this email.</p>
        <p style="color: #666; font-size: 14px;">— ${opts.guildName}</p>
      </div>
    `,
  };
}

/**
 * Lighter renewal notice for auto-renew members: no "renew now" button, just
 * the date and amount the card on file will be charged.
 */
export function autoRenewNoticeEmail(opts: {
  guildName: string;
  firstName?: string;
  renewDate: string;
  amountFormatted: string;
  portalUrl: string;
}): { subject: string; html: string } {
  const name = opts.firstName || "there";
  return {
    subject: `Your ${opts.guildName} membership renews automatically on ${opts.renewDate}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">Your membership renews soon</h1>
        <p>Hi ${name},</p>
        <p>Your membership with <strong>${opts.guildName}</strong> will renew automatically on <strong>${opts.renewDate}</strong>. The card on file will be charged <strong>${opts.amountFormatted}</strong>.</p>
        <p>Nothing to do — this is just a heads-up. To update your card or change your membership, visit the member portal:</p>
        <p style="margin: 24px 0;">
          <a href="${opts.portalUrl}"
             style="background: #c45c26; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Member Portal
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">Thank you for being part of our guild.</p>
      </div>
    `,
  };
}

export function eventConfirmationEmail(opts: {
  guildName: string;
  firstName?: string;
  eventTitle: string;
  eventDate: string;
  eventLocation?: string;
  amountFormatted?: string;
  ticketCode?: string;
}): { subject: string; html: string } {
  const name = opts.firstName || "there";
  return {
    subject: `You're registered for ${opts.eventTitle}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">Registration confirmed</h1>
        <p>Hi ${name},</p>
        <p>You're registered for:</p>
        <p style="font-size: 18px; font-weight: 600;">${opts.eventTitle}</p>
        <p>
          <strong>When:</strong> ${opts.eventDate}<br/>
          ${opts.eventLocation ? `<strong>Where:</strong> ${opts.eventLocation}<br/>` : ""}
          ${opts.amountFormatted ? `<strong>Paid:</strong> ${opts.amountFormatted}<br/>` : ""}
          ${opts.ticketCode ? `<strong>Ticket code:</strong> ${opts.ticketCode}` : ""}
        </p>
        <p style="color: #666; font-size: 14px;">— ${opts.guildName}</p>
      </div>
    `,
  };
}

export function magicLinkEmail(opts: {
  guildName: string;
  loginUrl: string;
}): { subject: string; html: string } {
  return {
    subject: `Your login link for ${opts.guildName}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">Sign in to ${opts.guildName}</h1>
        <p>Click the button below to sign in. This link expires in 15 minutes.</p>
        <p style="margin: 24px 0;">
          <a href="${opts.loginUrl}"
             style="background: #c45c26; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Sign In
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  };
}

export function paymentReceiptEmail(opts: {
  guildName: string;
  firstName?: string;
  description: string;
  amountFormatted: string;
  typeLabel: string;
}): { subject: string; html: string } {
  const name = opts.firstName || "there";
  return {
    subject: `Receipt: ${opts.description}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">Payment received</h1>
        <p>Hi ${name},</p>
        <p>Thank you for your ${opts.typeLabel} to <strong>${opts.guildName}</strong>.</p>
        <p style="font-size: 18px; font-weight: 600;">${opts.amountFormatted}</p>
        <p>${opts.description}</p>
        <p style="color: #666; font-size: 14px;">— ${opts.guildName}</p>
      </div>
    `,
  };
}

export function waitlistPromotedEmail(opts: {
  guildName: string;
  firstName?: string;
  eventTitle: string;
  eventDate: string;
  eventLocation?: string;
  ticketCode?: string;
}): { subject: string; html: string } {
  const name = opts.firstName || "there";
  return {
    subject: `You're in! Spot opened for ${opts.eventTitle}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">You're off the waitlist</h1>
        <p>Hi ${name},</p>
        <p>Good news — a spot opened and you're now registered for:</p>
        <p style="font-size: 18px; font-weight: 600;">${opts.eventTitle}</p>
        <p>
          <strong>When:</strong> ${opts.eventDate}<br/>
          ${opts.eventLocation ? `<strong>Where:</strong> ${opts.eventLocation}<br/>` : ""}
          ${opts.ticketCode ? `<strong>Ticket:</strong> ${opts.ticketCode}` : ""}
        </p>
        <p style="color: #666; font-size: 14px;">— ${opts.guildName}</p>
      </div>
    `,
  };
}

export function winBackEmail(opts: {
  guildName: string;
  firstName?: string;
  renewUrl: string;
}): { subject: string; html: string } {
  const name = opts.firstName || "there";
  return {
    subject: `We miss you at ${opts.guildName}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="color: #1a1a1a;">Come back anytime</h1>
        <p>Hi ${name},</p>
        <p>Your membership with <strong>${opts.guildName}</strong> has lapsed — we'd love to have you back.</p>
        <p style="margin: 24px 0;">
          <a href="${opts.renewUrl}"
             style="background: #c45c26; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Renew membership
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">— ${opts.guildName}</p>
      </div>
    `,
  };
}
