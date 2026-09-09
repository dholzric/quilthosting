-- Automations 2.0 (phase 3, Task E)
--
-- Adds the two per-sequence config columns the builder writes, and the runs
-- table that replaces automation_enrollments as the unit of work.
--
-- A "run" is one subject travelling through one sequence. It carries the step
-- pointer, the due time of the NEXT step, and the retry counter. The unique
-- index on (sequence_id, subject_type, subject_id) is what makes
-- enqueueTrigger() idempotent: it uses INSERT OR IGNORE and never pre-reads,
-- so two concurrent triggers for the same subject cannot both enrol it.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the Worker.
-- enrollMemberActivated() writes automation_runs from the first request after
-- deploy; on a pre-migration database the insert fails (logged, non-fatal) and
-- that member simply never enters the sequence.
--
-- automation_enrollments is left in place on purpose: runAutomationJob still
-- drains rows that were in flight when this shipped, and cancels any whose
-- subject already has an automation_runs row so nobody gets two copies.

ALTER TABLE automation_sequences ADD COLUMN conditions_json TEXT;
ALTER TABLE automation_sequences ADD COLUMN trigger_config_json TEXT;

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence_id TEXT NOT NULL,
  -- 'member' | 'registration' | 'form_response' | 'payment' — decides which
  -- table subject_id points at, and therefore how the recipient and the merge
  -- fields are resolved at send time.
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  -- Index into the sequence's steps_json of the step that has NOT been sent.
  step INTEGER NOT NULL DEFAULT 0,
  -- pending | sending | completed | failed | cancelled
  status TEXT NOT NULL DEFAULT 'pending',
  -- When the step at `step` becomes due.
  scheduled_at TEXT,
  -- When the most recent step was accepted by the provider.
  sent_at TEXT,
  error TEXT,
  -- Consecutive failures on the CURRENT step; reset when it finally sends.
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  lease_owner TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (sequence_id) REFERENCES automation_sequences(id) ON DELETE CASCADE
);

-- The due-work scan: WHERE status IN ('pending','sending') AND scheduled_at <= ?
CREATE INDEX IF NOT EXISTS idx_automation_runs_due
  ON automation_runs(status, scheduled_at);

-- Idempotency for enqueueTrigger(): one run per subject per sequence.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_subject
  ON automation_runs(sequence_id, subject_type, subject_id);

CREATE INDEX IF NOT EXISTS idx_automation_runs_tenant
  ON automation_runs(tenant_id, created_at);
