// src/lib/adminNav.test.ts
//
// The grouped sidebar model (phase 3, Task A). ADMIN_NAV is the single list
// of admin screens; visibleNav() crosses it with the four things that decide
// whether an officer ever sees a screen: the Simple/Advanced switch, her role
// (via the real PERMISSION_MATRIX), the tenant type, and the feature flags.
//
// The coverage test is the important one: admin.html's navigate() dispatch is
// the authoritative list of screens that exist, so a new screen that never
// gets a nav entry (or an entry for a screen that no longer exists) fails
// here instead of shipping as an unreachable page. Same "pin the reserved
// list to reality" idiom as src/lib/platformPaths.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ADMIN_NAV, NAV_GROUPS, visibleNav, type NavEntry } from "./adminNav";
import { FEATURE_KEYS, FEATURE_DEFAULTS, type FeatureKey } from "./features";
import { isTenantArea } from "./permissions";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN_HTML = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");

/** Every screen admin.html's navigate() can dispatch to (`page === "x"`). */
function navigatePages(html: string): string[] {
  const body = html.match(/async function navigate\(page\) \{[\s\S]*?\n {4}\}/);
  if (!body) throw new Error("Could not find navigate(page) in admin.html");
  const pages = [...body[0].matchAll(/page === "([\w-]+)"/g)].map((m) => m[1]);
  if (!pages.length) throw new Error("navigate(page) dispatch table looks empty");
  return pages;
}

const ALL_FEATURES_ON: Record<FeatureKey, boolean> = FEATURE_KEYS.reduce(
  (acc, k) => ({ ...acc, [k]: true }),
  {} as Record<FeatureKey, boolean>
);

const pagesOf = (entries: NavEntry[]) => entries.map((e) => e.page);

describe("ADMIN_NAV", () => {
  it("covers every screen admin.html's navigate() dispatches, exactly once", () => {
    const dispatch = navigatePages(ADMIN_HTML);
    expect(new Set(pagesOf(ADMIN_NAV)).size).toBe(ADMIN_NAV.length); // no duplicates
    expect(pagesOf(ADMIN_NAV).sort()).toEqual([...dispatch].sort());
  });

  it("only uses the declared groups, and every group has at least one entry", () => {
    for (const e of ADMIN_NAV) expect(NAV_GROUPS).toContain(e.group);
    for (const g of NAV_GROUPS) {
      expect(ADMIN_NAV.some((e) => e.group === g), `group ${g} has no entries`).toBe(true);
    }
  });

  it("every `area` is a real permission-matrix area (so canAccess never fails closed by typo)", () => {
    for (const e of ADMIN_NAV) {
      if (e.area) expect(isTenantArea(e.area), `${e.page}: unknown area ${e.area}`).toBe(true);
    }
  });

  it("every `feature` is a real feature key", () => {
    for (const e of ADMIN_NAV) {
      if (e.feature) expect(FEATURE_KEYS).toContain(e.feature);
    }
  });

  it("gives every entry a non-empty label", () => {
    for (const e of ADMIN_NAV) expect(e.label.trim().length).toBeGreaterThan(0);
  });
});

describe("visibleNav — the Simple set", () => {
  it("a guild owner in Simple mode sees exactly the nine everyday screens", () => {
    const seen = pagesOf(
      visibleNav({ advanced: false, role: "owner", tenantType: "guild", features: FEATURE_DEFAULTS })
    );
    expect(seen).toEqual([
      "dashboard",
      "members",
      "levels",
      "team",
      "events",
      "pages",
      "payments",
      "comms",
      "settings",
    ]);
  });

  it("a business owner in Simple mode sees the same set minus Levels, with the new site builder", () => {
    const seen = pagesOf(
      visibleNav({ advanced: false, role: "owner", tenantType: "business", features: FEATURE_DEFAULTS })
    );
    expect(seen).toEqual([
      "dashboard",
      "members",
      "team",
      "events",
      "site-pages",
      "payments",
      "comms",
      "settings",
    ]);
    expect(seen).not.toContain("levels");
    expect(seen).not.toContain("pages");
  });

  it("Simple mode hides everything else, but Advanced brings it all back", () => {
    const simple = new Set(
      pagesOf(visibleNav({ advanced: false, role: "owner", tenantType: "guild", features: ALL_FEATURES_ON }))
    );
    const advanced = pagesOf(
      visibleNav({ advanced: true, role: "owner", tenantType: "guild", features: ALL_FEATURES_ON })
    );
    // Advanced is a superset: nothing the officer could reach disappears.
    for (const p of simple) expect(advanced).toContain(p);
    // Every guild-visible screen is reachable once Advanced is on.
    const guildPages = ADMIN_NAV.filter((e) => e.tenant !== "business").map((e) => e.page);
    expect(advanced.sort()).toEqual([...guildPages].sort());
    for (const p of ["store", "invoices", "automations", "forms", "blog", "forum", "files", "galleries", "sms", "chapters", "api", "webhooks"]) {
      expect(simple.has(p), `${p} should be Advanced-only`).toBe(false);
      expect(advanced).toContain(p);
    }
  });
});

describe("visibleNav — roles", () => {
  it("a viewer never sees the admin-only screens (API keys, Zapier, domain)", () => {
    for (const advanced of [false, true]) {
      const seen = pagesOf(
        visibleNav({ advanced, role: "viewer", tenantType: "guild", features: ALL_FEATURES_ON })
      );
      expect(seen).not.toContain("api");
      expect(seen).not.toContain("webhooks");
      const biz = pagesOf(
        visibleNav({ advanced, role: "viewer", tenantType: "business", features: ALL_FEATURES_ON })
      );
      expect(biz).not.toContain("site-domain");
    }
  });

  it("an events chair keeps Events and Photos and loses the money screens' writes but not their reads", () => {
    const seen = pagesOf(
      visibleNav({ advanced: true, role: "events", tenantType: "guild", features: ALL_FEATURES_ON })
    );
    expect(seen).toContain("events");
    expect(seen).toContain("galleries");
    expect(seen).toContain("payments"); // read-only per PERMISSION_MATRIX, still visible
    expect(seen).not.toContain("api");
  });

  it("an unknown role sees nothing that is permission-gated", () => {
    const seen = pagesOf(
      visibleNav({ advanced: true, role: "kitten", tenantType: "guild", features: ALL_FEATURES_ON })
    );
    for (const e of ADMIN_NAV) {
      if (e.area) expect(seen).not.toContain(e.page);
    }
  });

  it("owner and admin see the same screens", () => {
    const opts = { advanced: true, tenantType: "guild" as const, features: ALL_FEATURES_ON };
    expect(pagesOf(visibleNav({ ...opts, role: "owner" }))).toEqual(
      pagesOf(visibleNav({ ...opts, role: "admin" }))
    );
  });
});

describe("visibleNav — tenant type", () => {
  it("business-only and guild-only entries never cross", () => {
    const guild = pagesOf(visibleNav({ advanced: true, role: "owner", tenantType: "guild", features: ALL_FEATURES_ON }));
    const business = pagesOf(visibleNav({ advanced: true, role: "owner", tenantType: "business", features: ALL_FEATURES_ON }));
    for (const e of ADMIN_NAV) {
      if (e.tenant === "business") {
        expect(guild, `${e.page} is business-only`).not.toContain(e.page);
        expect(business).toContain(e.page);
      }
      if (e.tenant === "guild") {
        expect(business, `${e.page} is guild-only`).not.toContain(e.page);
        expect(guild).toContain(e.page);
      }
    }
  });

  it("keeps the two Website builders apart (the old page builder is guild-only)", () => {
    const entry = (p: string) => ADMIN_NAV.find((e) => e.page === p)!;
    expect(entry("pages").tenant).toBe("guild");
    expect(entry("site-pages").tenant).toBe("business");
    expect(entry("site-theme").tenant).toBe("business");
    expect(entry("site-domain").tenant).toBe("business");
    for (const p of ["levels", "chapters", "forum"]) expect(entry(p).tenant).toBe("guild");
    for (const p of ["dashboard", "members", "blog", "settings"]) expect(entry(p).tenant).toBeUndefined();
  });
});

describe("visibleNav — feature flags", () => {
  it("a feature-gated entry appears only when its flag is on", () => {
    const gated = ADMIN_NAV.filter((e) => e.feature);
    expect(gated.length).toBeGreaterThan(0);
    for (const e of gated) {
      const off = pagesOf(
        visibleNav({ advanced: true, role: "owner", tenantType: e.tenant || "guild", features: FEATURE_DEFAULTS })
      );
      const on = pagesOf(
        visibleNav({
          advanced: true,
          role: "owner",
          tenantType: e.tenant || "guild",
          features: { ...FEATURE_DEFAULTS, [e.feature!]: true },
        })
      );
      expect(off, `${e.page} should be hidden while ${e.feature} is off`).not.toContain(e.page);
      expect(on).toContain(e.page);
    }
  });

  it("Reports is the feature-gated screen (features.reports, default off)", () => {
    expect(ADMIN_NAV.find((e) => e.page === "reports")!.feature).toBe("reports");
    expect(FEATURE_DEFAULTS.reports).toBe(false);
  });

  it("a missing features map behaves like all-off", () => {
    const seen = pagesOf(
      visibleNav({ advanced: true, role: "owner", tenantType: "guild", features: {} })
    );
    for (const e of ADMIN_NAV) {
      if (e.feature) expect(seen).not.toContain(e.page);
    }
  });
});
