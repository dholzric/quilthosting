// src/lib/permissions.test.ts
// Table-driven coverage of the role x area x method matrix in permissions.ts.
// Pure unit test, no Worker bindings (vitest.config.ts convention).
import { describe, it, expect } from "vitest";
import {
  canAccess,
  rolesAllowed,
  splitTenantPath,
  isExportPath,
  TENANT_AREAS,
  TENANT_ROLES,
  ADMIN_ONLY_AREAS,
  type TenantRole,
} from "./permissions";

const WRITE = ["POST", "PUT", "PATCH", "DELETE"] as const;

describe("canAccess: full-access roles", () => {
  it.each(["owner", "admin", "platform"] as const)("%s may do anything", (role) => {
    for (const area of TENANT_AREAS) {
      expect(canAccess(role, area, "GET")).toBe(true);
      for (const m of WRITE) expect(canAccess(role, area, m)).toBe(true);
      expect(canAccess(role, area, "GET", "/export.csv")).toBe(true);
    }
    // Unknown areas are still open to full-access roles.
    expect(canAccess(role, "something-new", "POST")).toBe(true);
  });
});

describe("canAccess: viewer", () => {
  it("may GET every non-admin-only area and nothing else", () => {
    for (const area of TENANT_AREAS) {
      const adminOnly = (ADMIN_ONLY_AREAS as readonly string[]).includes(area);
      expect(canAccess("viewer", area, "GET"), `viewer GET ${area}`).toBe(!adminOnly);
      for (const m of WRITE) {
        expect(canAccess("viewer", area, m), `viewer ${m} ${area}`).toBe(false);
      }
    }
  });

  it("has no access at all to admin-only areas", () => {
    for (const area of ["api-keys", "credentials", "billing", "qbo", "webhooks", "domain"]) {
      expect(canAccess("viewer", area, "GET")).toBe(false);
      expect(canAccess("viewer", area, "POST")).toBe(false);
    }
  });

  it("may GET team (read-only)", () => {
    expect(canAccess("viewer", "team", "GET")).toBe(true);
    expect(canAccess("viewer", "team", "POST")).toBe(false);
  });

  it("may not download exports", () => {
    expect(canAccess("viewer", "members", "GET", "/export.csv")).toBe(false);
    expect(canAccess("viewer", "payments", "GET", "/export.iif")).toBe(false);
    expect(canAccess("viewer", "events", "GET", "/ev1/registrations.csv")).toBe(false);
    expect(canAccess("viewer", "events", "GET", "/ev1/registrations")).toBe(true);
  });
});

describe("canAccess: membership", () => {
  const writable = ["members", "levels", "groups", "invoices", "payments", "emails", "sms", "forms"];

  it("writes only its own areas", () => {
    for (const area of TENANT_AREAS) {
      const adminOnly = (ADMIN_ONLY_AREAS as readonly string[]).includes(area);
      expect(canAccess("membership", area, "GET"), `membership GET ${area}`).toBe(!adminOnly);
      for (const m of WRITE) {
        expect(canAccess("membership", area, m), `membership ${m} ${area}`).toBe(
          writable.includes(area)
        );
      }
    }
  });

  it.each([
    "pages",
    "files",
    "products",
    "billing",
    "team",
    "credentials",
    "api-keys",
    "webhooks",
    "qbo",
    "domain",
    "automations",
    "projects",
    "events",
    "galleries",
  ])("cannot write %s", (area) => {
    expect(canAccess("membership", area, "POST")).toBe(false);
    expect(canAccess("membership", area, "DELETE", "/x")).toBe(false);
  });

  it("can record/refund payments and send blasts/sms", () => {
    expect(canAccess("membership", "payments", "POST", "/p1/refund")).toBe(true);
    expect(canAccess("membership", "emails", "POST")).toBe(true);
    expect(canAccess("membership", "sms", "POST", "/send")).toBe(true);
  });

  it("may download exports", () => {
    expect(canAccess("membership", "members", "GET", "/export.csv")).toBe(true);
    expect(canAccess("membership", "payments", "GET", "/export.iif")).toBe(true);
    expect(canAccess("membership", "events", "GET", "/ev1/registrations.csv")).toBe(true);
  });
});

describe("canAccess: events", () => {
  const writable = ["events", "galleries", "forms"];

  it("writes only events, galleries, forms", () => {
    for (const area of TENANT_AREAS) {
      const adminOnly = (ADMIN_ONLY_AREAS as readonly string[]).includes(area);
      expect(canAccess("events", area, "GET"), `events GET ${area}`).toBe(!adminOnly);
      for (const m of WRITE) {
        expect(canAccess("events", area, m), `events ${m} ${area}`).toBe(writable.includes(area));
      }
    }
  });

  it("can check in registrants", () => {
    expect(canAccess("events", "events", "POST", "/ev1/check-in")).toBe(true);
    expect(canAccess("events", "events", "PATCH", "/ev1/registrations/r1")).toBe(true);
  });

  it("cannot write members or mint keys", () => {
    expect(canAccess("events", "members", "POST")).toBe(false);
    expect(canAccess("events", "api-keys", "POST")).toBe(false);
    expect(canAccess("events", "api-keys", "GET")).toBe(false);
  });

  it("may not download exports", () => {
    expect(canAccess("events", "events", "GET", "/ev1/registrations.csv")).toBe(false);
    expect(canAccess("events", "members", "GET", "/export.csv")).toBe(false);
  });
});

describe("canAccess: admin-only writes", () => {
  it.each([
    ["api-keys", "POST", ""],
    ["api-keys", "DELETE", "/k1"],
    ["credentials", "PUT", "/stripe"],
    ["billing", "POST", "/checkout"],
    ["domain", "POST", ""],
    ["team", "POST", "/invite"],
    ["team", "PATCH", "/u1"],
    ["webhooks", "POST", ""],
    ["qbo", "POST", "/connect"],
  ])("only owner/admin/platform may %s %s%s", (area, method, sub) => {
    expect(rolesAllowed(area, method, sub).sort()).toEqual(["admin", "owner", "platform"]);
  });
});

describe("canAccess: fail closed", () => {
  it("rejects missing, empty, and unknown roles", () => {
    expect(canAccess(undefined, "members", "GET")).toBe(false);
    expect(canAccess(null, "members", "GET")).toBe(false);
    expect(canAccess("", "members", "GET")).toBe(false);
    expect(canAccess("superuser", "members", "GET")).toBe(false);
  });

  it("rejects unknown or empty areas for limited roles", () => {
    for (const role of ["viewer", "membership", "events"] as TenantRole[]) {
      expect(canAccess(role, "", "GET")).toBe(false);
      expect(canAccess(role, "not-an-area", "GET")).toBe(false);
    }
  });

  it("is case-insensitive on method", () => {
    expect(canAccess("viewer", "members", "get")).toBe(true);
    expect(canAccess("viewer", "members", "post")).toBe(false);
  });
});

describe("rolesAllowed", () => {
  it("lists every role for a plain read", () => {
    expect(rolesAllowed("members", "GET").sort()).toEqual([...TENANT_ROLES].sort());
  });
  it("lists membership + admins for a members write", () => {
    expect(rolesAllowed("members", "POST").sort()).toEqual(
      ["admin", "membership", "owner", "platform"].sort()
    );
  });
});

describe("isExportPath / splitTenantPath", () => {
  it("detects exports", () => {
    expect(isExportPath("/export.csv")).toBe(true);
    expect(isExportPath("/EXPORT.IIF")).toBe(true);
    expect(isExportPath("/ev1/volunteers.csv")).toBe(true);
    expect(isExportPath("/ev1/volunteers")).toBe(false);
    expect(isExportPath("")).toBe(false);
  });

  it("splits full paths at the tenantId segment", () => {
    expect(splitTenantPath("/api/tenants/t1/members/export.csv", "t1")).toEqual({
      area: "members",
      subPath: "/export.csv",
    });
    expect(splitTenantPath("/api/tenants/t1/api-keys", "t1")).toEqual({
      area: "api-keys",
      subPath: "",
    });
    expect(splitTenantPath("/api/tenants/t1/api-keys/", "t1")).toEqual({
      area: "api-keys",
      subPath: "",
    });
    expect(splitTenantPath("/api/tenants/t1", "t1")).toEqual({ area: "", subPath: "" });
  });

  it("falls back to the /tenants/ marker when tenantId is unknown", () => {
    expect(splitTenantPath("/api/tenants/abc/pages/p1")).toEqual({
      area: "pages",
      subPath: "/p1",
    });
    expect(splitTenantPath("/api/tenants/abc/pages?x=1")).toEqual({ area: "pages", subPath: "" });
    expect(splitTenantPath("/api/other")).toEqual({ area: "", subPath: "" });
  });

  it("uses the tenantId hint over a spoofed 'tenants' segment", () => {
    expect(splitTenantPath("/api/tenants/tenants/t1/pages", "t1")).toEqual({
      area: "pages",
      subPath: "",
    });
  });
});
