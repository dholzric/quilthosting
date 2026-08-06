-- Scale pack: indexes + blast progress for large guilds (10k–50k+ members)

-- Member list / sort / search support
CREATE INDEX IF NOT EXISTS idx_members_tenant_name
  ON members(tenant_id, last_name, first_name, id);
CREATE INDEX IF NOT EXISTS idx_members_tenant_created
  ON members(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_members_tenant_email_lower
  ON members(tenant_id, email);

-- Membership renewals + Stripe lookups
CREATE INDEX IF NOT EXISTS idx_memberships_stripe_sub
  ON memberships(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_memberships_active_end
  ON memberships(tenant_id, status, end_date);

-- Event registration lookups
CREATE INDEX IF NOT EXISTS idx_regs_event_created
  ON event_registrations(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_regs_tenant_email
  ON event_registrations(tenant_id, email);

-- Email log idempotency / blast progress
CREATE INDEX IF NOT EXISTS idx_email_logs_member_template
  ON email_logs(tenant_id, member_id, template, created_at);

-- Payments filters
CREATE INDEX IF NOT EXISTS idx_payments_tenant_status_created
  ON payments(tenant_id, status, created_at);

-- Directory
CREATE INDEX IF NOT EXISTS idx_members_directory_name
  ON members(tenant_id, status, directory_visible, last_name, first_name);

-- Queued blast progress (large audiences processed in chunks by cron / waitUntil)
ALTER TABLE blasts ADD COLUMN cursor_email TEXT;
ALTER TABLE blasts ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blasts ADD COLUMN body_text TEXT;

CREATE INDEX IF NOT EXISTS idx_blasts_sending
  ON blasts(status, created_at);
