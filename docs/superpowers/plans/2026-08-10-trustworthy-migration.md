# Trustworthy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin see every column in their CSV, choose where each one goes, import unmapped columns as custom fields, and get a reconciliation they can trust — before anything is written.

**Architecture:** A new pure module `src/lib/importMapping.ts` owns the column vocabulary and mapping logic with no database access, so it is directly testable. The existing import endpoint gains an optional header/raw-rows/mapping flow that proposes a mapping on dry run and applies it on import; the admin UI replaces its `confirm()` alert with a mapping table.

**Tech Stack:** TypeScript ESM, Hono 4, Cloudflare Workers + D1, Wrangler 4. Verification via `scripts/*.mjs` over HTTP plus esbuild-bundled direct calls, matching `scripts/verify-scale.mjs` and `scripts/e2e-auto-renew.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-10-trustworthy-migration-design.md`

## Global Constraints

- **Multi-tenancy:** every tenant-scoped query filters by `tenant_id`. No exceptions.
- **Data conventions:** timestamps ISO strings; booleans INTEGER 0/1; JSON columns TEXT with a `_json` suffix.
- **camelCase** for code identifiers.
- **No test runner exists.** Verification is `scripts/*.mjs`. Do not introduce Vitest/Jest.
- **`npx tsc --noEmit` must pass before every commit.**
- **Never use `sed -i`** on this machine (Windows/PowerShell) — use the editor or a Node one-liner.
- **No autonomous production deploys.** Commit and push to `main` freely; stop and ask before `npm run deploy`.
- **Backward compatibility is mandatory.** A request with `rows` and no `header` must behave exactly as it does today. The v1 API and any existing script depend on it.
- **Import is additive to custom-field definitions.** It may append to `tenants.settings_json.custom_fields`; it must never rename, reorder, or remove an existing definition.
- **Versioning:** bump `package.json` `version` AND `src/version.ts` `APP_VERSION` together. This plan lands `0.28.0-preview`.

### Preconditions

1. `.dev.vars` contains `GOOGLE_AUTH_REQUIRED=false`.
2. `npm run db:migrate:local` applied.
3. `npx wrangler dev` running on `:8787` in a separate terminal.
4. If `/api/auth/register` returns 429, clear the limiter:
   `npx wrangler kv key delete --binding KV --local "rl:register:unknown"`

---

## File Structure

**Create:**
- `src/lib/importMapping.ts` — column vocabulary, `proposeMapping`, `applyMapping`. Pure, no DB.
- `scripts/verify-import.mjs` — two-layer harness (esbuild direct calls + HTTP flow).
- `scripts/fixtures/wa-export-sample.csv` — realistic Wild Apricot export.

**Modify:**
- `src/routes/members.ts:447-710` — the import route: accept `header`/`raw_rows`/`mapping`, propose on dry run, apply on import, merge custom fields.
- `public/admin.html:1030-1100` — `importMembers()`: mapping table, reconciliation panel, error CSV.
- `package.json` — `scripts.test:import`, `version`.
- `src/version.ts` — `APP_VERSION`.
- `docs/api.md`, `docs/admin-guide.md` — document the mapping flow.

---

## Task 1: The mapping module

**Files:**
- Create: `src/lib/importMapping.ts`
- Create: `scripts/verify-import.mjs` (layer 1 only; layer 2 added in Task 3)
- Modify: `package.json` (add `test:import`)

**Interfaces:**
- Consumes: nothing — this is the base task.
- Produces: `KNOWN_TARGETS`, `KnownTarget`, `TARGET_SYNONYMS`, `MappingEntry`, `ImportMapping`, `normalizeHeader`, `slugifyKey`, `proposeMapping(header, existingCustomFields)`, `applyMapping(row, mapping)`. Tasks 2–4 import all of these.

- [ ] **Step 1: Write the failing test harness**

Create `scripts/verify-import.mjs`. This layer bundles the real module with esbuild and calls it directly — the same technique `scripts/verify-scale.mjs` uses so the test exercises shipped code rather than a reimplementation.

```js
/**
 * Import mapping + migration E2E.
 * Usage: node scripts/verify-import.mjs
 * Layer 1 (this file, top half) calls the real importMapping module directly.
 * Layer 2 (added in Task 3) drives the HTTP endpoint against wrangler dev.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts", ".verify-import-out");
mkdirSync(OUT, { recursive: true });

function bundle(entry, outfile) {
  const r = spawnSync(
    "npx",
    ["esbuild", entry, "--bundle", "--platform=node", "--format=esm",
     `--outfile=${outfile}`, "--packages=external"],
    { cwd: ROOT, encoding: "utf8", shell: true }
  );
  if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
  return outfile;
}

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) { console.log(`  ok  ${label}`); return; }
  failures++;
  console.error(`  FAIL ${label} ${detail}`);
}

const mod = await import(
  "file://" + bundle("src/lib/importMapping.ts", join(OUT, "importMapping.mjs"))
);
const { proposeMapping, applyMapping, normalizeHeader, slugifyKey } = mod;

console.log("--- layer 1: mapping vocabulary ---");

// Wild Apricot spells headers inconsistently; all of these must resolve.
{
  const header = ["E-Mail", "First name", "Last Name", "Phone Number"];
  const { mapping, unmapped } = proposeMapping(header, []);
  check("E-Mail -> email", mapping[0]?.target === "email");
  check("First name -> first_name", mapping[1]?.target === "first_name");
  check("Last Name -> last_name", mapping[2]?.target === "last_name");
  check("Phone Number -> phone", mapping[3]?.target === "phone");
  check("nothing unmapped", unmapped.length === 0, JSON.stringify(unmapped));
}

// An unknown column must be ignored AND reported, never silently dropped.
{
  const { mapping, unmapped } = proposeMapping(["Email", "Committee"], []);
  check("unknown -> ignore", mapping[1]?.kind === "ignore");
  check("unknown reported", unmapped.length === 1 && unmapped[0].index === 1,
        JSON.stringify(unmapped));
  check("unmapped carries header", unmapped[0]?.header === "Committee");
}

// An existing custom field should be recognised by key or by label.
{
  const existing = [{ key: "committee", label: "Committee" }];
  const { mapping, unmapped } = proposeMapping(["Email", "Committee"], existing);
  check("existing custom matched", mapping[1]?.kind === "custom");
  check("matched to existing key", mapping[1]?.key === "committee");
  check("matched custom is not unmapped", unmapped.length === 0);
}

// Two columns claiming one target: first wins, second becomes ignore.
{
  const { mapping, duplicates } = proposeMapping(["Email", "E-Mail Address"], []);
  check("first email wins", mapping[0]?.target === "email");
  check("second email ignored", mapping[1]?.kind === "ignore");
  check("duplicate reported", duplicates.length === 1 && duplicates[0].index === 1,
        JSON.stringify(duplicates));
}

// applyMapping splits a positional row into member fields + custom fields.
{
  const mapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "custom", key: "committee", label: "Committee" },
    2: { kind: "ignore" },
  };
  const { member, customFields } = applyMapping(
    ["ADA@example.com", "Raffle", "junk"], mapping
  );
  check("email extracted", member.email === "ADA@example.com");
  check("custom extracted", customFields.committee === "Raffle");
  check("ignored column absent", !("junk" in customFields) && Object.keys(customFields).length === 1);
}

// A short row must not throw or misalign.
{
  const mapping = { 0: { kind: "known", target: "email" },
                    1: { kind: "custom", key: "committee", label: "Committee" } };
  const { member, customFields } = applyMapping(["a@b.com"], mapping);
  check("short row: email still read", member.email === "a@b.com");
  check("short row: missing cell omitted", customFields.committee === undefined);
}

// Helpers used by the route.
check("normalizeHeader strips punctuation", normalizeHeader("E-Mail Address!") === "emailaddress");
check("slugifyKey produces a safe key", slugifyKey("T-Shirt Size") === "t_shirt_size");

console.log(failures ? `\n${failures} failure(s)` : "\nlayer 1 passed");
if (failures) process.exit(1);
```

Add to `package.json` `"scripts"`:

```json
"test:import": "node scripts/verify-import.mjs"
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:import`
Expected: FAIL — esbuild errors because `src/lib/importMapping.ts` does not exist.

- [ ] **Step 3: Write the module**

Create `src/lib/importMapping.ts`:

```ts
/**
 * CSV column mapping for member import.
 *
 * Pure functions, no database access, so the most data-destructive path in the
 * product is directly testable. Previously this logic lived in the browser and
 * silently discarded every column it did not recognise.
 */

/** Native member fields an imported column can target. */
export const KNOWN_TARGETS = [
  "email",
  "first_name",
  "last_name",
  "phone",
  "status",
  "notes",
  "level_name",
  "end_date",
  "joined_at",
] as const;

export type KnownTarget = (typeof KNOWN_TARGETS)[number];

/**
 * Header synonyms, compared after normalizeHeader().
 * Copied verbatim from the previous client-side mapping in admin.html so
 * migration behaviour does not change for files that already worked.
 */
export const TARGET_SYNONYMS: Record<KnownTarget, string[]> = {
  email: ["email", "emailaddress", "mail"],
  first_name: ["firstname", "first"],
  last_name: ["lastname", "last", "surname"],
  phone: ["phone", "phonenumber", "mobile", "cellphone"],
  status: ["status", "membershipstatus"],
  notes: ["notes", "note", "comments"],
  level_name: [
    "level", "levelname", "membershiplevel", "membershiptype", "membershiplabel",
  ],
  end_date: [
    "enddate", "expiry", "expiration", "expirationdate", "renewaldate",
    "membershipexpires",
  ],
  joined_at: ["joined", "joinedat", "joindate", "membersince"],
};

export type MappingEntry =
  | { kind: "known"; target: KnownTarget }
  | { kind: "custom"; key: string; label: string }
  | { kind: "ignore" };

/**
 * Keyed by COLUMN INDEX, not header text. CSV headers are not unique — an
 * export can contain two "Notes" columns — and keying by string would
 * silently collapse them, which is the same class of bug this module exists
 * to fix.
 */
export type ImportMapping = Record<number, MappingEntry>;

export function normalizeHeader(h: string): string {
  return (h || "").toLowerCase().replace(/[^a-z]/g, "");
}

/** Header -> a safe custom-field key: lowercase, underscores, no leading digit. */
export function slugifyKey(h: string): string {
  const base = (h || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "field";
  return /^[0-9]/.test(base) ? `f_${base}` : base;
}

export function proposeMapping(
  header: string[],
  existingCustomFields: Array<{ key: string; label: string }>
): {
  mapping: ImportMapping;
  unmapped: Array<{ index: number; header: string }>;
  duplicates: Array<{ index: number; header: string; target: KnownTarget }>;
} {
  const mapping: ImportMapping = {};
  const unmapped: Array<{ index: number; header: string }> = [];
  const duplicates: Array<{ index: number; header: string; target: KnownTarget }> = [];
  const claimed = new Set<KnownTarget>();
  const usedKeys = new Set<string>();

  header.forEach((raw, index) => {
    const norm = normalizeHeader(raw);

    // Pass 1: known target by synonym.
    const target = (KNOWN_TARGETS as readonly string[]).find((t) =>
      TARGET_SYNONYMS[t as KnownTarget].includes(norm)
    ) as KnownTarget | undefined;

    if (target) {
      if (claimed.has(target)) {
        // First column claiming a target wins; report rather than drop silently.
        mapping[index] = { kind: "ignore" };
        duplicates.push({ index, header: raw, target });
        return;
      }
      claimed.add(target);
      mapping[index] = { kind: "known", target };
      return;
    }

    // Pass 2: an existing custom field, by key or by label.
    const existing = existingCustomFields.find(
      (f) => normalizeHeader(f.key) === norm || normalizeHeader(f.label) === norm
    );
    if (existing) {
      mapping[index] = { kind: "custom", key: existing.key, label: existing.label };
      usedKeys.add(existing.key);
      return;
    }

    // Pass 3: unknown. Ignored by default, but always reported so the admin
    // can promote it to a custom field.
    mapping[index] = { kind: "ignore" };
    unmapped.push({ index, header: raw });
  });

  return { mapping, unmapped, duplicates };
}

/** Split one positional row into native member fields and custom-field values. */
export function applyMapping(
  row: string[],
  mapping: ImportMapping
): { member: Record<string, string>; customFields: Record<string, string> } {
  const member: Record<string, string> = {};
  const customFields: Record<string, string> = {};

  for (const [idxRaw, entry] of Object.entries(mapping)) {
    const idx = Number(idxRaw);
    const value = row[idx];
    // A short row simply has no value for this column — never throw, and never
    // shift the remaining columns.
    if (value === undefined) continue;
    if (entry.kind === "known") member[entry.target] = value;
    else if (entry.kind === "custom") customFields[entry.key] = value;
  }
  return { member, customFields };
}

/**
 * Ensure a proposed custom key does not collide with an existing definition
 * or another new one in the same import. Returns the key to actually use.
 */
export function uniqueCustomKey(
  desired: string,
  taken: Set<string>
): string {
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired}_${n}`)) n++;
  return `${desired}_${n}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:import`
Expected: `layer 1 passed`, exit 0.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/importMapping.ts scripts/verify-import.mjs package.json
git commit -m "feat(import): pure, testable column mapping module"
git push
```

---

## Task 2: The Wild Apricot fixture

A realistic export the rest of the plan tests against.

**Files:**
- Create: `scripts/fixtures/wa-export-sample.csv`

**Interfaces:**
- Consumes: nothing.
- Produces: a CSV whose columns are relied on by Tasks 3 and 4.

- [ ] **Step 1: Write the fixture**

Create `scripts/fixtures/wa-export-sample.csv`. Every row exists to trigger a
specific code path:

```csv
E-Mail,First name,Last Name,Phone Number,Membership status,Membership level,Renewal due,Member since,Notes,Committee,Machine Type,Bee Group,Fax
ada@example.test,Ada,Lovelace,512-555-0101,Active,Annual Membership,2027-01-15,2019-03-02,Founding member,Raffle,Bernina 770,Tuesday Bee,
grace@example.test,Grace,Hopper,512-555-0102,Active,Annual Membership,2027-02-20,2020-06-11,,Programs,Juki TL-2010Q,Tuesday Bee,
katherine@example.test,Katherine,Johnson,,Active,Annual Membership,not a date,2018-09-30,,Hospitality,Singer 4423,Thursday Bee,
mary@example.test,Mary,Jackson,512-555-0104,Bogus Status,Annual Membership,2027-04-01,2021-01-05,,,Handi Quilter,Thursday Bee,
dorothy@example.test,Dorothy,Vaughan,512-555-0105,Active,Nonexistent Level,2027-05-12,2017-11-19,,Raffle,Baby Lock,Tuesday Bee,
ada@example.test,Ada,Duplicate,512-555-0106,Active,Annual Membership,2027-06-01,2019-03-02,,,,,
,Missing,Email,512-555-0107,Active,Annual Membership,2027-07-04,2022-02-14,,,,,
```

What each column and row exercises:

| Element | Exercises |
|---|---|
| `E-Mail`, `First name`, `Last Name`, `Phone Number` | Synonym resolution across WA spellings |
| `Membership status`, `Membership level`, `Renewal due`, `Member since`, `Notes` | The remaining five known targets |
| `Committee`, `Machine Type`, `Bee Group` | Genuinely unmapped → custom fields |
| `Fax` | Present in the header but **empty in every row** → must produce NO warning |
| Row 3 (`katherine`) | `unparseable_date` on "not a date" |
| Row 4 (`mary`) | `invalid_status` on "Bogus Status" |
| Row 5 (`dorothy`) | `level_not_found` on "Nonexistent Level" |
| Row 6 | `duplicate email in file` |
| Row 7 | `missing or invalid email` |

> **This fixture is an assumption.** No real Wild Apricot export was available
> when it was written. It is effectively the specification of what we believe an
> export looks like — correct it the first time a real one is seen, and re-run
> `npm run test:import`.

**Note on "Member since":** it normalizes to `membersince`, which is already a
`joined_at` synonym, so it maps correctly and is *not* a custom field. The
design doc cited it as an example of a dropped column; that was wrong. The
genuinely unmapped columns are Committee, Machine Type, and Bee Group.

- [ ] **Step 2: Verify it parses**

Run:

```bash
node -e "const t=require('fs').readFileSync('scripts/fixtures/wa-export-sample.csv','utf8');const l=t.trim().split(/\r?\n/);console.log('rows:',l.length-1,'cols:',l[0].split(',').length)"
```
Expected: `rows: 7 cols: 13`

- [ ] **Step 3: Commit**

```bash
git add scripts/fixtures/wa-export-sample.csv
git commit -m "test(import): realistic Wild Apricot export fixture"
git push
```

---

## Task 3: Dry run proposes a mapping and reports warnings

**Files:**
- Modify: `src/routes/members.ts:447-520`
- Modify: `scripts/verify-import.mjs` (add layer 2)

**Interfaces:**
- Consumes: `proposeMapping`, `applyMapping`, `ImportMapping` from Task 1; the fixture from Task 2.
- Produces: the dry-run response envelope (`mapping`, `header`, `unmapped`, `warnings`, `skipped`, `sample`) that Task 4's UI renders.

- [ ] **Step 1: Add layer 2 to the harness**

Append to `scripts/verify-import.mjs`, before the final failure summary. Move
the summary block to the very end of the file.

```js
console.log("\n--- layer 2: dry run over HTTP ---");

import { readFileSync } from "node:fs";
const BASE = process.env.QH_BASE || "http://127.0.0.1:8787";

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

// Same stable-account trick as verify-integrations.mjs: registering per run
// exhausts the 10-per-10-minute limit and the harness stops working.
const HARNESS_EMAIL = "harness@example.test";
const HARNESS_PASSWORD = "harness-password-1";
let jwt;
{
  const login = await json("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: HARNESS_EMAIL, password: HARNESS_PASSWORD }),
  });
  if (login.status === 200) jwt = login.body.token;
  else {
    const reg = await json("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: HARNESS_EMAIL, password: HARNESS_PASSWORD, name: "Harness" }),
    });
    if (reg.status >= 400) {
      throw new Error(`auth failed (login ${login.status}, register ${reg.status}). ` +
        `Set GOOGLE_AUTH_REQUIRED=false in .dev.vars; if 429 the window is 10 minutes.`);
    }
    jwt = reg.body.token;
  }
}
const auth = { Authorization: `Bearer ${jwt}` };
const stamp = Math.random().toString(16).slice(2, 10);

const tenant = await json("/api/tenants", {
  method: "POST", headers: auth,
  body: JSON.stringify({ name: `Import ${stamp}`, slug: `import-${stamp}` }),
});
const tenantId = tenant.body.id;

// A level the fixture's "Annual Membership" rows can match.
await json(`/api/tenants/${tenantId}/levels`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                         duration_months: 12, renewal_type: "manual" }),
});

// Parse the fixture the same way the browser does.
function parseCsv(text) {
  const rows = []; let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i+1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

const csv = parseCsv(readFileSync(join(ROOT, "scripts/fixtures/wa-export-sample.csv"), "utf8"));
const header = csv[0];
const rawRows = csv.slice(1);

const membersBefore = await json(`/api/tenants/${tenantId}/members`, { headers: auth });

const dry = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, dry_run: true }),
});
check("dry run succeeds", dry.status === 200, JSON.stringify(dry.body).slice(0, 200));

const codes = (dry.body.warnings || []).map((w) => w.code);
const warnFor = (code) => (dry.body.warnings || []).find((w) => w.code === code);

check("proposes a mapping", !!dry.body.mapping);
check("E-Mail mapped to email", dry.body.mapping?.["0"]?.target === "email");
check("Committee reported unmapped",
  (dry.body.unmapped || []).some((u) => u.header === "Committee"));
check("unmapped_column warning present", codes.includes("unmapped_column"));

// The empty Fax column must NOT nag.
const unmappedWarnHeaders = (dry.body.warnings || [])
  .filter((w) => w.code === "unmapped_column").map((w) => w.header);
check("empty column produces no warning", !unmappedWarnHeaders.includes("Fax"),
  JSON.stringify(unmappedWarnHeaders));

check("unparseable_date warned", codes.includes("unparseable_date"));
check("invalid_status warned", codes.includes("invalid_status"));
check("level_not_found warned", codes.includes("level_not_found"));
check("warning carries a count", (warnFor("unmapped_column")?.count ?? 0) > 0);

check("duplicate email skipped", (dry.body.skipped || []).some((s) => /duplicate/i.test(s.reason)));
check("missing email skipped", (dry.body.skipped || []).some((s) => /email/i.test(s.reason)));
check("will_create counts the 5 valid rows", dry.body.will_create === 5,
  `got ${dry.body.will_create}`);

// The promise the whole preview rests on.
const membersAfter = await json(`/api/tenants/${tenantId}/members`, { headers: auth });
check("DRY RUN WROTE NOTHING",
  (membersAfter.body.total ?? 0) === (membersBefore.body.total ?? 0),
  `${membersBefore.body.total} -> ${membersAfter.body.total}`);

const settings = await json(`/api/tenants/${tenantId}`, { headers: auth });
let cf = [];
try { cf = JSON.parse(settings.body.settings_json || "{}").custom_fields || []; } catch {}
check("dry run created no custom fields", cf.length === 0, JSON.stringify(cf));
```

- [ ] **Step 2: Run it and confirm layer 2 fails**

Run: `npm run test:import`
Expected: layer 1 passes; layer 2 fails — the endpoint ignores `header`/`raw_rows`
and returns the old envelope with no `mapping` or `warnings`.

- [ ] **Step 3: Extend the route**

In `src/routes/members.ts`, replace the request destructuring at the top of
`memberRoutes.post("/import", …)`:

```ts
  const body = await c.req.json<{
    rows?: Array<Record<string, string>>;
    header?: string[];
    raw_rows?: string[][];
    mapping?: import("../lib/importMapping").ImportMapping;
    dry_run?: boolean;
  }>();

  const usingMapping = Array.isArray(body.raw_rows);
  if (usingMapping && Array.isArray(body.rows)) {
    return c.json(
      { error: "Send either rows or raw_rows, not both", code: "ambiguous_payload" },
      400
    );
  }
  if (usingMapping && !Array.isArray(body.header)) {
    return c.json(
      { error: "raw_rows requires header", code: "missing_header" },
      400
    );
  }
  if (!usingMapping && (!Array.isArray(body.rows) || !body.rows.length)) {
    return c.json({ error: "rows array is required" }, 400);
  }

  const rowCount = usingMapping ? body.raw_rows!.length : body.rows!.length;
  if (rowCount > 5000) {
    return c.json({ error: "Max 5000 rows per import — split larger files" }, 400);
  }
```

Then, immediately after that block, resolve the mapping and normalise every
row into the `Record<string,string>` shape the rest of the route already
consumes, so the existing loop needs no rewrite:

```ts
  // Existing custom-field definitions, used to recognise columns the guild
  // already models.
  let existingCustomFields: Array<{ key: string; label: string }> = [];
  try {
    const t = await first<{ settings_json: string | null }>(
      c.env.DB.prepare("SELECT settings_json FROM tenants WHERE id = ?").bind(tenant.id)
    );
    existingCustomFields = JSON.parse(t?.settings_json || "{}").custom_fields || [];
  } catch { /* no settings yet */ }

  const {
    proposeMapping, applyMapping, uniqueCustomKey,
  } = await import("../lib/importMapping");

  let mapping: import("../lib/importMapping").ImportMapping | null = null;
  let unmapped: Array<{ index: number; header: string }> = [];
  let duplicates: Array<{ index: number; header: string; target: string }> = [];
  const columnMismatchRows: number[] = [];

  // Rows in the legacy object shape; every downstream line already expects this.
  let normalizedRows: Array<Record<string, string>>;
  let customFieldsByRow: Array<Record<string, string>> = [];

  if (usingMapping) {
    const header = body.header!;
    if (body.mapping) {
      mapping = body.mapping;
    } else {
      const proposed = proposeMapping(header, existingCustomFields);
      mapping = proposed.mapping;
      unmapped = proposed.unmapped;
      duplicates = proposed.duplicates;
    }
    normalizedRows = [];
    body.raw_rows!.forEach((raw, i) => {
      if (raw.length !== header.length) {
        // A ragged row would misalign every field after the gap. Skip it
        // loudly rather than importing shifted data.
        columnMismatchRows.push(i + 1);
        normalizedRows.push({});
        customFieldsByRow.push({});
        return;
      }
      const { member, customFields } = applyMapping(raw, mapping!);
      normalizedRows.push(member);
      customFieldsByRow.push(customFields);
    });
  } else {
    normalizedRows = body.rows!;
    customFieldsByRow = normalizedRows.map(() => ({}));
  }
```

Replace every later use of `body.rows` in the route with `normalizedRows`.

- [ ] **Step 4: Build the warnings**

Add this helper above the route, and call it from the dry-run branch:

```ts
type ImportWarning = {
  code: string;
  message: string;
  count: number;
  sample_rows: number[];
  header?: string;
};

/** Aggregate per-row observations into one warning per code+column. */
function buildWarnings(args: {
  header: string[] | undefined;
  rawRows: string[][] | undefined;
  mapping: import("../lib/importMapping").ImportMapping | null;
  unmapped: Array<{ index: number; header: string }>;
  duplicates: Array<{ index: number; header: string; target: string }>;
  normalizedRows: Array<Record<string, string>>;
  levelByName: Map<string, unknown>;
  memberStatuses: string[];
  columnMismatchRows: number[];
  planWillHold: number;
}): ImportWarning[] {
  const out: ImportWarning[] = [];

  // Only warn about an ignored column when it actually carries data —
  // an all-empty column in the export is noise, not a loss.
  for (const u of args.unmapped) {
    const rowsWithData: number[] = [];
    (args.rawRows || []).forEach((r, i) => {
      if ((r[u.index] || "").trim() !== "") rowsWithData.push(i + 1);
    });
    if (!rowsWithData.length) continue;
    out.push({
      code: "unmapped_column",
      header: u.header,
      message: `"${u.header}" will not be imported`,
      count: rowsWithData.length,
      sample_rows: rowsWithData.slice(0, 3),
    });
  }

  for (const d of args.duplicates) {
    out.push({
      code: "duplicate_target",
      header: d.header,
      message: `"${d.header}" also matches ${d.target}; the first column wins and this one is ignored`,
      count: 1,
      sample_rows: [],
    });
  }

  const badDates: number[] = [];
  const badStatus: number[] = [];
  const badLevel: number[] = [];
  args.normalizedRows.forEach((row, i) => {
    const endRaw = row.end_date || row.expiry || row.renewal_date || row.expiration || "";
    if (endRaw && Number.isNaN(new Date(endRaw).getTime())) badDates.push(i + 1);
    const st = (row.status || "").toLowerCase();
    if (st && !args.memberStatuses.includes(st)) badStatus.push(i + 1);
    const lv = (row.level_name || row.level || "").trim();
    if (lv && !args.levelByName.has(lv.toLowerCase())) badLevel.push(i + 1);
  });

  if (badDates.length)
    out.push({ code: "unparseable_date",
      message: "Some renewal/expiry dates could not be read and will be left blank",
      count: badDates.length, sample_rows: badDates.slice(0, 3) });
  if (badStatus.length)
    out.push({ code: "invalid_status",
      message: `Some statuses are not one of: ${args.memberStatuses.join(", ")}. Those rows import as active.`,
      count: badStatus.length, sample_rows: badStatus.slice(0, 3) });
  if (badLevel.length)
    out.push({ code: "level_not_found",
      message: "Some membership levels do not exist in this guild; those members import without a membership",
      count: badLevel.length, sample_rows: badLevel.slice(0, 3) });
  if (args.columnMismatchRows.length)
    out.push({ code: "column_count_mismatch",
      message: "Some rows have a different number of columns than the header and will be skipped",
      count: args.columnMismatchRows.length,
      sample_rows: args.columnMismatchRows.slice(0, 3) });
  if (args.planWillHold > 0)
    out.push({ code: "plan_limit_will_hold",
      message: `Free plan allows ${30} active members; ${args.planWillHold} row(s) will import as pending until you upgrade`,
      count: args.planWillHold, sample_rows: [] });

  return out;
}
```

- [ ] **Step 5: Return the new envelope from the dry run**

The dry-run branch currently returns early, **before** levels are loaded, so it
cannot compute `level_not_found` or `plan_limit_will_hold`. Move the `levels` /
`levelByName` / `activeSlotsLeft` block to **above** the `if (body.dry_run)`
branch, then return:

```ts
  if (body.dry_run) {
    const seenEmails = new Set<string>();
    let willCreate = 0, willUpdate = 0;
    const skipped: Array<{ row: number; reason: string }> = [];
    const sample: Array<Record<string, string>> = [];

    normalizedRows.forEach((r, idx) => {
      if (columnMismatchRows.includes(idx + 1)) {
        skipped.push({ row: idx + 1, reason: "column count does not match header" });
        return;
      }
      const email = (r.email || "").toLowerCase().trim();
      if (!email || !email.includes("@")) {
        skipped.push({ row: idx + 1, reason: "missing or invalid email" });
        return;
      }
      if (seenEmails.has(email)) {
        skipped.push({ row: idx + 1, reason: "duplicate email in file" });
        return;
      }
      seenEmails.add(email);
      byEmail.has(email) ? willUpdate++ : willCreate++;
      if (sample.length < 5) {
        sample.push({
          email,
          name: [r.first_name, r.last_name].filter(Boolean).join(" "),
          action: byEmail.has(email) ? "update" : "create",
          custom: JSON.stringify(customFieldsByRow[idx] || {}),
        });
      }
    });

    // How many rows the free plan will hold below active.
    let planWillHold = 0;
    if (activeSlotsLeft != null) {
      const wantActive = normalizedRows.filter(
        (r) => ((r.status || "active").toLowerCase() === "active")
      ).length;
      planWillHold = Math.max(0, wantActive - activeSlotsLeft);
    }

    return c.json({
      dry_run: true,
      total_rows: normalizedRows.length,
      will_create: willCreate,
      will_update: willUpdate,
      will_skip: skipped.length,
      header: body.header ?? null,
      mapping,
      unmapped,
      warnings: buildWarnings({
        header: body.header, rawRows: body.raw_rows, mapping, unmapped, duplicates,
        normalizedRows, levelByName, memberStatuses: MEMBER_STATUSES,
        columnMismatchRows, planWillHold,
      }),
      // Full list, not capped: the error CSV in the UI depends on it.
      skipped,
      sample,
    });
  }
```

- [ ] **Step 6: Run the harness**

Run: `npm run test:import`
Expected: layer 1 and layer 2 both pass, including `DRY RUN WROTE NOTHING`.

- [ ] **Step 7: Confirm backward compatibility**

The legacy path must be untouched:

```bash
npm run test:integrations
```
Expected: exit 0. (It does not import members, but it exercises the same route
module and must not regress.)

Then check the old shape directly, using the tenant id and JWT printed by the
harness, or any tenant you own:

```bash
curl -s -X POST "http://127.0.0.1:8787/api/tenants/$TENANT_ID/members/import" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"rows":[{"email":"legacy@example.test","first_name":"Legacy"}],"dry_run":true}'
```
Expected: `will_create: 1`, and `mapping` is `null` — the legacy path proposes nothing.

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/routes/members.ts scripts/verify-import.mjs
git commit -m "feat(import): dry run proposes a column mapping and reports warnings"
git push
```

---

## Task 4: Real import applies the mapping and writes custom fields

**Files:**
- Modify: `src/routes/members.ts` (import loop + custom-field creation)
- Modify: `scripts/verify-import.mjs`

**Interfaces:**
- Consumes: `mapping`, `customFieldsByRow`, `uniqueCustomKey` from Tasks 1 and 3.
- Produces: `custom_fields_created` in the import response; values in `members.custom_fields_json`; definitions in `tenants.settings_json.custom_fields`.

- [ ] **Step 1: Add the failing assertions**

Append to `scripts/verify-import.mjs`:

```js
console.log("\n--- layer 3: real import ---");

// Promote the three unmapped columns to custom fields, as the UI will.
const mapping = { ...dry.body.mapping };
for (const u of dry.body.unmapped) {
  const key = u.header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  mapping[String(u.index)] = { kind: "custom", key, label: u.header };
}

const run1 = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, mapping }),
});
check("import succeeds", run1.status === 200, JSON.stringify(run1.body).slice(0, 200));
check("created 5 members", run1.body.created === 5, `got ${run1.body.created}`);
check("reports custom fields created",
  (run1.body.custom_fields_created || []).length === 3,
  JSON.stringify(run1.body.custom_fields_created));

const settings2 = await json(`/api/tenants/${tenantId}`, { headers: auth });
const cf2 = JSON.parse(settings2.body.settings_json || "{}").custom_fields || [];
check("definitions persisted", cf2.some((f) => f.key === "committee"), JSON.stringify(cf2));

const list = await json(`/api/tenants/${tenantId}/members?limit=100`, { headers: auth });
const ada = list.body.members.find((m) => m.email === "ada@example.test");
const adaFull = await json(`/api/tenants/${tenantId}/members/${ada.id}`, { headers: auth });
const adaCustom = JSON.parse(adaFull.body.custom_fields_json || "{}");
check("custom value stored", adaCustom.committee === "Raffle", JSON.stringify(adaCustom));
check("second custom value stored", adaCustom.machine_type === "Bernina 770");

// Re-running the same file must converge, not duplicate.
const run2 = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, mapping }),
});
check("re-run creates nothing", run2.body.created === 0, `got ${run2.body.created}`);
check("re-run updates the same 5", run2.body.updated === 5, `got ${run2.body.updated}`);
const list2 = await json(`/api/tenants/${tenantId}/members?limit=100`, { headers: auth });
check("no duplicate members", list2.body.total === list.body.total,
  `${list.body.total} -> ${list2.body.total}`);

// A hand-entered value must survive a re-import that omits its column.
await json(`/api/tenants/${tenantId}/members/${ada.id}`, {
  method: "PATCH", headers: auth,
  body: JSON.stringify({ custom_fields: { hand_entered: "keep me" } }),
});
const narrow = { ...mapping };
for (const [k, v] of Object.entries(narrow)) {
  if (v.kind === "custom" && v.key !== "committee") narrow[k] = { kind: "ignore" };
}
await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, mapping: narrow }),
});
const adaAfter = await json(`/api/tenants/${tenantId}/members/${ada.id}`, { headers: auth });
const adaCustom2 = JSON.parse(adaAfter.body.custom_fields_json || "{}");
check("hand-entered custom field survives re-import", adaCustom2.hand_entered === "keep me",
  JSON.stringify(adaCustom2));
check("existing definitions not removed",
  JSON.parse((await json(`/api/tenants/${tenantId}`, { headers: auth })).body.settings_json || "{}")
    .custom_fields.length >= 3);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:import`
Expected: layer 3 fails — `custom_fields_created` is absent and
`custom_fields_json` is empty.

- [ ] **Step 3: Create custom-field definitions before the loop**

In the real-import path of `src/routes/members.ts`, after `mapping` is resolved
and before the row loop:

```ts
  // Additive only: append definitions for custom targets the guild does not
  // already have. Never rename, reorder, or remove — an import must not be
  // able to corrupt an existing schema.
  const customFieldsCreated: Array<{ key: string; label: string }> = [];
  if (usingMapping && mapping) {
    const takenKeys = new Set(existingCustomFields.map((f) => f.key));
    const next = [...existingCustomFields];
    for (const entry of Object.values(mapping)) {
      if (entry.kind !== "custom") continue;
      if (takenKeys.has(entry.key)) continue;
      const key = uniqueCustomKey(entry.key, takenKeys);
      takenKeys.add(key);
      const def = { key, label: entry.label };
      next.push(def);
      customFieldsCreated.push(def);
    }
    if (customFieldsCreated.length) {
      const t = await first<{ settings_json: string | null }>(
        c.env.DB.prepare("SELECT settings_json FROM tenants WHERE id = ?").bind(tenant.id)
      );
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(t?.settings_json || "{}"); } catch {}
      settings.custom_fields = next;
      await c.env.DB.prepare(
        "UPDATE tenants SET settings_json = ?, updated_at = ? WHERE id = ?"
      ).bind(JSON.stringify(settings), new Date().toISOString(), tenant.id).run();
    }
  }
```

- [ ] **Step 4: Merge custom values into the existing statements**

Inside the row loop, replace the `UPDATE members SET …` statement so it also
writes `custom_fields_json`. Read the current value first so hand-entered keys
survive — mirroring `src/routes/members.ts:384-388`:

```ts
    const rowCustom = customFieldsByRow[rowIndex] || {};
    const hasCustom = Object.keys(rowCustom).length > 0;
```

For the **update** branch:

```ts
      let mergedCustomJson: string | null = null;
      if (hasCustom) {
        const cur = await first<{ custom_fields_json: string | null }>(
          c.env.DB.prepare("SELECT custom_fields_json FROM members WHERE id = ?").bind(memberId)
        );
        let existingVals: Record<string, string> = {};
        try { existingVals = JSON.parse(cur?.custom_fields_json || "{}"); } catch {}
        // Incoming values win; anything the guild typed by hand is preserved.
        mergedCustomJson = JSON.stringify({ ...existingVals, ...rowCustom });
      }
      stmts.push(
        c.env.DB.prepare(
          `UPDATE members SET
             first_name = coalesce(?, first_name), last_name = coalesce(?, last_name),
             phone = coalesce(?, phone), notes = coalesce(?, notes),
             status = coalesce(?, status),
             custom_fields_json = coalesce(?, custom_fields_json),
             updated_at = ?
           WHERE id = ?`
        ).bind(
          row.first_name || null, row.last_name || null,
          row.phone || null, row.notes || null,
          level ? null : importStatus,
          mergedCustomJson,
          now, memberId
        )
      );
```

For the **insert** branch, add the column and value:

```ts
        c.env.DB.prepare(
          `INSERT INTO members (id, tenant_id, email, first_name, last_name, phone, notes, status, custom_fields_json, joined_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          memberId, tenant.id, email,
          row.first_name || null, row.last_name || null,
          row.phone || null, row.notes || null,
          importStatus,
          hasCustom ? JSON.stringify(rowCustom) : "{}",
          row.joined_at || now, now, now
        )
```

The loop is currently `for (const row of body.rows)`. Change it to
`normalizedRows.forEach`-style indexing so `rowIndex` is available:

```ts
  for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex++) {
    const row = normalizedRows[rowIndex];
    if (columnMismatchRows.includes(rowIndex + 1)) { skipped++; continue; }
```

- [ ] **Step 5: Return the new fields**

Extend the final response with `custom_fields_created` and the full skipped
list. Locate the existing `return c.json({ created, updated, skipped, … })` and
add:

```ts
    custom_fields_created: customFieldsCreated,
```

- [ ] **Step 6: Run the harness**

Run: `npm run test:import`
Expected: all three layers pass, including re-run convergence and hand-entered
field survival.

- [ ] **Step 7: Typecheck, regression, commit**

```bash
npx tsc --noEmit
npm run test:integrations
node scripts/e2e-auto-renew.mjs
git add src/routes/members.ts scripts/verify-import.mjs
git commit -m "feat(import): apply mapping, create custom fields, merge values"
git push
```

---

## Task 5: The mapping UI

**Files:**
- Modify: `public/admin.html:1030-1100`

**Interfaces:**
- Consumes: the dry-run envelope from Task 3 and the import response from Task 4.
- Produces: no code interface — this is the last consumer.

- [ ] **Step 1: Replace `importMembers()`**

The current function parses the CSV, maps nine columns, posts a dry run, and
shows a `confirm()`. Replace it so it posts the raw rows and renders a screen.
`parseCsv` at `public/admin.html:1009` already returns `string[][]`, which is
exactly `raw_rows` — no new parsing is needed.

```js
    let _importState = null; // { header, rawRows, mapping, preview }

    async function importMembers(input) {
      const out = document.getElementById("import-result");
      const file = input.files && input.files[0];
      if (!file) return;
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length < 2) { out.textContent = "No data rows found."; return; }
      _importState = { header: rows[0], rawRows: rows.slice(1), mapping: null };
      out.textContent = `Checking ${_importState.rawRows.length} rows…`;
      await refreshImportPreview();
      input.value = "";
    }

    async function refreshImportPreview() {
      const s = _importState;
      const body = { header: s.header, raw_rows: s.rawRows, dry_run: true };
      if (s.mapping) body.mapping = s.mapping;
      try {
        s.preview = await api(`/api/tenants/${tenantId}/members/import`, {
          method: "POST", body: JSON.stringify(body),
        });
        s.mapping = s.preview.mapping;
        renderImportPreview();
      } catch (e) {
        document.getElementById("import-result").textContent = e.message;
      }
    }
```

- [ ] **Step 2: Render the mapping table**

```js
    function renderImportPreview() {
      const s = _importState, p = s.preview;
      const targets = ["email","first_name","last_name","phone","status","notes","level_name","end_date","joined_at"];
      const sampleFor = (i) => {
        const r = s.rawRows.find((row) => (row[i] || "").trim() !== "");
        return r ? r[i] : "";
      };
      const optionsFor = (i) => {
        const e = s.mapping[i] || { kind: "ignore" };
        const opts = [`<option value="ignore"${e.kind==="ignore"?" selected":""}>— Do not import —</option>`];
        for (const t of targets) {
          const sel = e.kind === "known" && e.target === t ? " selected" : "";
          opts.push(`<option value="known:${t}"${sel}>${t.replace(/_/g," ")}</option>`);
        }
        const sel = e.kind === "custom" ? " selected" : "";
        opts.push(`<option value="custom"${sel}>Import as custom field</option>`);
        return opts.join("");
      };
      const warnRow = (w) =>
        `<li><strong>${esc(w.message)}</strong> — ${w.count} row(s)${
          w.sample_rows.length ? ` (e.g. row ${w.sample_rows.join(", ")})` : ""}</li>`;

      document.getElementById("import-result").innerHTML = `
        <div class="card" style="margin-top:1rem">
          <h3>Check the columns</h3>
          <p class="muted" style="font-size:0.9rem">Nothing is saved until you press Import.</p>
          <table><thead><tr><th>Column in your file</th><th>Example</th><th>Import as</th></tr></thead>
          <tbody>${s.header.map((h, i) => `
            <tr>
              <td><code>${esc(h)}</code></td>
              <td class="muted" style="font-size:0.85rem">${esc(sampleFor(i)).slice(0,40)}</td>
              <td><select onchange="setImportTarget(${i}, this.value)">${optionsFor(i)}</select></td>
            </tr>`).join("")}</tbody></table>
        </div>
        <div class="card">
          <h3>What will happen</h3>
          <ul style="line-height:1.8">
            <li><strong>${p.will_create}</strong> new members</li>
            <li><strong>${p.will_update}</strong> existing members updated</li>
            <li><strong>${p.will_skip}</strong> rows skipped</li>
          </ul>
          ${p.warnings.length ? `<h4>Worth checking</h4><ul style="line-height:1.7">${p.warnings.map(warnRow).join("")}</ul>` : ""}
          <button onclick="runImport()">Import ${p.will_create + p.will_update} members</button>
          <button class="secondary" onclick="cancelImport()">Cancel</button>
        </div>`;
    }

    function setImportTarget(index, value) {
      const s = _importState;
      if (value === "ignore") s.mapping[index] = { kind: "ignore" };
      else if (value === "custom") {
        const header = s.header[index];
        const key = header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        s.mapping[index] = { kind: "custom", key, label: header };
      } else {
        s.mapping[index] = { kind: "known", target: value.slice("known:".length) };
      }
      refreshImportPreview(); // counts and warnings must stay truthful
    }

    function cancelImport() {
      _importState = null;
      document.getElementById("import-result").textContent = "Import cancelled — nothing was changed.";
    }
```

- [ ] **Step 3: Run the import and offer the error CSV**

```js
    async function runImport() {
      const s = _importState;
      const out = document.getElementById("import-result");
      out.textContent = `Importing ${s.rawRows.length} rows…`;
      try {
        const r = await api(`/api/tenants/${tenantId}/members/import`, {
          method: "POST",
          body: JSON.stringify({ header: s.header, raw_rows: s.rawRows, mapping: s.mapping }),
        });
        const cf = (r.custom_fields_created || []).length
          ? `, ${r.custom_fields_created.length} custom field(s) created` : "";
        const mem = r.memberships_assigned ? `, ${r.memberships_assigned} memberships assigned` : "";
        const lim = r.plan_limited ? `, ${r.plan_limited} held at free-plan limit` : "";
        out.innerHTML = `<p class="notice ok">Imported: ${r.created} new, ${r.updated} updated, ${r.skipped} skipped${mem}${cf}${lim}.</p>`;
        if ((r.skipped_rows || []).length) {
          // Let the guild fix and re-import just the failures rather than
          // re-running the whole file and guessing what went wrong.
          out.innerHTML += `<button class="secondary" onclick="downloadImportErrors()">Download ${r.skipped_rows.length} skipped rows</button>`;
          _importState.skippedRows = r.skipped_rows;
        } else {
          _importState = null;
        }
        setTimeout(() => navigate("members"), 2500);
      } catch (e) { out.textContent = e.message; }
    }

    function downloadImportErrors() {
      const s = _importState;
      const cell = (v) => { const t = v == null ? "" : String(v);
        return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const lines = [["row", "reason", ...s.header].map(cell).join(",")];
      for (const sk of s.skippedRows) {
        lines.push([sk.row, sk.reason, ...(s.rawRows[sk.row - 1] || [])].map(cell).join(","));
      }
      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "import-errors.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    }
```

- [ ] **Step 4: Return the skipped rows from the real import**

The error CSV needs them. In `src/routes/members.ts`, collect skip reasons in
the real-import loop into `skippedRows: Array<{row:number; reason:string}>` and
add `skipped_rows: skippedRows` to the response. The counter `skipped++` stays
for backward compatibility.

- [ ] **Step 5: Verify by hand**

With `wrangler dev` running, sign in to `/admin`, pick a guild, go to Members →
Import CSV, choose `scripts/fixtures/wa-export-sample.csv`, and confirm:

1. All 13 columns are listed, with `Fax` defaulting to "Do not import".
2. `Committee`, `Machine Type`, `Bee Group` default to "Do not import" and are
   named in the warnings.
3. Switching `Committee` to "Import as custom field" updates the warnings
   without a reload.
4. The counts read 5 create / 0 update / 2 skipped.
5. Import succeeds and the skipped-rows download contains rows 6 and 7.
6. Settings → custom fields now lists Committee.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit
git add public/admin.html src/routes/members.ts
git commit -m "feat(import): column mapping screen with reconciliation and error CSV"
git push
```

---

## Task 6: Documentation and version

**Files:**
- Modify: `docs/api.md`, `docs/admin-guide.md`, `package.json`, `src/version.ts`

- [ ] **Step 1: Document the endpoint**

Add to `docs/api.md` under the members section: the `header` / `raw_rows` /
`mapping` fields, the rule that exactly one of `rows` or `raw_rows` is present,
the full warning-code table from Task 3 Step 4, and `custom_fields_created` /
`skipped_rows` in the response. State plainly that the legacy `rows` shape is
unchanged and still supported.

- [ ] **Step 2: Document the admin flow**

Add a "Importing your members" section to `docs/admin-guide.md`: choose the
file, check the column table, promote any column to a custom field, read the
warnings, import, and download the skipped rows if any. Note that nothing is
written until Import is pressed, and that re-importing a corrected file updates
rather than duplicates.

- [ ] **Step 3: Bump the version**

Edit `package.json` and `src/version.ts` **with the editor, not `sed`**, both to
`0.28.0-preview`.

- [ ] **Step 4: Full verification**

```bash
npx tsc --noEmit
npm run test:import
npm run test:integrations
node scripts/e2e-auto-renew.mjs
```
All four must exit 0.

- [ ] **Step 5: Commit, then stop**

```bash
git add docs/ package.json src/version.ts
git commit -m "docs: CSV column mapping flow; v0.28.0-preview"
git push
```

**Do not deploy.** Ask for approval first.

---

## Self-Review

**Spec coverage.** Column mapping UI → Task 5. Custom-field creation → Task 4.
Reconciliation with warnings → Task 3. Error CSV → Task 5. Re-run safety →
Task 4 Step 1. Dry run writes nothing → Task 3 Step 1. Additive-only
definitions → Task 4 Steps 1 and 3. Pure-function testing → Task 1. HTTP
testing → Tasks 3 and 4. Fixture → Task 2. Backward compatibility → Task 3
Steps 3 and 7. The spec's `column_count_mismatch` rule → Task 3 Steps 3 and 4.

**Corrections to the spec made here.** The spec cites "Member Since" as an
example dropped column; it normalizes to `membersince`, an existing `joined_at`
synonym, so it maps correctly. Task 2 uses genuinely unmapped columns and says
so. The spec also did not mention that the dry-run branch returns *before*
levels are loaded — Task 3 Step 5 moves that block, without which
`level_not_found` and `plan_limit_will_hold` cannot be computed.

**Type consistency.** `ImportMapping` is index-keyed in Task 1 and used that
way in Tasks 3, 4, and 5 (the UI keys `s.mapping[i]` by integer). `MappingEntry`
discriminates on `kind` everywhere. `proposeMapping` returns
`{mapping, unmapped, duplicates}` in Task 1 and all three are consumed in
Task 3. `uniqueCustomKey(desired, taken)` is defined in Task 1 and called in
Task 4 Step 3.

**Soft spots a reviewer should press on:**
- **Task 4 Step 4 is the riskiest step.** It rewrites the row loop's control
  flow (`for…of` → indexed) and both SQL statements. A mistake misaligns
  `customFieldsByRow` against rows. The re-run and hand-entered-field
  assertions in Step 1 are what catch it.
- The update branch adds a `SELECT` per row with custom fields, which on a
  5,000-row import is 5,000 extra D1 reads. Acceptable for a migration that
  runs once, but if it proves slow, batch the reads the way `byEmail` already
  batches at 200 per query.
- `plan_limit_will_hold` is an estimate: it counts rows wanting `active` against
  remaining slots, but the real loop also considers whether an existing member
  was already active. The preview may over-report by a few on a re-import. Worth
  stating in the UI copy rather than pretending it is exact.
- The harness reuses one tenant across layers 2–4, so layer 4's re-import
  assertions depend on layer 3 having run. If a reviewer wants layers to be
  independently runnable, each needs its own tenant.
