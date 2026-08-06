-- Scheduled email blasts + send status
ALTER TABLE blasts ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE blasts ADD COLUMN send_at TEXT;
ALTER TABLE blasts ADD COLUMN layout TEXT NOT NULL DEFAULT 'plain';

CREATE INDEX idx_blasts_scheduled ON blasts(status, send_at);
