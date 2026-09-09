// src/lib/adminNav.ts
//
// The admin sidebar as data, so the same model can be tested here and
// rendered by public/admin.html (which mirrors ADMIN_NAV verbatim -- see
// src/lib/adminNavGating.test.ts, which pins the copy to this file).
//
// Four things decide whether an officer ever sees a screen:
//   1. `simple`  -- the Simple/Advanced switch (settings.ui.advanced). Simple
//                   is the default: nine everyday screens, grouped.
//   2. `area`    -- the real permission matrix (src/lib/permissions.ts). A
//                   viewer never sees API keys; an events chair never sees a
//                   screen she cannot even GET.
//   3. `tenant`  -- guild vs business. The old drag-and-drop page builder
//                   ("pages") and the new site builder ("site-pages") both
//                   label themselves "Website"; they must never both show.
//   4. `feature` -- settings.features. Off means the screen does not exist.
//
// Entries with no `area` are ones the API does not gate by area at all
// (Settings, the business identity/appearance panels, and the platform
// overview, which admin.html shows only to platform admins).
import { canAccess } from "./permissions";
import type { FeatureKey } from "./features";

export type NavGroup =
  | "Home"
  | "People"
  | "Calendar"
  | "Site"
  | "Money"
  | "Email"
  | "More"
  | "Settings";

/** Render order for the grouped sidebar. */
export const NAV_GROUPS: readonly NavGroup[] = [
  "Home",
  "People",
  "Calendar",
  "Site",
  "Money",
  "Email",
  "More",
  "Settings",
];

export type NavEntry = {
  /** data-page value; must match a branch of navigate() in admin.html. */
  page: string;
  label: string;
  group: NavGroup;
  /** Visible when advanced === false. The everyday nine. */
  simple: boolean;
  /** Only for this tenant type; omitted = both. */
  tenant?: "guild" | "business";
  /** Key into PERMISSION_MATRIX; omitted = not area-gated. */
  area?: string;
  /** Hidden unless this settings.features flag is on. */
  feature?: FeatureKey;
};

export const ADMIN_NAV: NavEntry[] = [
  // Home
  { page: "dashboard", label: "Dashboard", group: "Home", simple: true, area: "stats" },
  { page: "platform", label: "Platform", group: "Home", simple: false },
  // People
  { page: "members", label: "Members", group: "People", simple: true, area: "members" },
  { page: "levels", label: "Levels", group: "People", simple: true, tenant: "guild", area: "levels" },
  { page: "team", label: "Team", group: "People", simple: true, area: "team" },
  { page: "chapters", label: "Chapters", group: "People", simple: false, tenant: "guild", area: "chapters" },
  // Calendar
  { page: "events", label: "Events", group: "Calendar", simple: true, area: "events" },
  // Site
  { page: "pages", label: "Website", group: "Site", simple: true, tenant: "guild", area: "pages" },
  { page: "site-pages", label: "Website", group: "Site", simple: true, tenant: "business", area: "pages" },
  { page: "site-theme", label: "Appearance", group: "Site", simple: false, tenant: "business" },
  { page: "site-domain", label: "Domain & Launch", group: "Site", simple: false, tenant: "business", area: "domain" },
  { page: "site-identity", label: "Business details", group: "Site", simple: false, tenant: "business" },
  { page: "blog", label: "Blog", group: "Site", simple: false, area: "pages" },
  { page: "galleries", label: "Photos", group: "Site", simple: false, area: "galleries" },
  { page: "files", label: "Documents", group: "Site", simple: false, area: "files" },
  { page: "forum", label: "Forum", group: "Site", simple: false, tenant: "guild", area: "forum" },
  // Money
  { page: "payments", label: "Payments", group: "Money", simple: true, area: "payments" },
  { page: "invoices", label: "Invoices", group: "Money", simple: false, area: "invoices" },
  { page: "store", label: "Store", group: "Money", simple: false, area: "products" },
  { page: "projects", label: "Projects", group: "Money", simple: false, tenant: "business", area: "projects" },
  { page: "project-rates", label: "Quilting rates", group: "Money", simple: false, tenant: "business", area: "projects" },
  // Email
  { page: "comms", label: "Email", group: "Email", simple: true, area: "emails" },
  { page: "sms", label: "SMS", group: "Email", simple: false, area: "sms" },
  // More (collapsed behind a disclosure in the sidebar)
  { page: "automations", label: "Automations", group: "More", simple: false, area: "automations" },
  { page: "forms", label: "Forms", group: "More", simple: false, area: "forms" },
  // Reports is an existing screen: Advanced hides it from the default sidebar,
  // but no feature flag may take it away from a tenant that has it today.
  { page: "reports", label: "Reports", group: "More", simple: false, area: "stats" },
  { page: "api", label: "API", group: "More", simple: false, area: "api-keys" },
  { page: "webhooks", label: "Zapier", group: "More", simple: false, area: "webhooks" },
  // Settings
  { page: "settings", label: "Settings", group: "Settings", simple: true },
];

/**
 * The screens this officer, on this tenant, with these switches, may see.
 * Order follows ADMIN_NAV (which is written in NAV_GROUPS order).
 */
export function visibleNav(opts: {
  advanced: boolean;
  role: string;
  tenantType: "guild" | "business";
  features: Record<string, boolean>;
}): NavEntry[] {
  return ADMIN_NAV.filter((e) => {
    if (!opts.advanced && !e.simple) return false;
    if (e.tenant && e.tenant !== opts.tenantType) return false;
    if (e.feature && opts.features[e.feature] !== true) return false;
    if (e.area && !canAccess(opts.role, e.area, "GET", "/")) return false;
    return true;
  });
}
