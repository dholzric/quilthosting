-- Onboarding: platform-subdomain provisioning status + server-side checklist state.
--
-- domain_status: pending | active | failed | skipped (NULL on pre-existing rows =
-- unknown; the retry endpoint fills it in). domain_error carries the last
-- Cloudflare error message when status = 'failed'. onboarding_json holds the
-- admin's checklist preferences ({"dismissed_at": ISO}); every checklist step
-- itself is computed from real tables (src/lib/onboarding.ts), never stored.
ALTER TABLE tenants ADD COLUMN domain_status TEXT;
ALTER TABLE tenants ADD COLUMN domain_error TEXT;
ALTER TABLE tenants ADD COLUMN onboarding_json TEXT;
