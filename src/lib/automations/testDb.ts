/**
 * Test-only D1 stand-in backed by node:sqlite.
 *
 * The rest of the suite fakes D1 by matching SQL shapes, which is fine for
 * "did the route build the right UPDATE" assertions. The automations work is
 * different: its two central guarantees — enqueueTrigger's idempotency and the
 * run lease — are *database* behaviour (a UNIQUE index and a conditional
 * UPDATE's changes count). Faking those would test the fake, so these tests
 * run real SQL against an in-memory SQLite and apply the real
 * migrations/0029_automations_v2.sql text on top of a minimal base schema.
 *
 * Nothing in src/ imports this at runtime.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Columns the automations code reads, from migrations 0001/0008/0014/0023. */
const BASE_SCHEMA = `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', tenant_type TEXT DEFAULT 'guild',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE members (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
  first_name TEXT, last_name TEXT, status TEXT NOT NULL DEFAULT 'active',
  email_opt_out_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL,
  location TEXT, start_at TEXT NOT NULL, end_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE event_registrations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL,
  member_id TEXT, email TEXT NOT NULL, name TEXT,
  status TEXT NOT NULL DEFAULT 'registered',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE forms (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT ''
);
CREATE TABLE form_responses (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, form_id TEXT NOT NULL,
  member_id TEXT, email TEXT, name TEXT,
  answers_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, member_id TEXT,
  type TEXT NOT NULL DEFAULT 'dues', amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'succeeded',
  description TEXT, related_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE email_logs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, member_id TEXT,
  to_email TEXT NOT NULL, template TEXT NOT NULL, resend_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  blast_id TEXT, delivery_status TEXT, provider_message_id TEXT,
  delivery_error TEXT
);
CREATE TABLE suppressions (
  id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all', reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE automation_sequences (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  trigger_event TEXT NOT NULL DEFAULT 'member_activated',
  is_active INTEGER NOT NULL DEFAULT 1,
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE automation_enrollments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sequence_id TEXT NOT NULL,
  member_id TEXT NOT NULL, current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MIGRATION_0029 = fileURLToPath(
  new URL("../../../migrations/0029_automations_v2.sql", import.meta.url)
);

function toBind(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

export type TestDb = D1Database & {
  /** Raw handle, for fixtures and assertions. */
  sqlite: DatabaseSync;
  /** Every SQL string the code under test prepared, in order. */
  queries: string[];
  /** Convenience: run a query and return the rows. */
  rows<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T[];
  exec(sql: string): Promise<D1ExecResult>;
};

/**
 * In-memory database with the base schema plus the real 0029 migration.
 * Foreign keys stay off so a test can insert a member without a tenant row.
 */
export function createTestDb(): TestDb {
  const sqlite = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: false,
  });
  sqlite.exec(BASE_SCHEMA);
  sqlite.exec(readFileSync(MIGRATION_0029, "utf8"));

  const queries: string[] = [];

  const makeStmt = (sql: string, binds: unknown[]): D1PreparedStatement => {
    const bound = binds.map(toBind);
    const stmt = {
      _sql: sql,
      _binds: bound,
      bind(...b: unknown[]) {
        return makeStmt(sql, b);
      },
      async first<T>(col?: string) {
        queries.push(sql);
        const row = sqlite.prepare(sql).get(...bound) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return (col ? (row as any)[col] : row) as T;
      },
      async all<T>() {
        queries.push(sql);
        const results = sqlite.prepare(sql).all(...bound) as T[];
        return { success: true, results, meta: {} } as unknown as D1Result<T>;
      },
      async raw<T>() {
        queries.push(sql);
        const results = sqlite.prepare(sql).all(...bound) as Record<string, unknown>[];
        return results.map((r) => Object.values(r)) as unknown as T[];
      },
      async run<T>() {
        queries.push(sql);
        const info = sqlite.prepare(sql).run(...bound);
        return {
          success: true,
          results: [],
          meta: {
            changes: Number(info.changes ?? 0),
            last_row_id: Number(info.lastInsertRowid ?? 0),
          },
        } as unknown as D1Result<T>;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };

  const db = {
    prepare: (sql: string) => makeStmt(sql, []),
    async batch<T>(stmts: D1PreparedStatement[]) {
      // D1 batches are atomic; mirror that so "the insert failed" tests see
      // nothing half-written.
      sqlite.exec("BEGIN");
      try {
        const out: D1Result<T>[] = [];
        for (const s of stmts) out.push(await (s as any).run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 } as D1ExecResult;
    },
    async dump() {
      return new ArrayBuffer(0);
    },
    withSession() {
      throw new Error("not implemented in tests");
    },
    sqlite,
    queries,
    rows<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T[] {
      return sqlite.prepare(sql).all(...binds.map(toBind)) as T[];
    },
  };

  return db as unknown as TestDb;
}

/** Minimal tenant + member fixture used by most automation tests. */
export function seedTenant(
  db: TestDb,
  opts: { id?: string; name?: string; slug?: string } = {}
): { id: string; name: string; slug: string } {
  const t = {
    id: opts.id || "tenant-1",
    name: opts.name || "River Quilters",
    slug: opts.slug || "river",
  };
  db.sqlite
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)`)
    .run(t.id, t.name, t.slug);
  return t;
}

export function seedMember(
  db: TestDb,
  opts: {
    id?: string;
    tenantId?: string;
    email?: string;
    firstName?: string | null;
  } = {}
): { id: string; email: string } {
  const m = {
    id: opts.id || "member-1",
    tenantId: opts.tenantId || "tenant-1",
    email: opts.email || "ada@example.com",
    firstName: opts.firstName === undefined ? "Ada" : opts.firstName,
  };
  db.sqlite
    .prepare(
      `INSERT INTO members (id, tenant_id, email, first_name) VALUES (?, ?, ?, ?)`
    )
    .run(m.id, m.tenantId, m.email, m.firstName);
  return { id: m.id, email: m.email };
}

export function seedSequence(
  db: TestDb,
  opts: {
    id?: string;
    tenantId?: string;
    name?: string;
    trigger?: string;
    active?: boolean;
    steps?: unknown;
    conditions?: unknown;
    triggerConfig?: unknown;
  } = {}
): string {
  const id = opts.id || "seq-1";
  db.sqlite
    .prepare(
      `INSERT INTO automation_sequences
        (id, tenant_id, name, trigger_event, is_active, steps_json, conditions_json, trigger_config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      opts.tenantId || "tenant-1",
      opts.name || "Welcome",
      opts.trigger || "member_activated",
      opts.active === false ? 0 : 1,
      JSON.stringify(
        opts.steps ?? [
          { waitDays: 0, subject: "Hi {{first_name}}", bodyHtml: "<p>Welcome</p>" },
        ]
      ),
      opts.conditions === undefined ? null : JSON.stringify(opts.conditions),
      opts.triggerConfig === undefined ? null : JSON.stringify(opts.triggerConfig)
    );
  return id;
}
