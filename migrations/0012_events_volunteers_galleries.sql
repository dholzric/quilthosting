-- Recurring events, volunteer sign-up sheets, and photo galleries

-- Recurrence: a "series parent" holds the rule; generated instances point back.
ALTER TABLE events ADD COLUMN recurrence_rule TEXT;
ALTER TABLE events ADD COLUMN recurrence_parent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_recur_parent ON events(recurrence_parent_id);

-- Volunteer sign-up sheets (refreshments, show shifts, setup/teardown)
CREATE TABLE IF NOT EXISTS volunteer_slots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  needed INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vslots_event ON volunteer_slots(tenant_id, event_id, sort_order);

CREATE TABLE IF NOT EXISTS volunteer_signups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  member_id TEXT,
  name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (slot_id) REFERENCES volunteer_slots(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_vsignups_slot ON volunteer_signups(tenant_id, slot_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vsignups_unique ON volunteer_signups(slot_id, email);

-- Photo galleries (quilt shows, show-and-tell)
CREATE TABLE IF NOT EXISTS galleries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  event_id TEXT,
  is_members_only INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_galleries_tenant_slug ON galleries(tenant_id, slug);

CREATE TABLE IF NOT EXISTS gallery_photos (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  gallery_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  caption TEXT,
  credit TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gphotos_gallery ON gallery_photos(tenant_id, gallery_id, sort_order);
