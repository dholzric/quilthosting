-- P1: longarm projects — intake, estimate, agreement, e-signature.
-- Payment state is deliberately absent; P4 owns invoicing.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  reference TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  member_id TEXT,
  intake_json TEXT NOT NULL DEFAULT '{}',
  estimate_notes TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  -- SHA-256 of the access token. The raw token is emailed once and never
  -- stored, so a database disclosure exposes no customer's quote.
  access_token_hash TEXT NOT NULL,
  token_expires_at TEXT,
  estimated_at TEXT,
  signed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX idx_projects_tenant_status ON projects(tenant_id, status, created_at);
CREATE UNIQUE INDEX idx_projects_tenant_reference ON projects(tenant_id, reference);
-- Token lookup is by hash alone; it must be fast and must not need a scan.
CREATE UNIQUE INDEX idx_projects_token_hash ON projects(access_token_hash);

CREATE TABLE project_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'service',
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_project_lines_project ON project_lines(project_id, sort_order);

CREATE TABLE agreement_signatures (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  signer_email TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  agreement_title TEXT NOT NULL,
  -- Full immutable snapshot, NOT a reference to a template Linda can edit.
  -- This table exists to answer "what exactly did they agree to" years later.
  agreement_text TEXT NOT NULL,
  agreement_sha256 TEXT NOT NULL,
  signing_token_hash TEXT NOT NULL,
  signer_ip TEXT,
  signer_user_agent TEXT,
  signed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
-- One signature per project: the signing endpoint is idempotent, and this
-- index is what makes that a database guarantee rather than a code promise.
CREATE UNIQUE INDEX idx_agreement_signatures_project ON agreement_signatures(project_id);

-- Separate from invoice_counters on purpose: an estimate that is never
-- accepted must not consume an invoice number.
CREATE TABLE project_counters (
  tenant_id TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
