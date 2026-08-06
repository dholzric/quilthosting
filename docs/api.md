# QuiltHosting Public API (v1)

Base URL: `https://quilthosting.com/api/v1`  
Auth: `Authorization: Bearer qh_…` (create keys in Admin → API)

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| GET | `/me` | read | Tenant id, name, slug, plan |
| GET | `/members?status=` | read | Members (max 500) |
| GET | `/events` | read | Events |
| GET | `/payments` | read | Payments |
| GET | `/levels` | read | Active membership levels |

## Zapier

1. Create a key (Admin → API).
2. Use Webhooks by Zapier GET against the endpoints above.
3. Schedule polls for new members/payments, or build a custom Zapier integration later.

HTML reference: `/docs/api.html`
