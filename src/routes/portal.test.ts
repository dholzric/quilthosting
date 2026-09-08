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

function prefsDb(member: PrefMember, pages: { slug: string; deleted_at: string | null; published: number }[] = []) {
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
