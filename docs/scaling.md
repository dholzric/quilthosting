# Scaling to large guilds (50k members)

QuiltHosting is multi-tenant on Cloudflare Workers + D1. This document describes
how the product stays correct under Wild Apricot–class list sizes.

## Design goals

| Concern | Approach |
|---------|----------|
| Member list | Server pagination + search (`limit`/`offset`/`page`/`q`/`status`) |
| Admin UI | Never loads full member table; page size 50 |
| CSV export | Keyset batches of 1,000 |
| CSV import | Up to 5,000 rows/request; email lookup via `IN (...)` batches |
| Email blasts | Count-only audience; queue + chunked send for >75 recipients |
| Cron | Processes queued blasts in chunks each tick (multiple passes) |
| Directory | 100 per page |
| API v1 | Paginated members (`limit` max 500) |
| Indexes | Migration `0009_scale.sql` |

## API shapes

### Members

```
GET /api/tenants/:id/members?page=1&limit=50&q=smith&status=active

{
  "members": [ ... ],
  "total": 12450,
  "limit": 50,
  "offset": 0,
  "page": 1,
  "total_pages": 249,
  "has_more": true
}
```

### Payments

```
GET /api/tenants/:id/payments?page=1&limit=50
→ { "payments": [...], "total", "page", ... }
```

### Blasts > 75 recipients

```
POST /api/tenants/:id/emails
→ { "queued": true, "recipients": 12000, "blast_id": "..." }
```

Status progresses: `queued` → `sending` → `sent` (see Email admin list).

## Operational limits (Cloudflare)

- Worker CPU / wall time: large blasts continue across cron ticks (`0 8 * * *` plus any manual `__scheduled`).
- D1: prefer indexes and keyset scans over `OFFSET` deep into large tables (search first).
- R2: files/logos/photos are fine at scale; not on the hot path for membership lists.

## Importing 50k members

Split CSVs into ≤5,000-row chunks. Run multiple import requests. Assign levels via
`level_name` column when possible so free-plan caps are applied correctly.

## Plan note

Platform free tier still caps **active** members at 30. Guild plan ($24) removes
the cap — D1/Workers can hold tens of thousands of member rows per tenant.
