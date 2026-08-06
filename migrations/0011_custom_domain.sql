-- Custom domains: unique (case handled in app) when set
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_custom_domain
  ON tenants(custom_domain)
  WHERE custom_domain IS NOT NULL AND custom_domain != '';
