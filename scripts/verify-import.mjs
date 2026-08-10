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

console.log("\n--- layer 3: real import ---");

// Promote the unmapped columns to custom fields, as the UI will. The fixture
// has 4 (Committee, Machine Type, Bee Group, and an entirely-empty Fax
// column) — Fax carries no *warning* (it has no data in any row) but
// dry.body.unmapped is unfiltered by data-presence (Task 3's committed
// behavior), so it is still offered for promotion like the rest.
const mapping = { ...dry.body.mapping };
for (const u of dry.body.unmapped) {
  const key = u.header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  mapping[String(u.index)] = { kind: "custom", key, label: u.header };
}
check("fixture has 4 unmapped columns", dry.body.unmapped.length === 4,
  JSON.stringify(dry.body.unmapped));

const run1 = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, mapping }),
});
check("import succeeds", run1.status === 200, JSON.stringify(run1.body).slice(0, 200));
check("created 5 members", run1.body.created === 5, `got ${run1.body.created}`);
check("reports custom fields created",
  (run1.body.custom_fields_created || []).length === 4,
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

console.log(failures ? `\n${failures} failure(s)` : "\nall layers passed");
if (failures) process.exit(1);
