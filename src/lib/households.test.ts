/**
 * Households: the derived-membership rule, the price, and the invariant that
 * nothing else in the codebase decides who is a member.
 *
 * These run real SQL against an in-memory node:sqlite with the REAL
 * migrations/0031_households.sql applied on top of a minimal base schema
 * (the same idiom as src/lib/automations/testDb.ts). The whole point of
 * `activeMembershipFilter` is that it is a SQL fragment; faking D1 by
 * matching SQL shapes would test the shape and not the answer, and the answer
 * — "is the spouse a member now that the payer lapsed?" — is the feature.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
/**
 * @cloudflare/workers-types shadows @types/node here, so readdirSync is typed
 * as returning string[] with no options overload. The runtime is real Node.
 */
const readDir = readdirSync as unknown as (
  path: string,
  opts: { withFileTypes: true }
) => Array<{ name: string; isDirectory(): boolean }>;
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  activeMembershipFilter,
  isActiveMember,
  createHousehold,
  addToHousehold,
  removeFromHousehold,
  householdFor,
  householdsForMembers,
  emailsAlreadyInHousehold,
  householdPriceCents,
  householdMax,
  isHouseholdLevel,
  MAX_HOUSEHOLD_PEOPLE,
} from "./households";

/** Only the columns the household code reads (migrations 0001 + 0030). */
const BASE_SCHEMA = `
CREATE TABLE members (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
  first_name TEXT, last_name TEXT, status TEXT NOT NULL DEFAULT 'pending',
  directory_visible INTEGER NOT NULL DEFAULT 1,
  joined_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE memberships (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, member_id TEXT NOT NULL,
  level_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active', amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE membership_levels (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0, duration_months INTEGER NOT NULL DEFAULT 12,
  status TEXT NOT NULL DEFAULT 'active'
);
`;

const MIGRATION_0031 = fileURLToPath(
  new URL("../../migrations/0031_households.sql", import.meta.url)
);

function toBind(v: unknown) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint") return v;
  return String(v);
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  sqlite.exec(BASE_SCHEMA);
  sqlite.exec(readFileSync(MIGRATION_0031, "utf8"));

  const makeStmt = (sql: string, binds: unknown[]): D1PreparedStatement => {
    const bound = binds.map(toBind);
    return {
      bind: (...b: unknown[]) => makeStmt(sql, b),
      async first(col?: string) {
        const row = sqlite.prepare(sql).get(...(bound as never[])) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return col ? (row as never)[col] : row;
      },
      async all() {
        return { success: true, results: sqlite.prepare(sql).all(...(bound as never[])), meta: {} };
      },
      async run() {
        const info = sqlite.prepare(sql).run(...(bound as never[]));
        return {
          success: true,
          results: [],
          meta: { changes: Number(info.changes ?? 0), last_row_id: 0 },
        };
      },
    } as unknown as D1PreparedStatement;
  };

  const db = {
    prepare: (sql: string) => makeStmt(sql, []),
    async batch(stmts: D1PreparedStatement[]) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await (s as unknown as { run(): Promise<unknown> }).run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;

  return { db, sqlite };
}

const T = "tenant-1";
const NOW = "2026-01-15T00:00:00.000Z";

let db: D1Database;
let sqlite: DatabaseSync;

function addMember(id: string, status = "pending", tenantId = T) {
  sqlite
    .prepare(
      `INSERT INTO members (id, tenant_id, email, first_name, last_name, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, tenantId, `${id}@example.test`, id, "Quilter", status);
}

function addMembership(id: string, memberId: string, status = "active", householdId: string | null = null) {
  sqlite
    .prepare(
      `INSERT INTO memberships (id, tenant_id, member_id, level_id, start_date, status, household_id)
       VALUES (?, ?, ?, 'lvl', ?, ?, ?)`
    )
    .run(id, T, memberId, NOW, status, householdId);
}

function activeIds(tenantId = T): string[] {
  return (
    sqlite
      .prepare(
        `SELECT m.id FROM members m WHERE m.tenant_id = ? AND ${activeMembershipFilter("m")}
         ORDER BY m.id`
      )
      .all(tenantId) as Array<{ id: string }>
  ).map((r) => r.id);
}

beforeEach(() => {
  const made = makeDb();
  db = made.db;
  sqlite = made.sqlite;
});

describe("migration 0031", () => {
  it("gives every existing level an individual-membership default", () => {
    sqlite.prepare(`INSERT INTO membership_levels (id, tenant_id, name) VALUES ('l1', ?, 'Regular')`).run(T);
    const row = sqlite.prepare("SELECT * FROM membership_levels WHERE id = 'l1'").get() as Record<
      string,
      unknown
    >;
    expect(row.household_max).toBe(1);
    expect(row.household_add_cents).toBe(0);
  });

  it("leaves memberships.household_id NULL for a membership nobody bundled", () => {
    addMember("a");
    addMembership("ms1", "a");
    const row = sqlite.prepare("SELECT household_id FROM memberships WHERE id = 'ms1'").get() as Record<
      string,
      unknown
    >;
    expect(row.household_id).toBeNull();
  });

  it("refuses to put one person in two households", async () => {
    addMember("payer1");
    addMember("payer2");
    addMember("dana");
    const h1 = await createHousehold(db, T, "payer1", "One", ["dana"], NOW);
    expect(h1).toBeTruthy();
    await expect(createHousehold(db, T, "payer2", "Two", ["dana"], NOW)).rejects.toThrow();
    // The failed batch left nothing behind.
    expect(sqlite.prepare("SELECT COUNT(*) c FROM households").get()).toEqual({ c: 1 });
  });
});

describe("activeMembershipFilter", () => {
  it("rejects an alias that is not a SQL identifier", () => {
    expect(() => activeMembershipFilter("m; DROP TABLE members --")).toThrow();
    expect(() => activeMembershipFilter("")).toThrow();
    expect(activeMembershipFilter("mem")).toContain("mem.id");
  });

  it("binds nothing, so it drops in where status = 'active' used to sit", () => {
    expect(activeMembershipFilter("m")).not.toContain("?");
  });

  it("keeps today's answer for a member who is in no household", () => {
    addMember("solo-active", "active");
    addMember("solo-lapsed", "lapsed");
    addMember("solo-pending", "pending");
    expect(activeIds()).toEqual(["solo-active"]);
  });

  it("makes a household member active off the payer's membership", async () => {
    addMember("payer", "active");
    addMembership("ms1", "payer");
    addMember("spouse", "pending"); // never activated in their own right
    await createHousehold(db, T, "payer", "The Alvarez household", ["spouse"], NOW);
    expect(activeIds()).toEqual(["payer", "spouse"]);
    expect(await isActiveMember(db, T, "spouse")).toBe(true);
  });

  it("drops the household member when the payer's membership ends", async () => {
    addMember("payer", "active");
    addMembership("ms1", "payer");
    addMember("spouse", "active");
    await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    expect(activeIds()).toEqual(["payer", "spouse"]);

    // What runRenewalJob does: expire the membership, lapse the PAYER only.
    sqlite.prepare("UPDATE memberships SET status = 'expired' WHERE id = 'ms1'").run();
    sqlite.prepare("UPDATE members SET status = 'lapsed' WHERE id = 'payer'").run();

    // The spouse's members.status is still 'active' — nobody touched it — so
    // an OR-shaped filter would leave her a member off a lapsed payment.
    expect(
      (sqlite.prepare("SELECT status FROM members WHERE id = 'spouse'").get() as { status: string })
        .status
    ).toBe("active");
    expect(activeIds()).toEqual([]);
    expect(await isActiveMember(db, T, "spouse")).toBe(false);
  });

  it("still honours a household member's own membership if they buy one", async () => {
    addMember("payer", "lapsed");
    addMember("spouse", "active"); // stale flag: no payment stands behind it
    await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    expect(activeIds()).toEqual([]);
    // She buys her own membership on top of the household she is in.
    addMembership("ms-spouse", "spouse");
    expect(await isActiveMember(db, T, "spouse")).toBe(true);
    expect(await isActiveMember(db, T, "payer")).toBe(false);
  });

  it("never reaches across tenants", async () => {
    addMember("payer", "active");
    addMembership("ms1", "payer");
    addMember("spouse", "pending");
    await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    addMember("other-tenant-person", "pending", "tenant-2");
    expect(activeIds("tenant-2")).toEqual([]);
  });

  it("treats the payer's own row by the ordinary rule", async () => {
    addMember("payer", "active");
    addMember("spouse", "pending");
    await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    // The payer has no membership row (an officer marked them active by hand).
    // They keep the members.status answer; the spouse derives nothing.
    expect(activeIds()).toEqual(["payer"]);
  });
});

describe("householdPriceCents", () => {
  const level = { price_cents: 4000, household_add_cents: 1500 };

  it("charges the plain price for one person", () => {
    expect(householdPriceCents(level, 1)).toBe(4000);
  });

  it("adds the extra-person price per additional person", () => {
    expect(householdPriceCents(level, 2)).toBe(5500);
    expect(householdPriceCents(level, 4)).toBe(8500);
  });

  it("charges one price when the guild set no add-on", () => {
    expect(householdPriceCents({ price_cents: 4000, household_add_cents: 0 }, 3)).toBe(4000);
  });

  it("treats a missing or nonsense count as one person", () => {
    expect(householdPriceCents(level, 0)).toBe(4000);
    expect(householdPriceCents(level, -3)).toBe(4000);
    expect(householdPriceCents(level, Number.NaN)).toBe(4000);
  });

  it("survives a level row read before migration 0031 applied", () => {
    expect(householdPriceCents({ price_cents: 4000 }, 3)).toBe(4000);
  });
});

describe("householdMax / isHouseholdLevel", () => {
  it("reads an unedited level as an individual level", () => {
    expect(householdMax({})).toBe(1);
    expect(householdMax({ household_max: null })).toBe(1);
    expect(isHouseholdLevel({ household_max: 1 })).toBe(false);
    expect(isHouseholdLevel({ household_max: 2 })).toBe(true);
  });

  it("clamps to the hard ceiling", () => {
    expect(householdMax({ household_max: 999 })).toBe(MAX_HOUSEHOLD_PEOPLE);
    expect(householdMax({ household_max: 0 })).toBe(1);
  });
});

describe("householdFor / householdsForMembers", () => {
  it("returns the payer first and everyone else after", async () => {
    addMember("zpayer", "active");
    addMember("adana", "active");
    addMember("bevan", "active");
    const id = await createHousehold(db, T, "zpayer", "The Quilters", ["adana", "bevan"], NOW);
    const h = await householdFor(db, T, "bevan");
    expect(h?.id).toBe(id);
    expect(h?.name).toBe("The Quilters");
    expect(h?.payer_member_id).toBe("zpayer");
    expect(h?.members.map((m) => m.id)).toEqual(["zpayer", "adana", "bevan"]);
    expect(h?.members[0].role).toBe("payer");
    expect(h?.members[1].role).toBe("member");
  });

  it("returns null for someone in no household", async () => {
    addMember("solo", "active");
    expect(await householdFor(db, T, "solo")).toBeNull();
  });

  it("maps a roster page to its households in one query", async () => {
    addMember("payer", "active");
    addMember("spouse", "active");
    addMember("solo", "active");
    await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    const map = await householdsForMembers(db, T, ["payer", "spouse", "solo"]);
    expect(map.get("payer")).toMatchObject({ name: "House", role: "payer" });
    expect(map.get("spouse")).toMatchObject({ name: "House", role: "member" });
    expect(map.has("solo")).toBe(false);
  });

  it("reports emails already claimed by a household", async () => {
    addMember("payer", "active");
    addMember("spouse", "active");
    addMember("solo", "active");
    await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    expect(
      await emailsAlreadyInHousehold(db, T, ["SPOUSE@example.test", "solo@example.test"])
    ).toEqual(["spouse@example.test"]);
  });
});

describe("addToHousehold", () => {
  it("moves an existing member in", async () => {
    addMember("payer", "active");
    addMember("newcomer", "pending");
    addMembership("ms1", "payer");
    const id = await createHousehold(db, T, "payer", "House", [], NOW);
    await addToHousehold(db, T, id, "newcomer", NOW);
    expect((await householdFor(db, T, "newcomer"))?.id).toBe(id);
    expect(await isActiveMember(db, T, "newcomer")).toBe(true);
  });

  it("refuses a second household for the same person", async () => {
    addMember("p1", "active");
    addMember("p2", "active");
    addMember("dana", "active");
    const h1 = await createHousehold(db, T, "p1", "One", ["dana"], NOW);
    const h2 = await createHousehold(db, T, "p2", "Two", [], NOW);
    expect(h1).not.toBe(h2);
    await expect(addToHousehold(db, T, h2, "dana", NOW)).rejects.toThrow();
  });

  it("refuses to overfill a household", async () => {
    addMember("payer", "active");
    addMember("a", "active");
    addMember("b", "active");
    const id = await createHousehold(db, T, "payer", "House", ["a"], NOW);
    await expect(addToHousehold(db, T, id, "b", NOW, 2)).rejects.toThrow(/full/i);
  });

  it("refuses a household or member from another tenant", async () => {
    addMember("payer", "active");
    addMember("outsider", "active", "tenant-2");
    const id = await createHousehold(db, T, "payer", "House", [], NOW);
    await expect(addToHousehold(db, T, id, "outsider", NOW)).rejects.toThrow(/Member not found/);
    await expect(addToHousehold(db, "tenant-2", id, "outsider", NOW)).rejects.toThrow(
      /Household not found/
    );
  });
});

describe("removeFromHousehold", () => {
  it("ends the derived membership but keeps the person", async () => {
    addMember("payer", "active");
    addMembership("ms1", "payer");
    addMember("spouse", "active");
    await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    expect(await isActiveMember(db, T, "spouse")).toBe(true);

    await removeFromHousehold(db, T, "spouse", NOW);

    const row = sqlite.prepare("SELECT * FROM members WHERE id = 'spouse'").get() as Record<
      string,
      unknown
    >;
    expect(row).toBeTruthy(); // the record survives
    expect(row.status).toBe("lapsed"); // the derived membership does not
    expect(await isActiveMember(db, T, "spouse")).toBe(false);
    expect(await householdFor(db, T, "spouse")).toBeNull();
    // The payer is untouched.
    expect(await isActiveMember(db, T, "payer")).toBe(true);
  });

  it("leaves a member who pays for themselves active", async () => {
    addMember("payer", "active");
    addMembership("ms1", "payer");
    addMember("spouse", "active");
    addMembership("ms2", "spouse");
    await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    await removeFromHousehold(db, T, "spouse", NOW);
    expect(
      (sqlite.prepare("SELECT status FROM members WHERE id = 'spouse'").get() as { status: string })
        .status
    ).toBe("active");
    expect(await isActiveMember(db, T, "spouse")).toBe(true);
  });

  it("dissolves the household when the payer moves out", async () => {
    addMember("payer", "active");
    addMembership("ms1", "payer", "active");
    addMember("spouse", "active");
    const id = await createHousehold(db, T, "payer", "House", ["spouse"], NOW);
    sqlite.prepare("UPDATE memberships SET household_id = ? WHERE id = 'ms1'").run(id);

    await removeFromHousehold(db, T, "payer", NOW);

    expect(sqlite.prepare("SELECT COUNT(*) c FROM households").get()).toEqual({ c: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) c FROM household_members").get()).toEqual({ c: 0 });
    expect(
      (sqlite.prepare("SELECT household_id FROM memberships WHERE id='ms1'").get() as {
        household_id: string | null;
      }).household_id
    ).toBeNull();
    expect(await isActiveMember(db, T, "payer")).toBe(true); // still holds the membership
    expect(await isActiveMember(db, T, "spouse")).toBe(false);
  });

  it("is a no-op for someone in no household", async () => {
    addMember("solo", "active");
    await removeFromHousehold(db, T, "solo", NOW);
    expect(await isActiveMember(db, T, "solo")).toBe(true);
  });
});

/* ————————————————————————————————————————————————————————————————
 * The invariant: ONE place decides who is an active member.
 *
 * Six copies of `status = 'active'` against `members` was six chances for a
 * household spouse to be a member on the directory and a stranger at the
 * door. This scan walks every non-test source file, resolves each
 * `status = 'active'` comparison to the table it is actually about, and
 * fails if a members-table READ decides membership without going through
 * activeMembershipFilter. Write guards (`UPDATE members SET ... WHERE
 * status = 'active'`) are not decisions about who is a member and are left
 * alone.
 * ———————————————————————————————————————————————————————————————— */
const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATUS_RE = /(?:([A-Za-z_][A-Za-z0-9_]*)\.)?status\s*=\s*'active'/g;
const TABLE_RE =
  /\b(FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
const SQL_KEYWORDS = new Set([
  "where", "set", "on", "and", "or", "left", "inner", "join", "group",
  "order", "limit", "as", "values", "select",
]);

/**
 * Sites that read members.status = 'active' WITHOUT the shared filter, each
 * with the reason it is not a membership decision. Anything not on this list
 * must use activeMembershipFilter.
 */
const EXEMPT: Record<string, string> = {
  "routes/platform.ts":
    "platform ops status histogram: active/pending/lapsed must partition the same column",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readDir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function membershipDecisionSites(): Array<{ file: string; line: number; text: string }> {
  const found: Array<{ file: string; line: number; text: string }> = [];
  for (const abs of sourceFiles(SRC_ROOT)) {
    const rel = abs.slice(SRC_ROOT.length).replace(/\\/g, "/");
    if (rel === "lib/households.ts") continue; // the definition itself
    const src = readFileSync(abs, "utf8");
    STATUS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STATUS_RE.exec(src))) {
      const ctx = src.slice(Math.max(0, m.index - 800), m.index);
      const aliases = new Map<string, string>();
      let lastKeyword = "";
      let lastTable = "";
      TABLE_RE.lastIndex = 0;
      let t: RegExpExecArray | null;
      while ((t = TABLE_RE.exec(ctx))) {
        const table = t[2];
        const alias = t[3] && !SQL_KEYWORDS.has(t[3].toLowerCase()) ? t[3] : null;
        aliases.set(table, table);
        if (alias) aliases.set(alias, table);
        lastKeyword = t[1].toUpperCase();
        lastTable = table;
      }
      const table = m[1] ? aliases.get(m[1]) : lastTable;
      if (table !== "members") continue;
      // A write's own guard (UPDATE members SET ... WHERE status = 'active')
      // is not a question about who is a member.
      if (!m[1] && lastKeyword === "UPDATE") continue;
      found.push({
        file: rel,
        line: src.slice(0, m.index).split("\n").length,
        text: m[0],
      });
    }
  }
  return found;
}

describe("one place decides membership", () => {
  it("routes every members-table membership read through activeMembershipFilter", () => {
    const offenders = membershipDecisionSites().filter((s) => !EXEMPT[s.file]);
    expect(
      offenders.map((s) => `${s.file}:${s.line} — ${s.text}`),
      "these decide membership on their own; use activeMembershipFilter from src/lib/households.ts"
    ).toEqual([]);
  });

  it("keeps the exemption list honest — every exempt file still has such a read", () => {
    const sites = membershipDecisionSites();
    for (const file of Object.keys(EXEMPT)) {
      expect(
        sites.some((s) => s.file === file),
        `${file} no longer reads members.status directly; drop its exemption`
      ).toBe(true);
    }
  });

  it("actually finds the shared filter in the converted call sites", () => {
    const converted = [
      "lib/plans.ts",
      "lib/nextActions.ts",
      "lib/site/data.ts",
      "routes/public.ts",
      "routes/portal.ts",
      "routes/members.ts",
    ];
    for (const rel of converted) {
      const src = readFileSync(join(SRC_ROOT, rel), "utf8");
      expect(src, `${rel} should use activeMembershipFilter`).toContain("activeMembershipFilter");
    }
  });
});
