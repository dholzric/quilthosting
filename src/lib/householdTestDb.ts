/**
 * Test-only D1 stand-in for the household work, backed by node:sqlite.
 *
 * Same idiom and the same reason as src/lib/automations/testDb.ts: most of
 * the suite fakes D1 by matching SQL shapes, which is fine for "did the route
 * build the right UPDATE". Households are different. Their central guarantee
 * — "is this person an active member?" — is answered by a SQL fragment
 * (`activeMembershipFilter`) and enforced by a UNIQUE index. Faking either
 * would test the fake. So these tests run the REAL migration text against a
 * real in-memory SQLite.
 *
 * Nothing in src/ imports this at runtime.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The columns the household, roster, portal and plan-cap code actually read. */
const BASE_SCHEMA = `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', tenant_type TEXT DEFAULT 'guild',
  plan TEXT NOT NULL DEFAULT 'free', trial_ends_at TEXT,
  stripe_account_id TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT,
  custom_domain TEXT, public_launched INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE auth_tokens (
  jti TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE members (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
  first_name TEXT, last_name TEXT, phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  directory_visible INTEGER NOT NULL DEFAULT 1,
  bio TEXT, photo_file_id TEXT, showcase_json TEXT,
  custom_fields_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT, user_id TEXT, email_opt_out_at TEXT, joined_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE memberships (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, member_id TEXT NOT NULL,
  level_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  stripe_subscription_id TEXT, auto_renew INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE membership_levels (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT, price_cents INTEGER NOT NULL DEFAULT 0,
  duration_months INTEGER NOT NULL DEFAULT 12,
  renewal_type TEXT NOT NULL DEFAULT 'manual',
  term_mode TEXT NOT NULL DEFAULT 'anniversary', term_anchor TEXT,
  proration TEXT NOT NULL DEFAULT 'none', grace_days INTEGER NOT NULL DEFAULT 0,
  benefits_json TEXT NOT NULL DEFAULT '[]',
  is_public INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, member_id TEXT,
  type TEXT NOT NULL DEFAULT 'dues', amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'succeeded',
  description TEXT, related_id TEXT, fulfilled_at TEXT,
  stripe_payment_intent_id TEXT, stripe_invoice_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT, location TEXT, start_at TEXT NOT NULL, end_at TEXT,
  member_price_cents INTEGER NOT NULL DEFAULT 0,
  non_member_price_cents INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER, registration_open INTEGER NOT NULL DEFAULT 1,
  is_public INTEGER NOT NULL DEFAULT 1, settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE event_registrations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL,
  member_id TEXT, email TEXT NOT NULL, name TEXT,
  status TEXT NOT NULL DEFAULT 'registered', ticket_code TEXT,
  hold_expires_at TEXT, member_price_verified INTEGER,
  custom_answers_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE email_logs (
  id TEXT PRIMARY KEY, tenant_id TEXT, member_id TEXT, to_email TEXT NOT NULL,
  template TEXT NOT NULL, resend_id TEXT, status TEXT NOT NULL DEFAULT 'sent',
  blast_id TEXT, delivery_status TEXT, provider_message_id TEXT, delivery_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE email_suppressions (
  id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all', reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE webhook_outbox (
  id TEXT PRIMARY KEY, tenant_id TEXT, event TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MIGRATION_0031 = fileURLToPath(
  new URL("../../migrations/0031_households.sql", import.meta.url)
);

/**
 * The household half of migration 0031 only: the two tables. The three ALTER
 * TABLEs the migration also runs are folded into BASE_SCHEMA above (their
 * columns are declared there), because a test schema is not a migration
 * ledger and re-running the ALTERs would fail on a column that already
 * exists.
 */
function householdTablesSql(): string {
  const text = readFileSync(MIGRATION_0031, "utf8");
  return text
    .split("\n")
    .filter((line) => !/^\s*ALTER TABLE/i.test(line))
    .join("\n");
}

function toBind(v: unknown): null | number | bigint | string {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint") return v;
  return String(v);
}

export type HouseholdTestDb = D1Database & {
  sqlite: DatabaseSync;
  /** Every SQL string the code under test prepared, in order. */
  queries: string[];
  rows<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T[];
  run(sql: string, ...binds: unknown[]): void;
};

export function createHouseholdTestDb(): HouseholdTestDb {
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  sqlite.exec(BASE_SCHEMA);
  // The migration's three ALTER TABLEs, replayed verbatim against the base
  // schema above. (src/lib/households.test.ts applies the whole migration file
  // instead, which is what proves the defaults; here the ALTERs are split out
  // so route tests get the columns without re-parsing the ledger.)
  sqlite.exec("ALTER TABLE membership_levels ADD COLUMN household_max INTEGER NOT NULL DEFAULT 1");
  sqlite.exec(
    "ALTER TABLE membership_levels ADD COLUMN household_add_cents INTEGER NOT NULL DEFAULT 0"
  );
  sqlite.exec("ALTER TABLE memberships ADD COLUMN household_id TEXT");
  sqlite.exec(householdTablesSql());

  const queries: string[] = [];

  const makeStmt = (sql: string, binds: unknown[]): D1PreparedStatement => {
    const bound = binds.map(toBind);
    const stmt = {
      _sql: sql,
      bind(...b: unknown[]) {
        return makeStmt(sql, b);
      },
      async first<T>(col?: string) {
        queries.push(sql);
        const row = sqlite.prepare(sql).get(...(bound as never[])) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return (col ? (row as Record<string, unknown>)[col] : row) as T;
      },
      async all<T>() {
        queries.push(sql);
        const results = sqlite.prepare(sql).all(...(bound as never[])) as T[];
        return { success: true, results, meta: {} } as unknown as D1Result<T>;
      },
      async raw<T>() {
        queries.push(sql);
        const results = sqlite.prepare(sql).all(...(bound as never[])) as Record<string, unknown>[];
        return results.map((r) => Object.values(r)) as unknown as T[];
      },
      async run<T>() {
        queries.push(sql);
        const info = sqlite.prepare(sql).run(...(bound as never[]));
        return {
          success: true,
          results: [],
          meta: { changes: Number(info.changes ?? 0), last_row_id: 0 },
        } as unknown as D1Result<T>;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };

  const db = {
    prepare: (sql: string) => makeStmt(sql, []),
    async batch<T>(stmts: D1PreparedStatement[]) {
      // D1 batches are atomic; mirror that so a rejected household leaves no
      // half-written member rows behind.
      sqlite.exec("BEGIN");
      try {
        const out: D1Result<T>[] = [];
        for (const s of stmts) {
          out.push(await (s as unknown as { run(): Promise<D1Result<T>> }).run());
        }
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
      return sqlite.prepare(sql).all(...(binds.map(toBind) as never[])) as T[];
    },
    run(sql: string, ...binds: unknown[]): void {
      sqlite.prepare(sql).run(...(binds.map(toBind) as never[]));
    },
  };

  return db as unknown as HouseholdTestDb;
}

/** A guild, a level and nothing else. */
export function seedTenant(
  db: HouseholdTestDb,
  over: Partial<{ id: string; slug: string; name: string; plan: string; tenant_type: string }> = {}
) {
  const t = {
    id: "tenant-1",
    slug: "stitchers",
    name: "Stitchers Guild",
    plan: "free",
    tenant_type: "guild",
    ...over,
  };
  db.run(
    `INSERT INTO tenants (id, name, slug, plan, tenant_type) VALUES (?, ?, ?, ?, ?)`,
    t.id,
    t.name,
    t.slug,
    t.plan,
    t.tenant_type
  );
  return t;
}

export function seedLevel(
  db: HouseholdTestDb,
  over: Partial<{
    id: string;
    tenant_id: string;
    name: string;
    price_cents: number;
    household_max: number;
    household_add_cents: number;
    renewal_type: string;
    term_mode: string;
    proration: string;
  }> = {}
) {
  const l = {
    id: "level-1",
    tenant_id: "tenant-1",
    name: "Household",
    price_cents: 4000,
    household_max: 1,
    household_add_cents: 0,
    renewal_type: "manual",
    term_mode: "anniversary",
    proration: "none",
    ...over,
  };
  db.run(
    `INSERT INTO membership_levels
     (id, tenant_id, name, price_cents, household_max, household_add_cents,
      renewal_type, term_mode, proration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    l.id,
    l.tenant_id,
    l.name,
    l.price_cents,
    l.household_max,
    l.household_add_cents,
    l.renewal_type,
    l.term_mode,
    l.proration
  );
  return l;
}

export function seedMember(
  db: HouseholdTestDb,
  over: Partial<{
    id: string;
    tenant_id: string;
    email: string;
    first_name: string;
    last_name: string;
    status: string;
  }> = {}
) {
  const m = {
    id: "member-1",
    tenant_id: "tenant-1",
    email: "member-1@example.test",
    first_name: "Pat",
    last_name: "Quilter",
    status: "active",
    ...over,
  };
  db.run(
    `INSERT INTO members (id, tenant_id, email, first_name, last_name, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    m.id,
    m.tenant_id,
    m.email,
    m.first_name,
    m.last_name,
    m.status
  );
  return m;
}

export function seedMembership(
  db: HouseholdTestDb,
  over: Partial<{
    id: string;
    tenant_id: string;
    member_id: string;
    level_id: string;
    status: string;
    end_date: string;
    household_id: string;
  }> = {}
) {
  const ms = {
    id: "ms-1",
    tenant_id: "tenant-1",
    member_id: "member-1",
    level_id: "level-1",
    status: "active",
    end_date: "2026-12-31T23:59:59.999Z",
    household_id: null as string | null,
    ...over,
  };
  db.run(
    `INSERT INTO memberships
     (id, tenant_id, member_id, level_id, start_date, end_date, status, household_id)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', ?, ?, ?)`,
    ms.id,
    ms.tenant_id,
    ms.member_id,
    ms.level_id,
    ms.end_date,
    ms.status,
    ms.household_id
  );
  return ms;
}
