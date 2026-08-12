-- P0: business tenant type, per-tenant public launch, page SEO fields,
-- and the encrypted per-tenant credential store (populated in P4).

-- Business vs guild. Defaults to 'guild' so every existing tenant is unchanged.
ALTER TABLE tenants ADD COLUMN tenant_type TEXT NOT NULL DEFAULT 'guild';

-- Per-tenant public launch. Defaults to 0 so no tenant escapes the site gate
-- until explicitly launched.
ALTER TABLE tenants ADD COLUMN public_launched INTEGER NOT NULL DEFAULT 0;

-- Per-page SEO. All nullable; the renderer falls back to page.title and the
-- first text block when these are empty.
ALTER TABLE pages ADD COLUMN seo_title TEXT;
ALTER TABLE pages ADD COLUMN seo_description TEXT;
ALTER TABLE pages ADD COLUMN og_image_file_id TEXT;
ALTER TABLE pages ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0;

-- Encrypted per-tenant third-party credentials (PayPal client id/secret in P4).
-- Stripe is NOT stored here: tenants.stripe_account_id is a public identifier.
CREATE TABLE tenant_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  key TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_tenant_credentials
  ON tenant_credentials(tenant_id, provider, key);

-- Launched-tenant lookup runs on every request to a tenant host.
CREATE INDEX idx_tenants_launched
  ON tenants(tenant_type, public_launched);
