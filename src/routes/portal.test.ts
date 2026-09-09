// Coverage for the FIX-1 security gap closed alongside the P1 "longarm
// projects" public intake feature: GET /api/portal/:slug/files (the guild
// document library) and GET /api/portal/:slug/files/:fileId (its download
// route) used to return EVERY row in the shared `files` table for a tenant
// to any authenticated member -- including anonymous public-intake photos,
// which write into that same table WITHOUT `uploaded_by` (see
// src/routes/public.ts's projects/:reference/photos handler). Staff uploads
// (this file's own POST /:slug/photo, galleries.ts) always set
// `uploaded_by`, so excluding NULL rows is what makes the document library
// staff-curated content again without touching any existing guild file.
//
// Same fake-D1, real-signed-JWT idiom as src/routes/tenants.test.ts: dispatch
// through the exported `portalRoutes` Hono app with a keyword-routed fake D1
// that actually applies the `uploaded_by IS NOT NULL` clause by inspecting
// the SQL text the route sends -- so reverting the fix (which removes that
// clause from the query string) makes the fake stop filtering too, and the
// assertions below catch it.
import { describe, it, expect } from "vitest";
import { portalRoutes } from "./portal";
import { signJwt } from "../lib/auth";
import type { Env } from "../types";

const JWT_SECRET = "test-secret-not-used-in-prod";
const TENANT_ID = "tenant-1";
const MEMBER_EMAIL = "member@example.test";

type FileRow = {
  id: string;
  tenant_id: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
  uploaded_by: string | null;
  r2_key: string;
};

function fakeDb(files: FileRow[]) {
  const tenant = { id: TENANT_ID, slug: "stitchstudio", status: "active" };
  const member = {
    id: "member-1",
    tenant_id: TENANT_ID,
    email: MEMBER_EMAIL,
    status: "active",
  };

  function matchesFiles(sql: string, binds: unknown[]): FileRow[] {
    // Mirrors whatever WHERE clause the route actually sent: filters by
    // tenant_id always, by id when the query binds a fileId (download
    // route), and by uploaded_by IS NOT NULL only when that literal text is
    // present in the SQL -- i.e. only when the fix is in place.
    const requireUploader = sql.includes("uploaded_by IS NOT NULL");
    const hasIdFilter = sql.includes("WHERE id = ? AND tenant_id = ?");
    return files.filter((f) => {
      if (hasIdFilter) {
        if (f.id !== binds[0] || f.tenant_id !== binds[1]) return false;
      } else {
        if (f.tenant_id !== binds[0]) return false;
      }
      if (requireUploader && f.uploaded_by === null) return false;
      return true;
    });
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first<T = unknown>(): Promise<T | null> {
              if (sql.includes("FROM tenants")) return tenant as unknown as T;
              if (sql.includes("FROM members")) {
                return (binds.includes(MEMBER_EMAIL.toLowerCase()) ||
                binds.includes(MEMBER_EMAIL)
                  ? member
                  : null) as unknown as T;
              }
              if (sql.includes("FROM files")) {
                const matches = matchesFiles(sql, binds);
                return (matches[0] ?? null) as unknown as T;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM files")) {
                return { results: matchesFiles(sql, binds) };
              }
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db;
}

function fakeFiles() {
  return {
    async get(key: string) {
      return { body: `bytes-for-${key}` };
    },
  };
}

async function authHeader() {
  const token = await signJwt(
    { sub: "user-1", email: MEMBER_EMAIL },
    JWT_SECRET
  );
  return { Authorization: `Bearer ${token}` };
}

function makeEnv(files: FileRow[]): Env {
  return {
    DB: fakeDb(files),
    FILES: fakeFiles(),
    JWT_SECRET,
  } as unknown as Env;
}

const STAFF_FILE: FileRow = {
  id: "file-staff",
  tenant_id: TENANT_ID,
  filename: "guild-bylaws.pdf",
  content_type: "application/pdf",
  size: 100,
  created_at: "2026-01-01T00:00:00.000Z",
  uploaded_by: "user-1",
  r2_key: `${TENANT_ID}/file-staff/guild-bylaws.pdf`,
};

const PUBLIC_INTAKE_FILE: FileRow = {
  id: "file-public",
  tenant_id: TENANT_ID,
  filename: "quilt-top.jpg",
  content_type: "image/jpeg",
  size: 200,
  created_at: "2026-01-02T00:00:00.000Z",
  uploaded_by: null,
  r2_key: `${TENANT_ID}/file-public/quilt-top.jpg`,
};

describe("GET /api/portal/:slug/files — document library", () => {
  it("lists a staff-uploaded file but not a public-intake file with uploaded_by IS NULL", async () => {
    const env = makeEnv([STAFF_FILE, PUBLIC_INTAKE_FILE]);
    const res = await portalRoutes.request(
      "/stitchstudio/files",
      { headers: await authHeader() },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((r) => r.id);
    expect(ids).toContain("file-staff");
    expect(ids).not.toContain("file-public");
  });
});

describe("GET /api/portal/:slug/files/:fileId — download", () => {
  it("downloads a staff-uploaded file", async () => {
    const env = makeEnv([STAFF_FILE, PUBLIC_INTAKE_FILE]);
    const res = await portalRoutes.request(
      "/stitchstudio/files/file-staff",
      { headers: await authHeader() },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("404s a public-intake file (uploaded_by IS NULL) even by direct id", async () => {
    const env = makeEnv([STAFF_FILE, PUBLIC_INTAKE_FILE]);
    const res = await portalRoutes.request(
      "/stitchstudio/files/file-public",
      { headers: await authHeader() },
      env
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Email preferences (member marketing opt-out), and the portal pages list
// excluding trashed pages (migration 0025).
// ---------------------------------------------------------------------------

type PrefMember = { id: string; tenant_id: string; email: string; status: string; email_opt_out_at: string | null; updated_at: string };

type SuppRow = { tenant_id: string | null; email: string; reason: string };

function prefsDb(
  member: PrefMember,
  pages: { slug: string; deleted_at: string | null; published: number }[] = [],
  suppressions: SuppRow[] = []
) {
  const tenant = { id: TENANT_ID, slug: "stitchstudio", status: "active" };
  const statements: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          statements.push({ sql, binds });
          return {
            async first() {
              if (sql.includes("FROM tenants")) return tenant;
              if (sql.includes("FROM members")) {
                return binds[0] === TENANT_ID && binds[1] === member.email ? { ...member } : null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM pages")) {
                let rows = pages;
                if (sql.includes("deleted_at IS NULL")) rows = rows.filter((p) => p.deleted_at === null);
                if (sql.includes("published = 1")) rows = rows.filter((p) => p.published === 1);
                return { results: rows.map((p) => ({ slug: p.slug, title: p.slug, content_json: "{}", blocks_json: null, is_members_only: 0 })) };
              }
              return { results: [] };
            },
            async run() {
              // suppression.ts optOutMember: UPDATE members SET email_opt_out_at = ?, updated_at = ? WHERE tenant_id = ? AND email = ? AND email_opt_out_at IS NULL
              if (sql.includes("UPDATE members SET email_opt_out_at = ?")) {
                const [ts, , tenantId, email] = binds as string[];
                if (tenantId === TENANT_ID && email === member.email && member.email_opt_out_at === null) {
                  member.email_opt_out_at = ts;
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              // portal.ts opt back in: UPDATE members SET email_opt_out_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?
              if (sql.includes("UPDATE members SET email_opt_out_at = NULL")) {
                const [, tenantId, id] = binds as string[];
                if (tenantId === TENANT_ID && id === member.id) member.email_opt_out_at = null;
                return { success: true, meta: { changes: 1 } };
              }
              // suppression.ts clearUnsubscribe: DELETE FROM email_suppressions WHERE tenant_id = ? AND email = ? AND reason = 'unsubscribe'
              if (sql.includes("DELETE FROM email_suppressions")) {
                const [tenantId, email] = binds as string[];
                const onlyUnsub = sql.includes("reason = 'unsubscribe'");
                const before = suppressions.length;
                for (let i = suppressions.length - 1; i >= 0; i--) {
                  const r = suppressions[i];
                  if (r.tenant_id === tenantId && r.email === email && (!onlyUnsub || r.reason === "unsubscribe")) {
                    suppressions.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: before - suppressions.length } };
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return { db, statements };
}

function prefsEnv(db: unknown): Env {
  return { DB: db, JWT_SECRET } as unknown as Env;
}

describe("GET/PUT /api/portal/:slug/preferences — email opt-out round trip", () => {
  function member(optOut: string | null = null): PrefMember {
    return { id: "member-1", tenant_id: TENANT_ID, email: MEMBER_EMAIL, status: "active", email_opt_out_at: optOut, updated_at: "x" };
  }

  it("reads false, opts out via optOutMember, reads true, opts back in, reads false", async () => {
    const m = member();
    const { db, statements } = prefsDb(m);
    const env = prefsEnv(db);
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };

    let res = await portalRoutes.request("/stitchstudio/preferences", { headers }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email_opt_out: false });

    res = await portalRoutes.request("/stitchstudio/preferences", { method: "PUT", headers, body: JSON.stringify({ email_opt_out: true }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email_opt_out: true });
    expect(typeof m.email_opt_out_at).toBe("string");
    // Went through suppression.ts's guarded UPDATE, not an ad-hoc write.
    expect(statements.some((s) => s.sql.includes("AND email_opt_out_at IS NULL"))).toBe(true);

    res = await portalRoutes.request("/stitchstudio/preferences", { headers }, env);
    expect(await res.json()).toEqual({ email_opt_out: true });

    res = await portalRoutes.request("/stitchstudio/preferences", { method: "PUT", headers, body: JSON.stringify({ email_opt_out: false }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email_opt_out: false });
    expect(m.email_opt_out_at).toBeNull();

    res = await portalRoutes.request("/stitchstudio/preferences", { headers }, env);
    expect(await res.json()).toEqual({ email_opt_out: false });
  });

  it("opting back in also lifts this guild's 'unsubscribe' suppression row, and nothing else", async () => {
    const m = member("2026-01-01T00:00:00.000Z");
    const supp: SuppRow[] = [
      { tenant_id: TENANT_ID, email: MEMBER_EMAIL, reason: "unsubscribe" },
      { tenant_id: TENANT_ID, email: MEMBER_EMAIL, reason: "bounce" },
      { tenant_id: TENANT_ID, email: MEMBER_EMAIL, reason: "complaint" },
      { tenant_id: "other-tenant", email: MEMBER_EMAIL, reason: "unsubscribe" },
      { tenant_id: null, email: MEMBER_EMAIL, reason: "unsubscribe" },
    ];
    const { db, statements } = prefsDb(m, [], supp);
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await portalRoutes.request(
      "/stitchstudio/preferences",
      { method: "PUT", headers, body: JSON.stringify({ email_opt_out: false }) },
      prefsEnv(db)
    );
    expect(res.status).toBe(200);
    expect(m.email_opt_out_at).toBeNull();
    expect(supp.map((r) => `${r.tenant_id}:${r.reason}`)).toEqual([
      `${TENANT_ID}:bounce`,
      `${TENANT_ID}:complaint`,
      "other-tenant:unsubscribe",
      "null:unsubscribe",
    ]);
    const del = statements.find((s) => s.sql.includes("DELETE FROM email_suppressions"))!;
    expect(del.binds).toEqual([TENANT_ID, MEMBER_EMAIL]);

    // Opting OUT never deletes suppression rows.
    statements.length = 0;
    await portalRoutes.request(
      "/stitchstudio/preferences",
      { method: "PUT", headers, body: JSON.stringify({ email_opt_out: true }) },
      prefsEnv(db)
    );
    expect(statements.some((s) => s.sql.includes("DELETE FROM email_suppressions"))).toBe(false);
  });

  it("opting out is idempotent (a second opt-out keeps the original timestamp)", async () => {
    const m = member("2026-01-01T00:00:00.000Z");
    const { db } = prefsDb(m);
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await portalRoutes.request("/stitchstudio/preferences", { method: "PUT", headers, body: JSON.stringify({ email_opt_out: true }) }, prefsEnv(db));
    expect(res.status).toBe(200);
    expect(m.email_opt_out_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("401 without a session, 404 for a non-member, 400 for a non-boolean body", async () => {
    const { db } = prefsDb(member());
    const env = prefsEnv(db);
    expect((await portalRoutes.request("/stitchstudio/preferences", {}, env)).status).toBe(401);

    const stranger = await signJwt({ sub: "user-2", email: "stranger@example.test" }, JWT_SECRET);
    expect(
      (await portalRoutes.request("/stitchstudio/preferences", { headers: { Authorization: `Bearer ${stranger}` } }, env)).status
    ).toBe(404);

    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    expect(
      (await portalRoutes.request("/stitchstudio/preferences", { method: "PUT", headers, body: JSON.stringify({ email_opt_out: "yes" }) }, env)).status
    ).toBe(400);
  });
});

describe("GET /api/portal/:slug/pages — trashed pages are hidden", () => {
  it("excludes deleted_at rows", async () => {
    const m: PrefMember = { id: "member-1", tenant_id: TENANT_ID, email: MEMBER_EMAIL, status: "active", email_opt_out_at: null, updated_at: "x" };
    const { db } = prefsDb(m, [
      { slug: "live", deleted_at: null, published: 1 },
      { slug: "trashed", deleted_at: "2026-09-06T00:00:00.000Z", published: 1 },
    ]);
    const res = await portalRoutes.request("/stitchstudio/pages", { headers: await authHeader() }, prefsEnv(db));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { slug: string }[];
    expect(rows.map((r) => r.slug)).toEqual(["live"]);
  });
});

/* ————————————————— The portal's household view (spec §4.3) —————————————————
 *
 * "Your household membership, paid by Jane, renews December 31." The payer
 * manages who is on it; everybody else can see it and edit only themselves.
 *
 * Real in-memory SQLite (src/lib/householdTestDb.ts) rather than the fake
 * above, because the answers here — who is on the household, and whether the
 * spouse counts as a member — come out of SQL.
 */
import { beforeEach } from "vitest";
import {
  createHouseholdTestDb,
  seedLevel,
  seedMember,
  seedMembership,
  seedTenant,
  type HouseholdTestDb,
} from "../lib/householdTestDb";

describe("portal households", () => {
  let hdb: HouseholdTestDb;

  const env = () =>
    ({ DB: hdb, JWT_SECRET, APP_URL: "https://quilthosting.test" }) as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

  async function as(email: string, path: string, init: RequestInit = {}) {
    const token = await signJwt({ sub: `u-${email}`, email }, JWT_SECRET, 600);
    return portalRoutes.request(
      `http://x${path}`,
      { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } },
      env(),
      ctx as unknown as ExecutionContext
    );
  }

  beforeEach(() => {
    hdb = createHouseholdTestDb();
    seedTenant(hdb, { slug: "stitchers", name: "Stitchers Guild" });
    seedLevel(hdb, { id: "hl", name: "Household", price_cents: 4000, household_max: 3 });
    seedMember(hdb, {
      id: "payer",
      email: "jane@example.test",
      first_name: "Jane",
      last_name: "Alvarez",
    });
    seedMember(hdb, {
      id: "spouse",
      email: "dana@example.test",
      first_name: "Dana",
      last_name: "Alvarez",
      status: "pending",
    });
    seedMembership(hdb, {
      id: "ms",
      member_id: "payer",
      level_id: "hl",
      household_id: "h1",
      end_date: "2026-12-31T23:59:59.999Z",
    });
    hdb.run(
      `INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at)
       VALUES ('h1', 'tenant-1', 'The Alvarez household', 'payer', '', '')`
    );
    hdb.run(
      `INSERT INTO household_members (household_id, member_id, role, added_at)
       VALUES ('h1', 'payer', 'payer', ''), ('h1', 'spouse', 'member', '')`
    );
  });

  it("tells a household member who paid and when it renews", async () => {
    const res = await as("dana@example.test", "/stitchers/household");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      household: { name: string; members: Array<{ id: string; role: string }> };
      is_payer: boolean;
      payer: { first_name: string };
      membership: { end_date: string; level_name: string };
      max_people: number;
    };
    expect(body.household.name).toBe("The Alvarez household");
    expect(body.household.members.map((m) => m.id)).toEqual(["payer", "spouse"]);
    expect(body.is_payer).toBe(false);
    expect(body.payer.first_name).toBe("Jane");
    expect(body.membership.end_date).toBe("2026-12-31T23:59:59.999Z");
    expect(body.membership.level_name).toBe("Household");
    expect(body.max_people).toBe(3);
  });

  it("marks the payer as the payer", async () => {
    const body = (await (await as("jane@example.test", "/stitchers/household")).json()) as {
      is_payer: boolean;
    };
    expect(body.is_payer).toBe(true);
  });

  it("returns household: null for a member in none", async () => {
    seedMember(hdb, { id: "solo", email: "solo@example.test" });
    const body = (await (await as("solo@example.test", "/stitchers/household")).json()) as {
      household: unknown;
    };
    expect(body.household).toBeNull();
  });

  it("carries the household and the payer's membership on /me", async () => {
    const body = (await (await as("dana@example.test", "/stitchers/me")).json()) as {
      membership: unknown;
      household: { payer_member_id: string };
      household_membership: { end_date: string } | null;
      is_member: boolean;
    };
    expect(body.membership).toBeNull(); // she holds none of her own
    expect(body.household.payer_member_id).toBe("payer");
    expect(body.household_membership?.end_date).toBe("2026-12-31T23:59:59.999Z");
    expect(body.is_member).toBe(true); // derived from the payer
  });

  it("gives a household member the member price on events", async () => {
    const body = (await (await as("dana@example.test", "/stitchers/events")).json()) as {
      is_member: boolean;
    };
    expect(body.is_member).toBe(true);
  });

  it("lists a household member in the directory", async () => {
    const body = (await (await as("jane@example.test", "/stitchers/directory")).json()) as {
      members: Array<{ first_name: string }>;
      total: number;
    };
    expect(body.members.map((m) => m.first_name).sort()).toEqual(["Dana", "Jane"]);
    expect(body.total).toBe(2);
  });

  describe("payer-only management", () => {
    it("lets the payer rename the household", async () => {
      const res = await as("jane@example.test", "/stitchers/household", {
        method: "PATCH",
        body: JSON.stringify({ name: "Alvarez-Chen" }),
      });
      expect(res.status).toBe(200);
      expect(
        hdb.rows<{ name: string }>("SELECT name FROM households WHERE id = 'h1'")[0].name
      ).toBe("Alvarez-Chen");
    });

    it("refuses a rename from anybody else", async () => {
      const res = await as("dana@example.test", "/stitchers/household", {
        method: "PATCH",
        body: JSON.stringify({ name: "Someone else's house" }),
      });
      expect(res.status).toBe(403);
      expect(
        hdb.rows<{ name: string }>("SELECT name FROM households WHERE id = 'h1'")[0].name
      ).toBe("The Alvarez household");
    });

    it("lets the payer add a person, up to the level's household_max", async () => {
      const res = await as("jane@example.test", "/stitchers/household/people", {
        method: "POST",
        body: JSON.stringify({ email: "Kim@Example.test", first_name: "Kim" }),
      });
      expect(res.status).toBe(200);
      expect(hdb.rows("SELECT * FROM household_members WHERE household_id = 'h1'")).toHaveLength(3);
      expect(
        hdb.rows<{ email: string; status: string }>(
          "SELECT email, status FROM members WHERE email = 'kim@example.test'"
        )[0]
      ).toMatchObject({ status: "pending" });

      // A fourth is one too many for a household_max of 3.
      const full = await as("jane@example.test", "/stitchers/household/people", {
        method: "POST",
        body: JSON.stringify({ email: "sam@example.test" }),
      });
      expect(full.status).toBe(409);
      expect((await full.json()) as { code: string }).toMatchObject({ code: "household_full" });
    });

    it("refuses to add someone who is already in another household", async () => {
      seedMember(hdb, { id: "other-payer", email: "other@example.test" });
      seedMember(hdb, { id: "taken", email: "taken@example.test" });
      hdb.run(
        `INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at)
         VALUES ('h2', 'tenant-1', 'Other', 'other-payer', '', '')`
      );
      hdb.run(
        `INSERT INTO household_members (household_id, member_id, role, added_at)
         VALUES ('h2', 'other-payer', 'payer', ''), ('h2', 'taken', 'member', '')`
      );
      const res = await as("jane@example.test", "/stitchers/household/people", {
        method: "POST",
        body: JSON.stringify({ email: "taken@example.test" }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: "already_in_household",
      });
    });

    it("refuses an add from a non-payer", async () => {
      const res = await as("dana@example.test", "/stitchers/household/people", {
        method: "POST",
        body: JSON.stringify({ email: "kim@example.test" }),
      });
      expect(res.status).toBe(403);
      expect(hdb.rows("SELECT * FROM household_members")).toHaveLength(2);
    });

    it("lets the payer remove someone without deleting them", async () => {
      const res = await as("jane@example.test", "/stitchers/household/people/spouse", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(hdb.rows("SELECT * FROM household_members WHERE household_id = 'h1'")).toHaveLength(1);
      const spouse = hdb.rows<{ status: string }>(
        "SELECT status FROM members WHERE id = 'spouse'"
      )[0];
      expect(spouse).toBeTruthy();
      expect(spouse.status).toBe("pending"); // never was active in her own right
    });

    it("will not let the payer remove themselves", async () => {
      const res = await as("jane@example.test", "/stitchers/household/people/payer", {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: "payer_cannot_leave",
      });
      expect(hdb.rows("SELECT * FROM households")).toHaveLength(1);
    });
  });
});

describe("household enrolment needs consent or an officer", () => {
  it("refuses to pull an existing member into the payer's household", async () => {
    // A payer could otherwise enroll any member of the guild without asking:
    // it moves whose payment their membership hangs on, and household_members
    // has UNIQUE(member_id), so it also blocks them forming their own.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/routes/portal.ts", "utf8")
    );
    expect(src).toContain('code: "existing_member"');
    const addHandler = src.slice(
      src.indexOf('portalRoutes.post("/:slug/household/people"'),
      src.indexOf('portalRoutes.delete("/:slug/household/people/:memberId"')
    );
    expect(addHandler).toMatch(/member && member\.id !== ctx\.member\.id/);
    // and the refusal must come before any write
    expect(addHandler.indexOf('code: "existing_member"')).toBeLessThan(
      addHandler.indexOf("INSERT INTO members")
    );
  });
});
