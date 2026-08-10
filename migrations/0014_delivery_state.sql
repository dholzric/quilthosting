-- Per-(event, endpoint) delivery state. Previously the outbox row carried one
-- status for the whole fan-out, so if endpoint A succeeded and B failed, the
-- retry re-sent to BOTH and A saw avoidable duplicates.
CREATE TABLE IF NOT EXISTS webhook_delivery_targets (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (outbox_id) REFERENCES webhook_outbox(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_target_unique
  ON webhook_delivery_targets(outbox_id, endpoint_id);
CREATE INDEX IF NOT EXISTS idx_target_pending
  ON webhook_delivery_targets(status, outbox_id);

-- Lease so the queue and the one-minute sweeper cannot dispatch the same row
-- concurrently. claimed_at is for diagnostics; lease_until is the guard.
ALTER TABLE webhook_outbox ADD COLUMN lease_until TEXT;
ALTER TABLE webhook_outbox ADD COLUMN claimed_at TEXT;
