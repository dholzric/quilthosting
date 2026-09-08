// Test-only in-memory D1 stand-in for the auth flows (users + auth_tokens).
// Keyword-routed on the SQL text the code under test actually sends, and it
// really applies the `used_at IS NULL AND expires_at > ?` guard, so removing
// that clause from consumeMagicToken makes the replay tests fail.
// Not imported by production code.

export type FakeUserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
  is_platform_admin?: number;
};

export type FakeAuthTokenRow = {
  jti: string;
  user_id: string;
  purpose: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
};

export function fakeAuthDb(seedUsers: FakeUserRow[] = []) {
  const users = new Map<string, FakeUserRow>();
  for (const u of seedUsers) users.set(u.email, u);
  const tokens = new Map<string, FakeAuthTokenRow>();
  const log: { sql: string; binds: unknown[] }[] = [];

  const db = {
    users,
    tokens,
    log,
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          log.push({ sql, binds });
          return {
            async first<T = unknown>(): Promise<T | null> {
              if (sql.includes("FROM users WHERE email")) {
                return (users.get(String(binds[0])) ?? null) as T | null;
              }
              if (sql.includes("FROM users WHERE id")) {
                for (const u of users.values()) {
                  if (u.id === binds[0]) return u as unknown as T;
                }
                return null;
              }
              return null;
            },
            async run() {
              let changes = 0;
              if (sql.includes("INSERT INTO users")) {
                const [id, email, ...rest] = binds as string[];
                // INSERT (id, email, password_hash, name, ...) vs (id, email, name, ...)
                const name = sql.includes("password_hash") ? rest[1] : null;
                users.set(email, { id, email, password_hash: null, name: name ?? null });
                changes = 1;
              } else if (sql.includes("INSERT INTO auth_tokens")) {
                const [jti, user_id, expires_at, created_at] = binds as string[];
                tokens.set(jti, {
                  jti,
                  user_id,
                  purpose: "magic",
                  expires_at,
                  used_at: null,
                  created_at,
                });
                changes = 1;
              } else if (sql.includes("UPDATE auth_tokens SET used_at")) {
                const [usedAt, jti, now] = binds as string[];
                const row = tokens.get(jti);
                const guard =
                  sql.includes("used_at IS NULL") && sql.includes("expires_at >");
                if (row && (!guard || (row.used_at === null && row.expires_at > now))) {
                  row.used_at = usedAt;
                  changes = 1;
                }
              } else if (sql.includes("DELETE FROM auth_tokens WHERE jti")) {
                changes = tokens.delete(String(binds[0])) ? 1 : 0;
              } else if (sql.includes("DELETE FROM auth_tokens WHERE expires_at")) {
                const now = String(binds[0]);
                for (const [jti, row] of tokens) {
                  if (row.expires_at < now) {
                    tokens.delete(jti);
                    changes++;
                  }
                }
              }
              return { success: true, meta: { changes } };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return db;
}

export type FakeAuthDb = ReturnType<typeof fakeAuthDb>;
