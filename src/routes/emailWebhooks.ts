/**
 * Resend delivery webhooks: POST /api/webhooks/resend
 *
 * Resend signs webhooks with Svix: headers `svix-id`, `svix-timestamp`,
 * `svix-signature` ("v1,<base64> v1,<base64> ..."); the secret is
 * `whsec_<base64 key>`; signed content is `${id}.${timestamp}.${rawBody}`.
 * Verified here on WebCrypto with no dependency. Timestamps older than 5
 * minutes (or too far in the future) are rejected.
 *
 * Idempotent: the svix-id is the primary key of email_events; a redelivered
 * event is acknowledged (200) and not re-applied.
 *
 * Effects:
 *   email.sent / delivered / delivery_delayed / bounced / complained update
 *   email_logs.delivery_status (+ delivery_error) matched by provider id.
 *   Hard bounce  -> global suppression (scope 'all', reason 'bounce').
 *   Complaint    -> tenant suppression (scope 'marketing', reason
 *                   'complaint') + members.email_opt_out_at; global marketing
 *                   suppression when the tenant is unknown.
 *   opened/clicked update the existing open/click counters.
 *
 * Mounted under the already-exempt /api/webhooks/ prefix of the site gate.
 * Returns 503 when RESEND_WEBHOOK_SECRET is unset: never process
 * unauthenticated delivery events.
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { first } from "../lib/db";
import { normalizeEmail, optOutMember, suppress } from "../lib/suppression";

export const emailWebhookRoutes = new Hono<{ Bindings: Env }>();

const TOLERANCE_SECONDS = 5 * 60;

function b64ToBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Compute the Svix v1 signature (base64) for a payload. Exported for tests. */
export async function svixSign(
  secret: string,
  id: string,
  timestamp: string,
  body: string
): Promise<string> {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = b64ToBytes(raw);
  if (!keyBytes) throw new Error("bad webhook secret");
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  );
  return bytesToB64(new Uint8Array(sig));
}

export async function verifySvix(
  secret: string,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, error: "missing svix headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, error: "bad timestamp" };
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return { ok: false, error: "stale timestamp" };

  let expected: string;
  try {
    expected = await svixSign(secret, id, timestamp, body);
  } catch {
    return { ok: false, error: "bad secret" };
  }
  const expectedBytes = new TextEncoder().encode(expected);
  for (const part of signature.split(/\s+/)) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    if (timingSafeEqual(expectedBytes, new TextEncoder().encode(sig))) return { ok: true };
  }
  return { ok: false, error: "signature mismatch" };
}

type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    click?: { link?: string };
    tags?: Record<string, string>;
  };
};

const STATUS_BY_TYPE: Record<string, string> = {
  "email.sent": "accepted",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
};

function isHardBounce(b: { type?: string; subType?: string } | undefined): boolean {
  const type = (b?.type || "").toLowerCase();
  if (!type) return true; // no classification -> treat as permanent
  return type === "permanent" || type === "hard";
}

emailWebhookRoutes.post("/resend", async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "webhook not configured" }, 503);

  const body = await c.req.text();
  const verdict = await verifySvix(
    secret,
    {
      id: c.req.header("svix-id"),
      timestamp: c.req.header("svix-timestamp"),
      signature: c.req.header("svix-signature"),
    },
    body
  );
  if (!verdict.ok) return c.json({ error: verdict.error }, 400);

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const eventId = c.req.header("svix-id")!;
  const type = event.type || "unknown";
  const providerId = event.data?.email_id || null;
  const toList = Array.isArray(event.data?.to)
    ? event.data!.to
    : event.data?.to
      ? [event.data.to]
      : [];
  const recipient = toList.length ? normalizeEmail(toList[0]) : null;
  const now = new Date().toISOString();

  // Map to our log row first so the event row carries the link.
  let log: { id: string; tenant_id: string; to_email: string } | null = null;
  if (providerId) {
    try {
      log = await first<{ id: string; tenant_id: string; to_email: string }>(
        c.env.DB.prepare(
          `SELECT id, tenant_id, to_email FROM email_logs
           WHERE provider_message_id = ? OR resend_id = ? LIMIT 1`
        ).bind(providerId, providerId)
      );
    } catch (e) {
      console.warn("email_logs lookup failed", e);
    }
  }

  // Idempotency gate.
  try {
    const ins = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO email_events (id, type, email_log_id, provider_message_id, recipient, payload_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(eventId, type, log?.id ?? null, providerId, recipient, body.slice(0, 16_000), now)
      .run();
    if (!(ins.meta?.changes ?? 0)) {
      return c.json({ ok: true, duplicate: true });
    }
  } catch (e) {
    // Table missing (pre-migration) — acknowledge so Resend stops retrying,
    // but do not apply state we cannot make idempotent.
    console.error("email_events insert failed", e);
    return c.json({ ok: true, ignored: true });
  }

  const email = normalizeEmail(log?.to_email || recipient || "");
  const tenantId = log?.tenant_id ?? null;
  const stmts: D1PreparedStatement[] = [];

  const status = STATUS_BY_TYPE[type];
  if (status && log) {
    let error: string | null = null;
    if (type === "email.bounced") {
      const b = event.data?.bounce;
      error = [b?.type, b?.subType, b?.message].filter(Boolean).join(": ") || "bounced";
    } else if (type === "email.complained") {
      error = "recipient marked as spam";
    } else if (type === "email.failed") {
      error = "provider failed to send";
    }
    // Never let a late "delivered" overwrite a bounce/complaint, and never
    // let "accepted" regress a later state.
    const rank: Record<string, number> = {
      accepted: 0,
      delayed: 1,
      delivered: 2,
      failed: 3,
      bounced: 4,
      complained: 5,
    };
    stmts.push(
      c.env.DB.prepare(
        `UPDATE email_logs
           SET delivery_status = ?, delivery_error = COALESCE(?, delivery_error),
               provider_message_id = COALESCE(provider_message_id, ?)
         WHERE id = ?
           AND (delivery_status IS NULL OR
                CASE delivery_status
                  WHEN 'accepted' THEN 0 WHEN 'delayed' THEN 1 WHEN 'delivered' THEN 2
                  WHEN 'failed' THEN 3 WHEN 'bounced' THEN 4 WHEN 'complained' THEN 5
                  ELSE -1 END <= ?)`
      ).bind(status, error, providerId, log.id, rank[status] ?? 0)
    );
  } else if (type === "email.opened" && log) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE email_logs SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?`
      ).bind(now, log.id)
    );
  } else if (type === "email.clicked" && log) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE email_logs SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?) WHERE id = ?`
      ).bind(now, log.id)
    );
  }

  try {
    if (stmts.length) await c.env.DB.batch(stmts);
  } catch (e) {
    console.error("email_logs update failed", e);
  }

  // Suppressions (separate statements: INSERT OR IGNORE + conditional UPDATE).
  try {
    if (type === "email.bounced" && email && isHardBounce(event.data?.bounce)) {
      await suppress(c.env.DB, {
        tenantId: null,
        email,
        reason: "bounce",
        scope: "all",
        source: `resend:${eventId}`,
      });
    } else if (type === "email.complained" && email) {
      await suppress(c.env.DB, {
        tenantId,
        email,
        reason: "complaint",
        scope: "marketing",
        source: `resend:${eventId}`,
      });
      if (tenantId) await optOutMember(c.env.DB, tenantId, email);
    }
  } catch (e) {
    console.error("suppression write failed", e);
  }

  return c.json({ ok: true, type, matched: Boolean(log) });
});
