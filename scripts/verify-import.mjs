/**
 * Import mapping + migration E2E.
 * Usage: node scripts/verify-import.mjs
 * Layer 1 (this file, top half) calls the real importMapping module directly.
 * Layer 2 (added in Task 3) drives the HTTP endpoint against wrangler dev.
 */
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";

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

// D1 helpers, via a temp .sql file + --file= rather than an inline
// --command string: an inline string with spaces did not survive
// spawnSync's args-array + shell:true quoting reliably on this Windows
// environment. Same pattern as scripts/verify-idempotency.mjs.
function d1Exec(sql) {
  const sqlPath = join(tmpdir(), `qh-import-exec-${randomUUID()}.sql`);
  writeFileSync(sqlPath, sql, "utf8");
  try {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "quilthosting-db", "--local", `--file=${sqlPath}`],
      { stdio: "pipe", shell: true }
    );
  } finally {
    unlinkSync(sqlPath);
  }
}

function d1Query(sql) {
  const sqlPath = join(tmpdir(), `qh-import-query-${randomUUID()}.sql`);
  writeFileSync(sqlPath, sql, "utf8");
  try {
    const out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "quilthosting-db", "--local", `--file=${sqlPath}`, "--json"],
      { stdio: "pipe", shell: true }
    ).toString("utf8");
    const parsed = JSON.parse(out);
    return parsed[0]?.results ?? [];
  } finally {
    unlinkSync(sqlPath);
  }
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

// Row 2 is a ragged row (fewer cells than the header) — it must be reported
// as a column-count mismatch and skipped, not misread or left to shift the
// rows after it.
check("ragged row reported as column mismatch",
  (dry.body.skipped || []).some((s) => s.row === 2 && /column count/i.test(s.reason)),
  JSON.stringify(dry.body.skipped));
check("column_count_mismatch warning present", codes.includes("column_count_mismatch"));

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

// Task 5 fix round 1: setImportTarget re-POSTs the WHOLE mapping on every
// column edit. When body.mapping is supplied, the route must re-derive
// unmapped/duplicates from it rather than leaving them empty — otherwise
// promoting one column silently erases the unmapped_column warning for
// every OTHER column the admin hasn't touched yet.
{
  const oneEdited = { ...dry.body.mapping };
  const committeeEntry = dry.body.unmapped.find((u) => u.header === "Committee");
  oneEdited[String(committeeEntry.index)] =
    { kind: "custom", key: "committee", label: "Committee" };

  const afterEdit = await json(`/api/tenants/${tenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header, raw_rows: rawRows, dry_run: true, mapping: oneEdited }),
  });
  const editedHeaders = (afterEdit.body.warnings || [])
    .filter((w) => w.code === "unmapped_column").map((w) => w.header);

  check("promoted column (Committee) no longer warns as unmapped",
    !editedHeaders.includes("Committee"), JSON.stringify(editedHeaders));
  check("STALE-WARNING REGRESSION: untouched columns still warn (Machine Type)",
    editedHeaders.includes("Machine Type"), JSON.stringify(editedHeaders));
  check("STALE-WARNING REGRESSION: untouched columns still warn (Bee Group)",
    editedHeaders.includes("Bee Group"), JSON.stringify(editedHeaders));
}

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

// Truthful reconciliation: this run has 3 skipped rows, so it must NOT claim
// a clean "completed" status even though nothing about the memberships
// themselves failed. A batch id must be present either way.
check("import reports a batch id", !!run1.body.batch_id);
check("import with skipped rows reports partial, not completed",
  run1.body.status === "partial", `got ${run1.body.status}`);
// Of the fixture's data rows, 4 name the real "Annual Membership" level and
// are not otherwise skipped: ada (row 2), grace (row 4), katherine (row 5,
// bad renewal date but a valid level), mary (row 6, bogus status but a valid
// level). Dorothy (row 7) names "Nonexistent Level" -- not a match, so no
// membership is attempted for her. The duplicate ada (row 8) is skipped for
// being a duplicate before the level is ever consulted, so she isn't counted
// here either.
check("every row naming a real level is accounted for (assigned + failed)",
  (run1.body.memberships_assigned + (run1.body.membership_failures || 0)) === 4,
  `assigned=${run1.body.memberships_assigned} failed=${run1.body.membership_failures}`);
check("clean membership assignment: no failures on this run",
  run1.body.membership_failures === 0, `got ${run1.body.membership_failures}`);

// The real-import path must report the same full skipped list the dry run
// does — Task 5's error-CSV download is built on skipped_rows.
check("skipped count is 3 (ragged + duplicate + missing email)",
  run1.body.skipped === 3, `got ${run1.body.skipped}`);
check("skipped_rows has 3 entries",
  (run1.body.skipped_rows || []).length === 3, JSON.stringify(run1.body.skipped_rows));
check("skipped_rows reports the ragged row",
  (run1.body.skipped_rows || []).some((s) => s.row === 2 && /column count/i.test(s.reason)),
  JSON.stringify(run1.body.skipped_rows));
check("skipped_rows reports the duplicate email",
  (run1.body.skipped_rows || []).some((s) => /duplicate/i.test(s.reason)),
  JSON.stringify(run1.body.skipped_rows));
check("skipped_rows reports the missing email",
  (run1.body.skipped_rows || []).some((s) => /missing or invalid email/i.test(s.reason)),
  JSON.stringify(run1.body.skipped_rows));

const settings2 = await json(`/api/tenants/${tenantId}`, { headers: auth });
const cf2 = JSON.parse(settings2.body.settings_json || "{}").custom_fields || [];
check("definitions persisted", cf2.some((f) => f.key === "committee"), JSON.stringify(cf2));

const list = await json(`/api/tenants/${tenantId}/members?limit=100`, { headers: auth });
const ada = list.body.members.find((m) => m.email === "ada@example.test");
const adaFull = await json(`/api/tenants/${tenantId}/members/${ada.id}`, { headers: auth });
const adaCustom = JSON.parse(adaFull.body.custom_fields_json || "{}");
check("custom value stored", adaCustom.committee === "Raffle", JSON.stringify(adaCustom));
check("second custom value stored", adaCustom.machine_type === "Bernina 770");

// Grace is the row immediately after the ragged row (row 2). If rowIndex
// ever desynced from customFieldsByRow after a skipped row, her values would
// silently come from the wrong row (or be empty). This is the assertion
// that actually proves no index shift, not just that the ragged row itself
// was skipped.
const grace = list.body.members.find((m) => m.email === "grace@example.test");
const graceFull = await json(`/api/tenants/${tenantId}/members/${grace.id}`, { headers: auth });
const graceCustom = JSON.parse(graceFull.body.custom_fields_json || "{}");
check("row after ragged row lands on the correct member (committee)",
  graceCustom.committee === "Programs", JSON.stringify(graceCustom));
check("row after ragged row lands on the correct member (machine_type)",
  graceCustom.machine_type === "Juki TL-2010Q", JSON.stringify(graceCustom));

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

// Re-running the same mapping must not create a second copy of any
// definition. Length alone would not catch a rename or reorder, so compare
// the exact key sequence, not just the count.
check("re-run creates no new definitions",
  (run2.body.custom_fields_created || []).length === 0,
  JSON.stringify(run2.body.custom_fields_created));
const settings3 = await json(`/api/tenants/${tenantId}`, { headers: auth });
const cf3 = JSON.parse(settings3.body.settings_json || "{}").custom_fields || [];
check("definition key sequence unchanged after re-run",
  JSON.stringify(cf3.map((f) => f.key)) === JSON.stringify(cf2.map((f) => f.key)),
  `${JSON.stringify(cf2.map((f) => f.key))} -> ${JSON.stringify(cf3.map((f) => f.key))}`);

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

// Import again with every custom column ignored — this exercises the
// coalesce(?, custom_fields_json) branch specifically, with hand_entered
// as the canary: it was written only by the PATCH above, never by any
// import mapping, so it can only survive if custom_fields_json really is
// coalesced rather than unconditionally overwritten. An implementation
// that wrote `custom_fields_json = ?` instead of
// `coalesce(?, custom_fields_json)` would pass every check above (every
// prior import mapped at least one custom column) yet silently wipe every
// member's custom fields, including hand-entered ones, right here.
const allIgnore = { ...mapping };
for (const [k, v] of Object.entries(allIgnore)) {
  if (v.kind === "custom") allIgnore[k] = { kind: "ignore" };
}
await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, mapping: allIgnore }),
});
const adaAllIgnore = await json(`/api/tenants/${tenantId}/members/${ada.id}`, { headers: auth });
const adaCustom3 = JSON.parse(adaAllIgnore.body.custom_fields_json || "{}");
check("hand-entered field survives an all-ignore import (coalesce branch)",
  adaCustom3.hand_entered === "keep me", JSON.stringify(adaCustom3));
check("committee value also survives an all-ignore import",
  adaCustom3.committee === "Raffle", JSON.stringify(adaCustom3));

console.log("\n--- fix round 1: admin-created duplicate known-target must not let the later column win ---");

// setImportTarget in admin.html has no dedup guard, so an admin can set two
// dropdowns to the same known target by hand — here, column 1 ("First name")
// and column 8 ("Notes") both claim first_name. The duplicate_target warning
// promises "the first column wins and this one is ignored"; the route must
// make that literally true in the mapping it applies, not just report it.
const dupMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  8: { kind: "known", target: "first_name" },
};

const dupDry = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, dry_run: true, mapping: dupMapping }),
});
const dupDryDuplicate = (dupDry.body.warnings || []).find(
  (w) => w.code === "duplicate_target" && w.header === "Notes"
);
check("duplicate_target warning reported for the higher-index column (Notes)",
  !!dupDryDuplicate, JSON.stringify(dupDry.body.warnings));
check("echoed mapping demotes the duplicate column to ignore (not left as the admin's raw choice)",
  dupDry.body.mapping?.["8"]?.kind === "ignore", JSON.stringify(dupDry.body.mapping?.["8"]));
check("demoted duplicate also warns unmapped_column since it carries data (Notes)",
  (dupDry.body.warnings || []).some((w) => w.code === "unmapped_column" && w.header === "Notes"),
  JSON.stringify(dupDry.body.warnings));

const dupRun = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header, raw_rows: rawRows, mapping: dupMapping }),
});
check("duplicate-mapping import succeeds", dupRun.status === 200, JSON.stringify(dupRun.body).slice(0, 200));

const adaAfterDup = await json(`/api/tenants/${tenantId}/members/${ada.id}`, { headers: auth });
check("FIRST COLUMN WINS: first_name came from the lower-index column (First name = Ada), not the higher-index one (Notes = Founding member)",
  adaAfterDup.body.first_name === "Ada", `got ${JSON.stringify(adaAfterDup.body.first_name)}`);

console.log("\n--- fix round 2: colliding custom-field keys must be reported, not silently merged ---");

// Two headers that collapse to the same key must be REPORTED, not silently
// merged. Today the second overwrites the first with no warning at all.
const collideHeader = ["E-Mail", "Bee Group", "Bee-Group"];
const collideRows = [["a@example.test", "Tuesday", "Thursday"]];
const collideMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "custom", key: "bee_group", label: "Bee Group" },
  2: { kind: "custom", key: "bee_group", label: "Bee-Group" },
};
const dryCollide = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: collideHeader, raw_rows: collideRows,
                         mapping: collideMapping, dry_run: true }),
});
const dryCollideWarning = (dryCollide.body.warnings || []).find((w) => w.code === "duplicate_custom_key");
check("collision is warned in the dry run",
  !!dryCollideWarning, JSON.stringify(dryCollide.body.warnings));
// A bare code is useless to the admin — the message is the only thing the
// UI actually renders, so it must name both offending headers, not just
// signal that "some" collision happened.
check("dry-run warning names both offending headers",
  !!dryCollideWarning && dryCollideWarning.message.includes("Bee Group") &&
    dryCollideWarning.message.includes("Bee-Group"),
  JSON.stringify(dryCollideWarning));

const realCollide = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: collideHeader, raw_rows: collideRows, mapping: collideMapping }),
});
check("collision is rejected on the real import",
  realCollide.status === 400 && realCollide.body.code === "duplicate_custom_key",
  `got ${realCollide.status} ${JSON.stringify(realCollide.body)}`);
// admin.html's runImport catch prints only e.message (data.error) — the
// structured `duplicates` array is never surfaced to the admin, so the
// error STRING itself must name both columns or an admin who clicks Import
// past a stale preview sees a dead end.
check("400 error message names both offending headers",
  typeof realCollide.body.error === "string" &&
    realCollide.body.error.includes("Bee Group") &&
    realCollide.body.error.includes("Bee-Group"),
  JSON.stringify(realCollide.body.error));

console.log("\n--- fix round 2b: server-proposed collision against an EXISTING custom field ---");

// Layer 3's real import already created a "bee_group" custom field (label
// "Bee Group") on this tenant, from promoting the fixture's unmapped
// "Bee Group" column. Two NEW headers that both normalise to the same
// existing field's key/label — with no explicit mapping supplied, so
// proposeMapping (not the admin-supplied-mapping branch) resolves them —
// must be caught too. normalizeHeader strips all non a-z chars, so
// "Bee Group" and "Bee-Group" both normalise to "beegroup" and both match
// the existing field by label.
const settingsBeforeExisting = await json(`/api/tenants/${tenantId}`, { headers: auth });
const cfBeforeExisting = JSON.parse(settingsBeforeExisting.body.settings_json || "{}").custom_fields || [];
const hasBeeGroupField = cfBeforeExisting.some((f) => f.key === "bee_group");
check("precondition: tenant already has an existing bee_group custom field",
  hasBeeGroupField, JSON.stringify(cfBeforeExisting.map((f) => f.key)));

const existingCollideHeader = ["E-Mail", "Bee Group", "Bee-Group"];
const existingCollideRows = [["b@example.test", "Tuesday", "Thursday"]];

const dryExistingCollide = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: existingCollideHeader, raw_rows: existingCollideRows, dry_run: true }),
});
check("proposeMapping maps both new headers to the same existing key",
  dryExistingCollide.body.mapping?.["1"]?.key === "bee_group" &&
    dryExistingCollide.body.mapping?.["2"]?.key === "bee_group",
  JSON.stringify(dryExistingCollide.body.mapping));
const dryExistingWarning = (dryExistingCollide.body.warnings || [])
  .find((w) => w.code === "duplicate_custom_key");
check("server-proposed collision against an existing field is warned in the dry run",
  !!dryExistingWarning && dryExistingWarning.message.includes("Bee Group") &&
    dryExistingWarning.message.includes("Bee-Group"),
  JSON.stringify(dryExistingCollide.body.warnings));

const realExistingCollide = await json(`/api/tenants/${tenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: existingCollideHeader, raw_rows: existingCollideRows }),
});
check("server-proposed collision against an existing field is rejected on the real import",
  realExistingCollide.status === 400 && realExistingCollide.body.code === "duplicate_custom_key" &&
    realExistingCollide.body.error.includes("Bee Group") &&
    realExistingCollide.body.error.includes("Bee-Group"),
  `got ${realExistingCollide.status} ${JSON.stringify(realExistingCollide.body)}`);

console.log("\n--- layer 4: truthful reconciliation (batch status + forced membership failure) ---");

// Dedicated tenant so these two imports are unaffected by anything above
// (no pre-existing members, no duplicate emails, no ragged rows) — the point
// is to isolate membership-assignment success/failure from every other
// reason a row can be skipped.
const recoTenant = await json("/api/tenants", {
  method: "POST", headers: auth,
  body: JSON.stringify({ name: `Reco ${stamp}`, slug: `reco-${stamp}` }),
});
const recoTenantId = recoTenant.body.id;
await json(`/api/tenants/${recoTenantId}/levels`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                         duration_months: 12, renewal_type: "manual" }),
});

const recoHeader = ["Email", "First Name", "Last Name", "Level"];
const recoMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  3: { kind: "known", target: "level_name" },
};

// A clean import: every row is valid, every row names a real level, nothing
// is skipped and nothing is plan-limited. This is the case the contract
// promises "completed" for.
const cleanRows = [
  ["clean1@example.test", "Clean", "One", "Annual Membership"],
  ["clean2@example.test", "Clean", "Two", "Annual Membership"],
];
const cleanImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: recoHeader, raw_rows: cleanRows, mapping: recoMapping }),
});
check("clean import succeeds", cleanImport.status === 200,
  JSON.stringify(cleanImport.body).slice(0, 200));
check("clean import reports a batch id", !!cleanImport.body.batch_id);
check("clean import reports completed", cleanImport.body.status === "completed",
  `got ${cleanImport.body.status}`);
check("clean import assigns both memberships, fails none",
  cleanImport.body.memberships_assigned === 2 && cleanImport.body.membership_failures === 0,
  `assigned=${cleanImport.body.memberships_assigned} failed=${cleanImport.body.membership_failures}`);
// Fix round 2 matters most here: buildWarnings now runs on every real
// import, and status now depends on whether any of its codes are lossy. If
// that wiring were backwards (or too eager), EVERY import — even this
// clean one — would come back partial.
check("clean import has no warnings at all (regression guard for fix round 2)",
  (cleanImport.body.warnings || []).length === 0, JSON.stringify(cleanImport.body.warnings));

// A forced membership failure: same shape, different (new) emails so both
// rows create fresh members, but every membership activation is made to
// fail deterministically via a dev-only header (see src/routes/members.ts,
// gated on ENVIRONMENT === "development", same pattern as
// X-QH-Force-Outbox-Failure). The member row must still be created; only the
// membership assignment fails — and the response must say so.
const forcedRows = [
  ["forced1@example.test", "Forced", "One", "Annual Membership"],
  ["forced2@example.test", "Forced", "Two", "Annual Membership"],
];
const forced = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST",
  headers: { ...auth, "X-QH-Force-Membership-Failure": "1" },
  body: JSON.stringify({ header: recoHeader, raw_rows: forcedRows, mapping: recoMapping }),
});
check("forced-failure import succeeds (members are still created)",
  forced.status === 200, JSON.stringify(forced.body).slice(0, 200));
check("forced-failure import still creates both members",
  forced.body.created === 2, `got ${forced.body.created}`);
check("forced membership failure reports partial", forced.body.status === "partial",
  `got ${forced.body.status}`);
check("forced membership failure is counted",
  forced.body.membership_failures === 2, `got ${forced.body.membership_failures}`);
check("forced-failure import assigns none",
  forced.body.memberships_assigned === 0, `got ${forced.body.memberships_assigned}`);
check("forced membership failure appears in errors",
  (forced.body.errors || []).some((e) => e.kind === "membership_failed"),
  JSON.stringify(forced.body.errors));

// Exact correlation, not a tolerant OR: a 0-based row index ({0,1}) or the
// wrong field name entirely (e.RowNumber sniffed via `e.row`) would have
// passed a looser assertion like `e.row_number === 1 || e.row === 1`. Assert
// the precise {row_number -> email} mapping instead — forced1 is raw_rows[0]
// (row 1), forced2 is raw_rows[1] (row 2).
const forcedMembershipErrors = (forced.body.errors || []).filter((e) => e.kind === "membership_failed");
const forcedRowNumbers = forcedMembershipErrors.map((e) => e.row_number).sort((a, b) => a - b);
check("forced membership failures name exactly rows 1 and 2 (1-based), no more no less",
  JSON.stringify(forcedRowNumbers) === JSON.stringify([1, 2]),
  JSON.stringify(forcedMembershipErrors));
const byRow = new Map(forcedMembershipErrors.map((e) => [e.row_number, e.email]));
check("row 1's membership_failed error is attributed to forced1's email",
  byRow.get(1) === "forced1@example.test", JSON.stringify(forcedMembershipErrors));
check("row 2's membership_failed error is attributed to forced2's email",
  byRow.get(2) === "forced2@example.test", JSON.stringify(forcedMembershipErrors));

// The production-facing behavior: the header must be inert unless
// ENVIRONMENT === "development" is true FIRST. Nothing here can prove that
// against a prod deployment (this harness only ever talks to wrangler dev),
// but re-running the identical request without the header must go back to
// reporting a clean success, proving the header — not something incidental
// about these two rows — is what caused the failure above.
const forcedOff = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({
    header: recoHeader,
    raw_rows: [["forced3@example.test", "Forced", "Three", "Annual Membership"]],
    mapping: recoMapping,
  }),
});
check("without the header, membership assignment succeeds normally",
  forcedOff.body.status === "completed" && forcedOff.body.membership_failures === 0,
  JSON.stringify(forcedOff.body));

console.log("\n--- layer 4b: level_not_found is a real loss, not a silent 'completed' (fix round 1, item 1) ---");

// The original bug, reproduced: a row names a level (a typo here) that
// matches nothing in levelByName (which only holds status='active' levels).
// Before fix round 1, no counter moved, nothing landed in skipped_rows or
// errors, and status came out "completed" even though the member has no
// membership at all.
const levelTypoRows = [
  ["typo1@example.test", "Typo", "One", "Anual Membership"],
];
const levelTypo = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: recoHeader, raw_rows: levelTypoRows, mapping: recoMapping }),
});
check("level-typo import still creates the member",
  levelTypo.body.created === 1, `got ${levelTypo.body.created}`);
check("level-typo import assigns no membership",
  levelTypo.body.memberships_assigned === 0, `got ${levelTypo.body.memberships_assigned}`);
check("level-typo import reports partial, not completed (THE BUG)",
  levelTypo.body.status === "partial", `got ${levelTypo.body.status}`);
check("level-typo import counts level_not_found in the response",
  levelTypo.body.level_not_found === 1, `got ${levelTypo.body.level_not_found}`);
check("level-typo import records a level_not_found error naming the row and the bad level string",
  (levelTypo.body.errors || []).some(
    (e) => e.kind === "level_not_found" && e.row_number === 1 &&
      e.email === "typo1@example.test" && e.reason.includes("Anual Membership")),
  JSON.stringify(levelTypo.body.errors));

console.log("\n--- layer 4c: plan-limited rows that named a real level are accounted for (fix round 1, item 2) ---");

// Fresh tenant so the active-member count starts at 0 and is under our
// control. New tenants get a 30-day trial, which counts as "starter"
// (unlimited) for plan-limit purposes -- clear it so this tenant is
// actually on the free plan's 30-active-member cap. Same pattern as
// scripts/verify-idempotency.mjs section 6.
const planTenant = await json("/api/tenants", {
  method: "POST", headers: auth,
  body: JSON.stringify({ name: `Plan Reco ${stamp}`, slug: `planreco-${stamp}` }),
});
const planTenantId = planTenant.body.id;
d1Exec(`UPDATE tenants SET trial_ends_at = NULL WHERE id = '${planTenantId}';`);
await json(`/api/tenants/${planTenantId}/levels`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                         duration_months: 12, renewal_type: "manual" }),
});
// Fill to FREE_ACTIVE_MEMBER_LIMIT (30) active members, leaving zero slots.
for (let i = 0; i < 30; i++) {
  const r = await json(`/api/tenants/${planTenantId}/members`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ email: `fill-${stamp}-${i}@example.test`, status: "active" }),
  });
  if (r.status >= 400) throw new Error(`filling active member ${i} failed: ${JSON.stringify(r.body)}`);
}

const planLimitRows = [
  ["overcap1@example.test", "Over", "One", "Annual Membership"],
  ["overcap2@example.test", "Over", "Two", "Annual Membership"],
];
const planLimitImport = await json(`/api/tenants/${planTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: recoHeader, raw_rows: planLimitRows, mapping: recoMapping }),
});
check("plan-limited import still creates both members",
  planLimitImport.body.created === 2, `got ${planLimitImport.body.created}`);
check("plan-limited import assigns no membership (cap already full)",
  planLimitImport.body.memberships_assigned === 0, `got ${planLimitImport.body.memberships_assigned}`);
check("plan-limited import reports partial",
  planLimitImport.body.status === "partial", `got ${planLimitImport.body.status}`);
// The invariant the whole task rests on, now restated to include
// plan-limiting: every row naming a real level must be accounted for by
// exactly one of assigned / failed / plan_limited. Before fix round 1, a
// row that named a real level and hit the cap fell into neither counter,
// so this would read 0 === 2.
const namedRealLevelPlanLimit = 2;
check("invariant holds when the free-plan cap bites: assigned + failed + plan_limited === rows naming a real level",
  (planLimitImport.body.memberships_assigned + planLimitImport.body.membership_failures +
    planLimitImport.body.plan_limited) === namedRealLevelPlanLimit,
  `assigned=${planLimitImport.body.memberships_assigned} ` +
    `failed=${planLimitImport.body.membership_failures} ` +
    `plan_limited=${planLimitImport.body.plan_limited} expected=${namedRealLevelPlanLimit}`);
check("plan-limited rows that named a real level are itemized as errors of kind plan_limited",
  (planLimitImport.body.errors || []).filter((e) => e.kind === "plan_limited").length === 2,
  JSON.stringify(planLimitImport.body.errors));

// Persistence: the batch and its errors must be real rows in D1, not just
// fields synthesized into the HTTP response.
const persistedBatch = d1Query(
  `SELECT * FROM import_batches WHERE id = '${forced.body.batch_id}'`
);
check("forced-failure batch row is persisted", persistedBatch.length === 1,
  JSON.stringify(persistedBatch));
check("persisted batch row has status partial",
  persistedBatch[0]?.status === "partial", JSON.stringify(persistedBatch[0]));
check("persisted batch row has membership_failures = 2",
  persistedBatch[0]?.membership_failures === 2, JSON.stringify(persistedBatch[0]));
check("persisted batch row is scoped to the right tenant",
  persistedBatch[0]?.tenant_id === recoTenantId, JSON.stringify(persistedBatch[0]));

const persistedErrors = d1Query(
  `SELECT * FROM import_batch_errors WHERE batch_id = '${forced.body.batch_id}'`
);
check("forced-failure error rows are persisted (2 memberships failed)",
  persistedErrors.length === 2, JSON.stringify(persistedErrors));
check("persisted error rows are kind membership_failed",
  persistedErrors.every((e) => e.kind === "membership_failed"), JSON.stringify(persistedErrors));
check("persisted error rows are scoped to the right tenant",
  persistedErrors.every((e) => e.tenant_id === recoTenantId), JSON.stringify(persistedErrors));

console.log("\n--- layer 4d: a mid-batch crash closes the batch as 'failed', not stuck at 'running' (fix round 1, item 3) ---");

// Dev-only header (same env-first gating as the other two forced-failure
// headers in this file) that injects one extra member INSERT binding NULL
// into the NOT NULL tenant_id column, guaranteeing the whole member-INSERT
// D1 batch (which is atomic) fails to commit -- so the outer try/catch in
// the route is proven to actually run, not just exist unexercised.
const crashRows = [["crash1@example.test", "Crash", "One", "Annual Membership"]];
const crashImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST",
  headers: { ...auth, "X-QH-Force-Import-Batch-Failure": "1" },
  body: JSON.stringify({ header: recoHeader, raw_rows: crashRows, mapping: recoMapping }),
});
check("forced batch crash surfaces as a server error, not a fake 200",
  crashImport.status >= 500, `got ${crashImport.status} ${JSON.stringify(crashImport.body).slice(0, 200)}`);

const crashMemberCheck = await json(
  `/api/tenants/${recoTenantId}/members?q=crash1@example.test`, { headers: auth }
);
check("no member was created from the crashed batch (D1 .batch() is atomic)",
  (crashMemberCheck.body.members || []).length === 0, JSON.stringify(crashMemberCheck.body));

const latestBatch = d1Query(
  `SELECT * FROM import_batches WHERE tenant_id = '${recoTenantId}' ORDER BY started_at DESC, id DESC LIMIT 1`
);
check("the crashed batch was closed as 'failed', not left at 'running' forever",
  latestBatch[0]?.status === "failed", JSON.stringify(latestBatch[0]));
check("the crashed batch has a finished_at timestamp",
  !!latestBatch[0]?.finished_at, JSON.stringify(latestBatch[0]));

console.log("\n--- layer 4e: buildWarnings runs on the real import too, not just the dry-run preview (fix round 2) ---");

// A header rich enough to exercise status, level, and date in one shape,
// reused across the three scenarios below.
const richHeader = ["Email", "First Name", "Last Name", "Status", "Level", "Renewal"];
const richMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  3: { kind: "known", target: "status" },
  4: { kind: "known", target: "level_name" },
  5: { kind: "known", target: "end_date" },
};

// --- unparseable_date -------------------------------------------------
// A row that names a real level (so a membership IS assigned) but whose
// renewal date buildWarnings already flags as unparseable. Before fix
// round 2, activateMembership would silently compute a FABRICATED end date
// from the level's duration instead, and the response said "completed".
const badDateRows = [
  ["baddate1@example.test", "Bad", "Date", "", "Annual Membership", "not a date"],
];
const badDateImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: richHeader, raw_rows: badDateRows, mapping: richMapping }),
});
check("unparseable-date import still creates the member and assigns the membership",
  badDateImport.body.created === 1 && badDateImport.body.memberships_assigned === 1,
  JSON.stringify(badDateImport.body));
check("unparseable-date import reports partial, not completed (THE BUG)",
  badDateImport.body.status === "partial", `got ${badDateImport.body.status}`);
check("unparseable-date import records an unparseable_date error naming the row",
  (badDateImport.body.errors || []).some(
    (e) => e.kind === "unparseable_date" && e.row_number === 1 &&
      e.email === "baddate1@example.test"),
  JSON.stringify(badDateImport.body.errors));
check("unparseable-date import's warnings include the unparseable_date code",
  (badDateImport.body.warnings || []).some((w) => w.code === "unparseable_date"),
  JSON.stringify(badDateImport.body.warnings));
// Fix round 3, item 3: buildWarnings' strings were written for the dry-run
// preview ("will be left blank") and are now rendered on a FINISHED
// import, where the truth (per the round-2 fix's own per-row error
// message) is that the end date was computed from the level's duration,
// not left blank. The applied-phase message must say what actually
// happened, not what the preview predicted.
const badDateWarning = (badDateImport.body.warnings || []).find((w) => w.code === "unparseable_date");
check("applied-phase unparseable_date warning does NOT say \"will be left blank\" (THE BUG)",
  !!badDateWarning && !badDateWarning.message.includes("will be left blank"),
  JSON.stringify(badDateWarning));
check("applied-phase unparseable_date warning states what actually happened (computed from the level's duration)",
  !!badDateWarning && badDateWarning.message.includes("computed from the level's duration"),
  JSON.stringify(badDateWarning));

// --- invalid_status -----------------------------------------------------
// A status the guild's export used that QuiltHosting doesn't recognize,
// and (deliberately) no level, so the existing-behavior coercion is fully
// visible: the row imports as status=active directly (not via
// activateMembership). This is the "consumes a free-plan slot, gets guild
// email" case from the brief -- we assert the coercion happened (unchanged
// behavior), not that it stopped happening.
const suspendedRows = [
  ["suspended1@example.test", "Sus", "Pended", "Suspended", "", ""],
];
const suspendedImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: richHeader, raw_rows: suspendedRows, mapping: richMapping }),
});
check("invalid-status import still creates the member",
  suspendedImport.body.created === 1, JSON.stringify(suspendedImport.body));
check("invalid-status import reports partial, not completed (THE BUG)",
  suspendedImport.body.status === "partial", `got ${suspendedImport.body.status}`);
check("invalid-status import records an invalid_status error naming the row",
  (suspendedImport.body.errors || []).some(
    (e) => e.kind === "invalid_status" && e.row_number === 1 &&
      e.email === "suspended1@example.test"),
  JSON.stringify(suspendedImport.body.errors));
// The coercion itself (existing behavior, deliberately NOT changed by this
// fix): "Suspended" is not a recognized status, so the row imports active.
const suspendedList = await json(
  `/api/tenants/${recoTenantId}/members?q=suspended1@example.test`, { headers: auth }
);
const suspendedMember = (suspendedList.body.members || [])[0];
check("the coercion is unchanged: the member was imported with status=active despite \"Suspended\"",
  suspendedMember?.status === "active", JSON.stringify(suspendedMember));

// --- unmapped_column (data-carrying, ignored) ----------------------------
// A column the admin explicitly left as "Do not import" that actually
// carries data. Nothing here needs a level, a date, or a status at all --
// the whole point is that buildWarnings' unmapped_column code, on its own,
// is now enough to flip status to partial.
const unmappedHeader = ["Email", "First Name", "Notes"];
const unmappedMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "ignore" },
};
const unmappedRows = [["ignoredcol1@example.test", "Ignored", "some data that will be lost"]];
const unmappedImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: unmappedHeader, raw_rows: unmappedRows, mapping: unmappedMapping }),
});
check("unmapped-column import still creates the member",
  unmappedImport.body.created === 1, JSON.stringify(unmappedImport.body));
check("unmapped-column import reports partial purely from a warning, no counter involved (THE BUG)",
  unmappedImport.body.status === "partial", `got ${unmappedImport.body.status}`);
check("unmapped-column import's warnings include unmapped_column for \"Notes\"",
  (unmappedImport.body.warnings || []).some(
    (w) => w.code === "unmapped_column" && w.header === "Notes"),
  JSON.stringify(unmappedImport.body.warnings));

console.log("\n--- layer 4f: unparseable joined_at is the same class of bug, now closed too (fix round 3, item 1) ---");

// No level on this row, deliberately -- the brief's point is that rows
// WITHOUT a level got no signal at all (rows WITH a level were partially
// masked by activateMembership throwing on the same bad string, surfacing
// as an opaque membership_failed reason instead). Before this fix,
// row.joined_at was bound straight into members.joined_at with zero
// validation and nothing about the import said so.
const joinHeader = ["Email", "First Name", "Last Name", "Member Since"];
const joinMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  3: { kind: "known", target: "joined_at" },
};
const badJoinRows = [
  ["badjoin1@example.test", "Bad", "Join", "31/12/2019"],
];
const badJoinImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: joinHeader, raw_rows: badJoinRows, mapping: joinMapping }),
});
check("unparseable-joined_at import still creates the member",
  badJoinImport.body.created === 1, JSON.stringify(badJoinImport.body));
check("unparseable-joined_at import reports partial, not completed (THE BUG)",
  badJoinImport.body.status === "partial", `got ${badJoinImport.body.status}`);
check("unparseable-joined_at import records an unparseable_join_date error naming the row",
  (badJoinImport.body.errors || []).some(
    (e) => e.kind === "unparseable_join_date" && e.row_number === 1 &&
      e.email === "badjoin1@example.test"),
  JSON.stringify(badJoinImport.body.errors));
check("unparseable-joined_at import's warnings include the unparseable_join_date code",
  (badJoinImport.body.warnings || []).some((w) => w.code === "unparseable_join_date"),
  JSON.stringify(badJoinImport.body.warnings));
// Existing (unchanged) behavior, documented rather than fixed here: the raw
// unparseable string really is stored exactly as typed in members.joined_at.
const badJoinList = await json(
  `/api/tenants/${recoTenantId}/members?q=badjoin1@example.test`, { headers: auth }
);
const badJoinMember = (badJoinList.body.members || [])[0];
check("the coercion is unchanged: joined_at was stored exactly as typed (\"31/12/2019\"), not validated or blanked",
  badJoinMember?.joined_at === "31/12/2019", JSON.stringify(badJoinMember));

console.log("\n--- layer 4g: warnings are persisted, not just returned (fix round 3, item 2) ---");

// unmapped_column and duplicate_target derive status='partial' purely from
// a warning with no accompanying import_batch_errors row -- a stored batch
// with neither counters nor error rows explaining a 'partial' status would
// be exactly the "unexplained partial" gap Task 4's history page would hit.
// This batch (badJoinImport) is a clean case: nothing skipped, no
// membership failures, no plan-limiting, no level_not_found -- the ONLY
// reason it's partial is the unparseable_join_date warning, so its
// warnings_json is the whole explanation for why this batch isn't
// 'completed'.
const persistedJoinBatch = d1Query(
  `SELECT * FROM import_batches WHERE id = '${badJoinImport.body.batch_id}'`
);
check("the batch row's warnings_json is persisted (not null/empty)",
  !!persistedJoinBatch[0]?.warnings_json, JSON.stringify(persistedJoinBatch[0]));
let persistedJoinWarnings = [];
try { persistedJoinWarnings = JSON.parse(persistedJoinBatch[0]?.warnings_json || "[]"); } catch {}
check("the persisted warnings_json round-trips to include unparseable_join_date",
  persistedJoinWarnings.some((w) => w.code === "unparseable_join_date"),
  JSON.stringify(persistedJoinWarnings));

console.log("\n--- layer 4h: a lapsed/cancelled file status is silently overridden to active by a level (fix round 4, item 1) ---");

// Status is a VALID MEMBER_STATUS ("lapsed"), so invalid_status's check
// never fires -- but the row also names a real level, so importStatus
// forces "pending" and activateMembership then forces "active" regardless
// of what the file said. That coercion is not being changed here; the
// point is that it must be visible.
const lapsedOverrideRows = [
  ["lapsedoverride1@example.test", "Lapsed", "One", "Lapsed", "Annual Membership", ""],
];
const lapsedOverrideImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: richHeader, raw_rows: lapsedOverrideRows, mapping: richMapping }),
});
check("lapsed-override import still creates the member and assigns the membership",
  lapsedOverrideImport.body.created === 1 && lapsedOverrideImport.body.memberships_assigned === 1,
  JSON.stringify(lapsedOverrideImport.body));
check("lapsed-override import reports partial, not completed (THE BUG)",
  lapsedOverrideImport.body.status === "partial", `got ${lapsedOverrideImport.body.status}`);
check("lapsed-override import records a status_overridden_by_level error naming the row",
  (lapsedOverrideImport.body.errors || []).some(
    (e) => e.kind === "status_overridden_by_level" && e.row_number === 1 &&
      e.email === "lapsedoverride1@example.test"),
  JSON.stringify(lapsedOverrideImport.body.errors));
// The coercion itself is unchanged: the member really does end up active.
const lapsedOverrideList = await json(
  `/api/tenants/${recoTenantId}/members?q=lapsedoverride1@example.test`, { headers: auth }
);
check("the coercion is unchanged: the member ends up active despite the file saying Lapsed",
  (lapsedOverrideList.body.members || [])[0]?.status === "active",
  JSON.stringify(lapsedOverrideList.body.members));

console.log("\n--- layer 4i: joined_at is silently discarded on UPDATE, even when valid (fix round 4, item 2) ---");

// Insert first (no level, to isolate from item 1/activateMembership entirely
// -- this is purely about the members.joined_at column).
const joinUpdateHeader = ["Email", "First Name", "Last Name", "Member Since"];
const joinUpdateMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  3: { kind: "known", target: "joined_at" },
};
const joinInsertRows = [["joinupdate1@example.test", "Join", "One", "2020-01-01"]];
const joinInsertImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: joinUpdateHeader, raw_rows: joinInsertRows, mapping: joinUpdateMapping }),
});
check("baseline insert succeeds and is completed (nothing lossy about a fresh, valid joined_at)",
  joinInsertImport.body.created === 1 && joinInsertImport.body.status === "completed",
  JSON.stringify(joinInsertImport.body));

// Now re-import the SAME email with a DIFFERENT (still perfectly valid)
// joined_at. This is an update -- the UPDATE statement has no joined_at
// column at all, so the new value must be silently discarded and the
// ORIGINAL value must survive untouched.
const joinUpdateRows = [["joinupdate1@example.test", "Join", "One-Updated", "2021-06-01"]];
const joinUpdateImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: joinUpdateHeader, raw_rows: joinUpdateRows, mapping: joinUpdateMapping }),
});
check("update import still updates the member",
  joinUpdateImport.body.updated === 1, JSON.stringify(joinUpdateImport.body));
// Fix round 5 reclassified joined_at_ignored_on_update as INFORMATIONAL
// (see layer 5a below for why and for the fail-then-pass proof of that
// change) -- this assertion originally expected "partial" here (that WAS
// the round-4 fix), but forcing partial on every routine re-import that
// carries a Member Since column made partial meaningless, so round 5
// deliberately made this same scenario report completed instead. Updated
// to match the current, correct contract rather than leaving a stale
// expectation in a still-passing test.
check("update import reports completed -- a differing joined_at is informational only (fix round 5)",
  joinUpdateImport.body.status === "completed", `got ${joinUpdateImport.body.status}`);
check("update import records a joined_at_ignored_on_update error naming the row",
  (joinUpdateImport.body.errors || []).some(
    (e) => e.kind === "joined_at_ignored_on_update" && e.row_number === 1 &&
      e.email === "joinupdate1@example.test"),
  JSON.stringify(joinUpdateImport.body.errors));
const joinUpdateList = await json(
  `/api/tenants/${recoTenantId}/members?q=joinupdate1@example.test`, { headers: auth }
);
const joinUpdateMember = (joinUpdateList.body.members || [])[0];
check("the ORIGINAL joined_at survives -- the new value was truly discarded, not silently applied",
  joinUpdateMember?.joined_at?.startsWith("2020-01-01"), JSON.stringify(joinUpdateMember));
check("last_name WAS updated (proves this is a real update, not a no-op) while joined_at was not",
  joinUpdateMember?.last_name === "One-Updated", JSON.stringify(joinUpdateMember));

console.log("\n--- layer 4j: a valid renewal date with no level is silently dropped (fix round 4, item 3) ---");

const endDateNoLevelHeader = ["Email", "First Name", "Last Name", "Renewal"];
const endDateNoLevelMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  3: { kind: "known", target: "end_date" },
};
const endDateNoLevelRows = [["enddatenolevel1@example.test", "End", "NoLevel", "2027-01-01"]];
const endDateNoLevelImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: endDateNoLevelHeader, raw_rows: endDateNoLevelRows, mapping: endDateNoLevelMapping }),
});
check("end-date-without-level import still creates the member (no membership -- no level named)",
  endDateNoLevelImport.body.created === 1 && endDateNoLevelImport.body.memberships_assigned === 0,
  JSON.stringify(endDateNoLevelImport.body));
check("end-date-without-level import reports partial, not completed (THE BUG)",
  endDateNoLevelImport.body.status === "partial", `got ${endDateNoLevelImport.body.status}`);
check("end-date-without-level import records an end_date_without_level error naming the row",
  (endDateNoLevelImport.body.errors || []).some(
    (e) => e.kind === "end_date_without_level" && e.row_number === 1 &&
      e.email === "enddatenolevel1@example.test"),
  JSON.stringify(endDateNoLevelImport.body.errors));

console.log("\n--- layer 4k: re-importing with no Status column must not reactivate a lapsed member (fix round 4, item 4 -- behavior change) ---");

// Seed a lapsed member directly (not via import -- isolates this scenario
// from every other status-computation path).
const lapsedSeedEmail = `lapsedseed-${stamp}@example.test`;
const lapsedSeed = await json(`/api/tenants/${recoTenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: lapsedSeedEmail, first_name: "Lapsed", last_name: "Seed", status: "lapsed" }),
});
check("seed: lapsed member created directly", lapsedSeed.status === 201 || lapsedSeed.status === 200,
  `got ${lapsedSeed.status} ${JSON.stringify(lapsedSeed.body)}`);

// Re-import the SAME email through a header with NO Status column at all
// (and no Level column either) -- exactly what a guild's routine
// "update everyone's phone number" re-import would look like.
const noStatusHeader = ["Email", "First Name", "Last Name"];
const noStatusMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
};
const noStatusRows = [[lapsedSeedEmail, "Lapsed", "StillLapsed"]];
const noStatusImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: noStatusHeader, raw_rows: noStatusRows, mapping: noStatusMapping }),
});
check("no-status-column re-import still updates the member",
  noStatusImport.body.updated === 1, JSON.stringify(noStatusImport.body));
check("no-status-column re-import is a clean completed (nothing lossy fired)",
  noStatusImport.body.status === "completed", `got ${noStatusImport.body.status}`);
const noStatusList = await json(
  `/api/tenants/${recoTenantId}/members?q=${encodeURIComponent(lapsedSeedEmail)}`, { headers: auth }
);
const noStatusMember = (noStatusList.body.members || [])[0];
check("THE BEHAVIOR CHANGE: the member is STILL lapsed after a re-import with no Status column (THE BUG was: reactivated to active)",
  noStatusMember?.status === "lapsed", JSON.stringify(noStatusMember));
check("last_name WAS updated (proves this is a real update) while status was correctly left alone",
  noStatusMember?.last_name === "StillLapsed", JSON.stringify(noStatusMember));

console.log("\n--- layer 5a: joined_at_ignored_on_update only fires when the date genuinely differs, and is informational (fix round 5, item 1) ---");

const joinDiscriminateHeader = ["Email", "First Name", "Last Name", "Member Since"];
const joinDiscriminateMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  3: { kind: "known", target: "joined_at" },
};

// Baseline insert: "2019-03-02".
const joinDiscEmail = "joindiscriminate1@example.test";
const joinDiscInsert = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({
    header: joinDiscriminateHeader,
    raw_rows: [[joinDiscEmail, "Join", "Discriminate", "2019-03-02"]],
    mapping: joinDiscriminateMapping,
  }),
});
check("baseline insert succeeds and is completed",
  joinDiscInsert.body.created === 1 && joinDiscInsert.body.status === "completed",
  JSON.stringify(joinDiscInsert.body));

// Re-import with a DIFFERENT STRING that is the SAME CALENDAR DAY
// ("3/2/2019" vs "2019-03-02") -- this is the exact discrimination the
// brief asked for: compare by date value, not raw string.
const joinSameDayImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({
    header: joinDiscriminateHeader,
    raw_rows: [[joinDiscEmail, "Join", "SameDayReexport", "3/2/2019"]],
    mapping: joinDiscriminateMapping,
  }),
});
check("re-importing an UNCHANGED roster (same calendar day, different string format) still updates the member",
  joinSameDayImport.body.updated === 1, JSON.stringify(joinSameDayImport.body));
check("re-importing an unchanged roster (Member Since column present, same day) reports completed, not partial (THE BUG)",
  joinSameDayImport.body.status === "completed", `got ${joinSameDayImport.body.status}`);
check("no joined_at_ignored_on_update error fired for the unchanged (same-day) date",
  !(joinSameDayImport.body.errors || []).some((e) => e.kind === "joined_at_ignored_on_update"),
  JSON.stringify(joinSameDayImport.body.errors));

// Now a GENUINE difference -- must surface (informationally) but still
// remain completed, since it no longer forces partial by itself.
const joinDifferentImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({
    header: joinDiscriminateHeader,
    raw_rows: [[joinDiscEmail, "Join", "GenuinelyDifferent", "2021-06-01"]],
    mapping: joinDiscriminateMapping,
  }),
});
check("re-import with a genuinely different joined_at still updates the member",
  joinDifferentImport.body.updated === 1, JSON.stringify(joinDifferentImport.body));
check("a genuinely different joined_at is INFORMATIONAL ONLY: status stays completed, not partial",
  joinDifferentImport.body.status === "completed", `got ${joinDifferentImport.body.status}`);
check("a genuinely different joined_at still surfaces a joined_at_ignored_on_update error (downloadable)",
  (joinDifferentImport.body.errors || []).some(
    (e) => e.kind === "joined_at_ignored_on_update" && e.email === joinDiscEmail),
  JSON.stringify(joinDifferentImport.body.errors));
check("a genuinely different joined_at still surfaces the code in `warnings`",
  (joinDifferentImport.body.warnings || []).some((w) => w.code === "joined_at_ignored_on_update"),
  JSON.stringify(joinDifferentImport.body.warnings));
check("the corrected message says the record wins and the file's value still becomes the membership start date",
  (joinDifferentImport.body.warnings || []).some(
    (w) => w.code === "joined_at_ignored_on_update" &&
      w.message.includes("keeps its existing value") &&
      w.message.includes("membership start date") &&
      !w.message.includes("will be left blank")),
  JSON.stringify(joinDifferentImport.body.warnings));
// members.joined_at itself is still untouched -- only the CLASSIFICATION
// changed in this round, not the underlying storage behavior.
const joinDiscList = await json(
  `/api/tenants/${recoTenantId}/members?q=${encodeURIComponent(joinDiscEmail)}`, { headers: auth }
);
check("members.joined_at itself remains the ORIGINAL value (storage behavior unchanged)",
  (joinDiscList.body.members || [])[0]?.joined_at?.startsWith("2019-03-02"),
  JSON.stringify(joinDiscList.body.members));

console.log("\n--- layer 5b: N4 status-preservation regression pack, folded into the permanent harness (fix round 5, item 2) ---");

const n4Header = ["Email", "First Name", "Last Name", "Status"];
const n4Mapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  3: { kind: "known", target: "status" },
};

// N4a: new member with blank Status -> imports active.
const n4aEmail = `n4a-${stamp}@example.test`;
const n4aImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: n4Header, raw_rows: [[n4aEmail, "N4a", "New", ""]], mapping: n4Mapping }),
});
const n4aList = await json(`/api/tenants/${recoTenantId}/members?q=${encodeURIComponent(n4aEmail)}`, { headers: auth });
check("N4a: new member with blank Status imports active",
  (n4aList.body.members || [])[0]?.status === "active",
  JSON.stringify({ import: n4aImport.body, member: n4aList.body.members }));

// N4b: existing ACTIVE member + explicit Status=Lapsed -> moves to lapsed,
// import reports completed (an explicit, valid, level-less status change
// is not lossy -- it's exactly what the guild asked for).
const n4bEmail = `n4b-${stamp}@example.test`;
await json(`/api/tenants/${recoTenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: n4bEmail, first_name: "N4b", last_name: "Active", status: "active" }),
});
const n4bImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: n4Header, raw_rows: [[n4bEmail, "N4b", "Active", "Lapsed"]], mapping: n4Mapping }),
});
const n4bList = await json(`/api/tenants/${recoTenantId}/members?q=${encodeURIComponent(n4bEmail)}`, { headers: auth });
check("N4b: existing active member + explicit Status=Lapsed moves to lapsed",
  (n4bList.body.members || [])[0]?.status === "lapsed",
  JSON.stringify({ import: n4bImport.body, member: n4bList.body.members }));
check("N4b: import reports completed (explicit, valid, level-less status change is not lossy)",
  n4bImport.body.status === "completed", `got ${n4bImport.body.status}`);

// N4c: existing LAPSED member + explicit Status=Active -> moves to active.
const n4cEmail = `n4c-${stamp}@example.test`;
await json(`/api/tenants/${recoTenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: n4cEmail, first_name: "N4c", last_name: "Lapsed", status: "lapsed" }),
});
const n4cImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: n4Header, raw_rows: [[n4cEmail, "N4c", "Lapsed", "Active"]], mapping: n4Mapping }),
});
const n4cList = await json(`/api/tenants/${recoTenantId}/members?q=${encodeURIComponent(n4cEmail)}`, { headers: auth });
check("N4c: existing lapsed member + explicit Status=Active moves to active",
  (n4cList.body.members || [])[0]?.status === "active",
  JSON.stringify({ import: n4cImport.body, member: n4cList.body.members }));

// N4d: existing CANCELLED member + a Status column that IS present but
// BLANK for this row (distinct from layer 4k's "column entirely absent")
// -> stays cancelled.
const n4dEmail = `n4d-${stamp}@example.test`;
await json(`/api/tenants/${recoTenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: n4dEmail, first_name: "N4d", last_name: "Cancelled", status: "cancelled" }),
});
const n4dImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ header: n4Header, raw_rows: [[n4dEmail, "N4d", "StillCancelled", ""]], mapping: n4Mapping }),
});
const n4dList = await json(`/api/tenants/${recoTenantId}/members?q=${encodeURIComponent(n4dEmail)}`, { headers: auth });
check("N4d: existing cancelled member + blank Status CELL (column present) on update stays cancelled",
  (n4dList.body.members || [])[0]?.status === "cancelled",
  JSON.stringify({ import: n4dImport.body, member: n4dList.body.members }));
check("N4d: last_name was still updated (proves it's a real update, not skipped)",
  (n4dList.body.members || [])[0]?.last_name === "StillCancelled",
  JSON.stringify(n4dList.body.members));

console.log(failures ? `\n${failures} failure(s)` : "\nall layers passed");
if (failures) process.exit(1);
