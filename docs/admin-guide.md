# Admin guide (index)

The guild-facing admin documentation lives as HTML under `public/docs/` and is served at https://quilthosting.com/docs/ (behind the site gate while in stealth). This file is a pointer so repo readers can find the right page; it is not kept as a second copy.

| Topic | Page |
|---|---|
| Sidebar map — every admin screen and where it is documented | [`/docs/admin-guide.html`](../public/docs/admin-guide.html) |
| Getting started: sign-in, create guild, setup checklist, public URL | [`/docs/getting-started.html`](../public/docs/getting-started.html) |
| Website builder | [`/docs/website-builder.html`](../public/docs/website-builder.html) · developer contract: [website-builder.md](./website-builder.md) |
| Members, levels, custom fields, groups, dues by hand, renewals, CSV import/export | [`/docs/members-and-levels.html`](../public/docs/members-and-levels.html) |
| Events | [`/docs/events.html`](../public/docs/events.html) |
| Billing & payments | [`/docs/billing-payments.html`](../public/docs/billing-payments.html) |
| Email & automations, SMS | [`/docs/email-automations.html`](../public/docs/email-automations.html) |
| Roles & team (permission matrix from `src/lib/permissions.ts`) | [`/docs/roles-and-team.html`](../public/docs/roles-and-team.html) |
| Member portal | [`/docs/member-portal.html`](../public/docs/member-portal.html) |
| Store, donations, logo, embeds | [`/docs/store-and-donations.html`](../public/docs/store-and-donations.html) |
| Forms | [`/docs/forms.html`](../public/docs/forms.html) |
| Domains | [`/docs/domains.html`](../public/docs/domains.html) |
| Business sites (projects, quotes, launch) | [`/docs/business-sites.html`](../public/docs/business-sites.html) |
| Security & privacy | [`/docs/security-privacy.html`](../public/docs/security-privacy.html) |
| Troubleshooting | [`/docs/troubleshooting.html`](../public/docs/troubleshooting.html) |
| Feature reference | [`/docs/features.html`](../public/docs/features.html) |
| API & Zapier | [`/docs/api.html`](../public/docs/api.html) · [api.md](./api.md) · [zapier-webhooks.md](./zapier-webhooks.md) |

## Import contract (developer detail)

The CSV importer's full contract — payload shapes, every warning code, which codes force `partial`, batch statuses and the history endpoints — is in [api.md § Bulk member import](./api.md#bulk-member-import-admin-ui-not-the-v1-api). The user-facing explanation is in the Members page above.

## Roles

`owner` · `admin` · `membership` · `events` · `viewer` (plus the synthetic `platform` role for platform admins). Policy: `src/lib/permissions.ts`; enforcement: `src/middleware/permissions.ts`; client mirror for nav gating: `public/admin.html` (`ADMIN_ONLY_AREAS`, `ADMIN_AREAS`), pinned by `src/lib/adminNavGating.test.ts`.
