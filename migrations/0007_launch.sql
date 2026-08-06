-- Launch readiness: trials, directory privacy, email open tracking
ALTER TABLE tenants ADD COLUMN trial_ends_at TEXT;

ALTER TABLE members ADD COLUMN directory_visible INTEGER NOT NULL DEFAULT 1;

ALTER TABLE email_logs ADD COLUMN opened_at TEXT;
ALTER TABLE email_logs ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_tenants_trial ON tenants(trial_ends_at);
CREATE INDEX idx_members_directory ON members(tenant_id, directory_visible, status);
