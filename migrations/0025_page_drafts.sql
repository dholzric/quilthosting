-- Draft -> preview -> publish workflow for the website builder.
--
-- pages gains an unpublished draft (draft_* columns, NULL = no draft), an
-- optimistic-concurrency revision counter, a publish timestamp, and a soft
-- delete marker. page_revisions keeps the last 50 published/pre-restore
-- snapshots per page; page_redirects maps renamed slugs to their new slug.

ALTER TABLE pages ADD COLUMN draft_blocks_json TEXT;   -- NULL = no unpublished draft
ALTER TABLE pages ADD COLUMN draft_title TEXT;
ALTER TABLE pages ADD COLUMN draft_updated_at TEXT;
ALTER TABLE pages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1; -- bumps on every write
ALTER TABLE pages ADD COLUMN published_at TEXT;
ALTER TABLE pages ADD COLUMN deleted_at TEXT;          -- soft delete (trash)

CREATE TABLE page_revisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- publish | restore | pre_restore
  title TEXT NOT NULL,
  blocks_json TEXT,
  content_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_page_revisions_page ON page_revisions(page_id, created_at DESC);

CREATE TABLE page_redirects (
  tenant_id TEXT NOT NULL,
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, from_slug)
);
