# QuiltHosting

Membership + events platform for quilt (and craft) guilds.

**Domain:** [quilthosting.com](https://quilthosting.com)  
**Parent:** QuiltMap LLC  
**Stack:** Cloudflare Workers + Hono + D1 + R2 + KV · Stripe · Resend

Alternative to Wild Apricot with active-member pricing, in-app refunds, and quilt-guild workflows.

## Documentation

| | |
|--|--|
| **Product docs (live)** | [quilthosting.com/docs/](https://quilthosting.com/docs/) |
| **Docs index (repo)** | [docs/README.md](./docs/README.md) |
| **Getting started** | [docs/getting-started.md](./docs/getting-started.md) · HTML guide |
| **Admin / portal / billing** | under `public/docs/` |
| **Public API** | [docs/api.md](./docs/api.md) · `/docs/api.html` |
| **WA gap analysis** | [docs/wildapricot-gap-analysis.md](./docs/wildapricot-gap-analysis.md) |

HTML guides ship with the Worker (`public/docs/*`) and share the site access password while stealth.

## Quick start

```bash
npm install
npx wrangler d1 create quilthosting-db
# update wrangler.toml IDs
npm run db:migrate:local
npm run dev
```

| Surface | Path |
|---------|------|
| Marketing | `/` |
| Docs | `/docs/` |
| Admin | `/admin` |
| Portal | `/portal?slug=YOUR_GUILD` |
| Public guild | `/g/YOUR_GUILD` |

**Secrets:** `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `SITE_ACCESS_PASSWORD`  
**Production `APP_URL`:** https://quilthosting.com

## License

Private — QuiltHosting · QuiltMap LLC
