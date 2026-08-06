-- Outbound Zapier/Make webhooks + QBO connection metadata on tenants (settings_json holds tokens)
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT,
  events_json TEXT NOT NULL DEFAULT '["*"]',
  is_active INTEGER NOT NULL DEFAULT 1,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON webhook_endpoints(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status_code INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ep ON webhook_deliveries(endpoint_id, created_at);
