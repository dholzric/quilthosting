# QuiltHosting documentation

## Product docs (served site)

Live under the site gate at **https://quilthosting.com/docs/** (same password as the rest of the private preview).

| Page | Path |
|------|------|
| Docs hub | [`/docs/`](../public/docs/index.html) |
| Getting started | [`/docs/getting-started.html`](../public/docs/getting-started.html) |
| Admin guide | [`/docs/admin-guide.html`](../public/docs/admin-guide.html) |
| Member portal | [`/docs/member-portal.html`](../public/docs/member-portal.html) |
| Website, logo & store | [`/docs/website-store.html`](../public/docs/website-store.html) |
| Billing & payments | [`/docs/billing-payments.html`](../public/docs/billing-payments.html) |
| Email & automations | [`/docs/email-automations.html`](../public/docs/email-automations.html) |
| Public API & Zapier | [`/docs/api.html`](../public/docs/api.html) · [api.md](./api.md) |
| Feature reference | [`/docs/features.html`](../public/docs/features.html) |

Source HTML: `public/docs/*` (deployed with the Worker assets binding).

## Internal / engineering (repo only)

| Doc | Purpose |
|-----|---------|
| [api.md](./api.md) | API endpoints (markdown) |
| [auto-renew-e2e.md](./auto-renew-e2e.md) | Auto-renew E2E checklist & results |
| [wildapricot-gap-analysis.md](./wildapricot-gap-analysis.md) | WA parity audit |
| [competition-wild-apricot-alternatives.md](./competition-wild-apricot-alternatives.md) | Competitive notes |
| [scaling.md](./scaling.md) | Pagination, queued blasts, 50k-member design |

## Operator quick links

- Admin: `/admin`
- Member portal: `/portal?slug=…`
- Public guild: `/g/…`
- Embeds: `/embed/:slug/join|events|store`
