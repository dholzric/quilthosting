import type { Env } from "../../types";

const RESEND_API = "https://api.resend.com/emails";

export type SendEmailParams = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
};

export type SendEmailResult = {
  id: string;
  success: boolean;
  error?: string;
};

/**
 * Send a transactional email via Resend.
 */
export async function sendEmail(
  env: Env,
  params: SendEmailParams
): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — email not sent");
    return { id: "", success: false, error: "Email not configured" };
  }

  const from = params.from || "QuiltHosting <noreply@quilthosting.com>";

  const body = {
    from,
    to: Array.isArray(params.to) ? params.to : [params.to],
    subject: params.subject,
    html: params.html,
    text: params.text,
    reply_to: params.replyTo,
    tags: params.tags,
  };

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as { id?: string; message?: string };

    if (!res.ok) {
      console.error("Resend error", data);
      return {
        id: "",
        success: false,
        error: data.message || "Failed to send email",
      };
    }

    return { id: data.id || "", success: true };
  } catch (err) {
    console.error("Resend fetch error", err);
    return {
      id: "",
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ---------- Email Templates ----------

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

export function eventConfirmationEmail(opts: {
  guildName: string;
  firstName?: string;
  eventTitle: string;
  eventDate: string;
  eventLocation?: string;
  amountFormatted?: string;
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
          ${opts.amountFormatted ? `<strong>Paid:</strong> ${opts.amountFormatted}` : ""}
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
