-- Phase 2 Task A: the newsletter_signup section posts to
-- POST /public/:slug/newsletter, which records the address here. One row per
-- (tenant, email): the route upserts, so a visitor who signs up twice (or from
-- two sections) never produces a duplicate and never sees an error. Admin UI
-- for reading the list is out of scope for this phase.
CREATE TABLE newsletter_signups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,            -- normalized: trimmed, lower-cased
  name TEXT,
  source TEXT NOT NULL DEFAULT 'site', -- 'site' = public newsletter_signup section
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_newsletter_signups_tenant_email ON newsletter_signups(tenant_id, email);
CREATE INDEX idx_newsletter_signups_tenant_created ON newsletter_signups(tenant_id, created_at DESC);
