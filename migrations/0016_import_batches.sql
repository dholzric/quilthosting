-- Every import runs under a batch record so a partial result can be reported
-- as partial. Previously a membership-assignment failure was console.warn'd
-- and the response still said "created: N" — the admin saw a clean success
-- for a migration that had silently lost memberships.
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- running | completed | partial | failed
  status TEXT NOT NULL DEFAULT 'running',
  -- The mapping actually applied, so a later reader can tell what was imported.
  mapping_json TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  memberships_assigned INTEGER NOT NULL DEFAULT 0,
  membership_failures INTEGER NOT NULL DEFAULT 0,
  plan_limited INTEGER NOT NULL DEFAULT 0,
  custom_fields_created INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_batch_tenant
  ON import_batches(tenant_id, started_at);

-- Row-level outcomes, so the admin can download exactly what failed and why.
CREATE TABLE IF NOT EXISTS import_batch_errors (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  -- skipped | membership_failed | level_not_found | plan_limited
  -- (level_not_found and plan_limited added in Task 3 fix round 1: a row
  -- naming an unmatched level, or one that named a real level but hit the
  -- free-plan active-member cap, is a real loss and must be itemized here
  -- too, not just folded into an aggregate counter.)
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_error_batch
  ON import_batch_errors(batch_id);
