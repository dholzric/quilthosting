-- Email permission + delivery lifecycle.
--
-- Before this migration there was no way for a member to stop receiving
-- guild email, no record of bounces/complaints, and no per-recipient outcome
-- for bulk blasts. Marketing sends (blasts, automations) now consult
-- members.email_opt_out_at + email_suppressions; transactional mail
-- (receipts, magic links, renewals) is only blocked by scope='all'
-- suppressions (hard bounces).

-- Member-level marketing opt-out (one-click unsubscribe, complaint, manual).
-- Transactional mail is still allowed while this is set.
ALTER TABLE members ADD COLUMN email_opt_out_at TEXT;

-- Address-level suppression list. tenant_id NULL = platform-wide (hard
-- bounces, complaints with no known tenant). scope 'all' blocks every kind of
-- mail; 'marketing' blocks blasts/automations only.
CREATE TABLE IF NOT EXISTS email_suppressions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,                       -- bounce | complaint | unsubscribe | manual
  scope TEXT NOT NULL DEFAULT 'marketing',    -- marketing | all
  source TEXT,                                -- resend:<svix-id> | unsubscribe:<ua> | admin:<user id> ...
  created_at TEXT NOT NULL
);
-- SQLite treats NULLs as distinct in UNIQUE indexes, so one index cannot
-- express uniqueness over coalesce(tenant_id,''). Two indexes: one for
-- tenant-scoped rows, a partial one for global rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_suppressions_tenant
  ON email_suppressions(tenant_id, email, scope) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_suppressions_global
  ON email_suppressions(email, scope) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_suppressions_email
  ON email_suppressions(email);

-- Idempotent provider webhook ingestion. id = the provider's event id
-- (Resend/Svix `svix-id`), so a redelivered webhook is a no-op.
CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  email_log_id TEXT,
  provider_message_id TEXT,
  recipient TEXT,
  payload_json TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_events_log ON email_events(email_log_id);

-- Delivery lifecycle on the per-send log. email_logs.status ('sent'|'failed')
-- stays as the coarse legacy flag; delivery_status is the provider-driven
-- lifecycle: accepted | delivered | delayed | bounced | complained | failed.
ALTER TABLE email_logs ADD COLUMN delivery_status TEXT;
ALTER TABLE email_logs ADD COLUMN provider_message_id TEXT;
ALTER TABLE email_logs ADD COLUMN delivery_error TEXT;
-- Links a per-recipient log row to its blast so failed recipients can be
-- retried and per-blast outcomes reported. (template='blast' alone could not
-- distinguish two blasts sent the same day.)
ALTER TABLE email_logs ADD COLUMN blast_id TEXT;
CREATE INDEX IF NOT EXISTS idx_email_logs_provider_message
  ON email_logs(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_resend_id
  ON email_logs(resend_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_blast
  ON email_logs(blast_id, delivery_status);

-- Sending lease so two processors (cron tick + HTTP kick-off + overlapping
-- crons) cannot work the same blast concurrently. lease_owner is diagnostic.
ALTER TABLE blasts ADD COLUMN lease_until TEXT;
ALTER TABLE blasts ADD COLUMN lease_owner TEXT;
-- Recipients skipped because they were suppressed/opted out.
ALTER TABLE blasts ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
-- 1 = this run only re-sends to recipients whose log row is
-- delivery_status='failed' (admin "retry failed" on a partial blast).
ALTER TABLE blasts ADD COLUMN retry_failed INTEGER NOT NULL DEFAULT 0;
-- Last provider/system error seen while processing (diagnostic).
ALTER TABLE blasts ADD COLUMN last_error TEXT;
