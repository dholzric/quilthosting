/**
 * Outbound webhooks for Zapier / Make / custom integrations.
 * Fire-and-forget from domain events; failures logged, never block main flow.
 */
import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";

export type WebhookEvent =
  | "member.created"
  | "member.activated"
  | "member.updated"
  | "membership.activated"
  | "payment.succeeded"
  | "event.registration"
  | "form.response"
  | "*";

type Endpoint = {
  id: string;
  tenant_id: string;
  url: string;
  secret: string | null;
  events_json: string;
  is_active: number;
};

function wantsEvent(eventsJson: string, event: string): boolean {
  try {
    const arr = JSON.parse(eventsJson || "[]");
    if (!Array.isArray(arr) || !arr.length) return true;
    return arr.includes("*") || arr.includes(event);
  } catch {
    return true;
  }
}

async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function emitTenantEvent(
  env: Env,
  tenantId: string,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const endpoints = await all<Endpoint>(
      env.DB.prepare(
        `SELECT * FROM webhook_endpoints
         WHERE tenant_id = ? AND is_active = 1`
      ).bind(tenantId)
    );
    if (!endpoints.length) return;

    const payload = {
      id: generateId(),
      event,
      created_at: new Date().toISOString(),
      tenant_id: tenantId,
      data,
    };
    const body = JSON.stringify(payload);

    await Promise.all(
      endpoints.map(async (ep) => {
        if (!wantsEvent(ep.events_json, event)) return;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "User-Agent": "QuiltHosting-Webhooks/1.0",
          "X-QH-Event": event,
          "X-QH-Delivery": payload.id,
        };
        if (ep.secret) {
          headers["X-QH-Signature"] = await signBody(ep.secret, body);
        }
        let statusCode: number | null = null;
        let success = 0;
        let error: string | null = null;
        try {
          const res = await fetch(ep.url, {
            method: "POST",
            headers,
            body,
          });
          statusCode = res.status;
          success = res.ok ? 1 : 0;
          if (!res.ok) error = `HTTP ${res.status}`;
        } catch (e: any) {
          error = e?.message || "fetch failed";
          success = 0;
        }
        const now = new Date().toISOString();
        try {
          await env.DB.prepare(
            `INSERT INTO webhook_deliveries
             (id, tenant_id, endpoint_id, event, payload_json, status_code, success, error, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              generateId(),
              tenantId,
              ep.id,
              event,
              body.slice(0, 8000),
              statusCode,
              success,
              error,
              now
            )
            .run();
          if (success) {
            await env.DB.prepare(
              `UPDATE webhook_endpoints SET fail_count = 0, last_status = ?, last_error = null,
               last_success_at = ?, updated_at = ? WHERE id = ?`
            )
              .bind(statusCode, now, now, ep.id)
              .run();
          } else {
            await env.DB.prepare(
              `UPDATE webhook_endpoints SET fail_count = coalesce(fail_count,0) + 1,
               last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`
            )
              .bind(statusCode, error, now, ep.id)
              .run();
          }
        } catch (e) {
          console.warn("webhook log failed", e);
        }
      })
    );
  } catch (e) {
    console.warn("emitTenantEvent", e);
  }
}
