# QuiltHosting documentation

Current design work: [Template design remediation plan — Codex, September 11](superpowers/plans/2026-09-11-template-design-remediation.md). Includes the refreshed 114-kit inventory, preview/application correctness, six signature families, Tailwind evaluation, and release gates.

## Product docs (served site)

Live under the site gate at **https://quilthosting.com/docs/** (same password as the rest of the private preview). Source HTML: `public/docs/*`, deployed with the Worker assets binding. Written for volunteer officers; every claim is checked against the code at v0.56.0-preview.

| Page | Path |
|------|------|
| Docs hub | [`/docs/`](../public/docs/index.html) |
| Getting started | [`/docs/getting-started.html`](../public/docs/getting-started.html) |
| Website builder | [`/docs/website-builder.html`](../public/docs/website-builder.html) |
| Members & levels | [`/docs/members-and-levels.html`](../public/docs/members-and-levels.html) |
| Events | [`/docs/events.html`](../public/docs/events.html) |
| Billing & payments | [`/docs/billing-payments.html`](../public/docs/billing-payments.html) |
| Email & automations | [`/docs/email-automations.html`](../public/docs/email-automations.html) |
| Roles & team | [`/docs/roles-and-team.html`](../public/docs/roles-and-team.html) |
| Member portal | [`/docs/member-portal.html`](../public/docs/member-portal.html) |
| Store & donations | [`/docs/store-and-donations.html`](../public/docs/store-and-donations.html) (old `website-store.html` now redirects here) |
| Forms | [`/docs/forms.html`](../public/docs/forms.html) |
| Domains | [`/docs/domains.html`](../public/docs/domains.html) |
| Business sites | [`/docs/business-sites.html`](../public/docs/business-sites.html) |
| Security & privacy | [`/docs/security-privacy.html`](../public/docs/security-privacy.html) |
| Troubleshooting | [`/docs/troubleshooting.html`](../public/docs/troubleshooting.html) |
| Feature reference | [`/docs/features.html`](../public/docs/features.html) |
| API & Zapier | [`/docs/api.html`](../public/docs/api.html) · [api.md](./api.md) |
| Admin sidebar map | [`/docs/admin-guide.html`](../public/docs/admin-guide.html) |

Shared stylesheet: `public/docs/docs.css` (on top of `public/qh.css`). Pages work without JavaScript.

## Internal / engineering (repo only)

| Doc | Purpose |
|-----|---------|
| [operations.md](./operations.md) | Deploy steps, migrations, every var and secret, external webhook URLs, cron, queues, rate limiting, site gate, CI, local dev, backups (none), platform admin bootstrap |
| [website-builder.md](./website-builder.md) | Draft/publish/CAS API contract for the page editor, block schema, sanitizer, redirects |
| [api.md](./api.md) | Public API v1: keys, scopes, endpoints, idempotency, hooks, error codes, CSV import contract |
| [zapier-webhooks.md](./zapier-webhooks.md) | Outbound webhook payloads, signature, delivery semantics, limits |
| [admin-guide.md](./admin-guide.md) | Pointer index into the served admin docs |
| [scaling.md](./scaling.md) | Pagination, queued blasts, 50k-member design (predates the minute cron — see operations.md) |
| [auto-renew-e2e.md](./auto-renew-e2e.md) | Auto-renew E2E checklist & results (last run Aug 2026; re-run before relying on it) |
| [signature-collection.md](./signature-collection.md) | The four kits that ship their own artwork: provenance and licence of the illustration, how `kit-asset:` refs resolve, and the two tests that keep the images from silently 404ing |
| [native-apps.md](./native-apps.md) | Expo iOS/Android apps in `apps/mobile/` (not built by CI) |
| [wildapricot-gap-analysis.md](./wildapricot-gap-analysis.md) | WA parity audit — evidence bar, most rows still unaudited |
| [competition-wild-apricot-alternatives.md](./competition-wild-apricot-alternatives.md) | Competitive notes |
| [getting-started.md](./getting-started.md), [website-store.md](./website-store.md) | Older markdown stubs; the served HTML pages are authoritative |
| [superpowers/](./superpowers/) | Implementation plans and design specs (note: `specs/2026-08-13-configurable-services-design.md` is spec-only, not implemented) |

Repo-root HTML index of all standalone docs: [`docs-library.html`](../docs-library.html).

## Operator quick links

- Admin: `/admin` (Google sign-in)
- Member portal: `/portal?slug=…`
- Public guild: `/g/…`, `https://<slug>.quilthosting.com`, or the custom domain
- Embeds: `/embed/:slug/join|events|store`
- API: `/api/v1/*` (exempt from the site gate)
- Manual cron: `GET|POST /__scheduled` with `X-Cron-Secret: <JWT_SECRET>` (daily branch only)
- Mobile: `apps/mobile/` (Expo)
