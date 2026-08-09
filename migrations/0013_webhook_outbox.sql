-- Durable outbox: a row is written inside the mutation, dispatched out-of-band.
-- Replaces best-effort inline fetch, which lost events if the Worker was
-- cancelled between commit and delivery and made the user wait on slow endpoints.
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_outbox_sweep ON webhook_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON webhook_outbox(tenant_id, created_at);

-- Idempotency for v1 writes: Zapier retries, and without this a retried create
-- returns 409 and the Zap reports failure for a member that actually exists.
CREATE TABLE IF NOT EXISTS api_idempotency (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_key ON api_idempotency(tenant_id, idempotency_key);

-- Secret rotation + auto-disable support on endpoints.
ALTER TABLE webhook_endpoints ADD COLUMN secret_rotated_at TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN disabled_reason TEXT;
