# QuiltHosting

Membership + events platform for quilt (and craft) guilds.

**Domain:** quilthosting.com (purchased)

Built on Cloudflare Workers + D1 + R2 + KV. Alternative to Wild Apricot.
A product of **QuiltMap LLC** (parent company).

## Stack

Cloudflare Workers, Hono, D1, R2, KV, Stripe, Resend

## Quick start

```bash
npm install
npx wrangler d1 create quilthosting-db
# update wrangler.toml IDs
npm run db:migrate:local
npm run dev
```

Secrets: JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY

Production APP_URL: https://quilthosting.com

Admin: public/admin.html
Portal: public/portal.html?slug=YOUR_GUILD

## License

Private — QuiltHosting · QuiltMap LLC
