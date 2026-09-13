-- Design review: one row per reviewer per starter design.
--
-- The Design panel offers 120 starter designs and nobody had looked at them
-- side by side. This is the sheet a reviewer works through: a score out of
-- ten, what they thought, and whether we should offer it as a default.
--
-- Keyed on (kit_id, reviewer) so two people can review independently without
-- overwriting each other. Not tenant-scoped: the starter library belongs to
-- the platform, not to any one guild.
CREATE TABLE IF NOT EXISTS design_reviews (
  kit_id     TEXT NOT NULL,
  reviewer   TEXT NOT NULL,
  rating     INTEGER,
  comment    TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kit_id, reviewer)
);

CREATE INDEX IF NOT EXISTS idx_design_reviews_reviewer ON design_reviews(reviewer);
