-- Idempotency records become operation-scoped reservations with an expiry.
--
-- Previously the unique key was (tenant_id, idempotency_key), so the same key
-- used on POST /members and PATCH /members/:id collided: one operation could
-- replay the other's response or report a spurious 422. Zapier reuses a task
-- id across a Zap's steps, so this is the normal case, not an edge case.
--
-- SQLite cannot add a column to a UNIQUE index in place, so the table is
-- rebuilt. Existing rows are discarded rather than migrated: they carry no
-- operation, so they cannot be scoped correctly, and a stale replay of an
-- unscoped record is exactly the bug being fixed. The window is small (the
-- feature shipped in 0.27.0-preview and is not yet in production use), and
-- losing a cached response only means a retry re-executes — which the new
-- reservation path then makes safe.
DROP TABLE IF EXISTS api_idempotency;

CREATE TABLE api_idempotency (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Method + canonical route, e.g. "POST /v1/members". Part of the key.
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  -- reserved: handler is running or the worker died mid-flight.
  -- completed: response_status/response_json are authoritative.
  status TEXT NOT NULL DEFAULT 'reserved',
  response_status INTEGER,
  response_json TEXT,
  -- A reserved row older than this is treated as abandoned and may be taken
  -- over, so a crashed worker cannot 409 a caller forever.
  reserved_until TEXT,
  -- After this, the row is deleted by the daily sweep. Bounds retention of
  -- response bodies, which contain member PII.
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_idem_scoped
  ON api_idempotency(tenant_id, operation, idempotency_key);
CREATE INDEX idx_idem_expiry ON api_idempotency(expires_at);
