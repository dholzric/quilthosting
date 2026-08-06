-- Email blasts archive: newsletters viewable online after sending
CREATE TABLE blasts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  segment TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_blasts_tenant ON blasts(tenant_id, created_at DESC);
