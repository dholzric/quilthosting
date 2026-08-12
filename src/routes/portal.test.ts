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
