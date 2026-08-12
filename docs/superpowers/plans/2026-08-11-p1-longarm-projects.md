# P1 Longarm Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can describe a quilt on Stitch Studio Quilting's public site, get an immediate ballpark, receive an owner-reviewed estimate by email, and sign a service agreement online that produces a tamper-evident record.

**Architecture:** Four new D1 tables (`projects`, `project_lines`, `agreement_signatures`, `project_counters`) behind pure-function libraries for pricing, status transitions, tokens, and agreement hashing. A public intake endpoint rides the site gate's existing rule 4 (`/public/<own-slug>/...`); the customer-facing quote page rides rule 5 (`/quote/<token>`). No new gate allowlist rules are added. Admin is a `window.qhProjects` module mounted from `admin.html`, following the Task 13-14 site-builder pattern exactly.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), R2, KV, TypeScript, vitest, Resend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-p1-longarm-projects-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **All money is integer cents.** No floats in money math, ever.
- **Rates are stored as cents per 100 square inches.** `$0.025/sq in` is `250`. This exists because longarm's conventional $0.02-$0.03/sq in is not representable in integer cents.
- **Every D1 query is scoped `WHERE tenant_id = ?`.** This is the only thing standing between tenants. P0's `/img/:fileId` cross-tenant test exists for this reason.
- **No new `siteGate` allowlist rules.** Rule 4 already permits `/public/<own-slug>/...` (as it already does for `/join` and `/cart/checkout`); rule 5 already passes `/quote/<token>` because `quote` is not in `PLATFORM_PATH_PREFIXES` (`src/lib/platformPaths.ts:53`). Adding rules "for safety" is how a gate widens by accident.
- **`camelCase` for all code identifiers.** SQL columns stay `snake_case` to match the existing schema.
- **Client-side admin and site JS use DOM APIs only** — no HTML string injection. Stated at `public/qh-site-builder.js:3`.
- **No PDF library.** Printable HTML plus `window.print()`, following `src/lib/invoices.ts:131`.
- **The ballpark is never emailed as a price** and is **suppressed rather than shown as `$0`** when the rate table is incomplete.
- **Bump `package.json` version** with each task's commit (patch for fixes, minor for features).
- **New assertions must be mutation-checked** — deliberately break the behaviour, watch the test fail, revert. Precedent: commit `81cee4e`.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `migrations/0020_longarm_projects.sql` | Four tables and their indexes |
| `src/lib/projects/types.ts` | Shared types: `ProjectType`, `ProjectStatus`, `LongarmRates`, `EstimateLine`, row shapes |
| `src/lib/projects/pricing.ts` | `computeEstimate` — pure, no I/O |
| `src/lib/projects/status.ts` | `canTransition` / `assertTransition` — the status machine |
| `src/lib/projects/token.ts` | `mintAccessToken`, `hashToken` |
| `src/lib/projects/agreement.ts` | `sha256Hex`, `buildAgreementSnapshot` |
| `src/lib/projects/imageSniff.ts` | `sniffImageType` — magic bytes, not `Content-Type` |
| `src/lib/projects/reference.ts` | `buildReference` — human-facing code from prefix + number |
| `src/routes/projects.ts` | Owner admin API under `/api/tenants/:tenantId/projects` |
| `src/lib/site/quote.ts` | Quote page + signed-copy HTML rendering |
| `public/qh-projects.js` | Admin UI: queue, estimate builder, rate table, agreement templates |
| `src/lib/projects/pricing.test.ts` | Pricing unit tests |
| `src/lib/projects/status.test.ts` | Status machine unit tests |
| `src/lib/projects/token.test.ts` | Token mint/hash unit tests |
| `src/lib/projects/agreement.test.ts` | Hashing + snapshot unit tests |
| `src/lib/projects/imageSniff.test.ts` | Magic-byte sniffing unit tests |
| `src/routes/projects.test.ts` | Admin route tests (fake D1, same idiom as `pages.test.ts`) |

**Modify:**

| File | Change |
|---|---|
| `src/types.ts` | Add `Project`, `ProjectLine`, `AgreementSignature` row types |
| `src/index.ts:369` | Mount `projectRoutes` on `tenantApp` |
| `src/routes/public.ts` | Intake POST, photo upload POST, rate limits |
| `src/routes/site.ts` | `/quote/<token>` GET and sign POST, before the page-slug lookup |
| `src/lib/blocks.ts` | `project_intake` block: type, `parseBlocks` case, render case, `BUSINESS_BLOCK_TYPES` |
| `public/qh-site.js` | Hydrate `.qh-block-project-intake` |
| `public/admin.html` | Projects nav item + `qh-projects.js` script tag + page dispatch |
| `src/middleware/siteGate.test.ts` | Coverage for the two new public paths |
| `scripts/verify-business-site.mjs` | Full intake → estimate → sign chain |

---

## Task 1: Schema and types

**Files:**
- Create: `migrations/0020_longarm_projects.sql`
- Modify: `src/types/index.ts`
- Create: `src/lib/projects/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProjectType = "longarm" | "custom_quilt" | "tshirt_quilt"`; `ProjectStatus = "submitted" | "estimated" | "signed" | "in_progress" | "completed" | "declined" | "cancelled"`; interfaces `Project`, `ProjectLine`, `AgreementSignature`; `LongarmRates`; `EstimateLine = { kind: "service" | "addon" | "discount"; description: string; quantity: number; unitCents: number; amountCents: number }`.

- [ ] **Step 1: Write the migration**

Create `migrations/0020_longarm_projects.sql`:

```sql
-- P1: longarm projects — intake, estimate, agreement, e-signature.
-- Payment state is deliberately absent; P4 owns invoicing.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  reference TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  member_id TEXT,
  intake_json TEXT NOT NULL DEFAULT '{}',
  estimate_notes TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  -- SHA-256 of the access token. The raw token is emailed once and never
  -- stored, so a database disclosure exposes no customer's quote.
  access_token_hash TEXT NOT NULL,
  token_expires_at TEXT,
  estimated_at TEXT,
  signed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX idx_projects_tenant_status ON projects(tenant_id, status, created_at);
CREATE UNIQUE INDEX idx_projects_tenant_reference ON projects(tenant_id, reference);
-- Token lookup is by hash alone; it must be fast and must not need a scan.
CREATE UNIQUE INDEX idx_projects_token_hash ON projects(access_token_hash);

CREATE TABLE project_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'service',
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_project_lines_project ON project_lines(project_id, sort_order);

CREATE TABLE agreement_signatures (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  signer_email TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  agreement_title TEXT NOT NULL,
  -- Full immutable snapshot, NOT a reference to a template Linda can edit.
  -- This table exists to answer "what exactly did they agree to" years later.
  agreement_text TEXT NOT NULL,
  agreement_sha256 TEXT NOT NULL,
  signing_token_hash TEXT NOT NULL,
  signer_ip TEXT,
  signer_user_agent TEXT,
  signed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
-- One signature per project: the signing endpoint is idempotent, and this
-- index is what makes that a database guarantee rather than a code promise.
CREATE UNIQUE INDEX idx_agreement_signatures_project ON agreement_signatures(project_id);

-- Separate from invoice_counters on purpose: an estimate that is never
-- accepted must not consume an invoice number.
CREATE TABLE project_counters (
  tenant_id TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
```

- [ ] **Step 2: Apply the migration locally and confirm the tables exist**

```bash
npx wrangler d1 execute quilthosting --local --file=migrations/0020_longarm_projects.sql
npx wrangler d1 execute quilthosting --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'project%' OR name='agreement_signatures'"
```

Expected: four rows — `projects`, `project_lines`, `agreement_signatures`, `project_counters`.

- [ ] **Step 3: Add row types to `src/types/index.ts`**

Append to the existing type exports:

```ts
export interface Project {
  id: string;
  tenant_id: string;
  project_type: string;
  status: string;
  reference: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  member_id: string | null;
  intake_json: string;
  estimate_notes: string | null;
  subtotal_cents: number;
  total_cents: number;
  due_date: string | null;
  access_token_hash: string;
  token_expires_at: string | null;
  estimated_at: string | null;
  signed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectLine {
  id: string;
  project_id: string;
  kind: string;
  description: string;
  quantity: number;
  unit_cents: number;
  amount_cents: number;
  sort_order: number;
}

export interface AgreementSignature {
  id: string;
  tenant_id: string;
  project_id: string;
  signer_name: string;
  signer_email: string;
  consent_text: string;
  agreement_title: string;
  agreement_text: string;
  agreement_sha256: string;
  signing_token_hash: string;
  signer_ip: string | null;
  signer_user_agent: string | null;
  signed_at: string;
}
```

- [ ] **Step 4: Create `src/lib/projects/types.ts`**

```ts
// Shared vocabulary for P1. Kept separate from src/types/index.ts (which
// holds D1 row shapes) because these are domain types the pure-function
// libraries in this directory trade in — no database involved.

export type ProjectType = "longarm" | "custom_quilt" | "tshirt_quilt";

export const PROJECT_TYPES: readonly ProjectType[] = [
  "longarm",
  "custom_quilt",
  "tshirt_quilt",
];

export type ProjectStatus =
  | "submitted"
  | "estimated"
  | "signed"
  | "in_progress"
  | "completed"
  | "declined"
  | "cancelled";

export type EstimateLineKind = "service" | "addon" | "discount";

export interface EstimateLine {
  kind: EstimateLineKind;
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

/**
 * Owner-configured rates, stored in tenants.settings_json under "longarm".
 * Every rate is in CENTS PER 100 SQUARE INCHES where marked, because
 * longarm's conventional $0.02-$0.03 per square inch is not representable
 * in integer cents and float money is not acceptable.
 */
export interface LongarmRates {
  referencePrefix?: string;
  edgeToEdgeCentsPer100SqIn?: number;
  customCentsPer100SqIn?: number;
  battingCentsPer100SqIn?: number;
  threadFlatCents?: number;
  bindingCentsPerLinearInch?: number;
  backingPrepFlatCents?: number;
  customDesignFlatCents?: number;
  tshirtPerBlockCents?: number;
  tshirtFinishingFlatCents?: number;
  rushPercent?: number;
  minimumCents?: Partial<Record<ProjectType, number>>;
}

/** What computeEstimate returns. `suppressed` means: do not show a price. */
export interface EstimateResult {
  suppressed: boolean;
  lines: EstimateLine[];
  subtotalCents: number;
  totalCents: number;
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add migrations/0020_longarm_projects.sql src/types/index.ts src/lib/projects/types.ts package.json
git commit -m "feat(projects): schema and domain types for longarm projects"
```

---

## Task 2: Pricing

**Files:**
- Create: `src/lib/projects/pricing.ts`
- Test: `src/lib/projects/pricing.test.ts`

**Interfaces:**
- Consumes: `ProjectType`, `LongarmRates`, `EstimateLine`, `EstimateResult` from `./types`.
- Produces: `computeEstimate(input: EstimateInput, rates: LongarmRates): EstimateResult`, and `export interface EstimateInput { projectType: ProjectType; widthIn?: number; heightIn?: number; serviceLevel?: "edge_to_edge" | "custom"; batting?: boolean; thread?: boolean; binding?: boolean; backingPrep?: boolean; rush?: boolean; blockCount?: number; }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/projects/pricing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeEstimate } from "./pricing";
import type { LongarmRates } from "./types";

const RATES: LongarmRates = {
  edgeToEdgeCentsPer100SqIn: 250,   // $0.025 / sq in
  customCentsPer100SqIn: 500,       // $0.05  / sq in
  battingCentsPer100SqIn: 100,
  threadFlatCents: 1200,
  bindingCentsPerLinearInch: 25,
  backingPrepFlatCents: 2500,
  customDesignFlatCents: 5000,
  tshirtPerBlockCents: 1800,
  tshirtFinishingFlatCents: 7500,
  rushPercent: 25,
  minimumCents: { longarm: 5000, custom_quilt: 9000, tshirt_quilt: 15000 },
};

describe("computeEstimate", () => {
  it("prices edge-to-edge longarm by area at cents per 100 sq in", () => {
    // 60 x 80 = 4800 sq in -> 4800 * 250 / 100 = 12000 cents
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "edge_to_edge" },
      RATES
    );
    expect(r.suppressed).toBe(false);
    expect(r.lines[0].amountCents).toBe(12000);
    expect(r.totalCents).toBe(12000);
  });

  it("applies the custom rate when serviceLevel is custom", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "custom" },
      RATES
    );
    expect(r.lines[0].amountCents).toBe(24000);
  });

  it("rounds to the nearest cent rather than truncating", () => {
    // 5 x 5 = 25 sq in -> 25 * 250 / 100 = 62.5 -> 63
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 5, heightIn: 5, serviceLevel: "edge_to_edge" },
      { ...RATES, minimumCents: {} }
    );
    expect(r.lines[0].amountCents).toBe(63);
  });

  it("adds add-ons as their own lines", () => {
    const r = computeEstimate(
      {
        projectType: "longarm", widthIn: 60, heightIn: 80,
        serviceLevel: "edge_to_edge", batting: true, thread: true,
        binding: true, backingPrep: true,
      },
      RATES
    );
    const byDesc = Object.fromEntries(r.lines.map((l) => [l.description, l.amountCents]));
    expect(byDesc["Batting"]).toBe(4800);            // 4800 sq in * 100 / 100
    expect(byDesc["Thread"]).toBe(1200);
    expect(byDesc["Binding"]).toBe(7000);            // perimeter 280 in * 25
    expect(byDesc["Backing preparation"]).toBe(2500);
    expect(r.totalCents).toBe(12000 + 4800 + 1200 + 7000 + 2500);
  });

  it("applies rush as a percentage line on the subtotal", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "edge_to_edge", rush: true },
      RATES
    );
    expect(r.totalCents).toBe(15000);                // 12000 + 25%
    expect(r.lines.some((l) => l.description.startsWith("Rush"))).toBe(true);
  });

  it("raises a below-minimum total to the minimum with an explicit line", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 10, heightIn: 10, serviceLevel: "edge_to_edge" },
      RATES
    );
    expect(r.totalCents).toBe(5000);
    expect(r.lines.some((l) => l.description === "Minimum charge adjustment")).toBe(true);
  });

  it("prices a T-shirt quilt per block plus finishing, not by area", () => {
    const r = computeEstimate({ projectType: "tshirt_quilt", blockCount: 20 }, RATES);
    expect(r.totalCents).toBe(20 * 1800 + 7500);
  });

  it("adds a design fee for a custom quilt", () => {
    const r = computeEstimate(
      { projectType: "custom_quilt", widthIn: 60, heightIn: 80, serviceLevel: "custom" },
      RATES
    );
    expect(r.lines.some((l) => l.description === "Custom design")).toBe(true);
    expect(r.totalCents).toBe(24000 + 5000);
  });

  it("SUPPRESSES rather than returning zero when the needed rate is missing", () => {
    const r = computeEstimate(
      { projectType: "longarm", widthIn: 60, heightIn: 80, serviceLevel: "edge_to_edge" },
      {}
    );
    expect(r.suppressed).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.totalCents).toBe(0);
  });

  it("suppresses when dimensions are missing, zero, or negative", () => {
    for (const dims of [{}, { widthIn: 0, heightIn: 80 }, { widthIn: -60, heightIn: 80 }]) {
      const r = computeEstimate(
        { projectType: "longarm", serviceLevel: "edge_to_edge", ...dims },
        RATES
      );
      expect(r.suppressed).toBe(true);
    }
  });

  it("suppresses a T-shirt quilt with no block count", () => {
    expect(computeEstimate({ projectType: "tshirt_quilt" }, RATES).suppressed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/projects/pricing.test.ts`
Expected: FAIL — "Failed to resolve import ./pricing".

- [ ] **Step 3: Implement `src/lib/projects/pricing.ts`**

```ts
// Pure pricing. No I/O, no database, no clock — every input is an argument
// so the whole surface is unit-testable and deterministic.
//
// WHY CENTS PER 100 SQUARE INCHES: longarm work is conventionally priced at
// $0.02-$0.03 per square inch. Integer cents cannot represent $0.025, and
// float money is not acceptable, so rates are scaled by 100 and divided back
// out at the end of the multiplication (not before it).

import type {
  EstimateLine,
  EstimateResult,
  LongarmRates,
  ProjectType,
} from "./types";

export interface EstimateInput {
  projectType: ProjectType;
  widthIn?: number;
  heightIn?: number;
  serviceLevel?: "edge_to_edge" | "custom";
  batting?: boolean;
  thread?: boolean;
  binding?: boolean;
  backingPrep?: boolean;
  rush?: boolean;
  blockCount?: number;
}

const SUPPRESSED: EstimateResult = {
  suppressed: true,
  lines: [],
  subtotalCents: 0,
  totalCents: 0,
};

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Rate lookups return undefined when unset; a rate of 0 is NOT usable. */
function rate(value: number | undefined): number | undefined {
  return positive(value) ? value : undefined;
}

function line(
  kind: EstimateLine["kind"],
  description: string,
  quantity: number,
  unitCents: number,
  amountCents: number
): EstimateLine {
  return { kind, description, quantity, unitCents, amountCents };
}

/**
 * Compute a ballpark. Returns `suppressed: true` when the rate table or the
 * inputs are insufficient — the caller MUST then show no price at all rather
 * than rendering $0, which reads as "free" instead of "unknown".
 */
export function computeEstimate(
  input: EstimateInput,
  rates: LongarmRates
): EstimateResult {
  const lines: EstimateLine[] = [];

  if (input.projectType === "tshirt_quilt") {
    const perBlock = rate(rates.tshirtPerBlockCents);
    if (!perBlock || !positive(input.blockCount)) return SUPPRESSED;
    const blocks = Math.round(input.blockCount);
    lines.push(line("service", "T-shirt blocks", blocks, perBlock, blocks * perBlock));
    const finishing = rate(rates.tshirtFinishingFlatCents);
    if (finishing) {
      lines.push(line("service", "Finishing", 1, finishing, finishing));
    }
    return finalize(lines, input, rates);
  }

  if (!positive(input.widthIn) || !positive(input.heightIn)) return SUPPRESSED;

  const level = input.serviceLevel === "custom" ? "custom" : "edge_to_edge";
  const perSq =
    level === "custom"
      ? rate(rates.customCentsPer100SqIn)
      : rate(rates.edgeToEdgeCentsPer100SqIn);
  if (!perSq) return SUPPRESSED;

  const areaSqIn = input.widthIn * input.heightIn;
  const quiltingCents = Math.round((areaSqIn * perSq) / 100);
  lines.push(
    line(
      "service",
      level === "custom" ? "Custom quilting" : "Edge-to-edge quilting",
      areaSqIn,
      perSq,
      quiltingCents
    )
  );

  if (input.projectType === "custom_quilt") {
    const design = rate(rates.customDesignFlatCents);
    if (design) lines.push(line("service", "Custom design", 1, design, design));
  }

  if (input.batting) {
    const r = rate(rates.battingCentsPer100SqIn);
    if (r) lines.push(line("addon", "Batting", areaSqIn, r, Math.round((areaSqIn * r) / 100)));
  }
  if (input.thread) {
    const r = rate(rates.threadFlatCents);
    if (r) lines.push(line("addon", "Thread", 1, r, r));
  }
  if (input.binding) {
    const r = rate(rates.bindingCentsPerLinearInch);
    // Perimeter, not area — binding is sold by the linear inch.
    const perimeterIn = 2 * (input.widthIn + input.heightIn);
    if (r) lines.push(line("addon", "Binding", perimeterIn, r, Math.round(perimeterIn * r)));
  }
  if (input.backingPrep) {
    const r = rate(rates.backingPrepFlatCents);
    if (r) lines.push(line("addon", "Backing preparation", 1, r, r));
  }

  return finalize(lines, input, rates);
}

function finalize(
  lines: EstimateLine[],
  input: EstimateInput,
  rates: LongarmRates
): EstimateResult {
  if (!lines.length) return SUPPRESSED;

  let subtotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);

  if (input.rush) {
    const pct = rate(rates.rushPercent);
    if (pct) {
      const rushCents = Math.round((subtotalCents * pct) / 100);
      lines.push(line("service", `Rush (${pct}%)`, 1, rushCents, rushCents));
      subtotalCents += rushCents;
    }
  }

  let totalCents = subtotalCents;
  const minimum = rates.minimumCents?.[input.projectType];
  if (positive(minimum) && totalCents < minimum) {
    const adjustment = minimum - totalCents;
    lines.push(line("service", "Minimum charge adjustment", 1, adjustment, adjustment));
    totalCents = minimum;
  }

  return { suppressed: false, lines, subtotalCents, totalCents };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/projects/pricing.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation-check the suppression behaviour**

Temporarily change `if (!perSq) return SUPPRESSED;` to `const perSqSafe = perSq ?? 0;` and use it. Run the tests.
Expected: the "SUPPRESSES rather than returning zero" test FAILS. Revert the change and re-run to confirm green.

This is the single most important behaviour in the file — a suppressed estimate that silently becomes `$0` would show a customer a free quilt.

- [ ] **Step 6: Commit**

```bash
git add src/lib/projects/pricing.ts src/lib/projects/pricing.test.ts package.json
git commit -m "feat(projects): estimate pricing with integer-cent rates and explicit suppression"
```

---

## Task 3: Status machine, tokens, references

**Files:**
- Create: `src/lib/projects/hash.ts`, `src/lib/projects/status.ts`, `src/lib/projects/token.ts`, `src/lib/projects/reference.ts`
- Test: `src/lib/projects/status.test.ts`, `src/lib/projects/token.test.ts`

**Interfaces:**
- Consumes: `ProjectStatus` from `./types`.
- Produces: `sha256Hex(text: string): Promise<string>` from `./hash` — **the single SHA-256 implementation in this feature**; Task 4's `agreement.ts` imports it rather than writing its own. `canTransition(from: ProjectStatus, to: ProjectStatus): boolean`; `assertTransition(from: ProjectStatus, to: ProjectStatus): void` (throws `Error` with message `Illegal transition: <from> -> <to>`); `mintAccessToken(): string`; `hashToken(token: string): Promise<string>` (an alias of `sha256Hex`, kept for call-site readability); `buildReference(prefix: string | undefined, tenantSlug: string, n: number): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/projects/status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canTransition, assertTransition } from "./status";

describe("status machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("submitted", "estimated")).toBe(true);
    expect(canTransition("estimated", "signed")).toBe(true);
    expect(canTransition("signed", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
  });

  it("allows declining an estimate and cancelling accepted work", () => {
    expect(canTransition("estimated", "declined")).toBe(true);
    expect(canTransition("signed", "cancelled")).toBe(true);
    expect(canTransition("in_progress", "cancelled")).toBe(true);
  });

  it("refuses to skip the signature", () => {
    expect(canTransition("estimated", "in_progress")).toBe(false);
    expect(canTransition("submitted", "signed")).toBe(false);
  });

  it("refuses to move backwards", () => {
    expect(canTransition("signed", "estimated")).toBe(false);
    expect(canTransition("completed", "in_progress")).toBe(false);
  });

  it("treats declined, cancelled and completed as terminal", () => {
    for (const from of ["declined", "cancelled", "completed"] as const) {
      for (const to of ["submitted", "estimated", "signed", "in_progress"] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("allows re-sending an estimate without changing status", () => {
    expect(canTransition("estimated", "estimated")).toBe(true);
  });

  it("assertTransition throws with both states named", () => {
    expect(() => assertTransition("submitted", "completed")).toThrow(
      "Illegal transition: submitted -> completed"
    );
  });
});
```

Create `src/lib/projects/token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mintAccessToken, hashToken } from "./token";

describe("access tokens", () => {
  it("mints a URL-safe token with no padding", () => {
    const t = mintAccessToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).not.toContain("=");
  });

  it("mints at least 32 bytes of entropy", () => {
    // base64url of 32 bytes is 43 chars.
    expect(mintAccessToken().length).toBeGreaterThanOrEqual(43);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintAccessToken()));
    expect(seen.size).toBe(500);
  });

  it("hashes to lowercase hex SHA-256", async () => {
    // Known vector: SHA-256("abc")
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is deterministic and differs per token", async () => {
    const a = mintAccessToken();
    expect(await hashToken(a)).toBe(await hashToken(a));
    expect(await hashToken(a)).not.toBe(await hashToken(mintAccessToken()));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/projects/status.test.ts src/lib/projects/token.test.ts`
Expected: FAIL — unresolved imports for `./status` and `./token`.

- [ ] **Step 3: Implement the three modules**

Create `src/lib/projects/status.ts`:

```ts
// The status machine is enforced server-side, not merely reflected in the
// admin UI. A UI that hides a button is a suggestion; this is the rule.

import type { ProjectStatus } from "./types";

const ALLOWED: Record<ProjectStatus, readonly ProjectStatus[]> = {
  submitted: ["estimated", "cancelled"],
  // Self-transition is legal: re-sending a revised estimate is a normal act
  // and must not require a contrived status detour.
  estimated: ["estimated", "signed", "declined", "cancelled"],
  signed: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  declined: [],
  cancelled: [],
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal transition: ${from} -> ${to}`);
  }
}
```

Create `src/lib/projects/hash.ts` — the one and only SHA-256 in this feature:

```ts
// The single SHA-256 implementation for P1. Both the access-token hash and
// the agreement fingerprint use it. They were briefly specced as separate
// byte-identical copies on the theory that hashing a secret and hashing a
// document might one day diverge; that was speculative, and duplicated
// crypto is a poor thing to speculate with.

/** UTF-8 text to lowercase hex SHA-256. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

Create `src/lib/projects/token.ts`:

```ts
// Customer access tokens. The raw token is emailed once and NEVER stored —
// only its SHA-256 — so a database disclosure exposes no customer's quote.
// The consequence is intended: "resend link" mints a fresh token and
// invalidates the previous one, because the old one cannot be recovered.

import { sha256Hex } from "./hash";

const TOKEN_BYTES = 32;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function mintAccessToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** Alias of sha256Hex — kept so token call sites read as what they mean. */
export const hashToken = sha256Hex;
```

Create `src/lib/projects/reference.ts`:

```ts
// Human-facing project code — the thing Linda says on the phone. Sequential
// per tenant, allocated from project_counters (NOT invoice_counters: an
// estimate that is never accepted must not consume an invoice number).

/**
 * Build a reference like "SSQ-0042". Prefix comes from the owner's setting
 * when present, otherwise the first three alphanumerics of the tenant slug,
 * otherwise "QP".
 */
export function buildReference(
  prefix: string | undefined,
  tenantSlug: string,
  n: number
): string {
  const fromSetting = (prefix || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const fromSlug = (tenantSlug || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const code = (fromSetting || fromSlug.slice(0, 3) || "QP").slice(0, 6);
  return `${code}-${String(n).padStart(4, "0")}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/projects/status.test.ts src/lib/projects/token.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-check the status machine**

Temporarily add `"in_progress"` to `submitted`'s allowed list. Run the tests.
Expected: "refuses to skip the signature" FAILS. Revert and confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/projects/status.ts src/lib/projects/token.ts src/lib/projects/reference.ts src/lib/projects/status.test.ts src/lib/projects/token.test.ts package.json
git commit -m "feat(projects): status machine, hashed access tokens, reference codes"
```

---

## Task 4: Agreement snapshot and hashing

**Files:**
- Create: `src/lib/projects/agreement.ts`
- Test: `src/lib/projects/agreement.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` from `./hash` (Task 3). Do **not** write a second SHA-256 here — importing the shared one is the point.
- Produces: `buildAgreementSnapshot(args: { title: string; body: string; project: { reference: string; customerName: string; totalCents: number } }): string`; `CONSENT_TEXT: string`. Consumers of `sha256Hex` import it from `../projects/hash`, not from this module.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/projects/agreement.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sha256Hex } from "./hash";
import { buildAgreementSnapshot, CONSENT_TEXT } from "./agreement";

const PROJECT = { reference: "SSQ-0042", customerName: "Jane Quilter", totalCents: 12500 };

describe("agreement snapshot", () => {
  it("embeds the reference, the customer, and the agreed total", () => {
    const snap = buildAgreementSnapshot({
      title: "Service Agreement",
      body: "Quilting is performed at the customer's risk.",
      project: PROJECT,
    });
    expect(snap).toContain("SSQ-0042");
    expect(snap).toContain("Jane Quilter");
    expect(snap).toContain("$125.00");
    expect(snap).toContain("Quilting is performed at the customer's risk.");
  });

  it("is byte-stable for identical input", () => {
    const a = buildAgreementSnapshot({ title: "T", body: "B", project: PROJECT });
    const b = buildAgreementSnapshot({ title: "T", body: "B", project: PROJECT });
    expect(a).toBe(b);
  });

  it("changes its hash when the total changes", async () => {
    const a = buildAgreementSnapshot({ title: "T", body: "B", project: PROJECT });
    const b = buildAgreementSnapshot({
      title: "T", body: "B",
      project: { ...PROJECT, totalCents: 12501 },
    });
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it("states that the customer is agreeing to be bound", () => {
    expect(CONSENT_TEXT.toLowerCase()).toContain("agree");
    expect(CONSENT_TEXT.toLowerCase()).toContain("bound");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/projects/agreement.test.ts`
Expected: FAIL — unresolved import `./agreement`.

- [ ] **Step 3: Implement `src/lib/projects/agreement.ts`**

```ts
// The signed document. What gets hashed and stored is a SNAPSHOT — the
// agreement body Linda had configured at the moment of signing, with this
// project's specifics interpolated. A foreign key to a template she has
// since edited could not answer "what did this customer actually agree to",
// which is the only question this record exists to answer.

export const CONSENT_TEXT =
  "I have read this agreement and I agree to be bound by it.";

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Byte-stable plain text. Deliberately NOT HTML: the stored artefact should
 * be readable as-is years from now without a renderer, and stability matters
 * more than presentation because its hash is the integrity guarantee.
 */
export function buildAgreementSnapshot(args: {
  title: string;
  body: string;
  project: { reference: string; customerName: string; totalCents: number };
}): string {
  const { title, body, project } = args;
  return [
    title,
    "",
    `Project: ${project.reference}`,
    `Customer: ${project.customerName}`,
    `Agreed total: ${money(project.totalCents)}`,
    "",
    body,
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/projects/agreement.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/projects/agreement.ts src/lib/projects/agreement.test.ts package.json
git commit -m "feat(projects): agreement snapshot with SHA-256 integrity"
```

---

## Task 5: Magic-byte image sniffing

**Files:**
- Create: `src/lib/projects/imageSniff.ts`
- Test: `src/lib/projects/imageSniff.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sniffImageType(bytes: Uint8Array): string | null` returning one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, or `null`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/projects/imageSniff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sniffImageType } from "./imageSniff";

function bytes(...vals: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(vals);
  return out;
}
function ascii(s: string, offset = 0): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  return out;
}

describe("sniffImageType", () => {
  it("detects PNG", () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });

  it("detects JPEG", () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });

  it("detects GIF87a and GIF89a", () => {
    expect(sniffImageType(ascii("GIF87a"))).toBe("image/gif");
    expect(sniffImageType(ascii("GIF89a"))).toBe("image/gif");
  });

  it("detects WebP (RIFF container with a WEBP fourcc)", () => {
    const b = ascii("RIFF");
    b.set(ascii("WEBP").subarray(0, 4), 8);
    expect(sniffImageType(b)).toBe("image/webp");
  });

  it("detects AVIF (ftyp box)", () => {
    const b = ascii("ftyp", 4);
    b.set(ascii("avif").subarray(0, 4), 8);
    expect(sniffImageType(b)).toBe("image/avif");
  });

  it("REFUSES SVG even though its MIME type looks image-y", () => {
    expect(sniffImageType(ascii("<svg xmlns="))).toBe(null);
    expect(sniffImageType(ascii("<?xml version=\"1.0\"?><svg"))).toBe(null);
  });

  it("refuses HTML, which is the stored-XSS case that matters", () => {
    expect(sniffImageType(ascii("<!DOCTYPE html><script>"))).toBe(null);
  });

  it("refuses a RIFF container that is not WebP (e.g. a WAV)", () => {
    const b = ascii("RIFF");
    b.set(ascii("WAVE").subarray(0, 4), 8);
    expect(sniffImageType(b)).toBe(null);
  });

  it("refuses a truncated header rather than guessing", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBe(null);
    expect(sniffImageType(new Uint8Array(0))).toBe(null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/projects/imageSniff.test.ts`
Expected: FAIL — unresolved import `./imageSniff`.

- [ ] **Step 3: Implement `src/lib/projects/imageSniff.ts`**

```ts
// Decide an uploaded file's type from its BYTES, never from the client's
// Content-Type header. P0 learned this the expensive way: fileRoutes accepts
// whatever Content-Type a caller sends, so a text/html file could be stored
// and later echoed back on the tenant's own first-party origin — stored XSS.
// /img/:fileId now allowlists image types on the way out; this allowlists on
// the way in, so the bad bytes never land in R2 at all.
//
// SVG is deliberately absent. It is active content — it can carry inline
// <script> — and would reopen exactly that hole despite its image-y name.

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(s: string): number[] {
  return Array.from(s, (ch) => ch.charCodeAt(0));
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return "image/gif";
  }
  // RIFF....WEBP — the fourcc at offset 8 is load-bearing; a bare "RIFF" is
  // also how WAV and AVI start.
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  // ISO-BMFF: "ftyp" at offset 4, brand at offset 8.
  if (startsWith(bytes, ascii("ftyp"), 4)) {
    if (startsWith(bytes, ascii("avif"), 8) || startsWith(bytes, ascii("avis"), 8)) {
      return "image/avif";
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/projects/imageSniff.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation-check the RIFF fourcc**

Temporarily drop the `&& startsWith(bytes, ascii("WEBP"), 8)` clause. Run the tests.
Expected: "refuses a RIFF container that is not WebP" FAILS. Revert and confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/projects/imageSniff.ts src/lib/projects/imageSniff.test.ts package.json
git commit -m "feat(projects): magic-byte image sniffing, SVG refused as active content"
```

---

## Task 6: Owner admin API

**Files:**
- Create: `src/routes/projects.ts`
- Test: `src/routes/projects.test.ts`
- Modify: `src/index.ts` (mount alongside the other `tenantApp.route(...)` calls, after `/galleries`)

**Interfaces:**
- Consumes: `computeEstimate`/`EstimateInput` (Task 2), `assertTransition` (Task 3), `mintAccessToken`/`hashToken` (Task 3), `buildReference` (Task 3), `first`/`all` from `../lib/db`, `generateId` from `../lib/utils/id`.
- Produces: `export const projectRoutes` — a Hono app with `GET /`, `GET /:projectId`, `PATCH /:projectId`, `PUT /:projectId/lines`, `POST /:projectId/send-estimate`, `POST /:projectId/resend-link`.

- [ ] **Step 1: Write the failing tests**

Create `src/routes/projects.test.ts`. Use the same fake-D1 idiom as `src/routes/pages.test.ts:19` — dispatch through the exported app with a stand-in tenant context:

```ts
// Same idiom as src/routes/pages.test.ts and credentials.test.ts: dispatch
// through the exported app with a thin stand-in for tenantMiddleware, and a
// keyword-routed fake D1 that records every write.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { projectRoutes } from "./projects";
import type { Env, Tenant, TenantVariables } from "../types";

const TENANT_ID = "tenant-1";

function harness(opts: { project?: Record<string, unknown>; role?: string } = {}) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  // Every statement the routes prepare, in order. The tenant-scoping test
  // below asserts against this rather than trusting the routes.
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM projects")) return opts.project ?? null;
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              writes.push({ sql, binds });
              return { success: true };
            },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { writes.push({ sql, binds: [] }); return { success: true }; },
      };
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, slug: "stitchstudio", settings_json: "{}" } as Tenant);
    c.set("tenantRole", opts.role ?? "owner");
    await next();
  });
  app.route("/", projectRoutes);
  return { app, writes, prepared, env: { DB: db } as unknown as Env };
}

describe("projects admin API", () => {
  it("refuses a non-owner role", async () => {
    const { app, env } = harness({ role: "member", project: { id: "p1", status: "submitted" } });
    const res = await app.request("/p1", { method: "PATCH", body: JSON.stringify({ status: "estimated" }) }, env);
    expect(res.status).toBe(403);
  });

  it("rejects an illegal status transition with 409, not 500", async () => {
    const { app, env } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed" }) },
      env
    );
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain("submitted -> completed");
  });

  it("accepts a legal transition", async () => {
    const { app, env, writes } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "signed", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "in_progress" }) },
      env
    );
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.sql.includes("UPDATE projects"))).toBe(true);
  });

  it("scopes EVERY statement touching projects to the tenant", async () => {
    // The Global Constraints require `WHERE tenant_id = ?` on every query;
    // this asserts it against the SQL the routes actually prepare, rather
    // than trusting that they do. `prepared` is populated by the harness
    // above — see the `prepare(sql)` hook, which records each statement.
    const { app, env, prepared } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    await app.request("/p1", {}, env);
    await app.request("/", {}, env);

    const projectStatements = prepared.filter((sql) => /\bprojects\b/.test(sql));
    expect(projectStatements.length).toBeGreaterThan(0);
    for (const sql of projectStatements) {
      expect(sql).toMatch(/tenant_id\s*=\s*\?/);
    }
  });

  it("recomputes totals from the saved lines rather than trusting the client", async () => {
    const { app, env, writes } = harness({
      project: { id: "p1", tenant_id: TENANT_ID, status: "submitted", reference: "X-0001" },
    });
    const res = await app.request(
      "/p1/lines",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [
            { kind: "service", description: "Quilting", quantity: 1, unit_cents: 10000, amount_cents: 10000 },
            { kind: "addon", description: "Thread", quantity: 1, unit_cents: 1200, amount_cents: 1200 },
          ],
          // A client claiming the total is $1 must not be believed.
          total_cents: 100,
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const update = writes.find((w) => w.sql.includes("UPDATE projects SET subtotal_cents"));
    expect(update).toBeDefined();
    expect(update!.binds).toContain(11200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/routes/projects.test.ts`
Expected: FAIL — unresolved import `./projects`.

- [ ] **Step 3: Implement `src/routes/projects.ts`**

Follow `src/routes/domain.ts:23` for the role guard — copy that `requireOwnerAdmin` shape rather than inventing a new one:

```ts
import { Hono } from "hono";
import type { Env, Project, ProjectLine, TenantVariables, Tenant } from "../types";
import { all, first } from "../lib/db";
import { generateId } from "../lib/utils/id";
import { assertTransition } from "../lib/projects/status";
import { mintAccessToken, hashToken } from "../lib/projects/token";
import type { ProjectStatus } from "../lib/projects/types";

export const projectRoutes = new Hono<{
  Bindings: Env;
  Variables: TenantVariables;
}>();

/** Same guard as src/routes/domain.ts:23 — owner|admin|platform, not any role. */
async function requireOwnerAdmin(c: {
  get: (k: "tenantRole") => string;
}): Promise<Response | null> {
  const role = c.get("tenantRole");
  if (!["owner", "admin", "platform"].includes(role)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

// GET /api/tenants/:tenantId/projects?status=&type=
projectRoutes.get("/", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const status = c.req.query("status");
  const type = c.req.query("type");
  let sql = `SELECT * FROM projects WHERE tenant_id = ?`;
  const binds: string[] = [tenant.id];
  if (status) { sql += ` AND status = ?`; binds.push(status); }
  if (type) { sql += ` AND project_type = ?`; binds.push(type); }
  sql += ` ORDER BY created_at DESC LIMIT 500`;
  const rows = await all<Project>(c.env.DB.prepare(sql).bind(...binds));
  return c.json(rows);
});

// GET /api/tenants/:tenantId/projects/:projectId
projectRoutes.get("/:projectId", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(
      `SELECT * FROM projects WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);
  const lines = await all<ProjectLine>(
    c.env.DB.prepare(
      `SELECT * FROM project_lines WHERE project_id = ? ORDER BY sort_order`
    ).bind(project.id)
  );
  // access_token_hash is never returned to the browser: it is the lookup key
  // for the customer's link, and the admin UI has no use for it.
  const { access_token_hash: _omit, ...safe } = project;
  return c.json({ project: safe, lines });
});

// PATCH /api/tenants/:tenantId/projects/:projectId
projectRoutes.patch("/:projectId", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(
      `SELECT * FROM projects WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json<{
    status?: ProjectStatus;
    estimate_notes?: string;
    due_date?: string | null;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string | null;
  }>().catch(() => ({}));

  if (body.status && body.status !== project.status) {
    try {
      assertTransition(project.status as ProjectStatus, body.status);
    } catch (err) {
      // 409, not 500: an illegal transition is a conflict with current state,
      // not a server fault.
      return c.json({ error: (err as Error).message }, 409);
    }
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE projects SET
       status = coalesce(?, status),
       estimate_notes = coalesce(?, estimate_notes),
       due_date = coalesce(?, due_date),
       customer_name = coalesce(?, customer_name),
       customer_email = coalesce(?, customer_email),
       customer_phone = coalesce(?, customer_phone),
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
       updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      body.status ?? null,
      body.estimate_notes ?? null,
      body.due_date ?? null,
      body.customer_name ?? null,
      body.customer_email ?? null,
      body.customer_phone ?? null,
      body.status ?? "",
      now,
      now,
      project.id,
      tenant.id
    )
    .run();

  return c.json({ ok: true });
});

// PUT /api/tenants/:tenantId/projects/:projectId/lines — replace all lines
projectRoutes.put("/:projectId/lines", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(
      `SELECT * FROM projects WHERE id = ? AND tenant_id = ?`
    ).bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json<{
    lines?: {
      kind?: string;
      description?: string;
      quantity?: number;
      unit_cents?: number;
      amount_cents?: number;
    }[];
  }>().catch(() => ({ lines: [] }));

  const lines = (body.lines || []).slice(0, 100).map((l, i) => ({
    id: generateId(),
    kind: ["service", "addon", "discount"].includes(String(l.kind)) ? String(l.kind) : "service",
    description: String(l.description || "").slice(0, 300),
    quantity: Number.isFinite(l.quantity) ? Number(l.quantity) : 1,
    unitCents: Math.round(Number(l.unit_cents) || 0),
    amountCents: Math.round(Number(l.amount_cents) || 0),
    sortOrder: i,
  }));

  // Totals are recomputed from the lines. A client-supplied total is never
  // trusted — it is the number the customer will be asked to agree to.
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);

  await c.env.DB.prepare(`DELETE FROM project_lines WHERE project_id = ?`)
    .bind(project.id)
    .run();
  for (const l of lines) {
    await c.env.DB.prepare(
      `INSERT INTO project_lines
         (id, project_id, kind, description, quantity, unit_cents, amount_cents, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(l.id, project.id, l.kind, l.description, l.quantity, l.unitCents, l.amountCents, l.sortOrder)
      .run();
  }
  await c.env.DB.prepare(
    `UPDATE projects SET subtotal_cents = ?, total_cents = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(subtotalCents, subtotalCents, new Date().toISOString(), project.id, tenant.id)
    .run();

  return c.json({ ok: true, subtotal_cents: subtotalCents, total_cents: subtotalCents });
});

// POST /:projectId/resend-link — mints a FRESH token; the old one dies.
projectRoutes.post("/:projectId/resend-link", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(`SELECT * FROM projects WHERE id = ? AND tenant_id = ?`)
      .bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);

  const token = mintAccessToken();
  const tokenHash = await hashToken(token);
  const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  await c.env.DB.prepare(
    `UPDATE projects SET access_token_hash = ?, token_expires_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(tokenHash, expires, new Date().toISOString(), project.id, tenant.id)
    .run();

  return c.json({ ok: true, token });
});
```

Note: `POST /:projectId/send-estimate` is added in Task 7, where the email helper and the customer-record matching rule live.

- [ ] **Step 4: Mount the routes in `src/index.ts`**

Add the import beside the other route imports, and the mount immediately after the `/galleries` line (`src/index.ts:369`):

```ts
import { projectRoutes } from "./routes/projects";
```

```ts
tenantApp.route("/projects", projectRoutes);
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run src/routes/projects.test.ts && npx tsc --noEmit`
Expected: PASS, 5 tests; tsc exit 0.

- [ ] **Step 6: Mutation-check the total recomputation**

Temporarily change the totals update to bind `body.total_cents` instead of `subtotalCents`. Run the tests.
Expected: "recomputes totals from the saved lines" FAILS. Revert and confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/routes/projects.ts src/routes/projects.test.ts src/index.ts package.json
git commit -m "feat(projects): owner admin API with server-enforced status machine"
```

---

## Task 7: Public intake, counter allocation, emails

**Files:**
- Modify: `src/routes/public.ts` (new route + rate limit registration beside the existing ones at lines 21-29)
- Modify: `src/routes/projects.ts` (add `POST /:projectId/send-estimate`)

**Interfaces:**
- Consumes: `computeEstimate` (Task 2), `mintAccessToken`/`hashToken` (Task 3), `buildReference` (Task 3), `sendEmail` from `../lib/email` with `SendEmailParams = { to, subject, html, text?, from?, replyTo?, tags? }`, `rateLimit` from `../middleware/rateLimit`, and the **existing** `getTenantBySlug(db: D1Database, slug: string)` already defined at `src/routes/public.ts:32` — note it takes `c.env.DB`, not `c.env`.
- Produces: `POST /public/:slug/projects/intake` returning `{ ok: true, reference: string, ballpark: { suppressed: boolean, total_cents: number, lines: EstimateLine[] } }`; `POST /api/tenants/:id/projects/:projectId/send-estimate`; `escapeHtml` newly exported from `src/lib/blocks.ts`.

- [ ] **Step 0: Export `escapeHtml` from `src/lib/blocks.ts`**

`escapeHtml` already exists at `src/lib/blocks.ts:343` but is module-private, and both this task and Task 10 need it for email bodies. Add the `export` keyword rather than defining a third copy (there is already a private duplicate in `src/lib/email/merge.ts:123` — do not add a fourth):

```ts
export function escapeHtml(s: string): string {
```

Then in `src/routes/public.ts` and `src/routes/site.ts`:

```ts
import { escapeHtml } from "../lib/blocks";
```

- [ ] **Step 1: Register the rate limit**

In `src/routes/public.ts`, beside the existing limits at lines 21-29:

```ts
publicRoutes.use(
  "/:slug/projects/intake",
  rateLimit({ keyPrefix: "intake", limit: 20, windowSeconds: 600 })
);
publicRoutes.use(
  "/:slug/projects/:projectRef/photos",
  rateLimit({ keyPrefix: "intakephoto", limit: 40, windowSeconds: 600 })
);
```

- [ ] **Step 2: Write the intake handler in `src/routes/public.ts`**

```ts
// POST /public/:slug/projects/intake
// Reachable unauthenticated on a launched business tenant's own host via
// siteGate rule 4 (/public/<own-slug>/...), the same rule under which /join
// and /cart/checkout already accept unauthenticated writes. No new gate rule.
publicRoutes.post("/:slug/projects/intake", async (c) => {
  // getTenantBySlug is the existing helper at src/routes/public.ts:32 — it
  // takes the D1 binding, not env.
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant || tenant.tenant_type !== "business") {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.json<{
    project_type?: string;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string;
    intake?: Record<string, unknown>;
  }>().catch(() => ({}));

  const projectType = PROJECT_TYPES.includes(body.project_type as ProjectType)
    ? (body.project_type as ProjectType)
    : null;
  const name = String(body.customer_name || "").trim().slice(0, 200);
  const email = String(body.customer_email || "").trim().slice(0, 320);
  if (!projectType) return c.json({ error: "Choose a project type" }, 400);
  if (!name) return c.json({ error: "Name is required" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "A valid email is required" }, 400);
  }

  const intake = (body.intake && typeof body.intake === "object") ? body.intake : {};
  const widthIn = Number(intake.widthIn);
  const heightIn = Number(intake.heightIn);
  // Sane bounds: a quilt wider than 200in does not exist, and a negative one
  // would sail straight into the area multiplication.
  const dimsOk = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 200;
  if (projectType !== "tshirt_quilt" && (!dimsOk(widthIn) || !dimsOk(heightIn))) {
    return c.json({ error: "Enter the quilt's width and height in inches" }, 400);
  }

  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(tenant.settings_json || "{}"); } catch { settings = {}; }
  const rates = ((settings.longarm as LongarmRates) || {}) as LongarmRates;

  const ballpark = computeEstimate(
    {
      projectType,
      widthIn: dimsOk(widthIn) ? widthIn : undefined,
      heightIn: dimsOk(heightIn) ? heightIn : undefined,
      serviceLevel: intake.serviceLevel === "custom" ? "custom" : "edge_to_edge",
      batting: !!intake.batting,
      thread: !!intake.thread,
      binding: !!intake.binding,
      backingPrep: !!intake.backingPrep,
      rush: !!intake.rush,
      blockCount: Number(intake.blockCount) || undefined,
    },
    rates
  );

  // Allocate the reference. UPSERT-then-read keeps the counter monotonic
  // without a transaction, which D1 does not offer across statements.
  await c.env.DB.prepare(
    `INSERT INTO project_counters (tenant_id, next_number) VALUES (?, 1)
     ON CONFLICT(tenant_id) DO UPDATE SET next_number = next_number + 1`
  ).bind(tenant.id).run();
  const counter = await first<{ next_number: number }>(
    c.env.DB.prepare(`SELECT next_number FROM project_counters WHERE tenant_id = ?`)
      .bind(tenant.id)
  );
  const reference = buildReference(rates.referencePrefix, tenant.slug, counter?.next_number ?? 1);

  const token = mintAccessToken();
  const tokenHash = await hashToken(token);
  const id = generateId();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

  // The row commits BEFORE any email is attempted. A Resend outage must never
  // lose a customer's submission.
  await c.env.DB.prepare(
    `INSERT INTO projects
       (id, tenant_id, project_type, status, reference, customer_name, customer_email,
        customer_phone, intake_json, subtotal_cents, total_cents,
        access_token_hash, token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, tenant.id, projectType, reference, name, email,
      String(body.customer_phone || "").slice(0, 50) || null,
      JSON.stringify(intake),
      ballpark.suppressed ? 0 : ballpark.subtotalCents,
      ballpark.suppressed ? 0 : ballpark.totalCents,
      tokenHash, expires, now, now
    )
    .run();

  if (!ballpark.suppressed) {
    for (let i = 0; i < ballpark.lines.length; i++) {
      const l = ballpark.lines[i];
      await c.env.DB.prepare(
        `INSERT INTO project_lines
           (id, project_id, kind, description, quantity, unit_cents, amount_cents, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(generateId(), id, l.kind, l.description, l.quantity, l.unitCents, l.amountCents, i).run();
    }
  }

  // Acknowledgement only. The ballpark is NEVER emailed as a price — it is
  // shown on screen to convert a browsing visitor, and only the estimate
  // Linda has reviewed goes out.
  await sendEmail(c.env, {
    to: email,
    subject: `We received your quilt request (${reference})`,
    html: `<p>Thanks ${escapeHtml(name)} — we have your request, reference <strong>${reference}</strong>.</p>
           <p>We'll review the details and send your estimate shortly.</p>`,
  }).catch(() => undefined);

  const ownerEmail = (settings.business as { email?: string } | undefined)?.email;
  if (ownerEmail) {
    await sendEmail(c.env, {
      to: ownerEmail,
      subject: `New ${projectType.replace("_", " ")} intake — ${reference}`,
      html: `<p>${escapeHtml(name)} (${escapeHtml(email)}) submitted ${reference}.</p>`,
    }).catch(() => undefined);
  }

  return c.json({
    ok: true,
    reference,
    ballpark: {
      suppressed: ballpark.suppressed,
      total_cents: ballpark.totalCents,
      lines: ballpark.lines,
    },
  });
});
```

- [ ] **Step 3: Add `send-estimate` to `src/routes/projects.ts`**

```ts
// POST /:projectId/send-estimate
// This is where a customer record is created or matched — NOT at intake. An
// anonymous public form that writes to the Customers list is a spam
// amplifier; this step is human-reviewed, so junk never reaches it.
projectRoutes.post("/:projectId/send-estimate", async (c) => {
  const denied = await requireOwnerAdmin(c);
  if (denied) return denied;
  const tenant = c.get("tenant") as Tenant;
  const project = await first<Project>(
    c.env.DB.prepare(`SELECT * FROM projects WHERE id = ? AND tenant_id = ?`)
      .bind(c.req.param("projectId"), tenant.id)
  );
  if (!project) return c.json({ error: "Project not found" }, 404);

  try {
    assertTransition(project.status as ProjectStatus, "estimated");
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }

  let member = await first<{ id: string }>(
    c.env.DB.prepare(`SELECT id FROM members WHERE tenant_id = ? AND lower(email) = lower(?)`)
      .bind(tenant.id, project.customer_email)
  );
  if (!member) {
    const memberId = generateId();
    await c.env.DB.prepare(
      `INSERT INTO members (id, tenant_id, email, first_name, status, joined_at)
       VALUES (?, ?, ?, ?, 'active', datetime('now'))`
    ).bind(memberId, tenant.id, project.customer_email, project.customer_name).run();
    member = { id: memberId };
  }

  const token = mintAccessToken();
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  await c.env.DB.prepare(
    `UPDATE projects SET status = 'estimated', member_id = ?, access_token_hash = ?,
       token_expires_at = ?, estimated_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  ).bind(member.id, tokenHash, expires, now, now, project.id, tenant.id).run();

  const baseUrl = tenantPublicBaseUrl(c.env, tenant);
  await sendEmail(c.env, {
    to: project.customer_email,
    subject: `Your quilting estimate — ${project.reference}`,
    html: `<p>Your estimate for ${project.reference} is ready.</p>
           <p><a href="${baseUrl}/quote/${token}">View and sign your estimate</a></p>`,
  }).catch(() => undefined);

  return c.json({ ok: true });
});
```

- [ ] **Step 4: Typecheck and run the full unit suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/public.ts src/routes/projects.ts package.json
git commit -m "feat(projects): public intake with ballpark, reference allocation, estimate send"
```

---

## Task 8: Intake photo upload

**Files:**
- Modify: `src/routes/public.ts`

**Interfaces:**
- Consumes: `sniffImageType` (Task 5), `generateId`.
- Produces: `POST /public/:slug/projects/:projectRef/photos` accepting `multipart/form-data` and returning `{ ok: true, file_ids: string[] }`.

- [ ] **Step 1: Implement the handler**

```ts
// POST /public/:slug/projects/:projectRef/photos
// Deliberately open to the internet — a T-shirt quilt cannot be quoted
// without seeing the shirts. Bounded by: the rate limit registered in Task 7,
// a hard file count and size cap, and magic-byte type detection. The type is
// decided from BYTES, never from the client's Content-Type.
const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;

publicRoutes.post("/:slug/projects/:projectRef/photos", async (c) => {
  const tenant = await getTenantBySlug(c.env.DB, c.req.param("slug"));
  if (!tenant || tenant.tenant_type !== "business") {
    return c.json({ error: "Not found" }, 404);
  }
  const project = await first<{ id: string }>(
    c.env.DB.prepare(
      `SELECT id FROM projects WHERE tenant_id = ? AND reference = ? AND status = 'submitted'`
    ).bind(tenant.id, c.req.param("projectRef"))
  );
  if (!project) return c.json({ error: "Not found" }, 404);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Expected multipart form data" }, 400);

  const files = form.getAll("photos").filter((f): f is File => f instanceof File);
  if (!files.length) return c.json({ error: "No photos supplied" }, 400);
  if (files.length > MAX_FILES) {
    return c.json({ error: `At most ${MAX_FILES} photos` }, 400);
  }

  const fileIds: string[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      return c.json({ error: "Each photo must be under 10MB" }, 400);
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const contentType = sniffImageType(buf);
    if (!contentType) {
      return c.json({ error: "Photos must be PNG, JPEG, GIF, WebP or AVIF" }, 400);
    }
    const fileId = generateId();
    const key = `${tenant.id}/${fileId}/${file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)}`;
    await c.env.FILES.put(key, buf);
    await c.env.DB.prepare(
      `INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(fileId, tenant.id, key, file.name.slice(0, 200), contentType, buf.byteLength)
      .run();
    fileIds.push(fileId);
  }

  // Bind the photos to the project by appending to intake_json rather than
  // adding a table: they are intake data, and intake_json is where
  // type-varying intake data lives.
  const row = await first<{ intake_json: string }>(
    c.env.DB.prepare(`SELECT intake_json FROM projects WHERE id = ? AND tenant_id = ?`)
      .bind(project.id, tenant.id)
  );
  let intake: Record<string, unknown> = {};
  try { intake = JSON.parse(row?.intake_json || "{}"); } catch { intake = {}; }
  const existing = Array.isArray(intake.photoFileIds) ? intake.photoFileIds : [];
  intake.photoFileIds = [...existing, ...fileIds].slice(0, MAX_FILES);
  await c.env.DB.prepare(
    `UPDATE projects SET intake_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
  ).bind(JSON.stringify(intake), new Date().toISOString(), project.id, tenant.id).run();

  return c.json({ ok: true, file_ids: fileIds });
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/routes/public.ts package.json
git commit -m "feat(projects): intake photo upload with magic-byte type enforcement"
```

---

## Task 9: The `project_intake` block

**Files:**
- Modify: `src/lib/blocks.ts` (type union near line 19, `parseBlocks` case near line 146, render case near line 279, `BUSINESS_BLOCK_TYPES` at line 407)
- Modify: `public/qh-site.js`

**Interfaces:**
- Consumes: nothing from earlier tasks at build time; hydration calls the Task 7 endpoint.
- Produces: block type `{ type: "project_intake"; projectType: string; heading?: string; submitLabel?: string }`.

- [ ] **Step 1: Add the block type to the union**

In `src/lib/blocks.ts`, beside the `contact_form` entry:

```ts
  | { type: "project_intake"; projectType: string; heading?: string; submitLabel?: string }
```

- [ ] **Step 2: Add the `parseBlocks` case**

```ts
      case "project_intake":
        out.push({
          type: "project_intake",
          projectType: ["longarm", "custom_quilt", "tshirt_quilt"].includes(String(b.projectType))
            ? String(b.projectType)
            : "longarm",
          heading: String(b.heading || "Request a quote").slice(0, 120),
          submitLabel: String(b.submitLabel || "Get my estimate").slice(0, 60),
        });
        break;
```

- [ ] **Step 3: Add the render case**

```ts
      case "project_intake":
        // Server-rendered placeholder, hydrated by public/qh-site.js against
        // POST /public/:slug/projects/intake — the same shape contact_form
        // already uses.
        parts.push(
          `<div class="qh-block-project-intake" data-project-type="${escapeAttr(
            b.projectType
          )}" data-heading="${escapeAttr(b.heading || "Request a quote")}" data-submit-label="${escapeAttr(
            b.submitLabel || "Get my estimate"
          )}"></div>`
        );
        break;
```

- [ ] **Step 4: Add it to the admin picker list**

```ts
export const BUSINESS_BLOCK_TYPES = [
  "hero", "heading", "text", "image", "gallery_grid", "service_cards",
  "faq", "testimonials", "contact_form", "project_intake", "button",
  "events_list", "store_list", "divider", "spacer", "html",
];
```

- [ ] **Step 5: Hydrate it in `public/qh-site.js`**

Append inside the IIFE, after the `contact_form` block. DOM APIs only — no HTML strings:

```js
  document.querySelectorAll(".qh-block-project-intake").forEach(function (node) {
    var projectType = node.getAttribute("data-project-type") || "longarm";
    var form = el("form", "card");
    form.appendChild(el("h3", "", node.getAttribute("data-heading") || "Request a quote"));

    var name = el("input"); name.name = "name"; name.placeholder = "Your name"; name.required = true;
    var email = el("input"); email.type = "email"; email.placeholder = "Your email"; email.required = true;
    var phone = el("input"); phone.placeholder = "Phone (optional)";
    form.appendChild(name); form.appendChild(email); form.appendChild(phone);

    var width = el("input"); width.type = "number"; width.min = "1"; width.max = "200";
    width.placeholder = "Quilt width (inches)";
    var height = el("input"); height.type = "number"; height.min = "1"; height.max = "200";
    height.placeholder = "Quilt height (inches)";
    var blocks = el("input"); blocks.type = "number"; blocks.min = "1";
    blocks.placeholder = "How many T-shirt blocks?";

    if (projectType === "tshirt_quilt") {
      form.appendChild(blocks);
    } else {
      form.appendChild(width); form.appendChild(height);
    }

    var level = document.createElement("select");
    [["edge_to_edge", "Edge to edge"], ["custom", "Custom quilting"]].forEach(function (pair) {
      var o = document.createElement("option");
      o.value = pair[0]; o.textContent = pair[1];
      level.appendChild(o);
    });
    if (projectType !== "tshirt_quilt") form.appendChild(level);

    var addons = {};
    [["batting", "Batting"], ["thread", "Thread"], ["binding", "Binding"],
     ["backingPrep", "Backing preparation"], ["rush", "Rush turnaround"]].forEach(function (pair) {
      var wrap = el("label");
      var cb = document.createElement("input"); cb.type = "checkbox";
      addons[pair[0]] = cb;
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode(" " + pair[1]));
      form.appendChild(wrap);
    });

    var btn = el("button", "btn", node.getAttribute("data-submit-label") || "Get my estimate");
    btn.type = "submit";
    form.appendChild(btn);
    var out = el("div", "muted");
    form.appendChild(out);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      btn.disabled = true;
      var intake = {
        widthIn: Number(width.value) || undefined,
        heightIn: Number(height.value) || undefined,
        blockCount: Number(blocks.value) || undefined,
        serviceLevel: level.value,
      };
      Object.keys(addons).forEach(function (k) { intake[k] = addons[k].checked; });
      fetch("/public/" + encodeURIComponent(slug) + "/projects/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_type: projectType,
          customer_name: name.value,
          customer_email: email.value,
          customer_phone: phone.value,
          intake: intake,
        }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          btn.disabled = false;
          if (!res.ok) { out.textContent = res.j.error || "Something went wrong."; return; }
          node.replaceChildren();
          node.appendChild(el("h3", "", "Thanks — we have your request."));
          node.appendChild(el("p", "", "Your reference is " + res.j.reference + "."));
          // Suppressed means the rate table can't price this. Show NOTHING
          // rather than $0 — a confident wrong price is worse than no price.
          if (res.j.ballpark && !res.j.ballpark.suppressed) {
            node.appendChild(el("p", "",
              "Estimated ballpark: $" + (res.j.ballpark.total_cents / 100).toFixed(2)));
            node.appendChild(el("p", "muted",
              "This is an estimate only. We'll review the details and send your final quote."));
          }
        });
    });
    node.appendChild(form);
  });
```

- [ ] **Step 6: Typecheck and run the block tests**

Run: `npx tsc --noEmit && npx vitest run src/lib/site/render.test.ts`
Expected: tsc exit 0; existing render tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/blocks.ts public/qh-site.js package.json
git commit -m "feat(projects): project_intake block with ballpark display"
```

---

## Task 10: The quote page and the signing ceremony

**Files:**
- Create: `src/lib/site/quote.ts`
- Modify: `src/routes/site.ts` (match `/quote/` BEFORE the page-slug lookup at line 150)

**Interfaces:**
- Consumes: `hashToken` (Task 3), `sha256Hex`/`buildAgreementSnapshot`/`CONSENT_TEXT` (Task 4), `assertTransition` (Task 3).
- Produces: `renderQuotePage(args): string`, `renderSignedCopy(args): string`, and `renderInvalidLink(tenant: Tenant): string` from `src/lib/site/quote.ts`; `GET /quote/:token` and `POST /quote/:token/sign` handled inside `serveBusinessSite`. Also consumes `readTenantTheme(settingsJson) -> { theme, fonts }` (`src/lib/site/themeMigrate.ts:121`) and `escapeHtml` exported in Task 7.

- [ ] **Step 1: Add the route branch to `serveBusinessSite`**

In `src/routes/site.ts`, immediately before the `const slug = path === "/" ? ...` line (currently line 150):

```ts
  // Customer quote page. Matched BEFORE the page-slug lookup below.
  //
  // There is no collision with a page whose slug is "quote": a page slug is
  // one path segment, this is two, and pages.ts's slugify strips "/", so
  // "quote/<token>" can never equal a stored slug. No reserved-slug
  // machinery is needed.
  //
  // No siteGate change is required either: rule 5 already passes any path
  // that is not a reserved platform prefix, and "quote" is not in
  // PLATFORM_PATH_PREFIXES (src/lib/platformPaths.ts:53).
  const quoteMatch = path.match(/^\/quote\/([A-Za-z0-9_-]{20,120})$/);
  const signMatch = path.match(/^\/quote\/([A-Za-z0-9_-]{20,120})\/sign$/);

  if (quoteMatch || signMatch) {
    const rawToken = (quoteMatch || signMatch)![1];
    const tokenHash = await hashToken(rawToken);
    const project = await first<Project>(
      c.env.DB.prepare(
        `SELECT * FROM projects WHERE access_token_hash = ? AND tenant_id = ?`
      ).bind(tokenHash, tenant.id)
    );

    const expired =
      !!project?.token_expires_at &&
      new Date(project.token_expires_at).getTime() < Date.now();

    // Invalid and expired return the SAME response. Distinguishing them
    // would let the endpoint be probed to learn which tokens exist.
    if (!project || expired) {
      return new Response(renderInvalidLink(tenant), {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex",
        },
      });
    }

    if (signMatch && c.req.method === "POST") {
      return signQuote(c, tenant, project, tokenHash);
    }

    const lines = await all<ProjectLine>(
      c.env.DB.prepare(
        `SELECT * FROM project_lines WHERE project_id = ? ORDER BY sort_order`
      ).bind(project.id)
    );
    const signature = await first<AgreementSignature>(
      c.env.DB.prepare(
        `SELECT * FROM agreement_signatures WHERE project_id = ? AND tenant_id = ?`
      ).bind(project.id, tenant.id)
    );

    const html = signature
      ? renderSignedCopy({ tenant, project, lines, signature, baseUrl })
      : renderQuotePage({ tenant, project, lines, baseUrl });

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // The token is in the URL path. Without this, any outbound link the
        // customer clicks hands their quote to a third party in a Referer
        // header.
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex",
        "Cache-Control": "no-store",
      },
    });
  }
```

- [ ] **Step 2: Implement `signQuote` in `src/routes/site.ts`**

```ts
async function signQuote(
  c: Context<{ Bindings: Env }>,
  tenant: Tenant,
  project: Project,
  tokenHash: string
): Promise<Response> {
  // Idempotent by design AND by schema (unique index on project_id). A second
  // POST is the normal case — double-clicks and retries — not an error.
  const existing = await first<AgreementSignature>(
    c.env.DB.prepare(
      `SELECT * FROM agreement_signatures WHERE project_id = ? AND tenant_id = ?`
    ).bind(project.id, tenant.id)
  );
  if (existing) {
    return c.json({ ok: true, already_signed: true });
  }

  const body = await c.req.json<{ signer_name?: string; consent?: boolean }>().catch(() => ({}));
  const signerName = String(body.signer_name || "").trim().slice(0, 200);
  if (!signerName) return c.json({ error: "Type your full name to sign" }, 400);
  if (body.consent !== true) return c.json({ error: "You must agree to the terms" }, 400);

  try {
    assertTransition(project.status as ProjectStatus, "signed");
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }

  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(tenant.settings_json || "{}"); } catch { settings = {}; }
  const longarm = (settings.longarm || {}) as {
    agreementTitle?: string;
    agreementBody?: string;
  };

  const snapshot = buildAgreementSnapshot({
    title: longarm.agreementTitle || "Service Agreement",
    body: longarm.agreementBody || "",
    project: {
      reference: project.reference,
      customerName: project.customer_name,
      totalCents: project.total_cents,
    },
  });
  const hash = await sha256Hex(snapshot);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO agreement_signatures
       (id, tenant_id, project_id, signer_name, signer_email, consent_text,
        agreement_title, agreement_text, agreement_sha256, signing_token_hash,
        signer_ip, signer_user_agent, signed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      generateId(), tenant.id, project.id, signerName, project.customer_email,
      CONSENT_TEXT, longarm.agreementTitle || "Service Agreement", snapshot, hash,
      tokenHash,
      c.req.header("cf-connecting-ip") || null,
      (c.req.header("user-agent") || "").slice(0, 500) || null,
      now
    )
    .run();

  await c.env.DB.prepare(
    `UPDATE projects SET status = 'signed', signed_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  ).bind(now, now, project.id, tenant.id).run();

  await sendEmail(c.env, {
    to: project.customer_email,
    subject: `Signed — ${project.reference}`,
    html: `<p>Thank you. Your agreement for ${project.reference} is signed.</p>`,
  }).catch(() => undefined);

  const ownerEmail = (settings.business as { email?: string } | undefined)?.email;
  if (ownerEmail) {
    await sendEmail(c.env, {
      to: ownerEmail,
      subject: `${project.reference} signed by ${signerName}`,
      html: `<p>${escapeHtml(signerName)} signed ${project.reference}.</p>`,
    }).catch(() => undefined);
  }

  return c.json({ ok: true });
}
```

- [ ] **Step 3: Implement `src/lib/site/quote.ts`**

Render the quote page, the signed copy, and the invalid-link page. Use the same `esc()` discipline as `src/lib/site/render.ts:22` and reuse `buildRootVars` so the page carries the tenant's theme:

```ts
import { buildRootVars } from "./theme";
import { readTenantTheme } from "./themeMigrate";
import { CONSENT_TEXT } from "../projects/agreement";
import type { Project, ProjectLine, AgreementSignature, Tenant } from "../../types";

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? "-" : ""}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function shell(tenant: Tenant, title: string, bodyHtml: string): string {
  const { theme, fonts } = readTenantTheme(tenant.settings_json);
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/qh-site.css">
<style>:root{${buildRootVars(theme, fonts)}}
@media print{.qh-no-print{display:none}}</style>
</head><body class="qh-quote">${bodyHtml}</body></html>`;
}

function linesTable(lines: ProjectLine[], totalCents: number): string {
  const rows = lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td>${esc(String(l.quantity))}</td><td>${money(
          l.amount_cents
        )}</td></tr>`
    )
    .join("");
  return `<table class="qh-quote-lines">
<thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><th colspan="2">Total</th><th>${money(totalCents)}</th></tr></tfoot></table>`;
}

export function renderInvalidLink(tenant: Tenant): string {
  // Deliberately identical for an unknown token and an expired one.
  return shell(
    tenant,
    "Link no longer valid",
    `<main class="qh-quote-main"><h1>This link is no longer valid</h1>
<p>Please contact ${esc(tenant.name)} for an up-to-date link.</p></main>`
  );
}

export function renderQuotePage(args: {
  tenant: Tenant;
  project: Project;
  lines: ProjectLine[];
  baseUrl: string;
}): string {
  const { tenant, project, lines } = args;
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(tenant.settings_json || "{}"); } catch { settings = {}; }
  const longarm = (settings.longarm || {}) as { agreementTitle?: string; agreementBody?: string };
  const title = longarm.agreementTitle || "Service Agreement";

  return shell(
    tenant,
    `Estimate ${project.reference}`,
    `<main class="qh-quote-main">
<h1>Estimate ${esc(project.reference)}</h1>
<p>Prepared for ${esc(project.customer_name)}</p>
${linesTable(lines, project.total_cents)}
${project.estimate_notes ? `<p class="qh-quote-notes">${esc(project.estimate_notes)}</p>` : ""}
<section class="qh-agreement"><h2>${esc(title)}</h2>
<pre class="qh-agreement-body">${esc(longarm.agreementBody || "")}</pre></section>
<form id="qh-sign" class="qh-no-print">
  <label>Type your full name to sign
    <input name="signer_name" required maxlength="200" autocomplete="name">
  </label>
  <label><input type="checkbox" name="consent" required> ${esc(CONSENT_TEXT)}</label>
  <button type="submit" class="btn">Sign agreement</button>
  <p class="qh-sign-status" role="status"></p>
</form>
<script>
(function(){
  var f=document.getElementById('qh-sign');
  var s=f.querySelector('.qh-sign-status');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var btn=f.querySelector('button'); btn.disabled=true;
    fetch(location.pathname+'/sign',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({signer_name:f.signer_name.value,consent:f.consent.checked})
    }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(res){
        if(!res.ok){btn.disabled=false;s.textContent=res.j.error||'Something went wrong.';return;}
        location.reload();
      });
  });
})();
</script>
</main>`
  );
}

export function renderSignedCopy(args: {
  tenant: Tenant;
  project: Project;
  lines: ProjectLine[];
  signature: AgreementSignature;
  baseUrl: string;
}): string {
  const { tenant, project, lines, signature } = args;
  return shell(
    tenant,
    `Signed agreement ${project.reference}`,
    `<main class="qh-quote-main">
<h1>Signed agreement ${esc(project.reference)}</h1>
${linesTable(lines, project.total_cents)}
<section class="qh-agreement"><h2>${esc(signature.agreement_title)}</h2>
<pre class="qh-agreement-body">${esc(signature.agreement_text)}</pre></section>
<section class="qh-signature">
  <p>Signed by <strong>${esc(signature.signer_name)}</strong> on ${esc(signature.signed_at)}</p>
  <p>${esc(signature.consent_text)}</p>
  <p class="qh-hash">Document fingerprint (SHA-256): <code>${esc(signature.agreement_sha256)}</code></p>
</section>
<button class="btn qh-no-print" onclick="window.print()">Print / Save PDF</button>
</main>`
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/site/quote.ts src/routes/site.ts package.json
git commit -m "feat(projects): quote page and idempotent signing ceremony"
```

---

## Task 11: Admin UI

**Files:**
- Create: `public/qh-projects.js`
- Modify: `public/admin.html` (nav at line 81, script tag at line 115, dispatch at line 414)

**Interfaces:**
- Consumes: globals `api()`, `tenantId` from `admin.html`, exactly as `qh-site-builder.js:4` documents.
- Produces: `window.qhProjects = { renderQueue, renderRates }`.

- [ ] **Step 1: Add the nav entries to `admin.html`**

Beside the existing business-only links:

```html
        <a href="#" data-page="projects" class="business-only hidden">Projects</a>
        <a href="#" data-page="project-rates" class="business-only hidden">Quilting rates</a>
```

- [ ] **Step 2: Add the script tag beside `qh-site-builder.js`**

```html
  <script src="/qh-projects.js"></script>
```

- [ ] **Step 3: Add the page dispatch cases**

```js
        else if (page === "projects") await window.qhProjects.renderQueue(el);
        else if (page === "project-rates") await window.qhProjects.renderRates(el);
```

- [ ] **Step 4: Implement `public/qh-projects.js`**

DOM APIs only, same conventions as `qh-site-builder.js`:

```js
/* public/qh-projects.js — longarm project queue, estimate builder, rate table.
 * DOM APIs only, no HTML string injection (same rule as qh-site-builder.js).
 * Relies on globals from admin.html: api(), tenantId.
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
  function money(cents) {
    return "$" + ((Number(cents) || 0) / 100).toFixed(2);
  }

  const STATUSES = ["submitted", "estimated", "signed", "in_progress", "completed", "declined", "cancelled"];

  async function renderQueue(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Projects"));

    const filter = document.createElement("select");
    const anyOpt = document.createElement("option");
    anyOpt.value = ""; anyOpt.textContent = "All statuses";
    filter.appendChild(anyOpt);
    STATUSES.forEach(function (s) {
      const o = document.createElement("option");
      o.value = s; o.textContent = s.replace("_", " ");
      filter.appendChild(o);
    });
    root.appendChild(field("Status", filter));

    const list = e("div", "list");
    root.appendChild(list);

    async function load() {
      list.replaceChildren();
      const q = filter.value ? "?status=" + encodeURIComponent(filter.value) : "";
      const rows = await api("/api/tenants/" + tenantId + "/projects" + q);
      (Array.isArray(rows) ? rows : []).forEach(function (p) {
        const card = e("div", "card");
        card.appendChild(e("h3", "", p.reference + " — " + p.customer_name));
        card.appendChild(e("p", "muted", p.project_type.replace("_", " ") + " · " + p.status.replace("_", " ") + " · " + money(p.total_cents)));
        const open = e("button", "btn", "Open");
        open.addEventListener("click", function () { renderDetail(root, p.id); });
        card.appendChild(open);
        list.appendChild(card);
      });
    }
    filter.addEventListener("change", load);
    await load();
  }

  async function renderDetail(root, projectId) {
    root.replaceChildren();
    const data = await api("/api/tenants/" + tenantId + "/projects/" + projectId);
    const p = data.project;
    root.appendChild(e("h2", "", "Project " + p.reference));
    root.appendChild(e("p", "muted", p.customer_name + " · " + p.customer_email + (p.customer_phone ? " · " + p.customer_phone : "")));

    let intake = {};
    try { intake = JSON.parse(p.intake_json || "{}"); } catch (err) { intake = {}; }
    const intakeList = e("ul");
    Object.keys(intake).forEach(function (k) {
      if (k === "photoFileIds") return;
      intakeList.appendChild(e("li", "", k + ": " + String(intake[k])));
    });
    root.appendChild(e("h3", "", "Intake"));
    root.appendChild(intakeList);

    if (Array.isArray(intake.photoFileIds) && intake.photoFileIds.length) {
      const gallery = e("div", "list");
      intake.photoFileIds.forEach(function (fid) {
        const img = document.createElement("img");
        img.src = "/api/tenants/" + tenantId + "/files/" + encodeURIComponent(fid) + "/download";
        img.alt = "Intake photo";
        img.style.maxWidth = "200px";
        gallery.appendChild(img);
      });
      root.appendChild(gallery);
    }

    root.appendChild(e("h3", "", "Estimate lines"));
    const linesWrap = e("div", "list");
    root.appendChild(linesWrap);
    const rows = [];

    function addRow(line) {
      const row = e("div", "card");
      const desc = input(line ? line.description : "", "Description");
      const qty = input(line ? line.quantity : 1, "Qty"); qty.type = "number"; qty.step = "0.01";
      const unit = input(line ? (line.unit_cents / 100).toFixed(2) : "0.00", "Unit $");
      unit.type = "number"; unit.step = "0.01";
      const amount = input(line ? (line.amount_cents / 100).toFixed(2) : "0.00", "Amount $");
      amount.type = "number"; amount.step = "0.01";
      const del = e("button", "btn secondary", "Remove");
      del.addEventListener("click", function () {
        const i = rows.indexOf(entry);
        if (i >= 0) rows.splice(i, 1);
        row.remove();
      });
      [field("Description", desc), field("Qty", qty), field("Unit $", unit), field("Amount $", amount)]
        .forEach(function (n) { row.appendChild(n); });
      row.appendChild(del);
      linesWrap.appendChild(row);
      const entry = { desc: desc, qty: qty, unit: unit, amount: amount };
      rows.push(entry);
    }

    (data.lines || []).forEach(addRow);
    const addBtn = e("button", "btn secondary", "Add line");
    addBtn.addEventListener("click", function () { addRow(null); });
    root.appendChild(addBtn);

    const status = e("p", "muted", "");
    const saveLines = e("button", "btn", "Save lines");
    saveLines.addEventListener("click", async function () {
      const payload = rows.map(function (r) {
        return {
          kind: "service",
          description: r.desc.value,
          quantity: Number(r.qty.value) || 1,
          unit_cents: Math.round((Number(r.unit.value) || 0) * 100),
          amount_cents: Math.round((Number(r.amount.value) || 0) * 100),
        };
      });
      const res = await api("/api/tenants/" + tenantId + "/projects/" + projectId + "/lines", {
        method: "PUT",
        body: JSON.stringify({ lines: payload }),
      });
      status.textContent = "Saved. Total " + money(res.total_cents);
    });
    root.appendChild(saveLines);

    const send = e("button", "btn", "Send estimate to customer");
    send.addEventListener("click", async function () {
      try {
        await api("/api/tenants/" + tenantId + "/projects/" + projectId + "/send-estimate", { method: "POST" });
        status.textContent = "Estimate sent.";
      } catch (err) {
        status.textContent = err.message;
      }
    });
    root.appendChild(send);

    const advance = document.createElement("select");
    STATUSES.forEach(function (s) {
      const o = document.createElement("option");
      o.value = s; o.textContent = s.replace("_", " ");
      if (s === p.status) o.selected = true;
      advance.appendChild(o);
    });
    const saveStatus = e("button", "btn secondary", "Update status");
    saveStatus.addEventListener("click", async function () {
      try {
        await api("/api/tenants/" + tenantId + "/projects/" + projectId, {
          method: "PATCH",
          body: JSON.stringify({ status: advance.value }),
        });
        status.textContent = "Status updated.";
      } catch (err) {
        // The server rejects illegal transitions with 409; surface its words.
        status.textContent = err.message;
      }
    });
    root.appendChild(field("Status", advance));
    root.appendChild(saveStatus);
    root.appendChild(status);

    const back = e("button", "btn secondary", "Back to queue");
    back.addEventListener("click", function () { renderQueue(root); });
    root.appendChild(back);
  }

  const RATE_FIELDS = [
    ["edgeToEdgeCentsPer100SqIn", "Edge-to-edge (cents per 100 sq in)"],
    ["customCentsPer100SqIn", "Custom quilting (cents per 100 sq in)"],
    ["battingCentsPer100SqIn", "Batting (cents per 100 sq in)"],
    ["threadFlatCents", "Thread (flat, cents)"],
    ["bindingCentsPerLinearInch", "Binding (cents per linear inch)"],
    ["backingPrepFlatCents", "Backing preparation (flat, cents)"],
    ["customDesignFlatCents", "Custom design fee (flat, cents)"],
    ["tshirtPerBlockCents", "T-shirt quilt per block (cents)"],
    ["tshirtFinishingFlatCents", "T-shirt quilt finishing (flat, cents)"],
    ["rushPercent", "Rush surcharge (percent)"],
  ];

  async function renderRates(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Quilting rates & agreement"));
    root.appendChild(e("p", "muted",
      "Rates are in cents per 100 square inches so $0.025/sq in is entered as 250. " +
      "If a rate is missing, the public form shows no price at all rather than $0."));

    const site = await api("/api/tenants/" + tenantId);
    let settings = {};
    try { settings = JSON.parse(site.settings_json || "{}"); } catch (err) { settings = {}; }
    const longarm = settings.longarm || {};

    const inputs = {};
    RATE_FIELDS.forEach(function (pair) {
      const n = input(longarm[pair[0]] != null ? longarm[pair[0]] : "", "");
      n.type = "number"; n.min = "0";
      inputs[pair[0]] = n;
      root.appendChild(field(pair[1], n));
    });

    const prefix = input(longarm.referencePrefix || "", "e.g. SSQ");
    root.appendChild(field("Reference prefix", prefix));

    const minimums = {};
    [["longarm", "Longarm minimum (cents)"],
     ["custom_quilt", "Custom quilt minimum (cents)"],
     ["tshirt_quilt", "T-shirt quilt minimum (cents)"]].forEach(function (pair) {
      const n = input((longarm.minimumCents || {})[pair[0]] != null ? longarm.minimumCents[pair[0]] : "", "");
      n.type = "number"; n.min = "0";
      minimums[pair[0]] = n;
      root.appendChild(field(pair[1], n));
    });

    const agreementTitle = input(longarm.agreementTitle || "Service Agreement", "");
    root.appendChild(field("Agreement title", agreementTitle));
    const agreementBody = document.createElement("textarea");
    agreementBody.rows = 14;
    agreementBody.value = longarm.agreementBody || "";
    root.appendChild(field("Agreement text", agreementBody));
    root.appendChild(e("p", "muted",
      "A copy of this exact text is stored with every signature, so editing it here " +
      "never changes what a customer already agreed to."));

    const status = e("p", "muted", "");
    const save = e("button", "btn", "Save rates");
    save.addEventListener("click", async function () {
      const next = Object.assign({}, longarm, {
        referencePrefix: prefix.value.trim(),
        agreementTitle: agreementTitle.value,
        agreementBody: agreementBody.value,
        minimumCents: {},
      });
      RATE_FIELDS.forEach(function (pair) {
        const v = inputs[pair[0]].value;
        if (v !== "") next[pair[0]] = Math.round(Number(v));
      });
      Object.keys(minimums).forEach(function (k) {
        const v = minimums[k].value;
        if (v !== "") next.minimumCents[k] = Math.round(Number(v));
      });
      await api("/api/tenants/" + tenantId, {
        method: "PATCH",
        body: JSON.stringify({ settings: Object.assign({}, settings, { longarm: next }) }),
      });
      status.textContent = "Saved.";
    });
    root.appendChild(save);
    root.appendChild(status);
  }

  window.qhProjects = { renderQueue, renderRates };
})();
```

- [ ] **Step 5: Verify in the browser**

```bash
npm run dev
```

Open the admin as the business tenant. Confirm: Projects and Quilting rates appear in the sidebar only for the business tenant; the rate editor saves and reloads; an intake submitted from the public site appears in the queue; saving lines updates the total; "Update status" to an illegal target shows the server's `Illegal transition:` message rather than silently succeeding.

- [ ] **Step 6: Commit**

```bash
git add public/qh-projects.js public/admin.html package.json
git commit -m "feat(projects): admin queue, estimate builder, rate and agreement editor"
```

---

## Task 12: Gate coverage, E2E chain, and mutation proof

**Files:**
- Modify: `src/middleware/siteGate.test.ts`
- Modify: `scripts/verify-business-site.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: no runtime exports — this task's deliverable is evidence.

- [ ] **Step 1: Extend the gate matrix**

Add to `src/middleware/siteGate.test.ts`, following the existing rule-4 boundary cases:

```ts
describe("P1 public paths", () => {
  it("allows the intake POST on a launched business tenant's own slug", () => {
    expect(isLaunchedSitePathForTest("/public/stitchstudio/projects/intake", "stitchstudio")).toBe(true);
  });

  it("refuses the intake POST under ANOTHER tenant's slug", () => {
    expect(isLaunchedSitePathForTest("/public/othertenant/projects/intake", "stitchstudio")).toBe(false);
  });

  it("allows the quote page (rule 5 — 'quote' is not a reserved prefix)", () => {
    expect(isLaunchedSitePathForTest("/quote/" + "a".repeat(43), "stitchstudio")).toBe(true);
  });

  it("still refuses /admin and /portal on the same host", () => {
    expect(isLaunchedSitePathForTest("/admin", "stitchstudio")).toBe(false);
    expect(isLaunchedSitePathForTest("/portal", "stitchstudio")).toBe(false);
  });
});
```

If `isLaunchedSitePath` is not currently exported for tests, export it — do not duplicate its logic in the test file.

- [ ] **Step 2: Extend the E2E harness**

Add a section to `scripts/verify-business-site.mjs`, after the site-builder section, following its established shape (drive the real endpoint, then assert the rendered output changed):

```js
  console.log("\nP1 longarm chain (intake -> estimate -> sign):");
  {
    // Rates must exist or the ballpark suppresses — set them through the real
    // tenant PATCH path, not a direct SQL write.
    const withRates = await reqJson(HOST, `/api/tenants/${TENANT}`, {
      method: "PATCH",
      headers: ownerAuth,
      body: JSON.stringify({
        settings: {
          ...baseSettings,
          longarm: {
            referencePrefix: "SSQ",
            edgeToEdgeCentsPer100SqIn: 250,
            minimumCents: { longarm: 5000 },
            agreementTitle: "Service Agreement",
            agreementBody: "Quilting is performed at the customer's risk.",
          },
        },
      }),
    });
    check("rate table saved through the real admin path", withRates.status === 200, `got ${withRates.status}`);

    const intake = await reqJson(HOST, "/public/stitchstudio/projects/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_type: "longarm",
        customer_name: "Jane Quilter",
        customer_email: "jane@example.test",
        intake: { widthIn: 60, heightIn: 80, serviceLevel: "edge_to_edge" },
      }),
    });
    check("public intake accepted unauthenticated on the tenant host", intake.status === 200,
      `got ${intake.status} ${JSON.stringify(intake.json).slice(0, 200)}`);
    check("intake returned a reference using the configured prefix",
      /^SSQ-\d{4}$/.test(intake.json?.reference || ""), intake.json?.reference);
    check("ballpark computed 60x80 at 250 c/100sqin = 12000",
      intake.json?.ballpark?.suppressed === false && intake.json?.ballpark?.total_cents === 12000,
      JSON.stringify(intake.json?.ballpark));

    const reference = intake.json.reference;
    const row = d1Query(
      `SELECT id, status FROM projects WHERE tenant_id = '${TENANT}' AND reference = '${reference}'`
    );
    check("project row written at status submitted", row[0]?.status === "submitted", JSON.stringify(row[0]));
    const projectId = row[0]?.id;

    const sent = await reqJson(HOST, `/api/tenants/${TENANT}/projects/${projectId}/send-estimate`, {
      method: "POST", headers: ownerAuth,
    });
    check("send-estimate succeeds", sent.status === 200, `got ${sent.status}`);
    const afterSend = d1Query(
      `SELECT status, member_id FROM projects WHERE id = '${projectId}' AND tenant_id = '${TENANT}'`
    );
    check("status advanced to estimated", afterSend[0]?.status === "estimated", JSON.stringify(afterSend[0]));
    check("a customer record was created at send time, not at intake",
      !!afterSend[0]?.member_id, JSON.stringify(afterSend[0]));

    // The raw token is never stored, so the harness mints its own through the
    // real resend-link path and uses what that returns.
    const relink = await reqJson(HOST, `/api/tenants/${TENANT}/projects/${projectId}/resend-link`, {
      method: "POST", headers: ownerAuth,
    });
    check("resend-link returns a fresh raw token", !!relink.json?.token, JSON.stringify(relink.json).slice(0, 120));
    const token = relink.json.token;

    const quote = await req(HOST, `/quote/${token}`);
    check("quote page renders for a valid token", quote.status === 200, `got ${quote.status}`);
    check("quote page shows the agreed total", quote.body.includes("$120.00"), quote.body.slice(0, 1500));
    check("quote page sets Referrer-Policy: no-referrer (token is in the URL)",
      (quote.headers?.get?.("referrer-policy") || "") === "no-referrer",
      quote.headers?.get?.("referrer-policy"));

    const badToken = await req(HOST, `/quote/${"z".repeat(43)}`);
    check("an unknown token 404s", badToken.status === 404, `got ${badToken.status}`);
    check("the unknown-token page does not reveal whether the token existed",
      badToken.body.includes("no longer valid"), badToken.body.slice(0, 400));

    const signed = await reqJson(HOST, `/quote/${token}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signer_name: "Jane Quilter", consent: true }),
    });
    check("signing succeeds", signed.status === 200, `got ${signed.status}`);

    const sigRows = d1Query(
      `SELECT signer_name, agreement_sha256, agreement_text FROM agreement_signatures WHERE project_id = '${projectId}'`
    );
    check("exactly one signature row exists", sigRows.length === 1, `got ${sigRows.length}`);
    check("the snapshot captured the agreement body",
      (sigRows[0]?.agreement_text || "").includes("performed at the customer's risk"),
      sigRows[0]?.agreement_text);

    const again = await reqJson(HOST, `/quote/${token}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signer_name: "Someone Else", consent: true }),
    });
    check("signing twice is idempotent, not a second signature", again.status === 200 &&
      again.json?.already_signed === true, JSON.stringify(again.json));
    const sigRows2 = d1Query(`SELECT id FROM agreement_signatures WHERE project_id = '${projectId}'`);
    check("still exactly one signature row after the second POST", sigRows2.length === 1, `got ${sigRows2.length}`);

    const signedPage = await req(HOST, `/quote/${token}`);
    check("the page now renders the signed copy with its fingerprint",
      signedPage.body.includes(sigRows[0].agreement_sha256), signedPage.body.slice(0, 2000));
  }
```

Add the project tables to the harness's cleanup block:

```js
DELETE FROM agreement_signatures WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM project_lines WHERE project_id IN (SELECT id FROM projects WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}'));
DELETE FROM projects WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM project_counters WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
```

- [ ] **Step 3: Run everything**

```bash
npx tsc --noEmit
npx vitest run
npm run test:business-site
```

Expected: tsc exit 0; vitest green; "All checks passed" with roughly 20 more assertions than the 93 baseline.

- [ ] **Step 4: Mutation-check the new E2E assertions**

Run each of these, confirm the named check fails, then revert:

1. In `signQuote`, delete the `if (existing) return c.json({ ok: true, already_signed: true })` early return.
   Expected failure: "signing twice is idempotent" and "still exactly one signature row".
2. In `src/routes/site.ts`, remove the `"Referrer-Policy": "no-referrer"` header from the quote response.
   Expected failure: "quote page sets Referrer-Policy".
3. In `send-estimate`, move the member create/match to the intake handler instead.
   Expected failure: "a customer record was created at send time, not at intake".

A green suite that cannot fail is not evidence. Precedent: `81cee4e`.

- [ ] **Step 5: Run the five pre-existing server-driven scripts as a guild regression check**

Per the P0 plan's harness note, run these against an explicit port with `npx wrangler dev --port 8798 --local` up:

```bash
QH_BASE=http://127.0.0.1:8798 npm run test:scale
QH_BASE=http://127.0.0.1:8798 npm run test:integrations
QH_BASE=http://127.0.0.1:8798 npm run test:idempotency
QH_BASE=http://127.0.0.1:8798 npm run test:import
QH_BASE=http://127.0.0.1:8798 npm run test:delivery
```

Expected: all five exit 0. A `403 Missing origin header` means another project's `wrangler dev` holds the port — that string does not exist in this codebase.

- [ ] **Step 6: Commit and push**

```bash
git add src/middleware/siteGate.test.ts scripts/verify-business-site.mjs package.json
git commit -m "test(projects): gate coverage and full intake-to-signature E2E chain"
git push origin p0-business-tenant
```

---

## Definition of done

- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npx vitest run` green, including the ~42 new unit assertions across pricing, status, token, agreement, imageSniff, and the projects routes.
- [ ] `npm run test:business-site` green, with the P1 chain section passing.
- [ ] The five pre-existing `npm run test:*` scripts still pass (guild regression).
- [ ] A visitor can submit intake on the launched business tenant's public site and see a ballpark; an incomplete rate table shows **no price**, never `$0`.
- [ ] Linda can open the queue, edit lines, send an estimate, and advance status; an illegal transition is refused by the server with 409.
- [ ] A customer can open `/quote/<token>`, sign, and get a printable signed copy carrying the document fingerprint.
- [ ] Signing twice produces exactly one `agreement_signatures` row.
- [ ] An unknown token and an expired token are indistinguishable from outside.
- [ ] `/admin`, `/portal`, the platform apex, unlaunched tenants, and guild tenants are all still gated.
- [ ] Every new E2E assertion has been mutation-checked at least once.
- [ ] `package.json` version bumped; branch pushed.

## Deferred, named so nobody implements them early

Quilting-design galleries and the design picker (P1b). Class admin, calendar, registration (P2). Product images and storefront (P3). PayPal/Venmo, direct charges, deposits, and converting a signed project into an invoice (P4). Blog migration, videos, newsletter, 301 map (P5).

---

## Outcome and follow-ups (recorded 2026-08-12, after the whole-branch review)

All 12 tasks complete across 37 commits. Final state: `tsc --noEmit` clean, **394 vitest tests**,
**120 `test:business-site` assertions** (up from 93), all five pre-existing guild regression scripts
passing. Version `0.50.1-preview`.

### Gap in this plan — CLOSED 2026-08-12, after the merge

**A customer could not upload a photo.** The upload endpoint was complete and hardened (Task 8), the
admin gallery rendered `intake.photoFileIds` (Task 11), and both unit and E2E tests existed — but the
`project_intake` block collected no file input and nothing called the endpoint, so `photoFileIds`
could never be non-empty in production.

**Closed on `main` at `9c3382b`** (plus an a11y follow-up): the intake form now offers a file input for
every project type, validates against the server's exact bounds (5 files, 10MB each) before sending,
snapshots the `File[]` at submit, and uploads after intake returns the reference — the only moment the
project is at the `submitted` status the endpoint requires. Reviewed clean, with all four upload-failure
paths verified to keep telling the customer their request **was** received, since by then the shop
already has the job and a customer who thinks otherwise will re-submit and create a duplicate.

Historical note on how it was missed, kept because the lesson generalises:

The spec decided this explicitly (§8: *"Yes, with hard limits — a T-shirt quilt cannot be quoted
without seeing the shirts"*). **This plan lost it**: it assigned the endpoint to Task 8 and the viewer
to Task 11 and never assigned the upload UI to any task. Twelve briefs and eleven per-task reviews did
not catch it because each was scoped to one task; only the whole-branch review could see it.

With the upload UI shipped, **P1 now delivers client requirement 4 (custom/T-shirt quilts)** — subject
to the standing caveat that every rate figure is still a placeholder.

### Deviations from the spec worth knowing

- The quote page does **not** render through the P0 renderer as §2 specifies. It is a private shell
  carrying theme variables and `qh-site.css`, but no nav, logo, business name, or footer — so the page
  a paying customer lands on does not look like the rest of the shop's site.
- Intake photos are served to the admin via `/api/tenants/:id/files/:id/download`, not through
  `/img/:fileId` as §8 reasoned. The route used is auth-gated (arguably safer) but is one of the
  routes lacking the content-type allowlist noted below.
- Intake validation returns one shared message rather than per-field errors.
- The gate matrix grew for `/public/<slug>/projects/intake` and `/quote/<token>` but not for
  `/public/<slug>/projects/:ref/photos`, the other unauthenticated write. It does pass via rule 4.

### Pre-existing issues this work surfaced and deliberately did NOT fix

None is made materially worse by P1 — but P1 opens the first path by which anonymous internet content
enters the `files` table, so the first two shift from "staff-authored content is under-protected" to
"third-party content is under-protected". The magic-byte allowlist (Task 5) is what prevents that from
being an actual escalation.

1. **Sibling file routes lack `nosniff` and a content-type allowlist.** `portal.ts` (guild logo, member
   photo), `public.ts` (`:slug/photo/:photoId`), and `galleries.ts` all echo `files.content_type` with
   neither guard. Only `/img/:fileId` in `site.ts` is hardened. One header each.
2. **`GET /api/portal/:slug/files` lists every tenant file to any authenticated member**, not just
   staff. Latent today for business tenants (P0 hides `/portal`, customers have no login) — but it
   means one customer's quilt photos become readable by the whole membership the day portal access is
   enabled. **Must be closed before any business tenant gets portal access.**
3. **Authenticated callers get raw `public/` files on a launched tenant's host** for unmatched paths,
   because `serveBusinessSite` falls through to `c.notFound()` → `ASSETS.fetch()`, which ignores Host.
   Reproduced on a pre-existing control file. P1 correctly registered `/qh-projects.js` in
   `PLATFORM_EXACT_PATHS`, closing the unauthenticated case.
4. **`contact_form`'s hydration has no `.catch()`** — a network failure leaves its submit button
   permanently disabled with no message, the same defect fixed for `project_intake`.

### What this branch does not verify

- **`public/qh-site.js` and `public/qh-projects.js` have zero automated coverage** (~620 lines of the
  customer- and owner-facing surface). Every defect found in them was caught by reading, not testing.
  The inline signing script in `quote.ts` has never executed in a browser.
- **No browser session was run.** Task 11's runtime verification was curl against the API — real
  evidence for the API contract, none for the DOM.
- **Concurrency fixes were verified against local single-node D1**, which cannot reproduce production
  interleaving. Every race fix is pinned by a fake-D1 harness simulating one interleaving chosen by
  the test author — which is precisely how the sixth and seventh races survived until the final review.
- **Every rate figure is invented.** Design open questions 1 and 2 (Linda's real rate card, her existing
  agreement text) remain open. The arithmetic is correct; the numbers are placeholders.

### Recurring defect classes, for whoever plans P2

- **Check-then-act against D1**, which has no cross-statement transactions. Seven were found: the
  reference counter, the member upsert, `intake_json` linking, the signature INSERT, and the three
  status writes. Prefer atomic `ON CONFLICT ... RETURNING` or a guarded `WHERE ... AND col = ?` plus a
  `meta.changes` check — `src/lib/projects/statusWrite.ts` is the house pattern now.
- **Tests that assert nothing.** Four shipped and were caught: `expect(true).toBe(true)`, `a === a`, a
  header check passing on two `null`s, and a batch test that passed against the pre-batch code. Every
  new assertion in this plan was mutation-checked; keep doing that.
