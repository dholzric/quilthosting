/**
 * QuickBooks Online integration (OAuth + invoice/payment export).
 * Credentials: QBO_CLIENT_ID / QBO_CLIENT_SECRET env, tokens in tenant settings_json.qbo
 */
import { Hono } from "hono";
import type { Env, TenantVariables, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";

export const qboRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

type QboTokens = {
  realm_id?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  connected_at?: string;
};

function parseSettings(json: string | null | undefined): Record<string, any> {
  try {
    return JSON.parse(json || "{}") || {};
  } catch {
    return {};
  }
}

function qboCreds(env: Env): { clientId: string; clientSecret: string } | null {
  const clientId = (env as any).QBO_CLIENT_ID as string | undefined;
  const clientSecret = (env as any).QBO_CLIENT_SECRET as string | undefined;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

qboRoutes.get("/status", async (c) => {
  const tenant = c.get("tenant");
  const creds = qboCreds(c.env);
  const settings = parseSettings(tenant.settings_json);
  const qbo = (settings.qbo || {}) as QboTokens;
  return c.json({
    platform_configured: !!creds,
    connected: !!(qbo.realm_id && qbo.refresh_token),
    realm_id: qbo.realm_id || null,
    connected_at: qbo.connected_at || null,
  });
});

/** Start OAuth — returns Intuit authorize URL */
qboRoutes.get("/connect", async (c) => {
  const tenant = c.get("tenant");
  const creds = qboCreds(c.env);
  if (!creds) {
    return c.json(
      {
        error:
          "QBO_CLIENT_ID and QBO_CLIENT_SECRET not configured on the platform. Add Intuit app credentials.",
      },
      503
    );
  }
  const state = `${tenant.id}.${generateId().slice(0, 8)}`;
  await c.env.KV.put(`qbo_oauth:${state}`, tenant.id, { expirationTtl: 600 });
  const redirect = `${c.env.APP_URL.replace(/\/$/, "")}/api/tenants/${tenant.id}/qbo/callback`;
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", state);
  return c.json({ url: url.toString(), redirect_uri: redirect });
});

qboRoutes.get("/callback", async (c) => {
  const code = c.req.query("code") || "";
  const state = c.req.query("state") || "";
  const realmId = c.req.query("realmId") || "";
  const tenant = c.get("tenant");
  const creds = qboCreds(c.env);
  if (!creds || !code) {
    return c.html("<p>QuickBooks connect failed — missing code or credentials.</p>", 400);
  }
  const stored = await c.env.KV.get(`qbo_oauth:${state}`);
  if (stored && stored !== tenant.id) {
    return c.html("<p>Invalid OAuth state.</p>", 400);
  }
  const redirect = `${c.env.APP_URL.replace(/\/$/, "")}/api/tenants/${tenant.id}/qbo/callback`;
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
    }).toString(),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !data.access_token) {
    return c.html(`<p>Token exchange failed: ${data.error || res.status}</p>`, 502);
  }
  const settings = parseSettings(tenant.settings_json);
  settings.qbo = {
    realm_id: realmId,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    connected_at: new Date().toISOString(),
  };
  await c.env.DB.prepare(
    `UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(JSON.stringify(settings), new Date().toISOString(), tenant.id)
    .run();
  return c.html(
    `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem">
     <h2>QuickBooks connected</h2>
     <p>You can close this window and return to QuiltHosting Settings.</p>
     <script>setTimeout(function(){ location.href='/admin#page=settings'; }, 1500);</script>
     </body></html>`
  );
});

async function refreshIfNeeded(
  env: Env,
  tenant: Tenant
): Promise<QboTokens | null> {
  const creds = qboCreds(env);
  if (!creds) return null;
  const settings = parseSettings(tenant.settings_json);
  const qbo = (settings.qbo || {}) as QboTokens;
  if (!qbo.refresh_token) return null;
  if (qbo.access_token && qbo.expires_at && qbo.expires_at > Date.now() + 60_000) {
    return qbo;
  }
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: qbo.refresh_token,
    }).toString(),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !data.access_token) return null;
  qbo.access_token = data.access_token;
  if (data.refresh_token) qbo.refresh_token = data.refresh_token;
  qbo.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  settings.qbo = qbo;
  await env.DB.prepare(
    `UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(JSON.stringify(settings), new Date().toISOString(), tenant.id)
    .run();
  return qbo;
}

/** Export recent succeeded payments as QBO JournalEntry-style JSON (for import/tools) + push if connected */
qboRoutes.post("/export-payments", async (c) => {
  const tenant = c.get("tenant");
  const body = (await c.req.json().catch(() => ({}))) as {
    days?: number;
    push?: boolean;
  };
  const days = Math.min(365, Math.max(1, Number(body.days) || 90));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const payments = await all<{
    id: string;
    type: string;
    amount_cents: number;
    description: string | null;
    created_at: string;
    member_email: string | null;
  }>(
    c.env.DB.prepare(
      `SELECT p.id, p.type, p.amount_cents, p.description, p.created_at, m.email as member_email
       FROM payments p
       LEFT JOIN members m ON m.id = p.member_id
       WHERE p.tenant_id = ? AND p.status = 'succeeded' AND p.created_at >= ?
       ORDER BY p.created_at DESC LIMIT 500`
    ).bind(tenant.id, since)
  );

  const journal = {
    generated_at: new Date().toISOString(),
    guild: tenant.name,
    currency: "USD",
    lines: payments.map((p) => ({
      id: p.id,
      date: p.created_at.slice(0, 10),
      amount: p.amount_cents / 100,
      memo: p.description || p.type,
      customer_email: p.member_email,
      type: p.type,
    })),
  };

  let pushed = 0;
  let pushError: string | null = null;
  if (body.push) {
    const tokens = await refreshIfNeeded(c.env, tenant);
    if (!tokens?.access_token || !tokens.realm_id) {
      pushError = "QuickBooks not connected";
    } else {
      // Create SalesReceipts (best-effort; sandbox/production via Intuit API)
      const base = `https://quickbooks.api.intuit.com/v3/company/${tokens.realm_id}`;
      for (const line of journal.lines.slice(0, 20)) {
        try {
          const res = await fetch(`${base}/salesreceipt?minorversion=65`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              Line: [
                {
                  Amount: line.amount,
                  DetailType: "SalesItemLineDetail",
                  Description: line.memo,
                  SalesItemLineDetail: {
                    Qty: 1,
                    UnitPrice: line.amount,
                  },
                },
              ],
              PrivateNote: `QuiltHosting ${line.id}`,
            }),
          });
          if (res.ok) pushed++;
          else {
            const err = await res.text();
            pushError = err.slice(0, 200);
            break;
          }
        } catch (e: any) {
          pushError = e.message;
          break;
        }
      }
    }
  }

  return c.json({
    journal,
    count: payments.length,
    pushed,
    push_error: pushError,
    note: "IIF export remains available at /payments/export.iif. Push uses QBO SalesReceipt (max 20/request).",
  });
});

qboRoutes.delete("/disconnect", async (c) => {
  const tenant = c.get("tenant");
  const settings = parseSettings(tenant.settings_json);
  delete settings.qbo;
  await c.env.DB.prepare(
    `UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(JSON.stringify(settings), new Date().toISOString(), tenant.id)
    .run();
  return c.json({ ok: true });
});
