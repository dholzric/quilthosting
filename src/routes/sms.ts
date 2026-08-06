import { Hono } from "hono";
import type { Env, TenantVariables, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

export const smsRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

function twilioCreds(tenant: Tenant): { sid: string; token: string; from: string } | null {
  try {
    const s = JSON.parse(tenant.settings_json || "{}");
    const t = s.twilio || {};
    if (t.account_sid && t.auth_token && t.from_number) {
      return {
        sid: String(t.account_sid),
        token: String(t.auth_token),
        from: String(t.from_number),
      };
    }
  } catch {}
  return null;
}

smsRoutes.get("/logs", async (c) => {
  const tenant = c.get("tenant");
  try {
    const rows = await all(
      c.env.DB.prepare(
        `SELECT * FROM sms_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`
      ).bind(tenant.id)
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

smsRoutes.get("/config", async (c) => {
  const tenant = c.get("tenant");
  const creds = twilioCreds(tenant);
  return c.json({
    configured: !!creds,
    from_number: creds?.from || null,
  });
});

smsRoutes.post("/send", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{
    member_id?: string;
    phone?: string;
    body: string;
  }>();
  const text = (body.body || "").trim().slice(0, 1600);
  if (!text) return c.json({ error: "body is required" }, 400);

  let phone = (body.phone || "").trim();
  let memberId = body.member_id || null;
  if (memberId) {
    const m = await first<{ phone: string | null; id: string }>(
      c.env.DB.prepare(
        `SELECT id, phone FROM members WHERE id = ? AND tenant_id = ?`
      ).bind(memberId, tenant.id)
    );
    if (!m) return c.json({ error: "Member not found" }, 404);
    if (!phone) phone = m.phone || "";
  }
  if (!phone) return c.json({ error: "phone is required" }, 400);

  const id = generateId();
  const now = new Date().toISOString();
  const creds = twilioCreds(tenant);

  let status = "queued";
  let providerId: string | null = null;
  let error: string | null = null;

  if (creds) {
    try {
      const auth = btoa(`${creds.sid}:${creds.token}`);
      const params = new URLSearchParams({
        To: phone,
        From: creds.from,
        Body: text,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${creds.sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        }
      );
      const data = (await res.json()) as { sid?: string; message?: string; error_message?: string };
      if (res.ok && data.sid) {
        status = "sent";
        providerId = data.sid;
      } else {
        status = "failed";
        error = data.error_message || data.message || "Twilio error";
      }
    } catch (e: any) {
      status = "failed";
      error = e.message || "Twilio request failed";
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO sms_logs (id, tenant_id, member_id, phone, body, status, provider_id, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, tenant.id, memberId, phone, text, status, providerId, error, now)
    .run();

  return c.json(
    {
      id,
      status,
      provider_id: providerId,
      error,
      message:
        status === "queued"
          ? "SMS queued (configure Twilio in Settings → SMS to send live)."
          : status === "sent"
            ? "SMS sent."
            : error,
    },
    status === "failed" ? 502 : 201
  );
});
