# P0 — Business Tenant + Public Site Renderer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let QuiltHosting host a small business's primary public website — server-rendered, indexable, themed, on its own domain, live to the public while the rest of the platform stays password-gated.

**Architecture:** A `tenant_type` column splits business tenants from guilds and suppresses membership machinery for them. A new `src/lib/site/` module server-renders themed HTML from the existing `pages`/`blocks` data instead of serving the client-rendered `guild.html` SPA. `siteGate` gains a host-resolution step so exactly one launched tenant can be public while everything else stays dark. An AES-GCM credential table is added for P4's PayPal keys.

**Tech Stack:** TypeScript ESM, Cloudflare Workers, Hono, Zod, D1, R2, KV, WebCrypto. Tests: vitest (new, pure units) + `scripts/verify-*.mjs` node scripts (existing convention, integration).

**Spec:** `docs/superpowers/specs/2026-08-10-p0-business-tenant-public-site-design.md`

## Global Constraints

- **Tenant scoping:** every tenant-scoped query filters by `tenant_id`. No exceptions.
- **Storage conventions:** money is integer cents; booleans are INTEGER 0/1; timestamps are ISO strings; JSON columns are TEXT with a `_json` suffix.
- **camelCase** for code identifiers and new filenames (matches `tenantHost.ts`, `webhookOutbox.ts`).
- **No frontend framework.** Admin UI is vanilla DOM APIs. `public/qh-admin-ext.js` is the pattern: build nodes with `document.createElement`, never HTML string injection.
- **Stripe stores no secrets.** `tenants.stripe_account_id` only. Secret material goes in `tenant_credentials` (Task 11) or Worker secrets.
- **Typecheck must pass:** `npx tsc --noEmit` is clean before every commit.
- **Version:** `package.json` is at `0.31.0-preview`. Bump the minor to `0.32.0-preview` in Task 1 and leave it; P0 is one feature.
- **Guilds must not regress.** Every change defaults to existing guild behaviour. `tenant_type` defaults to `'guild'`, `public_launched` defaults to `0`.
- **Do not convert the five existing `verify-*.mjs` scripts to vitest.** Out of scope.

## File Structure

**Create:**
- `vitest.config.ts` — vitest config, node environment
- `migrations/0019_business_tenants.sql` — all P0 DDL in one migration
- `src/lib/tenantType.ts` — `isBusiness()` predicate, the single read point for `tenant_type`
- `src/lib/site/theme.ts` — `ThemeConfig`, `DEFAULT_THEME`, `safeColor`, `buildRootVars`
- `src/lib/site/fonts.ts` — `FONT_OPTIONS`, `resolveFont`, `buildFontsHref`
- `src/lib/site/themePresets.ts` — named presets
- `src/lib/site/themeMigrate.ts` — legacy ↔ token conversion both directions
- `src/lib/site/seo.ts` — meta/OG/canonical/JSON-LD emission
- `src/lib/site/render.ts` — page layout: header, nav, blocks, footer
- `src/lib/site/cache.ts` — Cache API wrapper keyed on `updated_at`
- `src/lib/credentials.ts` — AES-GCM encrypt/decrypt + D1 read/write
- `src/routes/credentials.ts` — admin API, never emits plaintext
- `public/qh-site-builder.js` — site-builder admin panels
- `scripts/verify-business-site.mjs` — gate matrix + D1-backed integration checks

**Modify:**
- `package.json` — vitest devDep, `test` script, version bump
- `src/types.ts` — `Tenant.tenant_type`/`public_launched`, `Env.CREDENTIAL_KEY`
- `src/lib/plans.ts:52` — business tenants have no member cap
- `src/lib/renewals.ts:27` — skip business tenants
- `src/lib/blocks.ts` — six new block types in `parseBlocks` and `blocksToHtml`
- `src/routes/public.ts:1084` — `/site` derives legacy theme fields from tokens
- `src/middleware/siteGate.ts` — per-tenant launch exemption
- `src/index.ts` — route business tenant hosts to the renderer
- `public/admin.html:74-77` — sidebar entries, hidden for guilds

---

### Task 1: Test harness, schema, and the `tenant_type` predicate

**Files:**
- Create: `vitest.config.ts`, `migrations/0019_business_tenants.sql`, `src/lib/tenantType.ts`, `src/lib/tenantType.test.ts`
- Modify: `package.json`, `src/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isBusiness(tenant: Pick<Tenant, "tenant_type">): boolean`, `isLaunched(tenant: Pick<Tenant, "tenant_type" | "public_launched">): boolean`. `Tenant` gains `tenant_type: "guild" | "business"` and `public_launched: number`. `Env` gains `CREDENTIAL_KEY?: string`.

- [ ] **Step 1: Add vitest and the test script**

In `package.json`, add to `devDependencies`: `"vitest": "^3.2.0"`. Add to `scripts`: `"test": "vitest run"`, `"test:watch": "vitest"`. Change `"version"` to `"0.32.0-preview"`.

Then run `npm install`.

- [ ] **Step 2: Create the vitest config**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-unit tests only. Anything needing D1, R2, or a live Worker
    // belongs in scripts/verify-*.mjs, per the existing convention.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Write the failing test**

```ts
// src/lib/tenantType.test.ts
import { describe, it, expect } from "vitest";
import { isBusiness, isLaunched } from "./tenantType";

describe("isBusiness", () => {
  it("is true only for tenant_type 'business'", () => {
    expect(isBusiness({ tenant_type: "business" })).toBe(true);
    expect(isBusiness({ tenant_type: "guild" })).toBe(false);
  });

  it("defaults to guild when the column is missing or junk", () => {
    // Rows written before migration 0019, or a bad manual UPDATE.
    expect(isBusiness({ tenant_type: undefined as never })).toBe(false);
    expect(isBusiness({ tenant_type: null as never })).toBe(false);
    expect(isBusiness({ tenant_type: "BUSINESS" as never })).toBe(false);
  });
});

describe("isLaunched", () => {
  it("requires both business type and public_launched=1", () => {
    expect(isLaunched({ tenant_type: "business", public_launched: 1 })).toBe(true);
    expect(isLaunched({ tenant_type: "business", public_launched: 0 })).toBe(false);
    expect(isLaunched({ tenant_type: "guild", public_launched: 1 })).toBe(false);
  });

  it("is false when public_launched is absent", () => {
    expect(isLaunched({ tenant_type: "business", public_launched: undefined as never })).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `npx vitest run src/lib/tenantType.test.ts`
Expected: FAIL — `Failed to resolve import "./tenantType"`.

- [ ] **Step 5: Write the implementation**

```ts
// src/lib/tenantType.ts
// Single read point for tenants.tenant_type. Everything that needs to know
// "is this a business?" asks here, so the guild/business split never becomes
// a scatter of inline string comparisons.

export type TenantType = "guild" | "business";

/**
 * Strict equality against the literal 'business'. Anything else — including a
 * missing column on a pre-migration row, or a differently-cased value — is a
 * guild. Defaulting to guild is the safe direction: a misread guild keeps its
 * existing behaviour, while a misread business would silently disable
 * membership limits.
 */
export function isBusiness(tenant: { tenant_type?: string | null }): boolean {
  return tenant.tenant_type === "business";
}

/**
 * A tenant is publicly launched only when it is a business AND explicitly
 * flagged. Guilds are never launched in the P0 sense — they stay behind the
 * site gate on guild.html.
 */
export function isLaunched(tenant: {
  tenant_type?: string | null;
  public_launched?: number | null;
}): boolean {
  return isBusiness(tenant) && tenant.public_launched === 1;
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run src/lib/tenantType.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Write the migration**

```sql
-- migrations/0019_business_tenants.sql
-- P0: business tenant type, per-tenant public launch, page SEO fields,
-- and the encrypted per-tenant credential store (populated in P4).

-- Business vs guild. Defaults to 'guild' so every existing tenant is unchanged.
ALTER TABLE tenants ADD COLUMN tenant_type TEXT NOT NULL DEFAULT 'guild';

-- Per-tenant public launch. Defaults to 0 so no tenant escapes the site gate
-- until explicitly launched.
ALTER TABLE tenants ADD COLUMN public_launched INTEGER NOT NULL DEFAULT 0;

-- Per-page SEO. All nullable; the renderer falls back to page.title and the
-- first text block when these are empty.
ALTER TABLE pages ADD COLUMN seo_title TEXT;
ALTER TABLE pages ADD COLUMN seo_description TEXT;
ALTER TABLE pages ADD COLUMN og_image_file_id TEXT;
ALTER TABLE pages ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0;

-- Encrypted per-tenant third-party credentials (PayPal client id/secret in P4).
-- Stripe is NOT stored here: tenants.stripe_account_id is a public identifier.
CREATE TABLE tenant_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  key TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_tenant_credentials
  ON tenant_credentials(tenant_id, provider, key);

-- Launched-tenant lookup runs on every request to a tenant host.
CREATE INDEX idx_tenants_launched
  ON tenants(tenant_type, public_launched);
```

- [ ] **Step 8: Apply the migration locally and confirm the columns exist**

```bash
npm run db:migrate:local
npx wrangler d1 execute quilthosting-db --local --command="SELECT tenant_type, public_launched FROM tenants LIMIT 1"
```

Expected: the query succeeds (zero rows is fine). A "no such column" error means the migration did not apply.

- [ ] **Step 9: Update the shared types**

In `src/types.ts`, add to the `Tenant` interface after `custom_domain`:

```ts
  /** 'guild' (default) or 'business'. Read via isBusiness() in lib/tenantType. */
  tenant_type: "guild" | "business";
  /** 1 = this tenant's public site bypasses the site gate. Businesses only. */
  public_launched: number;
```

And add to the `Env` type, after `JWT_SECRET`:

```ts
  /** AES-GCM key (base64, 32 bytes) for tenant_credentials. Required in production. */
  CREDENTIAL_KEY?: string;
```

- [ ] **Step 10: Typecheck and commit**

```bash
npx tsc --noEmit
npx vitest run
git add package.json package-lock.json vitest.config.ts migrations/0019_business_tenants.sql src/lib/tenantType.ts src/lib/tenantType.test.ts src/types.ts
git commit -m "feat(business): tenant_type + public_launched schema, vitest harness"
```

---

### Task 2: Business tenants escape the membership machinery

**Files:**
- Modify: `src/lib/plans.ts:52`, `src/lib/renewals.ts:27`
- Create: `src/lib/plans.test.ts`

**Interfaces:**
- Consumes: `isBusiness` from Task 1.
- Produces: `activeMemberLimitForTenant` returns `null` for business tenants. `runRenewalJob` never selects them.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/plans.test.ts
import { describe, it, expect } from "vitest";
import { activeMemberLimitForTenant, FREE_ACTIVE_MEMBER_LIMIT } from "./plans";

// activeMemberLimitForTenant reads plan, trial_ends_at, and tenant_type only.
function tenant(over: Record<string, unknown> = {}) {
  return {
    plan: "free",
    trial_ends_at: null,
    tenant_type: "guild",
    ...over,
  } as never;
}

describe("activeMemberLimitForTenant", () => {
  it("caps a free guild at the free limit", () => {
    expect(activeMemberLimitForTenant(tenant())).toBe(FREE_ACTIVE_MEMBER_LIMIT);
  });

  it("returns null (uncapped) for a free business tenant", () => {
    // A business's 'members' are its customers. Capping them at 30 would cap
    // the customer list of a paying site.
    expect(activeMemberLimitForTenant(tenant({ tenant_type: "business" }))).toBeNull();
  });

  it("still returns null for a paid guild", () => {
    expect(activeMemberLimitForTenant(tenant({ plan: "starter" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm the business case fails**

Run: `npx vitest run src/lib/plans.test.ts`
Expected: FAIL on "returns null (uncapped) for a free business tenant" — receives `30`, expected `null`.

- [ ] **Step 3: Make business tenants uncapped**

In `src/lib/plans.ts`, add the import at the top:

```ts
import { isBusiness } from "./tenantType";
```

Then change `activeMemberLimitForTenant` (line 52) so it short-circuits before any plan logic:

```ts
export function activeMemberLimitForTenant(
  tenant: { plan?: string | null; trial_ends_at?: string | null; tenant_type?: string | null }
): number | null {
  // Businesses have customers, not members. The free-plan member cap is a
  // membership-organisation concept and does not apply to them.
  if (isBusiness(tenant)) return null;
  return activeMemberLimit(effectivePlan(tenant.plan, tenant.trial_ends_at));
}
```

If the existing signature differs, keep its parameter names and add `tenant_type` to the accepted shape — do not change what callers pass.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/plans.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Exclude business tenants from the renewal job**

`runRenewalJob` (`src/lib/renewals.ts:27`) sends renewal reminders, lapses expired memberships, and sends winbacks. A business tenant has no memberships, and must never receive "your membership expires in 30 days".

Find every `SELECT` in `renewals.ts` that iterates tenants — each one needs the same guard added to its `WHERE` clause:

```sql
AND coalesce(tenant_type, 'guild') = 'guild'
```

Use `coalesce` rather than `tenant_type = 'guild'` so the filter is correct even against a row written before the migration. Where the job joins from `memberships` or `members` to `tenants`, apply the guard to the joined `tenants` row.

- [ ] **Step 6: Verify no tenant query in renewals is unguarded**

Run: `grep -n "FROM tenants\|JOIN tenants" src/lib/renewals.ts`

Every result must have the `coalesce(tenant_type, 'guild') = 'guild'` guard within its statement. This is checked end-to-end in Task 12; this step is the manual read-through.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/plans.ts src/lib/plans.test.ts src/lib/renewals.ts
git commit -m "feat(business): exempt business tenants from member caps and renewals"
```

---

### Task 3: Theme token model

Ports austinlongarm's proven theme system (`E:\austinlongarm\src\lib\theme-css.ts`, `fonts.ts`, `theme-presets.ts`), which already carries CSS-injection sanitising and its own tests.

**Files:**
- Create: `src/lib/site/theme.ts`, `src/lib/site/theme.test.ts`, `src/lib/site/fonts.ts`, `src/lib/site/fonts.test.ts`, `src/lib/site/themePresets.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ThemeConfig` (13 keys), `FontsConfig`, `DEFAULT_THEME`, `DEFAULT_FONTS`, `safeColor(value: unknown, fallback: string): string`, `buildRootVars(theme: ThemeConfig, fonts: FontsConfig): string`, `resolveFont(key: string): FontOption`, `buildFontsHref(headingKey: string, bodyKey: string): string`, `THEME_PRESETS: { name: string; theme: ThemeConfig }[]`.

- [ ] **Step 1: Write the failing theme test**

```ts
// src/lib/site/theme.test.ts
import { describe, it, expect } from "vitest";
import { safeColor, buildRootVars, DEFAULT_THEME, DEFAULT_FONTS } from "./theme";

describe("safeColor", () => {
  it("accepts hex and functional colors", () => {
    expect(safeColor("#8a2060", "#000")).toBe("#8a2060");
    expect(safeColor("#abc", "#000")).toBe("#abc");
    expect(safeColor("rgb(10, 20, 30)", "#000")).toBe("rgb(10, 20, 30)");
    expect(safeColor("hsl(200 50% 40%)", "#000")).toBe("hsl(200 50% 40%)");
  });

  it("rejects anything that could break out of the style sink", () => {
    // This is the whole point: theme values reach an inline <style>.
    expect(safeColor("red}</style><script>alert(1)</script>", "#000")).toBe("#000");
    expect(safeColor("url(https://evil.example/x)", "#000")).toBe("#000");
    expect(safeColor("expression(alert(1))", "#000")).toBe("#000");
    expect(safeColor(42, "#000")).toBe("#000");
    expect(safeColor(undefined, "#000")).toBe("#000");
  });
});

describe("buildRootVars", () => {
  it("emits one CSS custom property per color token plus two font stacks", () => {
    const css = buildRootVars(DEFAULT_THEME, DEFAULT_FONTS);
    expect(css).toContain("--color-primary:#8a2060");
    expect(css).toContain("--color-text-muted:#504852");
    expect(css).toContain("--font-display:");
    expect(css).toContain("--font-sans:");
    // themeColor drives <meta name="theme-color">, not a CSS var.
    expect(css).not.toContain("--color-theme-color");
  });

  it("substitutes the default when a token is unsafe", () => {
    const css = buildRootVars(
      { ...DEFAULT_THEME, primary: "}</style>" },
      DEFAULT_FONTS,
    );
    expect(css).toContain(`--color-primary:${DEFAULT_THEME.primary}`);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/site/theme.test.ts`
Expected: FAIL — cannot resolve `./theme`.

- [ ] **Step 3: Write `theme.ts`**

```ts
// src/lib/site/theme.ts
// Theme token model, ported from austinlongarm (src/lib/theme-css.ts +
// config-defaults.ts). Thirteen tokens; twelve become CSS custom properties
// and themeColor drives the <meta name="theme-color"> tag.

import { resolveFont } from "./fonts";

export interface ThemeConfig {
  primary: string;
  primaryBright: string;
  primaryDark: string;
  secondary: string;
  secondaryBright: string;
  accent: string;
  accentBright: string;
  gold: string;
  bg: string;
  card: string;
  textBase: string;
  textMuted: string;
  themeColor: string;
}

export interface FontsConfig {
  /** key into FONT_OPTIONS */
  heading: string;
  /** key into FONT_OPTIONS */
  body: string;
}

export const DEFAULT_THEME: ThemeConfig = {
  primary: "#8a2060",
  primaryBright: "#c060a0",
  primaryDark: "#6a1048",
  secondary: "#6a4060",
  secondaryBright: "#e090c8",
  accent: "#a04080",
  accentBright: "#f0c8e0",
  gold: "#f0c060",
  bg: "#fcf6fa",
  card: "#fdf4f8",
  textBase: "#2a2530",
  textMuted: "#504852",
  themeColor: "#c060a0",
};

export const DEFAULT_FONTS: FontsConfig = { heading: "fraunces", body: "inter" };

const COLOR_VAR: Partial<Record<keyof ThemeConfig, string>> = {
  primary: "--color-primary",
  primaryBright: "--color-primary-bright",
  primaryDark: "--color-primary-dark",
  secondary: "--color-secondary",
  secondaryBright: "--color-secondary-bright",
  accent: "--color-accent",
  accentBright: "--color-accent-bright",
  gold: "--color-gold",
  bg: "--color-bg",
  card: "--color-card",
  textBase: "--color-text-base",
  textMuted: "--color-text-muted",
};

// Hex (#rgb..#rrggbbaa) or rgb()/rgba()/hsl()/hsla() over a safe charset.
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$|^(?:rgb|hsl)a?\([0-9.,%\s/]+\)$/;

/**
 * Return value only if it is a safe CSS color, else the fallback. Theme values
 * are owner-authored but reach an inline <style> block, so a value like
 * "red}</style><script>" must never pass through.
 */
export function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_COLOR.test(value.trim())
    ? value.trim()
    : fallback;
}

/** ":root" declaration body (no selector, no braces). All colors sanitised. */
export function buildRootVars(theme: ThemeConfig, fonts: FontsConfig): string {
  const parts: string[] = [];
  (Object.keys(COLOR_VAR) as (keyof ThemeConfig)[]).forEach((k) => {
    const cssVar = COLOR_VAR[k];
    if (!cssVar) return;
    parts.push(`${cssVar}:${safeColor(theme?.[k], DEFAULT_THEME[k])}`);
  });
  parts.push(`--font-display:${resolveFont(fonts?.heading).cssStack}`);
  parts.push(`--font-sans:${resolveFont(fonts?.body).cssStack}`);
  return parts.join(";");
}
```

- [ ] **Step 4: Write the failing fonts test**

```ts
// src/lib/site/fonts.test.ts
import { describe, it, expect } from "vitest";
import { resolveFont, buildFontsHref, FONT_OPTIONS } from "./fonts";

describe("resolveFont", () => {
  it("resolves a known key", () => {
    expect(resolveFont("fraunces").label).toBe("Fraunces");
  });

  it("falls back to inter for an unknown key", () => {
    expect(resolveFont("not-a-font").label).toBe("Inter");
    expect(resolveFont("").label).toBe("Inter");
  });
});

describe("buildFontsHref", () => {
  it("requests both families", () => {
    const href = buildFontsHref("fraunces", "inter");
    expect(href).toContain("family=Fraunces");
    expect(href).toContain("family=Inter");
    expect(href).toContain("display=swap");
  });

  it("requests a single family when heading and body match", () => {
    const href = buildFontsHref("inter", "inter");
    expect(href.match(/family=/g)).toHaveLength(1);
  });

  it("every option has a non-empty css stack", () => {
    for (const [key, opt] of Object.entries(FONT_OPTIONS)) {
      expect(opt.cssStack, key).toBeTruthy();
      expect(opt.googleQuery, key).toBeTruthy();
    }
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run src/lib/site/fonts.test.ts`
Expected: FAIL — cannot resolve `./fonts`.

- [ ] **Step 6: Write `fonts.ts`**

Copy `E:\austinlongarm\src\lib\fonts.ts` verbatim to `src/lib/site/fonts.ts`. It has no imports and no Astro dependency, so it ports unchanged: the `FontOption` interface, the ten-entry `FONT_OPTIONS` record (inter, fraunces, playfair, lora, merriweather, cormorant, poppins, sourcesans, worksans, nunito), `resolveFont`, and `buildFontsHref`.

- [ ] **Step 7: Run both test files and confirm they pass**

Run: `npx vitest run src/lib/site/`
Expected: PASS — 4 theme tests, 3 fonts tests.

- [ ] **Step 8: Write `themePresets.ts`**

```ts
// src/lib/site/themePresets.ts
// Named starting points for the admin theme picker. Ported from
// austinlongarm src/lib/theme-presets.ts.

import type { ThemeConfig } from "./theme";
import { DEFAULT_THEME } from "./theme";

export const THEME_PRESETS: { name: string; theme: ThemeConfig }[] = [
  { name: "Berry (default)", theme: DEFAULT_THEME },
  {
    name: "Ocean",
    theme: {
      ...DEFAULT_THEME,
      primary: "#1f6f8b", primaryBright: "#2a9d8f", primaryDark: "#14505c",
      secondary: "#3d5a6c", secondaryBright: "#8ecae6", accent: "#457b9d",
      accentBright: "#cfe8ef", gold: "#e9c46a", themeColor: "#2a9d8f",
    },
  },
  {
    name: "Forest",
    theme: {
      ...DEFAULT_THEME,
      primary: "#2d6a4f", primaryBright: "#40916c", primaryDark: "#1b4332",
      secondary: "#52796f", secondaryBright: "#95d5b2", accent: "#588157",
      accentBright: "#d8f3dc", gold: "#e9c46a", themeColor: "#40916c",
    },
  },
  {
    name: "Charcoal",
    theme: {
      ...DEFAULT_THEME,
      primary: "#3a3a3c", primaryBright: "#5a5a5e", primaryDark: "#1f1f21",
      secondary: "#55555a", secondaryBright: "#9a9aa2", accent: "#6b6b70",
      accentBright: "#e2e2e6", gold: "#d4a017", bg: "#f6f6f7", card: "#ffffff",
      themeColor: "#3a3a3c",
    },
  },
];

export function presetByName(name: string): ThemeConfig | null {
  return THEME_PRESETS.find((p) => p.name === name)?.theme ?? null;
}
```

- [ ] **Step 9: Typecheck and commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/site/theme.ts src/lib/site/theme.test.ts src/lib/site/fonts.ts src/lib/site/fonts.test.ts src/lib/site/themePresets.ts
git commit -m "feat(site): theme token model, font options, and presets"
```

---

### Task 4: Legacy theme conversion, both directions

The five-field `SiteTheme` in `src/lib/blocks.ts` must expand into `ThemeConfig`, and `/public/:slug/site` must keep emitting the five fields so `guild.html` — which every existing guild still uses — does not lose its styling.

**Files:**
- Create: `src/lib/site/themeMigrate.ts`, `src/lib/site/themeMigrate.test.ts`
- Modify: `src/routes/public.ts:1084`

**Interfaces:**
- Consumes: `ThemeConfig`, `DEFAULT_THEME`, `FontsConfig`, `DEFAULT_FONTS` from Task 3; `SiteTheme` from `src/lib/blocks.ts`.
- Produces: `expandLegacyTheme(legacy: SiteTheme | ThemeConfig | null | undefined): ThemeConfig`, `deriveLegacyTheme(theme: ThemeConfig): SiteTheme`, `fontsFromLegacy(legacy: SiteTheme | null | undefined): FontsConfig`, `readTenantTheme(settingsJson: string | null): { theme: ThemeConfig; fonts: FontsConfig }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/site/themeMigrate.test.ts
import { describe, it, expect } from "vitest";
import {
  expandLegacyTheme,
  deriveLegacyTheme,
  fontsFromLegacy,
  readTenantTheme,
} from "./themeMigrate";
import { DEFAULT_THEME, DEFAULT_FONTS } from "./theme";

describe("expandLegacyTheme", () => {
  it("maps the two legacy colors onto their tokens", () => {
    const t = expandLegacyTheme({ primary: "#123456", accent: "#654321" });
    expect(t.primary).toBe("#123456");
    expect(t.accent).toBe("#654321");
  });

  it("fills the remaining eleven tokens from the default", () => {
    const t = expandLegacyTheme({ primary: "#123456" });
    expect(t.gold).toBe(DEFAULT_THEME.gold);
    expect(t.textMuted).toBe(DEFAULT_THEME.textMuted);
    expect(Object.keys(t)).toHaveLength(13);
  });

  it("uses headerBg as the card token when present", () => {
    expect(expandLegacyTheme({ headerBg: "#fff8f0" }).card).toBe("#fff8f0");
  });

  it("passes an already-expanded theme through unchanged", () => {
    // Idempotent: the backfill must be safe to run twice.
    const already = { ...DEFAULT_THEME, primary: "#abcdef" };
    expect(expandLegacyTheme(already)).toEqual(already);
  });

  it("returns the default for null or empty input", () => {
    expect(expandLegacyTheme(null)).toEqual(DEFAULT_THEME);
    expect(expandLegacyTheme({})).toEqual(DEFAULT_THEME);
  });

  it("drops unsafe colors rather than propagating them", () => {
    expect(expandLegacyTheme({ primary: "}</style>" }).primary).toBe(DEFAULT_THEME.primary);
  });
});

describe("deriveLegacyTheme", () => {
  it("round-trips the fields guild.html reads", () => {
    const expanded = expandLegacyTheme({ primary: "#123456", accent: "#654321" });
    const legacy = deriveLegacyTheme(expanded);
    expect(legacy.primary).toBe("#123456");
    expect(legacy.accent).toBe("#654321");
  });

  it("always supplies headerBg so guild.html never renders unstyled", () => {
    expect(deriveLegacyTheme(DEFAULT_THEME).headerBg).toBeTruthy();
  });
});

describe("fontsFromLegacy", () => {
  it("maps the legacy font enum onto font keys", () => {
    expect(fontsFromLegacy({ font: "serif" })).toEqual({ heading: "lora", body: "lora" });
    expect(fontsFromLegacy({ font: "rounded" })).toEqual({ heading: "nunito", body: "nunito" });
    expect(fontsFromLegacy({ font: "system" })).toEqual(DEFAULT_FONTS);
  });

  it("defaults when font is absent", () => {
    expect(fontsFromLegacy({})).toEqual(DEFAULT_FONTS);
    expect(fontsFromLegacy(null)).toEqual(DEFAULT_FONTS);
  });
});

describe("readTenantTheme", () => {
  it("reads theme and fonts out of settings_json", () => {
    const json = JSON.stringify({ theme: { primary: "#111111" }, fonts: { heading: "lora", body: "inter" } });
    const { theme, fonts } = readTenantTheme(json);
    expect(theme.primary).toBe("#111111");
    expect(fonts).toEqual({ heading: "lora", body: "inter" });
  });

  it("survives malformed json", () => {
    const { theme, fonts } = readTenantTheme("{not json");
    expect(theme).toEqual(DEFAULT_THEME);
    expect(fonts).toEqual(DEFAULT_FONTS);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/site/themeMigrate.test.ts`
Expected: FAIL — cannot resolve `./themeMigrate`.

- [ ] **Step 3: Write `themeMigrate.ts`**

```ts
// src/lib/site/themeMigrate.ts
// Converts between the legacy five-field SiteTheme (which guild.html reads)
// and the thirteen-token ThemeConfig the server renderer uses.
//
// Both directions matter. Expansion powers the backfill and the renderer;
// derivation keeps /public/:slug/site emitting what guild.html expects, so
// there is one stored source of truth instead of two drifting copies.

import type { SiteTheme } from "../blocks";
import type { ThemeConfig, FontsConfig } from "./theme";
import { DEFAULT_THEME, DEFAULT_FONTS, safeColor } from "./theme";

const LEGACY_FONT_MAP: Record<string, FontsConfig> = {
  system: DEFAULT_FONTS,
  serif: { heading: "lora", body: "lora" },
  rounded: { heading: "nunito", body: "nunito" },
};

function isExpanded(v: Record<string, unknown>): boolean {
  // themeColor exists only on ThemeConfig, never on SiteTheme.
  return typeof v.themeColor === "string";
}

/** Legacy SiteTheme (or an already-expanded ThemeConfig) -> ThemeConfig. */
export function expandLegacyTheme(
  legacy: Partial<SiteTheme> | Partial<ThemeConfig> | null | undefined
): ThemeConfig {
  const src = (legacy || {}) as Record<string, unknown>;

  if (isExpanded(src)) {
    // Already migrated. Re-validate every token so an unsafe value stored by
    // an older build cannot survive, and so the backfill is idempotent.
    const out = {} as ThemeConfig;
    (Object.keys(DEFAULT_THEME) as (keyof ThemeConfig)[]).forEach((k) => {
      out[k] = safeColor(src[k], DEFAULT_THEME[k]);
    });
    return out;
  }

  const primary = safeColor(src.primary, DEFAULT_THEME.primary);
  const accent = safeColor(src.accent, DEFAULT_THEME.accent);
  return {
    ...DEFAULT_THEME,
    primary,
    accent,
    // headerBg was the guild header surface; card is its nearest token.
    card: safeColor(src.headerBg, DEFAULT_THEME.card),
    themeColor: primary,
  };
}

/** ThemeConfig -> the five fields guild.html still consumes. */
export function deriveLegacyTheme(theme: ThemeConfig): SiteTheme {
  return {
    primary: safeColor(theme.primary, DEFAULT_THEME.primary),
    accent: safeColor(theme.accent, DEFAULT_THEME.accent),
    headerBg: safeColor(theme.card, DEFAULT_THEME.card),
  };
}

/** Legacy `font` enum -> FontsConfig. */
export function fontsFromLegacy(
  legacy: Partial<SiteTheme> | null | undefined
): FontsConfig {
  const key = String((legacy || {}).font || "");
  return LEGACY_FONT_MAP[key] ?? DEFAULT_FONTS;
}

/**
 * Read a tenant's theme + fonts out of settings_json, expanding legacy shapes
 * on the fly. Never throws: a business site must render even if settings_json
 * is corrupt.
 */
export function readTenantTheme(
  settingsJson: string | null | undefined
): { theme: ThemeConfig; fonts: FontsConfig } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(settingsJson || "{}") as Record<string, unknown>;
  } catch {
    return { theme: DEFAULT_THEME, fonts: DEFAULT_FONTS };
  }
  const rawTheme = (parsed.theme || {}) as Record<string, unknown>;
  const theme = expandLegacyTheme(rawTheme);
  const storedFonts = parsed.fonts as Partial<FontsConfig> | undefined;
  const fonts: FontsConfig = storedFonts?.heading && storedFonts?.body
    ? { heading: String(storedFonts.heading), body: String(storedFonts.body) }
    : fontsFromLegacy(rawTheme as Partial<SiteTheme>);
  return { theme, fonts };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/site/themeMigrate.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Keep `/public/:slug/site` emitting legacy fields**

In `src/routes/public.ts`, add to the imports:

```ts
import { readTenantTheme } from "../lib/site/themeMigrate";
import { deriveLegacyTheme } from "../lib/site/themeMigrate";
```

In the `/:slug/site` handler (line 1084), replace `theme: settings.theme || {}` in the returned JSON with a derived legacy payload plus the full token set for new clients:

```ts
  const { theme: tokens, fonts } = readTenantTheme(tenant.settings_json);
  return c.json({
    // guild.html reads these five fields. Derived from the tokens rather than
    // stored separately, so there is a single source of truth.
    theme: deriveLegacyTheme(tokens),
    // Full token set + fonts for the server renderer and the new admin.
    theme_tokens: tokens,
    fonts,
    nav: settings.nav || [],
    nav_pages: navPages,
    store: {
      tax_rate_bps: taxRateBps,
      tax_label: settings.store?.tax_label || "Sales tax",
    },
  });
```

- [ ] **Step 6: Confirm guild.html still gets what it reads**

```bash
npx tsc --noEmit
grep -n "theme\." public/guild.html | head -20
```

Every `theme.` property `guild.html` accesses must be one of `primary`, `accent`, `headerBg`. If it reads `font` or `style`, add those to `deriveLegacyTheme`'s return and to its test before continuing — otherwise existing guild sites lose that styling.

- [ ] **Step 7: Commit**

```bash
npx vitest run
git add src/lib/site/themeMigrate.ts src/lib/site/themeMigrate.test.ts src/routes/public.ts
git commit -m "feat(site): legacy theme expansion + derivation for guild.html compatibility"
```

> **CORRECTIONS APPLIED DURING EXECUTION.** Three defects in this task's own
> text were found and fixed while implementing it. The code above is left as
> originally written for the record; what actually shipped differs as follows.
>
> 1. **The `guild.html` field list above is wrong.** Step 6 asserted it reads
>    `primary`, `accent`, `headerBg`. It actually reads `primary`, `font`, and
>    `style` (`public/guild.html:918-930`) and never touches `accent` or
>    `headerBg`. `deriveLegacyTheme` therefore takes an optional second
>    parameter carrying the raw legacy theme, so `font` and `style` pass
>    through. Without this every guild would have lost its font and layout
>    style. Step 6 existed to catch exactly this, and did.
> 2. **`themeColor: primary` contradicted this task's own test.** The test
>    requires `expandLegacyTheme({})` to deep-equal `DEFAULT_THEME`, whose
>    `themeColor` (`#c060a0`) differs from its `primary` (`#8a2060`). Shipped
>    as `safeColor(src.primary, "") || DEFAULT_THEME.themeColor`, so a custom
>    `primary` still drives the browser theme-color.
> 3. **`deriveLegacyTheme` must be presence-based, not defaulted.** As written
>    above it always returns a `primary`, so every guild with
>    `settings_json = '{}'` — the default at signup, and the common case —
>    would flip from the platform's brand orange (`--brand: #b5501f`,
>    `public/qh.css:20`) to austinlongarm's purple, because `guild.html`'s
>    `if (theme.primary)` guard would start firing. That violates this plan's
>    own "guilds must not regress" constraint. Shipped emitting
>    `primary`/`accent`/`headerBg` only when the tenant actually stored one,
>    mirroring the `font`/`style` logic. `expandLegacyTheme` and
>    `readTenantTheme` still return a fully-defaulted 13-token `ThemeConfig` —
>    the business renderer depends on that.

**Deliberate deviation from the spec.** The spec called for a one-time data
backfill rewriting `settings_json` for every tenant. This task does read-time
expansion instead: `readTenantTheme` expands legacy shapes on every read, and
`expandLegacyTheme` is idempotent, so a stored value may be either shape
forever. Nothing rewrites existing tenant rows.

That is strictly safer — it removes the "theme migration touching live guild
sites" risk the spec flagged, along with the dry-run mode and before-images
that risk required. A tenant's `settings_json` is only ever rewritten when its
owner saves the appearance form (Task 13), at which point it is written in the
new shape. Do not add a backfill script.

---

### Task 5: SEO tag emission

**Files:**
- Create: `src/lib/site/seo.ts`, `src/lib/site/seo.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type SeoPage = { title: string; slug: string; seo_title?: string | null; seo_description?: string | null; og_image_file_id?: string | null; noindex?: number | null }`
  - `type SeoBusiness = { name: string; phone?: string; email?: string; street?: string; city?: string; state?: string; zip?: string }`
  - `resolveTitle(page: SeoPage, siteName: string): string`
  - `resolveDescription(page: SeoPage, bodyHtml: string): string`
  - `canonicalUrl(baseUrl: string, slug: string): string`
  - `buildSeoHead(args: { page: SeoPage; siteName: string; baseUrl: string; bodyHtml: string; ogImageUrl?: string | null }): string`
  - `buildLocalBusinessJsonLd(business: SeoBusiness, baseUrl: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/site/seo.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveTitle,
  resolveDescription,
  canonicalUrl,
  buildSeoHead,
  buildLocalBusinessJsonLd,
} from "./seo";

const page = { title: "Longarm Quilting", slug: "services" };

describe("resolveTitle", () => {
  it("prefers seo_title", () => {
    expect(resolveTitle({ ...page, seo_title: "Custom Longarm" }, "Stitch Studio"))
      .toBe("Custom Longarm");
  });

  it("falls back to 'title | siteName'", () => {
    expect(resolveTitle(page, "Stitch Studio")).toBe("Longarm Quilting | Stitch Studio");
  });

  it("does not append the site name to the home page", () => {
    expect(resolveTitle({ title: "Stitch Studio", slug: "" }, "Stitch Studio"))
      .toBe("Stitch Studio");
  });
});

describe("resolveDescription", () => {
  it("prefers seo_description", () => {
    expect(resolveDescription({ ...page, seo_description: "Hand-guided." }, "<p>ignored</p>"))
      .toBe("Hand-guided.");
  });

  it("falls back to the body text, stripped and truncated at 160", () => {
    const body = "<p>" + "quilting ".repeat(40) + "</p>";
    const d = resolveDescription(page, body);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).not.toContain("<");
    expect(d.endsWith("…")).toBe(true);
  });

  it("returns empty string when there is no body", () => {
    expect(resolveDescription(page, "")).toBe("");
  });
});

describe("canonicalUrl", () => {
  it("builds an absolute url on the tenant base", () => {
    expect(canonicalUrl("https://stitchstudioquilting.com", "services"))
      .toBe("https://stitchstudioquilting.com/services");
  });

  it("maps the empty slug to the site root", () => {
    expect(canonicalUrl("https://stitchstudioquilting.com", ""))
      .toBe("https://stitchstudioquilting.com/");
  });

  it("tolerates a trailing slash on the base", () => {
    expect(canonicalUrl("https://x.com/", "a")).toBe("https://x.com/a");
  });
});

describe("buildSeoHead", () => {
  const base = {
    page,
    siteName: "Stitch Studio",
    baseUrl: "https://stitchstudioquilting.com",
    bodyHtml: "<p>Edge to edge quilting.</p>",
  };

  it("emits title, description, canonical, and OG tags", () => {
    const head = buildSeoHead(base);
    expect(head).toContain("<title>Longarm Quilting | Stitch Studio</title>");
    expect(head).toContain('<meta name="description" content="Edge to edge quilting.">');
    expect(head).toContain('<link rel="canonical" href="https://stitchstudioquilting.com/services">');
    expect(head).toContain('<meta property="og:title"');
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it("emits robots noindex only when the page asks for it", () => {
    expect(buildSeoHead(base)).not.toContain("noindex");
    expect(buildSeoHead({ ...base, page: { ...page, noindex: 1 } }))
      .toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("escapes quotes and angle brackets in every attribute", () => {
    const head = buildSeoHead({
      ...base,
      page: { ...page, seo_title: 'Quilts" onload="alert(1)' },
    });
    expect(head).not.toContain('onload="alert(1)"');
    expect(head).toContain("&quot;");
  });

  it("omits the og:image tag entirely when there is no image", () => {
    expect(buildSeoHead(base)).not.toContain("og:image");
    expect(buildSeoHead({ ...base, ogImageUrl: "https://x.com/a.jpg" }))
      .toContain('<meta property="og:image" content="https://x.com/a.jpg">');
  });
});

describe("buildLocalBusinessJsonLd", () => {
  it("emits a LocalBusiness script with the address", () => {
    const ld = buildLocalBusinessJsonLd(
      { name: "Stitch Studio", city: "Wimberley", state: "TX", zip: "78676", phone: "512-555-0100" },
      "https://stitchstudioquilting.com",
    );
    expect(ld).toContain('"@type":"LocalBusiness"');
    expect(ld).toContain('"addressLocality":"Wimberley"');
    expect(ld).toContain('"telephone":"512-555-0100"');
  });

  it("cannot break out of the script tag", () => {
    const ld = buildLocalBusinessJsonLd({ name: '</script><script>alert(1)' }, "https://x.com");
    expect(ld).not.toContain("</script><script>");
  });

  it("omits absent fields rather than emitting empty strings", () => {
    const ld = buildLocalBusinessJsonLd({ name: "X" }, "https://x.com");
    expect(ld).not.toContain("telephone");
    expect(ld).not.toContain("addressLocality");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/site/seo.test.ts`
Expected: FAIL — cannot resolve `./seo`.

- [ ] **Step 3: Write `seo.ts`**

```ts
// src/lib/site/seo.ts
// Per-page SEO head emission. She is replacing a site with sixteen years of
// search history, so these tags are load-bearing, not decoration.

export type SeoPage = {
  title: string;
  slug: string;
  seo_title?: string | null;
  seo_description?: string | null;
  og_image_file_id?: string | null;
  noindex?: number | null;
};

export type SeoBusiness = {
  name: string;
  phone?: string;
  email?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
};

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveTitle(page: SeoPage, siteName: string): string {
  const explicit = (page.seo_title || "").trim();
  if (explicit) return explicit;
  const t = (page.title || "").trim();
  // The home page is the site; "Stitch Studio | Stitch Studio" reads as spam.
  if (!page.slug || t === siteName) return t || siteName;
  return `${t} | ${siteName}`;
}

export function resolveDescription(page: SeoPage, bodyHtml: string): string {
  const explicit = (page.seo_description || "").trim();
  if (explicit) return explicit;
  const text = stripTags(bodyHtml || "");
  if (!text) return "";
  if (text.length <= 160) return text;
  return text.slice(0, 159).trimEnd() + "…";
}

export function canonicalUrl(baseUrl: string, slug: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return slug ? `${base}/${slug}` : `${base}/`;
}

export function buildSeoHead(args: {
  page: SeoPage;
  siteName: string;
  baseUrl: string;
  bodyHtml: string;
  ogImageUrl?: string | null;
}): string {
  const { page, siteName, baseUrl, bodyHtml, ogImageUrl } = args;
  const title = resolveTitle(page, siteName);
  const description = resolveDescription(page, bodyHtml);
  const canonical = canonicalUrl(baseUrl, page.slug);

  const out: string[] = [];
  out.push(`<title>${escAttr(title)}</title>`);
  if (description) {
    out.push(`<meta name="description" content="${escAttr(description)}">`);
  }
  out.push(`<link rel="canonical" href="${escAttr(canonical)}">`);
  if (page.noindex === 1) {
    out.push(`<meta name="robots" content="noindex, nofollow">`);
  }
  out.push(`<meta property="og:type" content="website">`);
  out.push(`<meta property="og:site_name" content="${escAttr(siteName)}">`);
  out.push(`<meta property="og:title" content="${escAttr(title)}">`);
  if (description) {
    out.push(`<meta property="og:description" content="${escAttr(description)}">`);
  }
  out.push(`<meta property="og:url" content="${escAttr(canonical)}">`);
  out.push(`<meta name="twitter:card" content="summary_large_image">`);
  if (ogImageUrl) {
    out.push(`<meta property="og:image" content="${escAttr(ogImageUrl)}">`);
    out.push(`<meta name="twitter:image" content="${escAttr(ogImageUrl)}">`);
  }
  return out.join("\n");
}

export function buildLocalBusinessJsonLd(
  business: SeoBusiness,
  baseUrl: string
): string {
  const address: Record<string, string> = { "@type": "PostalAddress" };
  if (business.street) address.streetAddress = business.street;
  if (business.city) address.addressLocality = business.city;
  if (business.state) address.addressRegion = business.state;
  if (business.zip) address.postalCode = business.zip;

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: business.name,
    url: baseUrl.replace(/\/+$/, "") + "/",
  };
  if (business.phone) data.telephone = business.phone;
  if (business.email) data.email = business.email;
  if (Object.keys(address).length > 1) data.address = address;

  // JSON inside <script> must not contain a literal "</script>". Escaping the
  // "<" as \u003c is valid JSON and inert in HTML.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/site/seo.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/site/seo.ts src/lib/site/seo.test.ts
git commit -m "feat(site): per-page SEO head and LocalBusiness JSON-LD"
```

---

### Task 6: Business page blocks

Six new block types. Each must round-trip `parseBlocks` and render escaped HTML in `blocksToHtml`.

**Files:**
- Modify: `src/lib/blocks.ts`
- Create: `src/lib/blocks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PageBlock` gains `hero | service_cards | gallery_grid | faq | testimonials | contact_form`. `blocksToHtml` renders all of them. New export `BUSINESS_BLOCK_TYPES: string[]` and `GUILD_ONLY_BLOCK_TYPES: string[]` for the admin picker.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/blocks.test.ts
import { describe, it, expect } from "vitest";
import { parseBlocks, blocksToHtml, BUSINESS_BLOCK_TYPES, GUILD_ONLY_BLOCK_TYPES } from "./blocks";

const XSS = '<img src=x onerror=alert(1)>';

describe("parseBlocks — new business blocks", () => {
  it("parses a hero", () => {
    const [b] = parseBlocks([
      { type: "hero", eyebrow: "Since 2009", title: "Stitch Studio", subtitle: "Longarm quilting",
        imageUrl: "https://x.com/h.jpg", ctaLabel: "Book", ctaHref: "/order" },
    ]);
    expect(b).toMatchObject({ type: "hero", title: "Stitch Studio", ctaHref: "/order" });
  });

  it("parses service cards and caps the list", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `S${i}`, body: "b", icon: "✦" }));
    const [b] = parseBlocks([{ type: "service_cards", items }]) as never[];
    expect((b as { items: unknown[] }).items.length).toBeLessThanOrEqual(12);
  });

  it("parses a gallery grid", () => {
    const [b] = parseBlocks([
      { type: "gallery_grid", items: [{ url: "https://x.com/1.jpg", alt: "a", caption: "c" }] },
    ]);
    expect(b).toMatchObject({ type: "gallery_grid" });
  });

  it("parses faq entries", () => {
    const [b] = parseBlocks([{ type: "faq", items: [{ q: "How long?", a: "Six weeks." }] }]);
    expect(b).toMatchObject({ type: "faq" });
  });

  it("parses testimonials", () => {
    const [b] = parseBlocks([{ type: "testimonials", items: [{ quote: "Lovely", author: "Jan" }] }]);
    expect(b).toMatchObject({ type: "testimonials" });
  });

  it("parses a contact form", () => {
    const [b] = parseBlocks([{ type: "contact_form", formSlug: "contact", submitLabel: "Send" }]);
    expect(b).toMatchObject({ type: "contact_form", formSlug: "contact" });
  });

  it("still drops unknown types", () => {
    expect(parseBlocks([{ type: "definitely_not_a_block" }])).toHaveLength(0);
  });
});

describe("blocksToHtml — escaping", () => {
  it("escapes hero text", () => {
    const html = blocksToHtml(parseBlocks([{ type: "hero", title: XSS, subtitle: XSS }]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes service card text", () => {
    const html = blocksToHtml(parseBlocks([
      { type: "service_cards", items: [{ title: XSS, body: XSS, icon: XSS }] },
    ]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes faq and testimonial text", () => {
    const faq = blocksToHtml(parseBlocks([{ type: "faq", items: [{ q: XSS, a: XSS }] }]));
    const tst = blocksToHtml(parseBlocks([{ type: "testimonials", items: [{ quote: XSS, author: XSS }] }]));
    expect(faq).not.toContain("<img src=x");
    expect(faq).toContain("&lt;img");
    expect(tst).not.toContain("<img src=x");
    expect(tst).toContain("&lt;img");
  });

  it("escapes gallery urls into the src attribute", () => {
    const html = blocksToHtml(parseBlocks([
      { type: "gallery_grid", items: [{ url: '"><script>alert(1)</script>', alt: "a" }] },
    ]));
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("still passes the raw html block through untouched", () => {
    // Deliberate: owner-authored embed escape hatch, already length-capped.
    const html = blocksToHtml(parseBlocks([{ type: "html", html: "<iframe src='https://youtube.com'></iframe>" }]));
    expect(html).toContain("<iframe");
  });
});

describe("block type lists", () => {
  it("keeps join_cta out of the business picker", () => {
    expect(GUILD_ONLY_BLOCK_TYPES).toContain("join_cta");
    expect(BUSINESS_BLOCK_TYPES).not.toContain("join_cta");
  });

  it("offers every new block to businesses", () => {
    for (const t of ["hero", "service_cards", "gallery_grid", "faq", "testimonials", "contact_form"]) {
      expect(BUSINESS_BLOCK_TYPES, t).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/blocks.test.ts`
Expected: FAIL — `BUSINESS_BLOCK_TYPES` is not exported, and the new block cases fall through `parseBlocks`'s `default` so the arrays come back empty.

- [ ] **Step 3: Extend the `PageBlock` union**

In `src/lib/blocks.ts`, add these members to the `PageBlock` union:

```ts
  | { type: "hero"; eyebrow?: string; title: string; subtitle?: string; imageUrl?: string; ctaLabel?: string; ctaHref?: string }
  | { type: "service_cards"; items: { icon?: string; title: string; body?: string }[] }
  | { type: "gallery_grid"; items: { url: string; alt?: string; caption?: string }[] }
  | { type: "faq"; items: { q: string; a: string }[] }
  | { type: "testimonials"; items: { quote: string; author?: string }[] }
  | { type: "contact_form"; formSlug: string; submitLabel?: string }
```

- [ ] **Step 4: Add the parse cases**

Insert these before `default:` in `parseBlocks`'s switch. The `str` helper keeps the existing slice-cap style consistent:

```ts
      case "hero":
        out.push({
          type: "hero",
          eyebrow: String(b.eyebrow || "").slice(0, 80),
          title: String(b.title || "").slice(0, 160),
          subtitle: String(b.subtitle || "").slice(0, 300),
          imageUrl: String(b.imageUrl || "").slice(0, 2000),
          ctaLabel: String(b.ctaLabel || "").slice(0, 60),
          ctaHref: String(b.ctaHref || "").slice(0, 2000),
        });
        break;
      case "service_cards":
        out.push({
          type: "service_cards",
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 12).map((raw) => {
            const it = (raw || {}) as Record<string, unknown>;
            return {
              icon: String(it.icon || "").slice(0, 8),
              title: String(it.title || "").slice(0, 120),
              body: String(it.body || "").slice(0, 600),
            };
          }),
        });
        break;
      case "gallery_grid":
        out.push({
          type: "gallery_grid",
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 40).map((raw) => {
            const it = (raw || {}) as Record<string, unknown>;
            return {
              url: String(it.url || "").slice(0, 2000),
              alt: String(it.alt || "").slice(0, 200),
              caption: String(it.caption || "").slice(0, 300),
            };
          }).filter((it) => it.url),
        });
        break;
      case "faq":
        out.push({
          type: "faq",
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 30).map((raw) => {
            const it = (raw || {}) as Record<string, unknown>;
            return { q: String(it.q || "").slice(0, 300), a: String(it.a || "").slice(0, 2000) };
          }).filter((it) => it.q),
        });
        break;
      case "testimonials":
        out.push({
          type: "testimonials",
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 20).map((raw) => {
            const it = (raw || {}) as Record<string, unknown>;
            return { quote: String(it.quote || "").slice(0, 800), author: String(it.author || "").slice(0, 120) };
          }).filter((it) => it.quote),
        });
        break;
      case "contact_form":
        out.push({
          type: "contact_form",
          formSlug: String(b.formSlug || "contact").slice(0, 100),
          submitLabel: String(b.submitLabel || "Send").slice(0, 60),
        });
        break;
```

- [ ] **Step 5: Add the render cases**

Insert these into `blocksToHtml`'s switch, using the file's existing `escapeHtml` and `escapeAttr` helpers:

```ts
      case "hero":
        parts.push(
          `<section class="qh-block-hero"${
            b.imageUrl ? ` style="background-image:url('${escapeAttr(b.imageUrl)}')"` : ""
          }><div class="qh-hero-inner">${
            b.eyebrow ? `<p class="qh-hero-eyebrow">${escapeHtml(b.eyebrow)}</p>` : ""
          }<h1 class="qh-hero-title">${escapeHtml(b.title)}</h1>${
            b.subtitle ? `<p class="qh-hero-sub">${escapeHtml(b.subtitle)}</p>` : ""
          }${
            b.ctaLabel && b.ctaHref
              ? `<p class="qh-hero-cta"><a class="btn" href="${escapeAttr(b.ctaHref)}">${escapeHtml(b.ctaLabel)}</a></p>`
              : ""
          }</div></section>`
        );
        break;
      case "service_cards":
        parts.push(
          `<div class="qh-block-services">${b.items
            .map(
              (it) =>
                `<div class="qh-service-card card">${
                  it.icon ? `<div class="qh-service-icon">${escapeHtml(it.icon)}</div>` : ""
                }<h3>${escapeHtml(it.title)}</h3>${
                  it.body ? `<p>${escapeHtml(it.body)}</p>` : ""
                }</div>`
            )
            .join("")}</div>`
        );
        break;
      case "gallery_grid":
        parts.push(
          `<div class="qh-block-gallery">${b.items
            .map(
              (it) =>
                `<figure class="qh-gallery-item"><img src="${escapeAttr(it.url)}" alt="${escapeAttr(
                  it.alt || ""
                )}" loading="lazy" />${
                  it.caption ? `<figcaption>${escapeHtml(it.caption)}</figcaption>` : ""
                }</figure>`
            )
            .join("")}</div>`
        );
        break;
      case "faq":
        parts.push(
          `<div class="qh-block-faq">${b.items
            .map(
              (it) =>
                `<details class="qh-faq-item"><summary>${escapeHtml(it.q)}</summary><div>${escapeHtml(
                  it.a
                )}</div></details>`
            )
            .join("")}</div>`
        );
        break;
      case "testimonials":
        parts.push(
          `<div class="qh-block-testimonials">${b.items
            .map(
              (it) =>
                `<blockquote class="qh-testimonial"><p>${escapeHtml(it.quote)}</p>${
                  it.author ? `<cite>${escapeHtml(it.author)}</cite>` : ""
                }</blockquote>`
            )
            .join("")}</div>`
        );
        break;
      case "contact_form":
        // Hydrated client-side against POST /public/:slug/forms/:formSlug,
        // the same endpoint the existing public form pages use.
        parts.push(
          `<div class="qh-block-contact-form" data-form-slug="${escapeAttr(
            b.formSlug
          )}" data-submit-label="${escapeAttr(b.submitLabel || "Send")}"></div>`
        );
        break;
```

- [ ] **Step 6: Export the picker lists**

Add at the end of `src/lib/blocks.ts`:

```ts
/** Blocks offered in the admin picker for business tenants. */
export const BUSINESS_BLOCK_TYPES = [
  "hero", "heading", "text", "image", "gallery_grid", "service_cards",
  "faq", "testimonials", "contact_form", "button", "events_list",
  "store_list", "divider", "spacer", "html",
];

/** Blocks that only make sense for a membership organisation. */
export const GUILD_ONLY_BLOCK_TYPES = ["join_cta"];
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `npx vitest run src/lib/blocks.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/blocks.ts src/lib/blocks.test.ts
git commit -m "feat(site): hero, service cards, gallery, faq, testimonials, contact form blocks"
```

> **CORRECTION APPLIED DURING EXECUTION.** The escaping tests for
> `service_cards`, `faq`, and `testimonials` originally asserted
> `not.toContain("onerror=")`. That assertion can never hold and was fixed
> above. `escapeHtml` neutralizes *structure*, not substrings: the payload
> becomes `&lt;img src=x onerror=alert(1)&gt;`, which is inert but still
> contains the literal text `onerror=`. The correct assertion — already used
> by the `hero` and `gallery_grid` tests in this same file — is that the
> unescaped tag is absent and the escaped form is present. The alternative,
> adding attribute-stripping sanitization, was explicitly out of scope: this
> task must not alter `escapeHtml`/`escapeAttr`.

---

### Task 7: Page renderer

**Files:**
- Create: `src/lib/site/render.ts`, `src/lib/site/render.test.ts`

**Interfaces:**
- Consumes: `buildRootVars`, `DEFAULT_THEME`, `DEFAULT_FONTS` (Task 3); `buildFontsHref` (Task 3); `readTenantTheme` (Task 4); `buildSeoHead`, `buildLocalBusinessJsonLd`, `SeoPage`, `SeoBusiness` (Task 5); `contentFromPage` (existing, `src/lib/blocks.ts`).
- Produces:
  - `type RenderNavItem = { label: string; href: string; external?: boolean }`
  - `type RenderArgs = { tenant: { name: string; slug: string; settings_json: string | null }; page: SeoPage & { content_json?: string | null; blocks_json?: string | null }; nav: RenderNavItem[]; baseUrl: string; logoUrl?: string | null; ogImageUrl?: string | null; showPlatformCredit: boolean }`
  - `renderPageHtml(args: RenderArgs): string`
  - `readBranding(settingsJson: string | null): { showPlatformCredit: boolean }`
  - `readBusinessIdentity(settingsJson: string | null): SeoBusiness`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/site/render.test.ts
import { describe, it, expect } from "vitest";
import { renderPageHtml, readBranding, readBusinessIdentity } from "./render";

const tenant = {
  name: "Stitch Studio",
  slug: "stitchstudio",
  settings_json: JSON.stringify({
    theme: { primary: "#8a2060", accent: "#a04080", themeColor: "#c060a0" },
    fonts: { heading: "fraunces", body: "inter" },
    business: { name: "Stitch Studio Quilting", city: "Wimberley", state: "TX", phone: "512-555-0100" },
  }),
};

const page = {
  title: "Services",
  slug: "services",
  blocks_json: JSON.stringify([{ type: "heading", text: "Longarm", level: 2 }]),
};

const args = {
  tenant,
  page,
  nav: [{ label: "Services", href: "/services" }],
  baseUrl: "https://stitchstudioquilting.com",
  showPlatformCredit: true,
};

describe("renderPageHtml", () => {
  it("returns a complete document", () => {
    const html = renderPageHtml(args);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // The slug attribute is how qh-site.js finds the tenant to hydrate against.
    expect(html).toContain('<html lang="en" data-tenant-slug="stitchstudio">');
    expect(html).toContain("</html>");
  });

  it("inlines the theme tokens as css custom properties", () => {
    expect(renderPageHtml(args)).toContain("--color-primary:#8a2060");
  });

  it("emits the seo head and the json-ld", () => {
    const html = renderPageHtml(args);
    // The business-identity name wins over tenant.name for the visible site
    // name — that is the whole point of the Business details field.
    expect(html).toContain("<title>Services | Stitch Studio Quilting</title>");
    expect(html).toContain('"@type":"LocalBusiness"');
    expect(html).toContain('"name":"Stitch Studio Quilting"');
  });

  it("renders the page blocks", () => {
    expect(renderPageHtml(args)).toContain("Longarm");
  });

  it("renders nav links and escapes them", () => {
    const html = renderPageHtml({
      ...args,
      nav: [{ label: '<img src=x onerror=alert(1)>', href: '"><script>' }],
    });
    expect(html).not.toContain("onerror=alert(1)");
    expect(html).not.toContain('"><script>');
  });

  it("shows the platform credit when enabled", () => {
    const html = renderPageHtml(args);
    expect(html).toContain("Powered by");
    expect(html).toContain("https://quilthosting.com");
  });

  it("omits the platform credit when disabled", () => {
    expect(renderPageHtml({ ...args, showPlatformCredit: false })).not.toContain("Powered by");
  });

  it("uses the tenant name when settings have no business identity", () => {
    const html = renderPageHtml({
      ...args,
      tenant: { ...tenant, settings_json: "{}" },
    });
    expect(html).toContain("Stitch Studio");
  });

  it("renders even when settings_json is corrupt", () => {
    const html = renderPageHtml({ ...args, tenant: { ...tenant, settings_json: "{oops" } });
    expect(html).toContain("<!DOCTYPE html>");
  });
});

describe("readBranding", () => {
  it("defaults the platform credit to shown", () => {
    expect(readBranding("{}").showPlatformCredit).toBe(true);
    expect(readBranding(null).showPlatformCredit).toBe(true);
  });

  it("honours an explicit false", () => {
    const j = JSON.stringify({ branding: { show_platform_credit: false } });
    expect(readBranding(j).showPlatformCredit).toBe(false);
  });
});

describe("readBusinessIdentity", () => {
  it("reads the business subtree", () => {
    expect(readBusinessIdentity(tenant.settings_json).city).toBe("Wimberley");
  });

  it("returns an empty name for missing settings", () => {
    expect(readBusinessIdentity("{}").name).toBe("");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/site/render.test.ts`
Expected: FAIL — cannot resolve `./render`.

- [ ] **Step 3: Write `render.ts`**

```ts
// src/lib/site/render.ts
// Server-rendered page shell for business tenants. Replaces guild.html's
// client-side paint so pages are indexable and paint on first byte.

import { contentFromPage } from "../blocks";
import { buildRootVars } from "./theme";
import { buildFontsHref } from "./fonts";
import { readTenantTheme } from "./themeMigrate";
import { buildSeoHead, buildLocalBusinessJsonLd, type SeoPage, type SeoBusiness } from "./seo";

export type RenderNavItem = { label: string; href: string; external?: boolean };

export type RenderArgs = {
  tenant: { name: string; slug: string; settings_json: string | null };
  page: SeoPage & { content_json?: string | null; blocks_json?: string | null };
  nav: RenderNavItem[];
  baseUrl: string;
  logoUrl?: string | null;
  ogImageUrl?: string | null;
  showPlatformCredit: boolean;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseSettings(settingsJson: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(settingsJson || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Platform credit defaults to shown; white-labelling is opt-out. */
export function readBranding(settingsJson: string | null | undefined): {
  showPlatformCredit: boolean;
} {
  const branding = (parseSettings(settingsJson).branding || {}) as Record<string, unknown>;
  return { showPlatformCredit: branding.show_platform_credit !== false };
}

export function readBusinessIdentity(settingsJson: string | null | undefined): SeoBusiness {
  const b = (parseSettings(settingsJson).business || {}) as Record<string, unknown>;
  return {
    name: String(b.name || ""),
    phone: b.phone ? String(b.phone) : undefined,
    email: b.email ? String(b.email) : undefined,
    street: b.street ? String(b.street) : undefined,
    city: b.city ? String(b.city) : undefined,
    state: b.state ? String(b.state) : undefined,
    zip: b.zip ? String(b.zip) : undefined,
  };
}

export function renderPageHtml(args: RenderArgs): string {
  const { tenant, page, nav, baseUrl, logoUrl, ogImageUrl, showPlatformCredit } = args;

  const { theme, fonts } = readTenantTheme(tenant.settings_json);
  const identity = readBusinessIdentity(tenant.settings_json);
  const siteName = identity.name || tenant.name;

  const { html: bodyHtml } = contentFromPage(page);
  const seoHead = buildSeoHead({ page, siteName, baseUrl, bodyHtml, ogImageUrl });
  const jsonLd = buildLocalBusinessJsonLd({ ...identity, name: siteName }, baseUrl);

  const navHtml = nav
    .map(
      (n) =>
        `<a href="${esc(n.href)}"${n.external ? ' rel="noopener"' : ""}>${esc(n.label)}</a>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en" data-tenant-slug="${esc(tenant.slug)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${esc(theme.themeColor)}">
${seoHead}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="${esc(buildFontsHref(fonts.heading, fonts.body))}">
<link rel="stylesheet" href="/qh-site.css">
<style>:root{${buildRootVars(theme, fonts)}}</style>
${jsonLd}
</head>
<body class="qh-site">
<header class="qh-site-header">
  <div class="qh-site-header-inner">
    <a class="qh-site-brand" href="/">${
      logoUrl ? `<img src="${esc(logoUrl)}" alt="" width="48" height="48">` : ""
    }<span>${esc(siteName)}</span></a>
    <nav class="qh-site-nav">${navHtml}</nav>
  </div>
</header>
<main class="qh-site-main">
${bodyHtml}
</main>
<footer class="qh-site-footer">
  <div class="qh-site-footer-inner">
    <p>${esc(siteName)}</p>
    ${
      showPlatformCredit
        ? `<p class="qh-platform-credit">Powered by <a href="https://quilthosting.com">QuiltHosting</a></p>`
        : ""
    }
  </div>
</footer>
<script src="/qh-site.js" defer></script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/site/render.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Create the public stylesheet and hydration script**

Create `public/qh-site.css` with the layout for the classes the renderer emits. Every color comes from the custom properties `buildRootVars` sets — no hardcoded colors, or the theme picker does nothing:

```css
/* public/qh-site.css — business tenant public site.
   All colors come from :root custom properties set by buildRootVars(). */
*,*::before,*::after{box-sizing:border-box}
body.qh-site{margin:0;background:var(--color-bg);color:var(--color-text-base);
  font-family:var(--font-sans);line-height:1.6}
h1,h2,h3{font-family:var(--font-display);line-height:1.2;margin:0 0 .5em}
a{color:var(--color-primary)}
.qh-site-header{background:var(--color-card);border-bottom:1px solid var(--color-accent-bright)}
.qh-site-header-inner,.qh-site-footer-inner{max-width:1080px;margin:0 auto;padding:1rem 1.5rem;
  display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
.qh-site-brand{display:flex;align-items:center;gap:.75rem;font-family:var(--font-display);
  font-size:1.3rem;font-weight:600;text-decoration:none;color:var(--color-text-base)}
.qh-site-nav{display:flex;gap:1rem;flex-wrap:wrap}
.qh-site-nav a{text-decoration:none;font-size:.95rem}
.qh-site-main{max-width:1080px;margin:0 auto;padding:2rem 1.5rem 4rem}
.qh-block-hero{background-size:cover;background-position:center;border-radius:16px;
  padding:4rem 2rem;margin-bottom:2.5rem;background-color:var(--color-accent-bright)}
.qh-hero-eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.8rem;
  color:var(--color-primary-dark);margin:0 0 .5rem}
.qh-hero-title{font-size:clamp(2rem,5vw,3.25rem);margin:0 0 .5rem}
.qh-hero-sub{font-size:1.15rem;color:var(--color-text-muted);margin:0 0 1.25rem}
.btn{display:inline-block;background:var(--color-primary);color:#fff;text-decoration:none;
  padding:.7rem 1.4rem;border-radius:8px;font-weight:600}
.btn:hover{background:var(--color-primary-dark)}
.card{background:var(--color-card);border:1px solid var(--color-accent-bright);
  border-radius:12px;padding:1.25rem}
.qh-block-services{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
  gap:1rem;margin:2rem 0}
.qh-service-icon{font-size:1.75rem;margin-bottom:.5rem}
.qh-block-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));
  gap:.75rem;margin:2rem 0}
.qh-gallery-item{margin:0}
.qh-gallery-item img{width:100%;height:100%;object-fit:cover;border-radius:10px;display:block}
.qh-faq-item{border-bottom:1px solid var(--color-accent-bright);padding:.85rem 0}
.qh-faq-item summary{cursor:pointer;font-weight:600}
.qh-block-testimonials{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
.qh-testimonial{margin:0;background:var(--color-card);border-left:3px solid var(--color-primary);
  padding:1rem 1.25rem;border-radius:0 10px 10px 0}
.qh-testimonial cite{display:block;margin-top:.5rem;color:var(--color-text-muted);font-size:.9rem}
.qh-site-footer{background:var(--color-card);border-top:1px solid var(--color-accent-bright);
  margin-top:3rem;font-size:.9rem;color:var(--color-text-muted)}
.qh-platform-credit a{color:var(--color-primary)}
@media (max-width:640px){.qh-site-header-inner{flex-direction:column;align-items:flex-start}}
```

Create `public/qh-site.js` to hydrate the three blocks that need data after paint. Use DOM APIs only, per the repo convention:

```js
/* public/qh-site.js — hydrates blocks that need data after first paint.
   Server-rendered content is already in the DOM; this only fills the
   placeholders left by events_list, store_list, and contact_form. */
(function () {
  var slug = document.documentElement.getAttribute("data-tenant-slug") || "";
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function get(path) {
    return fetch("/public/" + encodeURIComponent(slug) + path).then(function (r) {
      return r.ok ? r.json() : null;
    });
  }
  document.querySelectorAll(".qh-block-events").forEach(function (node) {
    get("/events").then(function (data) {
      if (!data || !data.events) return;
      var limit = Number(node.getAttribute("data-limit")) || 5;
      data.events.slice(0, limit).forEach(function (ev) {
        var card = el("div", "card");
        card.appendChild(el("h3", "", ev.title));
        if (ev.start_at) card.appendChild(el("p", "", new Date(ev.start_at).toLocaleString()));
        node.appendChild(card);
      });
    });
  });
  document.querySelectorAll(".qh-block-store").forEach(function (node) {
    get("/products").then(function (data) {
      if (!data || !data.products) return;
      var limit = Number(node.getAttribute("data-limit")) || 6;
      data.products.slice(0, limit).forEach(function (p) {
        var card = el("div", "card");
        card.appendChild(el("h3", "", p.name));
        card.appendChild(el("p", "", "$" + ((p.price_cents || 0) / 100).toFixed(2)));
        node.appendChild(card);
      });
    });
  });
  document.querySelectorAll(".qh-block-contact-form").forEach(function (node) {
    var formSlug = node.getAttribute("data-form-slug");
    var form = el("form", "card");
    var name = el("input"); name.name = "name"; name.placeholder = "Your name"; name.required = true;
    var email = el("input"); email.name = "email"; email.type = "email";
    email.placeholder = "Your email"; email.required = true;
    var msg = el("textarea"); msg.name = "message"; msg.placeholder = "How can I help?"; msg.rows = 5;
    var btn = el("button", "btn", node.getAttribute("data-submit-label") || "Send");
    btn.type = "submit";
    [name, email, msg, btn].forEach(function (n) { form.appendChild(n); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      btn.disabled = true;
      fetch("/public/" + encodeURIComponent(slug) + "/forms/" + encodeURIComponent(formSlug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.value, email: email.value, message: msg.value }),
      }).then(function (r) {
        node.replaceChildren(el("p", "", r.ok ? "Thanks — I'll be in touch." : "Something went wrong."));
      });
    });
    node.appendChild(form);
  });
})();
```

- [ ] **Step 6: Run tests, typecheck, commit**

```bash
npx vitest run
npx tsc --noEmit
git add src/lib/site/render.ts src/lib/site/render.test.ts public/qh-site.css public/qh-site.js
git commit -m "feat(site): server-rendered page shell, stylesheet, and block hydration"
```

> **CORRECTIONS APPLIED DURING EXECUTION.** Two defects in this task's own text.
>
> 1. **The fixture contradicted the implementation.** `siteName` is
>    `identity.name || tenant.name`, but the fixture set `tenant.name` to
>    "Stitch Studio" and `settings.business.name` to "Stitch Studio Quilting"
>    while asserting the *tenant* name in the title — unsatisfiable. The
>    implementation is correct and the fixture was wrong: the business-identity
>    name must win for the title, header, and footer, or Task 14's Business
>    details panel ("used in the site footer and in the structured data") is
>    lying to the owner. Assertions corrected above; the two names are kept
>    deliberately distinct so the test now pins precedence rather than
>    accidentally passing.
> 2. **The escaping test repeated Task 6's unsatisfiable pattern.**
>    `not.toContain("onerror=alert(1)")` cannot hold against `esc()`. Same
>    test-only correction as Task 6: assert the unescaped tag is absent and the
>    escaped form present.

---

### Task 8: Render cache

**Files:**
- Create: `src/lib/site/cache.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `siteCacheKey(host: string, path: string, updatedAt: string): string`, `cachedRender(args: { host: string; path: string; updatedAt: string; build: () => string | Promise<string> }): Promise<Response>`.

- [ ] **Step 1: Write `cache.ts`**

```ts
// src/lib/site/cache.ts
// Rendered HTML is cached in the Cache API under a key that includes the
// page's updated_at, so publishing produces a new key and the stale entry
// simply ages out. No explicit purge needed.

export function siteCacheKey(host: string, path: string, updatedAt: string): string {
  // Cache API keys must be URLs. The version segment carries updated_at.
  const safeVersion = encodeURIComponent(updatedAt || "0");
  return `https://site-cache.invalid/${encodeURIComponent(host)}/${safeVersion}${
    path.startsWith("/") ? path : "/" + path
  }`;
}

export async function cachedRender(args: {
  host: string;
  path: string;
  updatedAt: string;
  build: () => string | Promise<string>;
}): Promise<Response> {
  const key = new Request(siteCacheKey(args.host, args.path, args.updatedAt));
  const cache = (caches as unknown as { default: Cache }).default;

  const hit = await cache.match(key);
  if (hit) return hit;

  const html = await args.build();
  const res = new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Short browser TTL, long edge TTL. The key changes on publish, so a
      // long edge TTL never serves stale content after an edit.
      "Cache-Control": "public, max-age=60, s-maxage=86400",
    },
  });
  await cache.put(key, res.clone());
  return res;
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/site/cache.ts
git commit -m "feat(site): edge cache for rendered pages keyed on updated_at"
```

Note: `cachedRender` is exercised end-to-end in Task 12's verify script. It has no pure logic worth a vitest beyond `siteCacheKey`, which is covered there because a wrong key would show as a stale-content failure.

---

### Task 9: Route business tenant hosts to the renderer

**Files:**
- Modify: `src/index.ts` (the tenant-host middleware at lines 66-120)
- Create: `src/routes/site.ts`

**Interfaces:**
- Consumes: `isBusiness`, `isLaunched` (Task 1); `renderPageHtml`, `readBranding` (Task 7); `cachedRender` (Task 8); `getTenantByHost`, `tenantPublicBaseUrl` (existing).
- Produces: `serveBusinessSite(c, tenant): Promise<Response | null>` — returns `null` when the path is not a site page so the caller falls through.

- [ ] **Step 1: Write `src/routes/site.ts`**

```ts
// src/routes/site.ts
// Serves a business tenant's public website: pages, sitemap, robots.

import type { Context } from "hono";
import type { Env, Tenant } from "../types";
import { all, first } from "../lib/db";
import { renderPageHtml, readBranding } from "../lib/site/render";
import { cachedRender } from "../lib/site/cache";
import { tenantPublicBaseUrl } from "../lib/tenantHost";

type PageRow = {
  id: string;
  slug: string;
  title: string;
  content_json: string | null;
  blocks_json: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_image_file_id: string | null;
  noindex: number;
  updated_at: string;
};

async function loadNav(env: Env, tenant: Tenant) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {
    settings = {};
  }
  const explicit = Array.isArray(settings.nav) ? settings.nav : [];
  if (explicit.length) {
    return explicit
      .map((n: Record<string, unknown>) => ({
        label: String(n.label || "").slice(0, 60),
        href: String(n.href || "").slice(0, 500),
        external: !!n.external,
      }))
      .filter((n) => n.label && n.href)
      .slice(0, 20);
  }
  const rows = await all<{ slug: string; title: string; nav_label: string | null }>(
    env.DB.prepare(
      `SELECT slug, title, nav_label FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         AND coalesce(show_in_nav, 1) = 1 AND coalesce(page_type, 'page') = 'page'
       ORDER BY sort_order, title`
    ).bind(tenant.id)
  );
  return rows.map((r) => ({
    label: r.nav_label || r.title,
    href: r.slug ? `/${r.slug}` : "/",
  }));
}

/**
 * Serve a public site path. Returns null when the path is not a site page so
 * the caller can fall through to the platform's own routes.
 */
export async function serveBusinessSite(
  c: Context<{ Bindings: Env }>,
  tenant: Tenant
): Promise<Response | null> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const host = c.req.header("host") || url.host;
  const baseUrl = tenantPublicBaseUrl(c.env, tenant, host);

  if (path === "/robots.txt") {
    // A launched business site is meant to be crawled. Point at its own
    // sitemap, not the platform's.
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (path === "/sitemap.xml") {
    const rows = await all<{ slug: string; updated_at: string }>(
      c.env.DB.prepare(
        `SELECT slug, updated_at FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(noindex, 0) = 0
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
    const urls = rows
      .map((r) => {
        const loc = r.slug ? `${baseUrl}/${r.slug}` : `${baseUrl}/`;
        return `<url><loc>${loc}</loc><lastmod>${(r.updated_at || "").slice(0, 10)}</lastmod></url>`;
      })
      .join("");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
      { headers: { "Content-Type": "application/xml; charset=utf-8" } }
    );
  }

  const slug = path === "/" ? "" : path.replace(/^\/+/, "").replace(/\/+$/, "");
  // Home page convention: an empty slug, or a page explicitly named "home".
  const row = await first<PageRow>(
    c.env.DB.prepare(
      `SELECT id, slug, title, content_json, blocks_json, seo_title, seo_description,
              og_image_file_id, coalesce(noindex, 0) AS noindex, updated_at
       FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         AND slug = ?
       LIMIT 1`
    ).bind(tenant.id, slug || "home")
  );

  if (!row) return null;

  const nav = await loadNav(c.env, tenant);
  const { showPlatformCredit } = readBranding(tenant.settings_json);

  return cachedRender({
    host,
    path,
    updatedAt: row.updated_at,
    build: () =>
      renderPageHtml({
        tenant: { name: tenant.name, slug: tenant.slug, settings_json: tenant.settings_json },
        page: {
          title: row.title,
          slug: slug,
          seo_title: row.seo_title,
          seo_description: row.seo_description,
          og_image_file_id: row.og_image_file_id,
          noindex: row.noindex,
          content_json: row.content_json,
          blocks_json: row.blocks_json,
        },
        nav,
        baseUrl,
        showPlatformCredit,
      }),
  });
}
```

- [ ] **Step 2: Wire it into the host middleware**

In `src/index.ts`, add the imports:

```ts
import { isBusiness } from "./lib/tenantType";
import { serveBusinessSite } from "./routes/site";
```

Inside the tenant-host middleware, immediately after `if (!tenant) return next();` and **before** the `/portal` branch, insert:

```ts
  // Business tenants get the server-rendered site. Guilds keep guild.html.
  if (isBusiness(tenant)) {
    // Platform surfaces stay on the platform, even on a custom domain.
    const isPlatformPath =
      path.startsWith("/admin") ||
      path.startsWith("/portal") ||
      path.startsWith("/docs") ||
      path.startsWith("/embed") ||
      path === "/qh.css" ||
      path === "/sw.js" ||
      path === "/manifest.webmanifest" ||
      path === "/icon.svg" ||
      path.startsWith("/assets");
    if (!isPlatformPath) {
      const res = await serveBusinessSite(c, tenant);
      if (res) return res;
      // No matching page — fall through so the 404 handler runs.
    }
  }
```

- [ ] **Step 3: Seed a business tenant and check it renders**

```bash
npx wrangler d1 execute quilthosting-db --local --file=scripts/seed-business.sql
```

Create `scripts/seed-business.sql` first:

```sql
-- scripts/seed-business.sql — local dev fixture for the business renderer.
DELETE FROM pages WHERE tenant_id = 'tnt_demo_business';
DELETE FROM tenants WHERE id = 'tnt_demo_business';

INSERT INTO tenants (id, name, slug, custom_domain, plan, status, tenant_type, public_launched, settings_json)
VALUES (
  'tnt_demo_business', 'Stitch Studio Quilting', 'stitchstudio', 'stitchstudioquilting.test',
  'free', 'active', 'business', 1,
  '{"theme":{"primary":"#8a2060","accent":"#a04080","themeColor":"#c060a0"},"fonts":{"heading":"fraunces","body":"inter"},"business":{"name":"Stitch Studio Quilting","city":"Wimberley","state":"TX","phone":"512-555-0100"}}'
);

INSERT INTO pages (id, tenant_id, slug, title, blocks_json, published, sort_order, seo_description)
VALUES (
  'pg_demo_home', 'tnt_demo_business', 'home', 'Stitch Studio Quilting',
  '[{"type":"hero","eyebrow":"Longarm quilting since 2009","title":"Stitch Studio Quilting","subtitle":"Edge-to-edge and custom longarm quilting in Wimberley, Texas.","ctaLabel":"Request a quote","ctaHref":"/contact"},{"type":"service_cards","items":[{"icon":"\u2726","title":"Edge to Edge","body":"An allover design across the whole quilt."},{"icon":"\u2739","title":"Custom Longarm","body":"Designs chosen block by block."}]}]',
  1, 0, 'Longarm quilting, classes, patterns, and custom T-shirt quilts in Wimberley, Texas.'
);
```

- [ ] **Step 4: Start dev and fetch the page with a spoofed Host**

```bash
npm run dev
```

In another shell:

```bash
curl -s -H "Host: stitchstudioquilting.test" http://localhost:8787/ | head -30
```

Expected: HTML beginning `<!DOCTYPE html>` containing `<title>Stitch Studio Quilting</title>`, `--color-primary:#8a2060`, and `Powered by`.

If it instead returns the site-gate login page, that is expected until Task 10 — confirm by re-running with the gate cookie or by temporarily setting `ENVIRONMENT=development` in `.dev.vars`.

- [ ] **Step 5: Check the sitemap and robots**

```bash
curl -s -H "Host: stitchstudioquilting.test" http://localhost:8787/sitemap.xml
curl -s -H "Host: stitchstudioquilting.test" http://localhost:8787/robots.txt
```

Expected: an `<urlset>` containing the home URL, and a robots body with `Allow: /` and a `Sitemap:` line.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/routes/site.ts src/index.ts scripts/seed-business.sql
git commit -m "feat(site): serve server-rendered pages, sitemap, and robots for business tenants"
```

---

### Task 10: Per-tenant launch exemption in the site gate

The highest-risk change in P0. A mistake here exposes the entire platform.

**Files:**
- Modify: `src/middleware/siteGate.ts`

**Interfaces:**
- Consumes: `isLaunched` (Task 1), `getTenantByHost` (existing).
- Produces: no new exports. Behaviour: a launched business tenant's hostname bypasses the gate for public paths only.

- [ ] **Step 1: Add the host exemption**

In `src/middleware/siteGate.ts`, add imports:

```ts
import { getTenantByHost } from "../lib/tenantHost";
import { isLaunched } from "../lib/tenantType";
```

Insert this block inside the middleware, immediately after the `if (path.startsWith("/api/webhooks/")) return next();` line and before the bearer-token check:

```ts
    // Per-tenant launch: a launched business tenant's own hostname serves its
    // public site without the gate, while the platform stays in stealth.
    //
    // Two invariants, both load-bearing:
    //   1. The exemption keys off the RESOLVED TENANT, never off a path. No
    //      path prefix may open the gate on a platform host.
    //   2. /admin and /portal stay gated even on a launched custom domain, so
    //      a launched site can never expose the platform's admin surface.
    const gateHost = c.req.header("host") || "";
    if (gateHost && !isPlatformOnlyPath(path)) {
      try {
        const hostTenant = await getTenantByHost(c.env.DB, gateHost, c.env.APP_URL);
        if (hostTenant && isLaunched(hostTenant)) return next();
      } catch {
        // A DB failure must not open the gate. Fall through to the password.
      }
    }
```

Add this helper above the `siteGate` definition:

```ts
/**
 * Paths that always belong to the platform, never to a tenant's public site.
 * These stay gated on every host, including a launched tenant's custom domain.
 */
function isPlatformOnlyPath(path: string): boolean {
  return (
    path.startsWith("/admin") ||
    path.startsWith("/portal") ||
    path.startsWith("/api/tenants") ||
    path.startsWith("/api/platform") ||
    path === "/site-access"
  );
}
```

- [ ] **Step 2: Make robots.txt respect the launch**

The gate currently returns a deny-all `robots.txt` for every host. That must now apply only to gated hosts. The exemption block above runs before the `robots.txt` branch, so a launched tenant already falls through to `serveBusinessSite`, which serves its own permissive robots. Confirm the ordering by reading the file: the `if (path === "/robots.txt")` branch must appear **after** the exemption block.

- [ ] **Step 3: Verify the platform is still gated**

```bash
npm run dev
```

With `SITE_ACCESS_PASSWORD` set in `.dev.vars` and `ENVIRONMENT` unset or `production`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: stitchstudioquilting.test" http://localhost:8787/admin
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: stitchstudioquilting.test" http://localhost:8787/
```

Expected, in order: `401` (platform gated), `401` (admin gated even on the custom domain), `200` (launched tenant's public site open).

- [ ] **Step 4: Verify an unlaunched tenant stays dark**

```bash
npx wrangler d1 execute quilthosting-db --local --command="UPDATE tenants SET public_launched = 0 WHERE id = 'tnt_demo_business'"
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: stitchstudioquilting.test" http://localhost:8787/
npx wrangler d1 execute quilthosting-db --local --command="UPDATE tenants SET public_launched = 1 WHERE id = 'tnt_demo_business'"
```

Expected: `401` while unlaunched.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/middleware/siteGate.ts
git commit -m "feat(gate): per-tenant public launch exemption, platform paths stay gated"
```

---

### Task 11: Encrypted tenant credential store

Built now so P4's PayPal keys have somewhere safe to land, and so the schema does not need a second migration later.

**Files:**
- Create: `src/lib/credentials.ts`, `src/lib/credentials.test.ts`, `src/routes/credentials.ts`
- Modify: `src/index.ts` (mount the route)

**Interfaces:**
- Consumes: `first`, `all` from `src/lib/db`; `generateId` from `src/lib/utils/id`.
- Produces:
  - `encryptSecret(keyB64: string, plaintext: string): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }>`
  - `decryptSecret(keyB64: string, ciphertext: Uint8Array, iv: Uint8Array): Promise<string>`
  - `putCredential(env: Env, tenantId: string, provider: string, key: string, value: string): Promise<void>`
  - `getCredential(env: Env, tenantId: string, provider: string, key: string): Promise<string | null>`
  - `listCredentialStatus(env: Env, tenantId: string, provider: string): Promise<{ key: string; configured: boolean; updated_at: string }[]>`
  - `clearCredential(env: Env, tenantId: string, provider: string, key: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/credentials.test.ts
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./credentials";

// 32 random bytes, base64. Test-only value, never used anywhere real.
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", async () => {
    const { ciphertext, iv } = await encryptSecret(KEY, "sk_paypal_example");
    expect(await decryptSecret(KEY, ciphertext, iv)).toBe("sk_paypal_example");
  });

  it("produces a different iv and ciphertext each time", async () => {
    const a = await encryptSecret(KEY, "same");
    const b = await encryptSecret(KEY, "same");
    expect(Buffer.from(a.iv).toString("hex")).not.toBe(Buffer.from(b.iv).toString("hex"));
    expect(Buffer.from(a.ciphertext).toString("hex")).not.toBe(
      Buffer.from(b.ciphertext).toString("hex"),
    );
  });

  it("fails to decrypt under the wrong key", async () => {
    const { ciphertext, iv } = await encryptSecret(KEY, "secret");
    const wrong = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
    await expect(decryptSecret(wrong, ciphertext, iv)).rejects.toThrow();
  });

  it("fails loudly when the key is missing", async () => {
    await expect(encryptSecret("", "x")).rejects.toThrow(/CREDENTIAL_KEY/);
  });

  it("fails loudly when the key is the wrong length", async () => {
    const short = Buffer.from(new Uint8Array(16).fill(1)).toString("base64");
    await expect(encryptSecret(short, "x")).rejects.toThrow(/32 bytes/);
  });

  it("rejects tampered ciphertext rather than returning garbage", async () => {
    const { ciphertext, iv } = await encryptSecret(KEY, "secret");
    ciphertext[0] ^= 0xff;
    await expect(decryptSecret(KEY, ciphertext, iv)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/credentials.test.ts`
Expected: FAIL — cannot resolve `./credentials`.

- [ ] **Step 3: Write `credentials.ts`**

```ts
// src/lib/credentials.ts
// Per-tenant third-party secrets, AES-GCM encrypted under a Worker secret.
//
// Only PayPal needs this: Stripe Connect never gives us a secret to hold, so
// tenants.stripe_account_id stays a plain column. Values are write-only from
// the API's perspective — nothing ever reads a secret back out to a client.

import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";

async function importKey(keyB64: string): Promise<CryptoKey> {
  if (!keyB64) {
    throw new Error("CREDENTIAL_KEY is not configured");
  }
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(keyB64), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error("CREDENTIAL_KEY is not valid base64");
  }
  if (raw.length !== 32) {
    throw new Error("CREDENTIAL_KEY must decode to 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  keyB64: string,
  plaintext: string
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ciphertext: new Uint8Array(buf), iv };
}

export async function decryptSecret(
  keyB64: string,
  ciphertext: Uint8Array,
  iv: Uint8Array
): Promise<string> {
  const key = await importKey(keyB64);
  // Throws on tamper or wrong key — AES-GCM is authenticated, so a failure
  // here means the data is untrustworthy, not that it needs a fallback.
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(buf);
}

export async function putCredential(
  env: Env,
  tenantId: string,
  provider: string,
  key: string,
  value: string
): Promise<void> {
  const { ciphertext, iv } = await encryptSecret(env.CREDENTIAL_KEY || "", value);
  await env.DB.prepare(
    `INSERT INTO tenant_credentials (id, tenant_id, provider, key, ciphertext, iv)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, provider, key)
     DO UPDATE SET ciphertext = excluded.ciphertext,
                   iv = excluded.iv,
                   updated_at = datetime('now')`
  )
    .bind(generateId("cred"), tenantId, provider, key, ciphertext, iv)
    .run();
}

export async function getCredential(
  env: Env,
  tenantId: string,
  provider: string,
  key: string
): Promise<string | null> {
  const row = await first<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }>(
    env.DB.prepare(
      `SELECT ciphertext, iv FROM tenant_credentials
       WHERE tenant_id = ? AND provider = ? AND key = ?`
    ).bind(tenantId, provider, key)
  );
  if (!row) return null;
  return decryptSecret(
    env.CREDENTIAL_KEY || "",
    new Uint8Array(row.ciphertext),
    new Uint8Array(row.iv)
  );
}

export async function listCredentialStatus(
  env: Env,
  tenantId: string,
  provider: string
): Promise<{ key: string; configured: boolean; updated_at: string }[]> {
  const rows = await all<{ key: string; updated_at: string }>(
    env.DB.prepare(
      `SELECT key, updated_at FROM tenant_credentials
       WHERE tenant_id = ? AND provider = ? ORDER BY key`
    ).bind(tenantId, provider)
  );
  return rows.map((r) => ({ key: r.key, configured: true, updated_at: r.updated_at }));
}

export async function clearCredential(
  env: Env,
  tenantId: string,
  provider: string,
  key: string
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM tenant_credentials WHERE tenant_id = ? AND provider = ? AND key = ?`
  )
    .bind(tenantId, provider, key)
    .run();
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/credentials.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the admin route**

```ts
// src/routes/credentials.ts
// Admin API for tenant_credentials. Write and clear only — there is
// deliberately no endpoint that returns a stored secret.

import { Hono } from "hono";
import { z } from "zod";
import type { Env, TenantVariables } from "../types";
import { putCredential, listCredentialStatus, clearCredential } from "../lib/credentials";

export const credentialRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

const ALLOWED: Record<string, string[]> = {
  paypal: ["client_id", "client_secret"],
};

const putSchema = z.object({
  provider: z.string().min(1).max(40),
  key: z.string().min(1).max(60),
  value: z.string().min(1).max(500),
});

/** GET / — which credentials exist. Never their values. */
credentialRoutes.get("/", async (c) => {
  const tenant = c.get("tenant");
  const provider = c.req.query("provider") || "paypal";
  if (!ALLOWED[provider]) return c.json({ error: "Unknown provider" }, 400);
  const stored = await listCredentialStatus(c.env, tenant.id, provider);
  const byKey = new Map(stored.map((s) => [s.key, s]));
  return c.json({
    provider,
    credentials: ALLOWED[provider].map((key) => ({
      key,
      configured: byKey.has(key),
      updated_at: byKey.get(key)?.updated_at ?? null,
    })),
  });
});

credentialRoutes.put("/", async (c) => {
  const tenant = c.get("tenant");
  const parsed = putSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const { provider, key, value } = parsed.data;
  if (!ALLOWED[provider]?.includes(key)) {
    return c.json({ error: "Unknown provider or key" }, 400);
  }
  if (!c.env.CREDENTIAL_KEY) {
    // Fail loudly. Storing plaintext, or silently accepting and dropping the
    // value, would both be worse than a 503.
    return c.json({ error: "Credential storage is not configured" }, 503);
  }
  await putCredential(c.env, tenant.id, provider, key, value);
  return c.json({ ok: true, provider, key, configured: true });
});

credentialRoutes.delete("/:provider/:key", async (c) => {
  const tenant = c.get("tenant");
  const provider = c.req.param("provider");
  const key = c.req.param("key");
  if (!ALLOWED[provider]?.includes(key)) {
    return c.json({ error: "Unknown provider or key" }, 400);
  }
  await clearCredential(c.env, tenant.id, provider, key);
  return c.json({ ok: true, provider, key, configured: false });
});
```

- [ ] **Step 6: Mount the route**

In `src/index.ts`, add the import:

```ts
import { credentialRoutes } from "./routes/credentials";
```

Mount it beside the other tenant-scoped route groups, using the same middleware chain those use (`requireAuth`, `tenantMiddleware`, `requireTenantAccess`). Find the line mounting `invoiceRoutes` and add an equivalent line for `/api/tenants/:tenantId/credentials`.

- [ ] **Step 7: Add the key to the local dev vars**

Generate a key and append it to `.dev.vars` (gitignored):

```bash
node -e "console.log('CREDENTIAL_KEY=' + require('crypto').randomBytes(32).toString('base64'))" >> .dev.vars
```

For production, this will be `npx wrangler secret put CREDENTIAL_KEY` at deploy time. Do not run that now.

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/credentials.ts src/lib/credentials.test.ts src/routes/credentials.ts src/index.ts
git commit -m "feat(credentials): AES-GCM per-tenant credential store with write-only API"
```

---

### Task 12: Integration verification script

**Files:**
- Create: `scripts/verify-business-site.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything above, over HTTP and D1.
- Produces: `npm run test:business-site`.

- [ ] **Step 1: Write the verification script**

```js
/**
 * Business site + gate matrix E2E.
 * Usage: npm run dev  (in one shell), then: node scripts/verify-business-site.mjs
 *
 * Follows the pattern of scripts/verify-import.mjs: D1 via a temp .sql file
 * and --file=, HTTP against the local wrangler dev server with a spoofed Host.
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const BASE = process.env.QH_BASE || "http://localhost:8787";
const HOST = "stitchstudioquilting.test";
const TENANT = "tnt_demo_business";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) { console.log(`  ok  ${label}`); return; }
  failures++;
  console.error(`  FAIL ${label} ${detail}`);
}

function d1Exec(sql) {
  const p = join(tmpdir(), `qh-bs-${randomUUID()}.sql`);
  writeFileSync(p, sql, "utf8");
  try {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "quilthosting-db", "--local", `--file=${p}`],
      { stdio: "pipe", shell: true },
    );
  } finally {
    unlinkSync(p);
  }
}

async function req(path, host) {
  const res = await fetch(BASE + path, { headers: host ? { Host: host } : {} });
  return { status: res.status, body: await res.text() };
}

console.log("Seeding business tenant...");
d1Exec(`
DELETE FROM pages WHERE tenant_id = '${TENANT}';
DELETE FROM tenants WHERE id = '${TENANT}';
INSERT INTO tenants (id, name, slug, custom_domain, plan, status, tenant_type, public_launched, settings_json)
VALUES ('${TENANT}', 'Stitch Studio Quilting', 'stitchstudio', '${HOST}', 'free', 'active', 'business', 1,
  '{"theme":{"primary":"#8a2060"},"business":{"name":"Stitch Studio Quilting","city":"Wimberley","state":"TX"}}');
INSERT INTO pages (id, tenant_id, slug, title, blocks_json, published, sort_order)
VALUES ('pg_bs_home', '${TENANT}', 'home', 'Stitch Studio Quilting',
  '[{"type":"hero","title":"Stitch Studio Quilting","subtitle":"Longarm quilting"}]', 1, 0);
INSERT INTO pages (id, tenant_id, slug, title, blocks_json, published, sort_order, noindex)
VALUES ('pg_bs_secret', '${TENANT}', 'secret', 'Hidden', '[]', 1, 1, 1);
`);

console.log("\nRendered site:");
{
  const r = await req("/", HOST);
  check("home renders 200", r.status === 200, `got ${r.status}`);
  check("is server-rendered html", r.body.startsWith("<!DOCTYPE html>"));
  check("contains hero title in the source", r.body.includes("Stitch Studio Quilting"));
  check("carries theme custom properties", r.body.includes("--color-primary:#8a2060"));
  check("emits LocalBusiness json-ld", r.body.includes('"@type":"LocalBusiness"'));
  check("shows the platform credit", r.body.includes("Powered by"));
  check("is not noindexed", !r.body.includes('content="noindex'));
}

console.log("\nSEO endpoints:");
{
  const s = await req("/sitemap.xml", HOST);
  check("sitemap 200", s.status === 200, `got ${s.status}`);
  check("sitemap lists home", s.body.includes(`https://${HOST}/`));
  check("sitemap omits noindex pages", !s.body.includes("/secret"));

  const rb = await req("/robots.txt", HOST);
  check("robots 200", rb.status === 200, `got ${rb.status}`);
  check("robots allows crawling", rb.body.includes("Allow: /"));
  check("robots points at the sitemap", rb.body.includes("sitemap.xml"));
}

console.log("\nGate matrix:");
{
  const platform = await req("/", null);
  check("platform apex still gated", platform.status === 401, `got ${platform.status}`);

  const admin = await req("/admin", HOST);
  check("/admin gated on the tenant domain", admin.status === 401, `got ${admin.status}`);

  const portal = await req("/portal", HOST);
  check("/portal gated on the tenant domain", portal.status === 401, `got ${portal.status}`);

  d1Exec(`UPDATE tenants SET public_launched = 0 WHERE id = '${TENANT}';`);
  const dark = await req("/", HOST);
  check("unlaunched tenant is gated", dark.status === 401, `got ${dark.status}`);

  d1Exec(`UPDATE tenants SET tenant_type = 'guild', public_launched = 1 WHERE id = '${TENANT}';`);
  const guild = await req("/", HOST);
  check("a guild is never launch-exempt", guild.status === 401, `got ${guild.status}`);

  d1Exec(`UPDATE tenants SET tenant_type = 'business', public_launched = 1 WHERE id = '${TENANT}';`);
}

console.log("\nGuild theme compatibility:");
{
  const r = await fetch(`${BASE}/public/stitchstudio/site`);
  const j = r.ok ? await r.json() : {};
  check("/site still emits legacy theme.primary", typeof j?.theme?.primary === "string");
  check("/site emits the full token set", typeof j?.theme_tokens?.textMuted === "string");
}

console.log("\nRenewals exclusion:");
{
  // A business tenant must not appear in any renewal-job tenant scan.
  const p = join(tmpdir(), `qh-bs-q-${randomUUID()}.sql`);
  writeFileSync(p, `SELECT count(*) AS n FROM tenants WHERE id = '${TENANT}' AND coalesce(tenant_type,'guild') = 'guild';`, "utf8");
  const out = execFileSync("npx",
    ["wrangler", "d1", "execute", "quilthosting-db", "--local", `--file=${p}`, "--json"],
    { stdio: "pipe", shell: true }).toString("utf8");
  unlinkSync(p);
  const n = JSON.parse(out)[0]?.results?.[0]?.n;
  check("business tenant excluded by the guild guard", n === 0, `matched ${n}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Register the script**

Add to `package.json` `scripts`:

```json
"test:business-site": "node scripts/verify-business-site.mjs"
```

- [ ] **Step 3: Run it**

```bash
# shell 1
npm run dev
# shell 2
npm run test:business-site
```

Expected: `All checks passed`, exit 0. Any FAIL line names the exact broken behaviour — fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-business-site.mjs package.json
git commit -m "test(business): gate matrix and rendered-site verification script"
```

---

### Task 13: Site-builder admin

**Files:**
- Create: `public/qh-site-builder.js`
- Modify: `public/admin.html`

**Interfaces:**
- Consumes: globals provided by `admin.html` — `api()`, `navigate()`, `tenantId`, `token`, `API`, `show()`, `hide()` — exactly as `public/qh-admin-ext.js` does.
- Produces: admin pages `site-pages`, `site-theme`, `site-domain`.

- [ ] **Step 1: Add the sidebar entries**

In `public/admin.html`, inside `<nav>` (after line 77), add:

```html
        <a href="#" data-page="site-pages" id="nav-site-pages" class="business-only">Website</a>
        <a href="#" data-page="site-theme" id="nav-site-theme" class="business-only">Appearance</a>
        <a href="#" data-page="site-domain" id="nav-site-domain" class="business-only">Domain &amp; Launch</a>
```

And add the guild-only class to the membership entries so they can be hidden. Find the existing sidebar links for Levels, Renewals, Chapters, Forums, and Directory and add `guild-only` to each one's `class` attribute.

- [ ] **Step 2: Toggle nav by tenant type**

In `admin.html`, inside the function that runs after the tenant is loaded (the same place `nav-platform` is un-hidden around line 198), add:

```js
      const isBusinessTenant = (currentTenant && currentTenant.tenant_type) === "business";
      document.querySelectorAll(".business-only").forEach((el) => {
        el.classList.toggle("hidden", !isBusinessTenant);
      });
      document.querySelectorAll(".guild-only").forEach((el) => {
        el.classList.toggle("hidden", isBusinessTenant);
      });
```

If the variable holding the loaded tenant is not named `currentTenant`, use whatever `admin.html` already uses — check the surrounding lines rather than introducing a new global.

- [ ] **Step 3: Ensure the API returns the new fields**

The tenant GET endpoint must include `tenant_type` and `public_launched` or the toggle above always reads `undefined`. Check `src/routes/tenants.ts` — if it selects explicit columns rather than `SELECT *`, add both. Verify:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/tenants/$TENANT_ID | grep -o "tenant_type"
```

Expected: prints `tenant_type`.

- [ ] **Step 4: Write the site-builder panels**

```js
/* public/qh-site-builder.js — business tenant site builder.
 * Pages + blocks, appearance, domain and launch.
 * DOM APIs only, no HTML string injection (same rule as qh-admin-ext.js).
 * Relies on globals from admin.html: api(), tenantId, show(), hide().
 */
(function () {
  function e(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function field(labelText, node) {
    const wrap = e("div", "field");
    wrap.appendChild(e("label", "", labelText));
    wrap.appendChild(node);
    return wrap;
  }
  function input(value, placeholder) {
    const n = document.createElement("input");
    if (value != null) n.value = value;
    if (placeholder) n.placeholder = placeholder;
    return n;
  }
  function textarea(value, rows) {
    const n = document.createElement("textarea");
    n.rows = rows || 4;
    if (value != null) n.value = value;
    return n;
  }

  // ---- Pages -------------------------------------------------------------
  async function renderPages(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Website pages"));
    const list = e("div", "list");
    root.appendChild(list);

    const data = await api(`/tenants/${tenantId}/pages`);
    (data.pages || []).forEach((pg) => {
      const row = e("div", "card");
      row.appendChild(e("h3", "", pg.title));
      row.appendChild(e("p", "muted", "/" + (pg.slug || "")));
      const edit = e("button", "btn", "Edit");
      edit.addEventListener("click", () => renderPageEditor(root, pg));
      const del = e("button", "btn secondary", "Delete");
      del.addEventListener("click", async () => {
        // No window.confirm: a modal dialog blocks the admin surface.
        if (del.dataset.armed !== "1") {
          del.dataset.armed = "1";
          del.textContent = "Click again to delete";
          return;
        }
        await api(`/tenants/${tenantId}/pages/${pg.id}`, { method: "DELETE" });
        renderPages(root);
      });
      row.appendChild(edit);
      row.appendChild(del);
      list.appendChild(row);
    });

    const add = e("button", "btn", "New page");
    add.addEventListener("click", () =>
      renderPageEditor(root, { title: "", slug: "", blocks_json: "[]", published: 0 })
    );
    root.appendChild(add);
  }

  function renderPageEditor(root, pg) {
    root.replaceChildren();
    root.appendChild(e("h2", "", pg.id ? "Edit page" : "New page"));

    const title = input(pg.title, "Page title");
    const slug = input(pg.slug, "url-slug (blank or 'home' for the home page)");
    const seoTitle = input(pg.seo_title || "", "SEO title (defaults to page title)");
    const seoDesc = textarea(pg.seo_description || "", 2);
    const blocks = textarea(pg.blocks_json || "[]", 16);
    const noindex = document.createElement("input");
    noindex.type = "checkbox";
    noindex.checked = pg.noindex === 1;
    const published = document.createElement("input");
    published.type = "checkbox";
    published.checked = pg.published === 1;

    root.appendChild(field("Title", title));
    root.appendChild(field("Slug", slug));
    root.appendChild(field("Blocks (JSON)", blocks));
    root.appendChild(field("SEO title", seoTitle));
    root.appendChild(field("SEO description", seoDesc));
    root.appendChild(field("Hide from search engines", noindex));
    root.appendChild(field("Published", published));

    const status = e("p", "muted", "");
    const save = e("button", "btn", "Save");
    save.addEventListener("click", async () => {
      let parsedBlocks;
      try {
        parsedBlocks = JSON.parse(blocks.value || "[]");
      } catch (err) {
        status.textContent = "Blocks must be valid JSON: " + err.message;
        return;
      }
      const body = {
        title: title.value,
        slug: slug.value,
        blocks_json: JSON.stringify(parsedBlocks),
        seo_title: seoTitle.value,
        seo_description: seoDesc.value,
        noindex: noindex.checked ? 1 : 0,
        published: published.checked ? 1 : 0,
      };
      await api(
        pg.id ? `/tenants/${tenantId}/pages/${pg.id}` : `/tenants/${tenantId}/pages`,
        { method: pg.id ? "PATCH" : "POST", body: JSON.stringify(body) }
      );
      renderPages(root);
    });
    const back = e("button", "btn secondary", "Cancel");
    back.addEventListener("click", () => renderPages(root));
    root.appendChild(save);
    root.appendChild(back);
    root.appendChild(status);
  }

  // ---- Appearance --------------------------------------------------------
  const TOKENS = [
    "primary", "primaryBright", "primaryDark", "secondary", "secondaryBright",
    "accent", "accentBright", "gold", "bg", "card", "textBase", "textMuted", "themeColor",
  ];

  async function renderTheme(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Appearance"));

    const site = await api(`/tenants/${tenantId}`);
    let settings = {};
    try { settings = JSON.parse(site.settings_json || "{}"); } catch (err) { settings = {}; }
    const theme = settings.theme || {};
    const fonts = settings.fonts || { heading: "fraunces", body: "inter" };

    const inputs = {};
    TOKENS.forEach((k) => {
      const n = document.createElement("input");
      n.type = "color";
      n.value = /^#[0-9a-fA-F]{6}$/.test(theme[k] || "") ? theme[k] : "#8a2060";
      inputs[k] = n;
      root.appendChild(field(k, n));
    });

    const heading = input(fonts.heading, "heading font key");
    const body = input(fonts.body, "body font key");
    root.appendChild(field("Heading font", heading));
    root.appendChild(field("Body font", body));

    const credit = document.createElement("input");
    credit.type = "checkbox";
    credit.checked = (settings.branding || {}).show_platform_credit !== false;
    root.appendChild(field("Show 'Powered by QuiltHosting'", credit));

    const save = e("button", "btn", "Save appearance");
    save.addEventListener("click", async () => {
      const nextTheme = {};
      TOKENS.forEach((k) => { nextTheme[k] = inputs[k].value; });
      const next = {
        ...settings,
        theme: nextTheme,
        fonts: { heading: heading.value, body: body.value },
        branding: { ...(settings.branding || {}), show_platform_credit: credit.checked },
      };
      await api(`/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ settings_json: JSON.stringify(next) }),
      });
      save.textContent = "Saved";
    });
    root.appendChild(save);
  }

  // ---- Domain & launch ---------------------------------------------------
  async function renderDomain(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Domain & launch"));

    const site = await api(`/tenants/${tenantId}`);
    const domain = input(site.custom_domain || "", "yourdomain.com");
    root.appendChild(field("Custom domain", domain));

    const saveDomain = e("button", "btn", "Save domain");
    saveDomain.addEventListener("click", async () => {
      const res = await api(`/tenants/${tenantId}/domain`, {
        method: "POST",
        body: JSON.stringify({ domain: domain.value }),
      });
      const dns = e("pre", "", JSON.stringify(res.dns || res, null, 2));
      root.appendChild(dns);
    });
    root.appendChild(saveDomain);

    const launched = document.createElement("input");
    launched.type = "checkbox";
    launched.checked = site.public_launched === 1;
    root.appendChild(field("Site is live to the public", launched));
    root.appendChild(
      e("p", "muted",
        "While this is off, the site stays behind the private-preview password.")
    );

    const saveLaunch = e("button", "btn", "Save");
    saveLaunch.addEventListener("click", async () => {
      await api(`/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ public_launched: launched.checked ? 1 : 0 }),
      });
      saveLaunch.textContent = "Saved";
    });
    root.appendChild(saveLaunch);
  }

  window.qhSiteBuilder = { renderPages, renderTheme, renderDomain };
})();
```

- [ ] **Step 5: Hook the pages into the router and load the script**

In `admin.html`, add the script tag beside the existing `qh-admin-ext.js` tag:

```html
<script src="/qh-site-builder.js"></script>
```

Then in the `navigate()` / page-switch function, add three cases. `qh-admin-ext.js` pages are wired the same way — find the existing case for `galleries` and place these beside it, substituting the container variable that case uses:

```js
      case "site-pages":
        window.qhSiteBuilder.renderPages(container);
        break;
      case "site-theme":
        window.qhSiteBuilder.renderTheme(container);
        break;
      case "site-domain":
        window.qhSiteBuilder.renderDomain(container);
        break;
```

- [ ] **Step 6: Allow the tenant PATCH to set `public_launched`**

In `src/routes/tenants.ts`, find the PATCH handler's allowed-field list and add `public_launched`:

```ts
  if (body.public_launched !== undefined) {
    sets.push("public_launched = ?");
    binds.push(body.public_launched ? 1 : 0);
  }
```

Match the surrounding code's variable names for the SET-clause and bind arrays rather than introducing `sets`/`binds` if it uses something else.

**Do not add `tenant_type` to this handler.** A tenant owner who could flip their own guild to `business` would drop their own member cap (Task 2) and gain a launch toggle. `tenant_type` is set at tenant creation or by a platform admin through `src/routes/platform.ts` only. Add it there instead, behind the existing platform-admin check:

```ts
  if (body.tenant_type === "guild" || body.tenant_type === "business") {
    sets.push("tenant_type = ?");
    binds.push(body.tenant_type);
  }
```

- [ ] **Step 7: Verify in the browser**

```bash
npm run dev
```

Open `http://localhost:8787/admin`, sign in, select the business tenant. Confirm: Website / Appearance / Domain & Launch appear; Levels / Renewals / Chapters / Forums / Directory are hidden; editing a page and saving changes what `curl -H "Host: stitchstudioquilting.test" http://localhost:8787/` returns.

- [ ] **Step 8: Typecheck, run everything, commit, push**

```bash
npx tsc --noEmit
npx vitest run
npm run test:business-site
git add public/qh-site-builder.js public/admin.html src/routes/tenants.ts
git commit -m "feat(admin): site builder — pages, appearance, domain and launch"
git push origin main
```

---

### Task 14: Images, business identity, nav, and the Customers relabel

Closes the remaining spec §5 items. Task 9 accepts `logoUrl` and `ogImageUrl` but never computes them, and nothing yet serves an uploaded image on a tenant host — so images are the blocking piece.

**Files:**
- Modify: `src/routes/site.ts`, `src/routes/public.ts`, `public/qh-site-builder.js`, `public/admin.html`
- Create: nothing

**Interfaces:**
- Consumes: `fileRoutes.post("/")` (existing, `src/routes/files.ts:45` — uploads to R2 and inserts into `files`); `renderPageHtml` (Task 7); `serveBusinessSite` (Task 9).
- Produces: `GET /img/:fileId` on a tenant host, serving from R2 with an immutable cache header.

- [ ] **Step 1: Serve tenant images on the tenant host**

The only public image route today is `/public/:slug/photo/:photoId`, which joins through `gallery_photos` and only works for gallery images (`src/routes/public.ts:1654`). Site images need a direct route.

In `src/routes/site.ts`, inside `serveBusinessSite`, add this branch immediately after the `robots.txt` branch:

```ts
  const imgMatch = path.match(/^\/img\/([A-Za-z0-9_-]{1,64})$/);
  if (imgMatch) {
    const row = await first<{ r2_key: string; content_type: string | null }>(
      c.env.DB.prepare(
        `SELECT r2_key, content_type FROM files WHERE id = ? AND tenant_id = ?`
      ).bind(imgMatch[1], tenant.id)
    );
    if (!row) return new Response("Not found", { status: 404 });
    const obj = await c.env.FILES.get(row.r2_key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": row.content_type || "image/jpeg",
        // File ids are immutable — a replaced image gets a new id, so this
        // can be cached forever without a purge.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }
```

The `tenant_id` in the WHERE clause is what stops one tenant's file id from reading another tenant's image.

- [ ] **Step 2: Wire the logo and OG image into the render call**

Still in `serveBusinessSite`, before the `cachedRender` call:

```ts
  let logoFileId = "";
  try {
    logoFileId = String(
      (JSON.parse(tenant.settings_json || "{}").assets || {}).logo_file_id || ""
    );
  } catch {
    logoFileId = "";
  }
  const logoUrl = logoFileId ? `${baseUrl}/img/${logoFileId}` : null;
  const ogImageUrl = row.og_image_file_id ? `${baseUrl}/img/${row.og_image_file_id}` : null;
```

Then pass `logoUrl` and `ogImageUrl` into `renderPageHtml`'s argument object, replacing the two properties currently omitted.

- [ ] **Step 3: Verify an uploaded image renders**

```bash
npm run dev
# Upload through the admin Files UI, note the returned file id, then:
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  -H "Host: stitchstudioquilting.test" http://localhost:8787/img/<FILE_ID>
```

Expected: `200 image/jpeg` (or the uploaded type). Then confirm cross-tenant isolation returns 404:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Host: stitchstudioquilting.test" http://localhost:8787/img/some-other-tenants-file-id
```

Expected: `404`.

- [ ] **Step 4: Add the business identity and nav panels**

Append to `public/qh-site-builder.js`, inside the same IIFE, before the `window.qhSiteBuilder = ...` line:

```js
  // ---- Business identity + navigation ------------------------------------
  const IDENTITY_FIELDS = [
    ["name", "Business name"],
    ["phone", "Phone"],
    ["email", "Email"],
    ["street", "Street"],
    ["city", "City"],
    ["state", "State"],
    ["zip", "ZIP"],
  ];

  async function renderIdentity(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Business details"));
    root.appendChild(
      e("p", "muted",
        "Used in the site footer and in the structured data search engines read.")
    );

    const site = await api(`/tenants/${tenantId}`);
    let settings = {};
    try { settings = JSON.parse(site.settings_json || "{}"); } catch (err) { settings = {}; }
    const business = settings.business || {};
    const assets = settings.assets || {};

    const inputs = {};
    IDENTITY_FIELDS.forEach(function (pair) {
      const n = input(business[pair[0]] || "", pair[1]);
      inputs[pair[0]] = n;
      root.appendChild(field(pair[1], n));
    });

    const logo = input(assets.logo_file_id || "", "file id from the Files page");
    root.appendChild(field("Logo file id", logo));

    root.appendChild(e("h3", "", "Navigation"));
    root.appendChild(
      e("p", "muted", "One item per line as 'Label | /path'. Leave empty to list published pages automatically.")
    );
    const navText = textarea(
      (settings.nav || []).map(function (n) { return n.label + " | " + n.href; }).join("\n"),
      6
    );
    root.appendChild(navText);

    const save = e("button", "btn", "Save details");
    save.addEventListener("click", async () => {
      const nextBusiness = {};
      IDENTITY_FIELDS.forEach(function (pair) { nextBusiness[pair[0]] = inputs[pair[0]].value; });
      const nav = navText.value
        .split("\n")
        .map(function (line) { return line.split("|"); })
        .filter(function (parts) { return parts.length >= 2 && parts[0].trim() && parts[1].trim(); })
        .map(function (parts) { return { label: parts[0].trim(), href: parts[1].trim() }; });
      const next = {
        ...settings,
        business: nextBusiness,
        assets: { ...assets, logo_file_id: logo.value.trim() },
        nav: nav,
      };
      await api(`/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ settings_json: JSON.stringify(next) }),
      });
      save.textContent = "Saved";
    });
    root.appendChild(save);
  }
```

Change the export line at the bottom of the file to:

```js
  window.qhSiteBuilder = { renderPages, renderTheme, renderDomain, renderIdentity };
```

- [ ] **Step 5: Add the sidebar entry and route**

In `public/admin.html`, add beside the other `business-only` links:

```html
        <a href="#" data-page="site-identity" class="business-only">Business details</a>
```

And add the case beside the other three:

```js
      case "site-identity":
        window.qhSiteBuilder.renderIdentity(container);
        break;
```

- [ ] **Step 6: Relabel Members as Customers for business tenants**

Spec §1 requires this. In `admin.html`, extend the toggle added in Task 13 Step 2:

```js
      document.querySelectorAll("[data-members-label]").forEach((el) => {
        el.textContent = isBusinessTenant ? "Customers" : "Members";
      });
```

Then add `data-members-label` to the sidebar Members link and to the Members page heading. This is a label change only — the `members` table, its routes, and its API shape are untouched.

- [ ] **Step 7: Verify end to end**

```bash
npm run dev
```

In the admin: set a business name, phone, and city; save; then confirm the public page picks them up.

```bash
curl -s -H "Host: stitchstudioquilting.test" http://localhost:8787/ | grep -o '"telephone":"[^"]*"'
```

Expected: the phone number you entered appears in the JSON-LD. Also confirm the sidebar reads "Customers" for the business tenant and "Members" for a guild.

- [ ] **Step 8: Typecheck, run everything, commit, push**

```bash
npx tsc --noEmit
npx vitest run
npm run test:business-site
git add src/routes/site.ts public/qh-site-builder.js public/admin.html
git commit -m "feat(admin): tenant image serving, business identity, nav editor, Customers relabel"
git push origin main
```

---

## Definition of done

- [ ] `npx tsc --noEmit` clean.
- [ ] `npx vitest run` green — 9 test files (`tenantType`, `plans`, `theme`, `fonts`, `themeMigrate`, `seo`, `blocks`, `render`, `credentials`), ~70 assertions.
- [ ] `npm run test:business-site` green.
- [ ] The five pre-existing `npm run test:*` scripts still pass (regression check on guilds).
- [ ] A launched business tenant serves server-rendered, indexable HTML on its own hostname.
- [ ] Uploaded images serve from `/img/:fileId` on the tenant host, and a file id from another tenant 404s.
- [ ] The owner can edit pages, blocks, appearance, business details, nav, domain, and the launch toggle without touching the database.
- [ ] `quilthosting.com`, `/admin`, `/portal`, and unlaunched tenants all still return 401 behind the gate.
- [ ] An existing guild site renders unchanged through `guild.html`.
- [ ] `package.json` version is `0.32.0-preview` and the work is pushed to `origin/main`.

## Deferred to later sub-projects

Named here so no one implements them early: longarm intake, agreements, and e-sign (P1); class admin, calendar, and registration (P2); product images and storefront (P3); PayPal/Venmo, direct charges, and the Connect webhook rebuild (P4); blog migration, videos, newsletter, and the 301 map (P5).
