-- WA parity pack: website blocks/nav, forms, invoices, forums, blogs,
-- automations/clicks, API keys, SMS logs, multi-chapter, store tax/cart, profile showcase

-- Pages: blocks editor, nav, blog type
ALTER TABLE pages ADD COLUMN page_type TEXT NOT NULL DEFAULT 'page';
ALTER TABLE pages ADD COLUMN blocks_json TEXT;
ALTER TABLE pages ADD COLUMN show_in_nav INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pages ADD COLUMN nav_label TEXT;

-- Member showcase / photo
ALTER TABLE members ADD COLUMN photo_file_id TEXT;
ALTER TABLE members ADD COLUMN bio TEXT;
ALTER TABLE members ADD COLUMN showcase_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE members ADD COLUMN stripe_customer_id TEXT;

-- Products: SKU + tax flag
ALTER TABLE products ADD COLUMN sku TEXT;
ALTER TABLE products ADD COLUMN taxable INTEGER NOT NULL DEFAULT 1;

-- Multi-chapter (Council)
ALTER TABLE tenants ADD COLUMN parent_tenant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tenants_parent ON tenants(parent_tenant_id);

-- Email click tracking
ALTER TABLE email_logs ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_logs ADD COLUMN clicked_at TEXT;

CREATE TABLE IF NOT EXISTS email_clicks (
  id TEXT PRIMARY KEY,
  email_log_id TEXT NOT NULL,
  tenant_id TEXT,
  url TEXT NOT NULL,
  clicked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (email_log_id) REFERENCES email_logs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_clicks_log ON email_clicks(email_log_id);

-- Custom forms / surveys (with conditional field rules in fields_json)
CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  form_type TEXT NOT NULL DEFAULT 'survey',
  fields_json TEXT NOT NULL DEFAULT '[]',
  is_public INTEGER NOT NULL DEFAULT 1,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forms_tenant_slug ON forms(tenant_id, slug);
CREATE INDEX IF NOT EXISTS idx_forms_tenant ON forms(tenant_id, published);

CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  member_id TEXT,
  email TEXT,
  name TEXT,
  answers_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_form_responses_form ON form_responses(form_id, created_at);

-- Multi-line invoices with sequential numbers
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  member_id TEXT,
  invoice_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'usd',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  issued_at TEXT,
  paid_at TEXT,
  notes TEXT,
  payment_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_tenant_number ON invoices(tenant_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_member ON invoices(tenant_id, member_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_inv ON invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_counters (
  tenant_id TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Welcome / multi-step automations
CREATE TABLE IF NOT EXISTS automation_sequences (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_event TEXT NOT NULL DEFAULT 'member_activated',
  is_active INTEGER NOT NULL DEFAULT 1,
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auto_seq_tenant ON automation_sequences(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS automation_enrollments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (sequence_id) REFERENCES automation_sequences(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auto_enroll_next ON automation_enrollments(status, next_send_at);

-- Store orders (multi-SKU cart)
CREATE TABLE IF NOT EXISTS store_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  member_id TEXT,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '[]',
  stripe_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_store_orders_tenant ON store_orders(tenant_id, created_at);

-- Members-only forums
CREATE TABLE IF NOT EXISTS forum_topics (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  member_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_forum_topics_tenant ON forum_topics(tenant_id, updated_at);

CREATE TABLE IF NOT EXISTS forum_posts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  member_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES forum_topics(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_forum_posts_topic ON forum_posts(topic_id, created_at);

-- Public API keys (Zapier / integrations)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["read"]',
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

-- SMS log (Twilio optional via tenant settings)
CREATE TABLE IF NOT EXISTS sms_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  member_id TEXT,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_logs_tenant ON sms_logs(tenant_id, created_at);
