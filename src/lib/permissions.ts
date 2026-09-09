// src/lib/permissions.ts
// Single, explicit role -> route-area permission matrix for the tenant admin
// API (`/api/tenants/:tenantId/<area>/...`, see the `tenantApp.route(...)`
// block in src/index.ts).
//
// Background: `requireTenantAccess` (src/middleware/auth.ts) only proves the
// caller has *some* `tenant_users` row (or is a platform admin) and stores the
// role on context as `tenantRole`. Until this module existed nothing enforced
// that role, so a Viewer could POST /pages or mint an API key. This file is the
// policy; src/middleware/permissions.ts is the enforcement point.
//
// Deliberately dependency-free and table-driven so public/admin.html can mirror
// the same table for nav gating without importing Worker code.
//
// Matrix (R = read/GET, W = write/POST|PUT|PATCH|DELETE, X = export downloads,
// "-" = no access at all, not even GET):
//
// | area        | owner/admin/platform | membership | events | viewer |
// |-------------|----------------------|------------|--------|--------|
// | levels      | RW                   | RW         | R      | R      |
// | members     | RW X                 | RW X       | R      | R      |
// | events      | RW X                 | R  X       | RW     | R      |
// | stats       | RW X                 | R  X       | R      | R      |
// | reports     | RW                   | R          | R      | R      |
// | payments    | RW X                 | RW X       | R      | R      |
// | emails      | RW                   | RW         | R      | R      |
// | groups      | RW                   | RW         | R      | R      |
// | team        | RW                   | R          | R      | R      |
// | pages       | RW                   | R          | R      | R      |
// | files       | RW                   | R          | R      | R      |
// | products    | RW                   | R          | R      | R      |
// | billing     | RW                   | -          | -      | -      |
// | forms       | RW X                 | RW X       | RW     | R      |
// | invoices    | RW X                 | RW X       | R      | R      |
// | credentials | RW                   | -          | -      | -      |
// | automations | RW                   | R          | R      | R      |
// | forum       | RW                   | R          | R      | R      |
// | api-keys    | RW                   | -          | -      | -      |
// | sms         | RW                   | RW         | R      | R      |
// | chapters    | RW                   | R          | R      | R      |
// | webhooks    | RW                   | -          | -      | -      |
// | qbo         | RW                   | -          | -      | -      |
// | domain      | RW                   | -          | -      | -      |
// | galleries   | RW                   | R          | RW     | R      |
// | projects    | RW                   | R          | R      | R      |
//
// Notes:
// - "X" (exports) = any sub-path containing `export` or `.csv` (e.g.
//   /members/export.csv, /payments/export.iif, /events/:id/registrations.csv).
//   Exports are owner/admin/platform/membership only, even where the role can
//   otherwise read the area (so the events role cannot pull registrations.csv).
// - OPEN_SUBPATHS (below) lists the few write-method routes that write
//   nothing and are therefore open to every role that can read the area
//   (today: POST /pages/preview).
// - Routes that already carry their own stricter checks (team.ts owner-only
//   rules, billing.ts owner-only cancel, domain.ts / credentials.ts /
//   projects.ts owner|admin|platform guards) keep them; this matrix is a
//   floor, never a ceiling.
// - Unknown areas fail closed for every role except owner/admin/platform.

export type TenantRole =
  | "owner"
  | "admin"
  | "membership"
  | "events"
  | "viewer"
  | "platform";

export const TENANT_ROLES: readonly TenantRole[] = [
  "owner",
  "admin",
  "membership",
  "events",
  "viewer",
  "platform",
];

/** Sub-app prefixes mounted under /api/tenants/:tenantId in src/index.ts. */
export const TENANT_AREAS = [
  "levels",
  "members",
  "events",
  "stats",
  "reports",
  "payments",
  "emails",
  "groups",
  "team",
  "pages",
  "files",
  "products",
  "billing",
  "forms",
  "invoices",
  "credentials",
  "automations",
  "forum",
  "api-keys",
  "sms",
  "chapters",
  "webhooks",
  "qbo",
  "domain",
  "galleries",
  "projects",
] as const;

export type TenantArea = (typeof TENANT_AREAS)[number];

/** Areas that non-admin roles may not touch at all (not even GET). */
export const ADMIN_ONLY_AREAS: readonly TenantArea[] = [
  "api-keys",
  "credentials",
  "billing",
  "qbo",
  "webhooks",
  "domain",
];

type RoleRule = {
  /** "*" = every area (including unknown ones) readable and writable. */
  write: "*" | readonly TenantArea[];
  /** Areas the role may not read at all. Ignored when write === "*". */
  noRead: readonly TenantArea[];
  /** May download exports (paths containing `export` or `.csv`). */
  exports: boolean;
};

const FULL: RoleRule = { write: "*", noRead: [], exports: true };

export const PERMISSION_MATRIX: Readonly<Record<TenantRole, RoleRule>> = {
  owner: FULL,
  admin: FULL,
  platform: FULL,
  membership: {
    write: [
      "members",
      "levels",
      "groups",
      "invoices",
      "payments",
      "emails",
      "sms",
      "forms",
    ],
    noRead: ADMIN_ONLY_AREAS,
    exports: true,
  },
  events: {
    write: ["events", "galleries", "forms"],
    noRead: ADMIN_ONLY_AREAS,
    exports: false,
  },
  viewer: {
    write: [],
    noRead: ADMIN_ONLY_AREAS,
    exports: false,
  },
};

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Write-method sub-paths that are open to every role allowed to READ the
 * area. Each entry is a route that writes nothing despite its method:
 *
 * - POST /pages/preview renders unsaved editor state to sanitized HTML so an
 *   events chair (or a viewer) can preview a page she cannot publish.
 *
 * Matched on the exact sub-path (trailing slash ignored), never a prefix,
 * so /pages/preview/anything stays governed by the area's write rule.
 */
export const OPEN_SUBPATHS: readonly {
  area: TenantArea;
  method: string;
  subPath: string;
}[] = [{ area: "pages", method: "POST", subPath: "/preview" }];

function isOpenSubPath(area: string, method: string, subPath: string): boolean {
  const p = subPath.split("?")[0].replace(/\/+$/, "").toLowerCase();
  return OPEN_SUBPATHS.some(
    (o) => o.area === area && o.method === method && o.subPath === p
  );
}

export function isTenantRole(role: unknown): role is TenantRole {
  return typeof role === "string" && (TENANT_ROLES as readonly string[]).includes(role);
}

export function isTenantArea(area: unknown): area is TenantArea {
  return typeof area === "string" && (TENANT_AREAS as readonly string[]).includes(area);
}

/** True when the sub-path (after the area) is an export/download endpoint. */
export function isExportPath(subPath: string): boolean {
  const p = subPath.toLowerCase();
  return p.includes("export") || p.includes(".csv");
}

/**
 * Pure policy check. `area` is the first path segment after the tenantId,
 * `subPath` is whatever follows it (may be "" or "/"). Unknown roles and
 * unknown areas fail closed (except full-access roles, which see everything).
 */
export function canAccess(
  role: string | undefined | null,
  area: string,
  method: string,
  subPath = ""
): boolean {
  if (!isTenantRole(role)) return false;
  const rule = PERMISSION_MATRIX[role];
  if (rule.write === "*") return true;
  if (!isTenantArea(area)) return false;

  const m = method.toUpperCase();
  const isRead = READ_METHODS.has(m);

  if (rule.noRead.includes(area)) return false;
  if (isExportPath(subPath) && !rule.exports) return false;
  if (isRead) return true;
  if (isOpenSubPath(area, m, subPath)) return true;
  return rule.write.includes(area);
}

/** Roles that would be admitted to the given cell; used for 403 payloads. */
export function rolesAllowed(area: string, method: string, subPath = ""): TenantRole[] {
  return TENANT_ROLES.filter((r) => canAccess(r, area, method, subPath));
}

/**
 * Split a full request path into { area, subPath } relative to the tenant
 * mount. Works from the `/tenants/<id>/` marker so it does not depend on the
 * exact mount prefix; pass `tenantId` when known to disambiguate.
 *
 *   /api/tenants/t1/members/export.csv -> { area: "members", subPath: "/export.csv" }
 *   /api/tenants/t1/api-keys           -> { area: "api-keys", subPath: "" }
 *   /api/tenants/t1                    -> { area: "", subPath: "" }
 */
export function splitTenantPath(
  path: string,
  tenantId?: string
): { area: string; subPath: string } {
  const segs = path.split("?")[0].split("/").filter(Boolean);
  let idx = -1;
  if (tenantId) {
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i] === "tenants" && safeDecode(segs[i + 1]) === tenantId) {
        idx = i + 1;
        break;
      }
    }
  }
  if (idx === -1) {
    const t = segs.indexOf("tenants");
    if (t === -1 || t + 1 >= segs.length) return { area: "", subPath: "" };
    idx = t + 1;
  }
  const area = segs[idx + 1] ?? "";
  const rest = segs.slice(idx + 2);
  return { area, subPath: rest.length ? "/" + rest.join("/") : "" };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
