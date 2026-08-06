-- Email / member groups (named lists for targeting blasts)
CREATE TABLE member_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_member_groups_tenant_name ON member_groups(tenant_id, name);
CREATE INDEX idx_member_groups_tenant ON member_groups(tenant_id);

CREATE TABLE member_group_members (
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, member_id),
  FOREIGN KEY (group_id) REFERENCES member_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_mgm_member ON member_group_members(member_id);
CREATE INDEX idx_mgm_tenant ON member_group_members(tenant_id, group_id);
