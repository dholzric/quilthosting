import { Hono } from "hono";
import type { Env, Tenant } from "../types";
import { generateId } from "../lib/utils/id";
import { first, all } from "../lib/db";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { TRIAL_DAYS } from "../lib/plans";
import { provisionPlatformSubdomain, tenantPublicBaseUrl } from "../lib/tenantHost";
import { starterPages, starterPageRow, starterSettingsJson } from "../lib/starterSite";
import {
  computeOnboarding,
  normalizeDomainStatus,
  type OnboardingTenant,
} from "../lib/onboarding";
import { DEFAULT_DESIGN, PATTERN_IDS, deriveRoles, designFontsHref, siteDesignSchema } from "../lib/site/design/tokens";
import { PALETTES, PALETTE_FAMILIES, PALETTE_FAMILY_LABELS } from "../lib/site/design/palettes";
import { TYPE_PAIRS } from "../lib/site/design/typePairs";
import { patternDataUri } from "../lib/site/design/patterns";
import { readSiteDesign } from "../lib/site/design/migrate";
import { FONT_OPTIONS } from "../lib/site/fonts";
import { KITS } from "../lib/site/kits/index";
import { kitSettingsJson } from "../lib/site/kits/apply";

export const tenantRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

tenantRoutes.use("*", requireAuth);

const CITY_MAX = 120;
const MEETING_INFO_MAX = 300;

/**
 * Where the public site can be reached RIGHT NOW. The /g/:slug platform path
 * always works; the free subdomain only once DNS provisioning reports active,
 * and a custom domain once set. tenantPublicBaseUrl() picks the nicest of
 * those; this only falls back to /g/ while the subdomain isn't ready.
 */
function publicUrlFor(env: Env, tenant: OnboardingTenant): string {
  const status = normalizeDomainStatus(tenant.domain_status);
  if (tenant.custom_domain || status === "active") {
    return tenantPublicBaseUrl(env, tenant);
  }
  return `${env.APP_URL.replace(/\/$/, "")}/g/${tenant.slug}`;
}

const SECRET_BEARING_ROLES = new Set(["owner", "admin", "platform"]);

/**
 * settings_json carries a few provider secrets that only owners/admins may
 * see (today: settings.twilio.auth_token). Every other role gets a masked
 * copy so a viewer or events chair cannot lift the guild's Twilio token from
 * the tenant record. Writes are unaffected: the tenant PATCH is owner/admin
 * only and replaces the whole settings object.
 */
export function redactSettingsForRole<T extends { settings_json?: string | null }>(
  row: T,
  role: string | null | undefined
): T {
  if (role && SECRET_BEARING_ROLES.has(role)) return row;
  if (!row.settings_json) return row;
  try {
    const s = JSON.parse(row.settings_json) as Record<string, unknown>;
    const tw = s.twilio as Record<string, unknown> | undefined;
    if (tw && typeof tw === "object" && tw.auth_token) {
      s.twilio = { ...tw, auth_token: "••••••••" };
      return { ...row, settings_json: JSON.stringify(s) };
    }
  } catch {
    /* unparsable settings: return as-is */
  }
  return row;
}

function withPublicFields(env: Env, tenant: OnboardingTenant) {
  return {
    ...tenant,
    domain_status: normalizeDomainStatus(tenant.domain_status),
    domain_error: tenant.domain_error || null,
    public_url: publicUrlFor(env, tenant),
    subdomain_url: tenantPublicBaseUrl(env, { ...tenant, custom_domain: null }),
    public_base_url: tenantPublicBaseUrl(env, tenant),
  };
}

/** Members of the guild, or platform admins. Returns the role or null. */
async function tenantAccessRole(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<string | null> {
  const membership = await first<{ role: string }>(
    db
      .prepare("SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?")
      .bind(tenantId, userId)
  );
  if (membership) return membership.role;
  const adminRow = await first<{ is_platform_admin: number }>(
    db.prepare("SELECT is_platform_admin FROM users WHERE id = ?").bind(userId)
  );
  return adminRow?.is_platform_admin ? "platform" : null;
}

// GET /api/tenants — guilds the current user belongs to
// Platform admins see every tenant (role = membership role or "platform").
tenantRoutes.get("/", async (c) => {
  const user = c.get("user");
  const adminRow = await first<{ is_platform_admin: number }>(
    c.env.DB.prepare(
      "SELECT is_platform_admin FROM users WHERE id = ?"
    ).bind(user.id)
  );
  if (adminRow?.is_platform_admin) {
    const rows = await all<Tenant & { role: string }>(
      c.env.DB.prepare(
        `SELECT t.*, COALESCE(tu.role, 'platform') AS role
         FROM tenants t
         LEFT JOIN tenant_users tu
           ON tu.tenant_id = t.id AND tu.user_id = ?
         ORDER BY t.name COLLATE NOCASE`
      ).bind(user.id)
    );
    return c.json({ tenants: rows, platform_admin: true });
  }
  const rows = await all<Tenant & { role: string }>(
    c.env.DB.prepare(
      `SELECT t.*, tu.role FROM tenants t
       JOIN tenant_users tu ON tu.tenant_id = t.id
       WHERE tu.user_id = ? AND t.status = 'active'
       ORDER BY t.created_at`
    ).bind(user.id)
  );
  return c.json({
    tenants: rows.map((r) => redactSettingsForRole(r, r.role)),
    platform_admin: false,
  });
});

// POST /api/tenants — create a guild; creator becomes owner.
// Seeds a five-page starter website (src/lib/starterSite.ts) and a default
// theme in the same batch, so the guild's public site is never empty, and
// kicks off free-subdomain provisioning with a persisted status.
//
// This route only ever creates guilds: tenant_type defaults to 'guild' and can
// only be flipped to 'business' afterwards by a platform admin
// (PATCH /api/platform/tenants/:id), so the guild starter site is the right
// seed for every row this handler inserts.
tenantRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    name: string;
    slug: string;
    city?: string;
    meeting_info?: string;
  }>();
  if (!body.name || !body.slug) {
    return c.json({ error: "name and slug are required" }, 400);
  }
  const name = String(body.name).trim();
  if (!name) return c.json({ error: "name and slug are required" }, 400);
  const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (slug.length < 2) {
    return c.json({ error: "Invalid slug" }, 400);
  }
  const city = body.city === undefined || body.city === null ? "" : String(body.city).trim();
  const meetingInfo =
    body.meeting_info === undefined || body.meeting_info === null
      ? ""
      : String(body.meeting_info).trim();
  if (city.length > CITY_MAX) {
    return c.json({ error: `city must be ${CITY_MAX} characters or fewer` }, 400);
  }
  if (meetingInfo.length > MEETING_INFO_MAX) {
    return c.json({ error: `meeting_info must be ${MEETING_INFO_MAX} characters or fewer` }, 400);
  }
  const existing = await first(
    c.env.DB.prepare("SELECT id FROM tenants WHERE slug = ?").bind(slug)
  );
  if (existing) {
    return c.json({ error: "Slug already taken" }, 409);
  }
  const id = generateId();
  const now = new Date().toISOString();
  // 30-day Guild trial (unlimited members) without a credit card
  const trialEnds = new Date();
  trialEnds.setUTCDate(trialEnds.getUTCDate() + TRIAL_DAYS);
  const trialIso = trialEnds.toISOString();

  const pageStmts = starterPages(name, { city, meetingInfo }).map((page) => {
    const row = starterPageRow(page);
    return c.env.DB.prepare(
      `INSERT INTO pages
       (id, tenant_id, slug, title, content_json, blocks_json, page_type, show_in_nav, nav_label,
        is_members_only, published, sort_order, seo_title, seo_description, noindex,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'page', 1, NULL, 0, 1, ?, NULL, NULL, 0, ?, ?)`
    ).bind(
      generateId(),
      id,
      row.slug,
      row.title,
      row.content_json,
      row.blocks_json,
      row.sort_order,
      now,
      now
    );
  });

  // All migrations are applied in production; no pre-migration fallback.
  // If this batch fails the client gets a 500 and nothing half-created.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO tenants (id, name, slug, plan, status, settings_json, trial_ends_at,
                            domain_status, domain_error, created_at, updated_at)
       VALUES (?, ?, ?, 'free', 'active', ?, ?, 'pending', NULL, ?, ?)`
    ).bind(id, name, slug, starterSettingsJson(), trialIso, now, now),
    c.env.DB.prepare(
      `INSERT INTO tenant_users (tenant_id, user_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`
    ).bind(id, user.id, now),
    ...pageStmts,
  ]);

  // Free {slug}.quilthosting.com subdomain. Runs after the response is sent
  // and records active/failed/skipped on the tenant row so the admin can
  // see (and retry) it from the onboarding checklist.
  const provisioning = provisionPlatformSubdomain(c.env, id, slug).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(provisioning);
  } catch {
    // No ExecutionContext (unit tests / non-Workers runtime): let it run detached.
    void provisioning;
  }

  const tenant = await first<OnboardingTenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  if (!tenant) return c.json({ error: "Guild was not created" }, 500);
  // The read-back may race the waitUntil above; the row was inserted pending.
  if (!tenant.domain_status) tenant.domain_status = "pending";
  return c.json(withPublicFields(c.env, tenant), 201);
});

// GET /api/tenants/:id/onboarding — computed setup checklist (members of the
// guild, or platform admins; same access rule as GET /:id).
tenantRoutes.get("/:id/onboarding", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const role = await tenantAccessRole(c.env.DB, id, user.id);
  if (!role) return c.json({ error: "Forbidden" }, 403);
  const tenant = await first<OnboardingTenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  if (!tenant) return c.json({ error: "Not found" }, 404);
  const state = await computeOnboarding(c.env.DB, tenant);
  const pub = withPublicFields(c.env, tenant);
  return c.json({
    ...state,
    public_url: pub.public_url,
    subdomain_url: pub.subdomain_url,
    custom_domain: tenant.custom_domain || null,
    role,
  });
});

// POST /api/tenants/:id/onboarding/dismiss — hide the checklist (any member
// role; it is a per-guild preference, not a privileged change). Body
// { undo: true } clears the dismissal so the "Setup" link can reopen it.
tenantRoutes.post("/:id/onboarding/dismiss", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const role = await tenantAccessRole(c.env.DB, id, user.id);
  if (!role) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json<{ undo?: boolean }>().catch(() => ({}) as { undo?: boolean });
  const now = new Date().toISOString();
  const onboardingJson = body.undo ? JSON.stringify({}) : JSON.stringify({ dismissed_at: now });
  await c.env.DB.prepare(
    `UPDATE tenants SET onboarding_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(onboardingJson, now, id)
    .run();
  return c.json({ ok: true, dismissed: !body.undo, dismissed_at: body.undo ? null : now });
});

const SITE_RENDERERS = new Set(["legacy", "sections"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Which renderer serves the tenant's public site. Mirrors the server rule
 * (useLegacyRenderer): only an explicit "legacy" keeps the classic shell. */
export function siteRendererOf(settings: unknown): "legacy" | "sections" {
  const site = isRecord(settings) ? settings.site : null;
  return isRecord(site) && site.renderer === "legacy" ? "legacy" : "sections";
}

/**
 * Validate the two design-system keys a tenant PATCH may carry. Returns the
 * settings with `design` normalised (palette id resolved to its inputs,
 * defaults filled) or the issues to send back as a 400. Every other key is
 * passed through untouched -- the admin always sends the merged object.
 */
export function validateDesignSettings(
  settings: Record<string, unknown>
): { ok: true; settings: Record<string, unknown> } | { ok: false; issues: { path: string; message: string }[] } {
  const out = { ...settings };
  const issues: { path: string; message: string }[] = [];
  if (out.design !== undefined) {
    const r = siteDesignSchema.safeParse(out.design);
    if (r.success) out.design = r.data;
    else issues.push(...r.error.issues.map((i) => ({ path: ["settings", "design", ...i.path].join("."), message: i.message })));
  }
  if (out.site !== undefined) {
    if (!isRecord(out.site)) {
      issues.push({ path: "settings.site", message: "Expected an object" });
    } else if (out.site.renderer !== undefined && !(typeof out.site.renderer === "string" && SITE_RENDERERS.has(out.site.renderer))) {
      issues.push({ path: "settings.site.renderer", message: 'renderer must be "legacy" or "sections"' });
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, settings: out };
}

const SYSTEM_STACK = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
function fontStackFor(key: string): string {
  return key === "system" ? SYSTEM_STACK : (FONT_OPTIONS[key]?.cssStack ?? FONT_OPTIONS.inter.cssStack);
}

// GET /api/tenants/:id/design-options — the palette / type-pair / pattern
// library for the admin Design panel, plus this tenant's current design
// (legacy themes migrated through readSiteDesign) and renderer. Read access
// is the same as GET /:id: any member of the tenant, or a platform admin.
tenantRoutes.get("/:id/design-options", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const membership = await first<{ role: string }>(
    c.env.DB.prepare("SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?").bind(id, user.id)
  );
  if (!membership) {
    const adminRow = await first<{ is_platform_admin: number }>(
      c.env.DB.prepare("SELECT is_platform_admin FROM users WHERE id = ?").bind(user.id)
    );
    if (!adminRow?.is_platform_admin) return c.json({ error: "Forbidden" }, 403);
  }
  const tenant = await first<Tenant>(c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id));
  if (!tenant) return c.json({ error: "Not found" }, 404);

  const current = readSiteDesign(tenant.settings_json);
  let settings: unknown = null;
  try { settings = JSON.parse(tenant.settings_json || "{}"); } catch { settings = null; }
  const currentDark = !!(current.palette.id && PALETTES.find((p) => p.id === current.palette.id)?.dark);
  const currentRoles = deriveRoles(current.palette.input, currentDark);
  const patternColors = { a: currentRoles.primary, b: currentRoles.dark, c: currentRoles.accent };

  return c.json({
    palettes: PALETTES.map((p) => ({
      id: p.id,
      name: p.name,
      family: p.family,
      dark: !!p.dark,
      input: p.input,
      roles: deriveRoles(p.input, !!p.dark),
    })),
    families: PALETTE_FAMILIES.map((f) => ({ id: f, label: PALETTE_FAMILY_LABELS[f] })),
    typePairs: TYPE_PAIRS.map((p) => ({
      id: p.id,
      name: p.name,
      display: p.display,
      body: p.body,
      sample: p.sample,
      fontsHref: designFontsHref({ ...DEFAULT_DESIGN, typePair: p.id }),
      displayStack: fontStackFor(p.display),
      bodyStack: fontStackFor(p.body),
    })),
    patterns: PATTERN_IDS.map((pid) => ({ id: pid, dataUri: patternDataUri(pid, patternColors) })),
    kits: KITS.map((k) => ({
      id: k.id,
      name: k.name,
      audience: k.audience,
      character: k.character,
      design: readSiteDesign(kitSettingsJson(k)),
    })),
    defaults: DEFAULT_DESIGN,
    current,
    renderer: siteRendererOf(settings),
  });
});

// GET /api/tenants/:id — members of the guild only (platform admins: any)
tenantRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const membership = await first<{ role: string }>(
    c.env.DB.prepare(
      "SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
    ).bind(id, user.id)
  );
  const viewerRole = membership?.role || "platform";
  if (!membership) {
    const adminRow = await first<{ is_platform_admin: number }>(
      c.env.DB.prepare(
        "SELECT is_platform_admin FROM users WHERE id = ?"
      ).bind(user.id)
    );
    if (!adminRow?.is_platform_admin) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }
  const tenant = await first<OnboardingTenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  if (!tenant) return c.json({ error: "Not found" }, 404);
  // public_base_url is computed server-side (custom domain > platform
  // subdomain > APP_URL), the same helper site.ts's send-estimate email
  // already uses for this exact purpose -- so the admin UI's "Resend link"
  // flow can build the customer-facing URL from an authoritative value
  // instead of guessing at the platform host from window.location.host,
  // which is wrong whenever admin.html happens to be reached on a launched
  // tenant's own hostname (final review, F9: an authenticated caller CAN
  // reach raw public/ files there -- siteGate's JWT-bearer bypass is
  // host-agnostic by design). public_url additionally falls back to the
  // /g/:slug path while the free subdomain is still pending/failed.
  return c.json(redactSettingsForRole(withPublicFields(c.env, tenant), viewerRole));
});

// PATCH /api/tenants/:id — owner/admin can rename or update settings
tenantRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const membership = await first<{ role: string }>(
    c.env.DB.prepare(
      "SELECT role FROM tenant_users WHERE tenant_id = ? AND user_id = ?"
    ).bind(id, user.id)
  );
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const body = await c.req.json<{
    name?: string;
    settings?: Record<string, unknown>;
    public_launched?: number | boolean;
  }>();
  const fields: string[] = [];
  const params: any[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: "name cannot be empty" }, 400);
    fields.push("name = ?");
    params.push(body.name.trim());
  }
  if (body.settings !== undefined) {
    if (!isRecord(body.settings)) {
      return c.json({ error: "settings must be an object", issues: [{ path: "settings", message: "Expected an object" }] }, 400);
    }
    // settings.design (site design tokens) and settings.site.renderer are
    // validated here so a bad value from the admin never reaches the
    // renderer; everything else in settings is the tenant's own business.
    const checked = validateDesignSettings(body.settings);
    if (!checked.ok) return c.json({ error: "Invalid settings", issues: checked.issues }, 400);
    fields.push("settings_json = ?");
    params.push(JSON.stringify(checked.settings));
  }
  // Deliberately NOT handled here: tenant_type. A tenant owner/admin who
  // could flip their own guild to "business" would drop their member cap
  // (src/lib/plans.ts) and gain the public launch toggle below. tenant_type
  // is set at tenant creation or by a platform admin only — see
  // PATCH /api/platform/tenants/:id in src/routes/platform.ts.
  if (body.public_launched !== undefined) {
    fields.push("public_launched = ?");
    params.push(body.public_launched ? 1 : 0);
  }
  if (!fields.length) return c.json({ error: "No fields to update" }, 400);
  fields.push("updated_at = ?");
  params.push(new Date().toISOString(), id);
  await c.env.DB.prepare(
    `UPDATE tenants SET ${fields.join(", ")} WHERE id = ?`
  )
    .bind(...params)
    .run();
  const tenant = await first<Tenant>(
    c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id)
  );
  return c.json(tenant);
});
