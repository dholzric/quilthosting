# Zapier / Make outbound webhooks

Admin → **Zapier** (or API: `/api/tenants/:id/webhooks`).

## Setup in Zapier

1. Create a Zap → **Webhooks by Zapier** → **Catch Hook**.  
2. Copy the URL into QuiltHosting → Zapier → Add endpoint.  
3. Subscribe to events (or `*`).  
4. Save the **signing secret** shown once.  
5. Send **Test** from QuiltHosting; continue the Zap.

## Payload

```json
{
  "id": "delivery-uuid",
  "event": "member.activated",
  "created_at": "2026-08-06T12:00:00.000Z",
  "tenant_id": "…",
  "data": { }
}
```

Headers: `X-QH-Event`, `X-QH-Delivery`, `X-QH-Signature` (HMAC-SHA256 hex of raw body).

## Events

| Event | When |
|-------|------|
| `member.activated` | Membership becomes active |
| `membership.activated` | Same + level metadata |
| `payment.succeeded` | Checkout completed |
| `form.response` | Public form submitted |
| `*` | All |

REST pull API remains at `/api/v1/*` with API keys.
