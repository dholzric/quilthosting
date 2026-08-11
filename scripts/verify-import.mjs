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
  // One retry on a TRANSPORT failure only (never on an HTTP status): a
  // d1Query/d1Exec between two requests shells out to `npx wrangler d1
  // execute`, which takes long enough that wrangler dev closes the idle
  // keep-alive socket. undici then reuses that dead socket and the very
  // next request dies with ECONNRESET before the server ever logs it --
  // deterministically, at whichever assertion happens to sit after a D1
  // call. A retry re-dials. Any real HTTP response, including a 5xx, is
  // returned untouched so no genuine server error can be masked.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        ...opts,
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
      return { status: res.status, body };
    } catch (e) {
      if (attempt >= 1) throw e;
    }
  }
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
// Fix round 7 deliberately added an INFORMATIONAL level_without_end_date
// warning, and this fixture (a Level column, no expiry column -- the most
// common Wild Apricot shape) legitimately fires it now. The round-2 guard
// is preserved in substance rather than deleted: the batch must still be
// `completed` (asserted just above), and the ONLY warning allowed here is
// that informational one -- if the round-2 wiring were backwards or too
// eager, some other code would show up in this list.
check("clean import's only warning is the informational level_without_end_date (regression guard for fix round 2)",
  (cleanImport.body.warnings || []).every((w) => w.code === "level_without_end_date"),
  JSON.stringify(cleanImport.body.warnings));

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

console.log("\n--- layer 6: Task 4 import history (batch list + error report) ---");

// 6a: a batch appears in the list with the right status and counts. Use
// cleanImport (layer 4, recoTenantId) — a known-clean batch: status
// completed, 2 created, 2 memberships assigned, 0 failures.
{
  const list = await json(`/api/tenants/${recoTenantId}/members/import/batches`, { headers: auth });
  check("batch list request succeeds", list.status === 200, JSON.stringify(list.body).slice(0, 200));
  check("batch list returns an array", Array.isArray(list.body.batches), JSON.stringify(list.body).slice(0, 200));
  const found = (list.body.batches || []).find((b) => b.id === cleanImport.body.batch_id);
  check("clean import's batch appears in the list", !!found, JSON.stringify(list.body.batches).slice(0, 400));
  check("listed batch has the right status", found?.status === "completed", JSON.stringify(found));
  check("listed batch has the right created_count", found?.created_count === 2, JSON.stringify(found));
  check("listed batch has the right memberships_assigned", found?.memberships_assigned === 2, JSON.stringify(found));

  // Newest first: cleanImport ran before forced, forced ran before
  // forcedOff (all on recoTenantId, all earlier in this file) — the most
  // recently started batch in the list must be the LAST one created in
  // this file's run (n4d, right above this section), not cleanImport.
  const startedTimes = (list.body.batches || []).map((b) => b.started_at);
  const sorted = [...startedTimes].sort().reverse();
  check("batch list is ordered newest-first by started_at",
    JSON.stringify(startedTimes) === JSON.stringify(sorted), JSON.stringify(startedTimes));
}

// 6b: the errors endpoint returns exactly the rows Task 3 recorded. `forced`
// (layer 4, recoTenantId) has 2 membership_failed errors at rows 1 and 2,
// already asserted against forced.body.errors above — this proves the
// SAME facts are readable back from the persisted batch, not just the
// one-shot response.
{
  const errResp = await json(
    `/api/tenants/${recoTenantId}/members/import/batches/${forced.body.batch_id}/errors`,
    { headers: auth }
  );
  check("batch errors request succeeds", errResp.status === 200, JSON.stringify(errResp.body).slice(0, 200));
  const errs = errResp.body.errors || [];
  check("errors endpoint returns an uncapped full list (2 rows, not fewer)", errs.length === 2, JSON.stringify(errs));
  const byRow = new Map(errs.map((e) => [e.row_number, e]));
  check("errors endpoint reports row 1 as membership_failed for forced1",
    byRow.get(1)?.kind === "membership_failed" && byRow.get(1)?.email === "forced1@example.test",
    JSON.stringify(errs));
  check("errors endpoint reports row 2 as membership_failed for forced2",
    byRow.get(2)?.kind === "membership_failed" && byRow.get(2)?.email === "forced2@example.test",
    JSON.stringify(errs));
  check("error_kind_labels is present and reuses the server's label map",
    errResp.body.error_kind_labels?.membership_failed === "membership(s) failed to assign",
    JSON.stringify(errResp.body.error_kind_labels));
}

// 6c: a batch id belonging to another tenant returns 404, not that
// tenant's data. Create a second, genuinely separate tenant and request
// recoTenantId's batch through it.
{
  const otherTenant = await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `Other ${stamp}`, slug: `other-${stamp}` }),
  });
  const otherTenantId = otherTenant.body.id;

  const crossList = await json(
    `/api/tenants/${otherTenantId}/members/import/batches/${cleanImport.body.batch_id}/errors`,
    { headers: auth }
  );
  check("cross-tenant batch lookup returns 404, not another tenant's data",
    crossList.status === 404, `got ${crossList.status} ${JSON.stringify(crossList.body).slice(0, 200)}`);

  // The other tenant's own (empty) batch list must not include recoTenantId's batch.
  const otherBatches = await json(`/api/tenants/${otherTenantId}/members/import/batches`, { headers: auth });
  check("other tenant's batch list does not leak recoTenantId's batch",
    !(otherBatches.body.batches || []).some((b) => b.id === cleanImport.body.batch_id),
    JSON.stringify(otherBatches.body.batches));
}

// 6d: reachability check, NOT a route-ordering regression guard. It was
// originally written as one ("THE ROUTE-ORDERING TRAP") on the assumption
// that GET /:memberId would swallow "import" as a member id if the literal
// routes were ever registered after it. That assumption was tested (Task 4
// review, Finding B) by actually moving both /import/batches routes below
// /:memberId and re-running this suite -- this exact check still passed,
// because Hono's :memberId param only matches a single path segment and
// "/import/batches" is two, so /:memberId can never capture it either way.
// See the comment on memberRoutes.get("/import/batches", ...) in
// src/routes/members.ts for the actual (registration-order-independent)
// reasoning. This check still earns its keep as a plain sanity check that
// the endpoint resolves to a batch list at all.
{
  const reach = await json(`/api/tenants/${recoTenantId}/members/import/batches`, { headers: auth });
  check("/members/import/batches resolves to a batch list, not a member lookup",
    reach.status === 200 && Array.isArray(reach.body.batches) && reach.body.error === undefined,
    JSON.stringify(reach.body).slice(0, 200));
}

console.log("\n--- layer 7: Task 4 review Finding A -- column-level warnings must be surfaced in the history view, not silently dropped ---");

// migrations/0017_import_batch_warnings.sql names this exact scenario: a
// CSV with a data-carrying IGNORED column produces status='partial' with
// ZERO rows in import_batch_errors (unmapped_column is a column-level fact,
// not a per-row one). Before this fix, the batches list and errors
// endpoints fetched warnings_json from D1 but never returned a parsed
// `warnings` field to the client, so a guild looking at a 'partial' batch
// with an empty error CSV had no way to find out why.
{
  const warnHeader = ["Email", "First Name", "Last Name", "Committee Notes"];
  const warnMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "ignore" },
  };
  const warnRows = [["warncol@example.test", "Warn", "Col", "some data that will be dropped"]];

  const warnImport = await json(`/api/tenants/${recoTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: warnHeader, raw_rows: warnRows, mapping: warnMapping }),
  });
  check("import with a data-carrying ignored column succeeds", warnImport.status === 200,
    JSON.stringify(warnImport.body).slice(0, 200));
  check("import with a data-carrying ignored column reports partial",
    warnImport.body.status === "partial", `got ${warnImport.body.status}`);
  check("PRECONDITION: this exact scenario produces zero row-level errors (the gap Finding A is about)",
    (warnImport.body.errors || []).length === 0, JSON.stringify(warnImport.body.errors));
  check("PRECONDITION: the one-shot response DOES carry the warning (proves the loss is real, not double-counted)",
    (warnImport.body.warnings || []).some((w) => w.code === "unmapped_column" && w.header === "Committee Notes"),
    JSON.stringify(warnImport.body.warnings));

  // The history view (batch list) must carry a non-empty explanation for
  // this batch — not just the raw warnings_json column, a client-usable
  // parsed `warnings` array, the same shape the one-shot import response
  // already uses.
  const histList = await json(`/api/tenants/${recoTenantId}/members/import/batches`, { headers: auth });
  const histBatch = (histList.body.batches || []).find((b) => b.id === warnImport.body.batch_id);
  check("FINDING A: history list has a non-empty `warnings` array for this batch",
    Array.isArray(histBatch?.warnings) && histBatch.warnings.length > 0,
    JSON.stringify(histBatch));
  check("FINDING A: history list's warning names the dropped column",
    (histBatch?.warnings || []).some((w) => w.code === "unmapped_column" && w.header === "Committee Notes"),
    JSON.stringify(histBatch?.warnings));

  // The per-batch errors endpoint (what the "Download errors" button
  // drives) must ALSO carry the explanation — otherwise a guild who
  // downloads the CSV for this exact 'partial' batch gets a header-only
  // file with zero rows and no idea why the batch isn't 'completed'.
  const histErrors = await json(
    `/api/tenants/${recoTenantId}/members/import/batches/${warnImport.body.batch_id}/errors`,
    { headers: auth }
  );
  check("FINDING A: errors endpoint returns a non-empty `warnings` array too",
    Array.isArray(histErrors.body.warnings) && histErrors.body.warnings.length > 0,
    JSON.stringify(histErrors.body));
  check("FINDING A: errors endpoint's warning also names the dropped column",
    (histErrors.body.warnings || []).some((w) => w.code === "unmapped_column" && w.header === "Committee Notes"),
    JSON.stringify(histErrors.body.warnings));
}

console.log("\n--- layer 8: Task 4 review Finding C -- import_batches records who ran the import ---");

// actor_email is a SNAPSHOT captured at import time, not a live join to
// users.email — asserted here by checking it matches the harness account's
// email exactly (the only account this script authenticates as).
{
  const meResp = await json("/api/auth/me", { headers: auth });
  const actorEmail = meResp.body.user?.email;
  check("precondition: harness account email is readable", !!actorEmail, JSON.stringify(meResp.body));

  const list = await json(`/api/tenants/${recoTenantId}/members/import/batches`, { headers: auth });
  const found = (list.body.batches || []).find((b) => b.id === cleanImport.body.batch_id);
  check("FINDING C: listed batch records actor_email", found?.actor_email === actorEmail,
    JSON.stringify(found));
  check("FINDING C: listed batch records actor_user_id", !!found?.actor_user_id, JSON.stringify(found));
}

console.log("\n--- layer 9: a free-plan guild AT its cap re-importing its own roster must not demote its own actives (fix round 6) ---");

// The mirror image of layer 4k. There, a re-import that OMITTED the Status
// column silently REACTIVATED every lapsed member. Here, a re-import that
// INCLUDES Status=active silently DEACTIVATES every already-active member:
// a guild sitting exactly at FREE_ACTIVE_MEMBER_LIMIT starts the import
// with activeSlotsLeft === 0, and the no-level cap branch demoted every
// active row to 'pending' without ever asking whether that member was
// ALREADY active (and therefore consuming no NEW slot). The level-naming
// branch has always asked -- see the alreadyActive lookup there -- which is
// why 9c below passes on the unfixed code too and is a regression guard,
// not a reproduction.
const CAP = 30;
const capHeader = ["Email", "First Name", "Last Name", "Status"];
const capMapping = {
  0: { kind: "known", target: "email" },
  1: { kind: "known", target: "first_name" },
  2: { kind: "known", target: "last_name" },
  3: { kind: "known", target: "status" },
};

// A tenant on the ACTUAL free plan: new tenants get a 30-day trial, which
// counts as "starter" (unlimited) for plan-limit purposes. Same pattern as
// layer 4c above.
async function freePlanTenant(prefix) {
  const t = await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `${prefix} ${stamp}`, slug: `${prefix}-${stamp}` }),
  });
  d1Exec(`UPDATE tenants SET trial_ends_at = NULL WHERE id = '${t.body.id}';`);
  return t.body.id;
}

async function statusByEmail(tenantId) {
  const list = await json(`/api/tenants/${tenantId}/members?limit=200`, { headers: auth });
  return new Map((list.body.members || []).map((m) => [m.email, m.status]));
}

function countBy(values) {
  const o = {};
  for (const v of values) o[String(v)] = (o[String(v)] || 0) + 1;
  return o;
}

// --- 9a: the reproduction (no-level path) -------------------------------
{
  const capTenantId = await freePlanTenant("capdemo");
  const emails = Array.from({ length: CAP }, (_, i) => `cap-${stamp}-${i}@example.test`);
  const rows = emails.map((e, i) => [e, "Cap", `M${i}`, "active"]);

  const firstRun = await json(`/api/tenants/${capTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: capHeader, raw_rows: rows, mapping: capMapping }),
  });
  check("cap: first import fills the free plan to exactly its limit",
    firstRun.body.created === CAP, `got ${firstRun.body.created}`);
  const afterFirst = await statusByEmail(capTenantId);
  check("cap: all 30 are active after the first import",
    emails.every((e) => afterFirst.get(e) === "active"),
    JSON.stringify(countBy(emails.map((e) => afterFirst.get(e)))));

  // The unchanged roster, re-imported. Nothing about it asks for anything
  // new: every row is an existing member who is ALREADY active.
  const reRun = await json(`/api/tenants/${capTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: capHeader, raw_rows: rows, mapping: capMapping }),
  });
  check("cap: re-import updates all 30 and creates none",
    reRun.body.created === 0 && reRun.body.updated === CAP,
    `created=${reRun.body.created} updated=${reRun.body.updated}`);
  const afterRe = await statusByEmail(capTenantId);
  check("THE BUG: already-active members are STILL active after an unchanged re-import at the cap",
    emails.every((e) => afterRe.get(e) === "active"),
    JSON.stringify(countBy(emails.map((e) => afterRe.get(e)))));
  // An already-active member is not being HELD BACK -- nothing is being
  // denied them, they keep exactly the status they had. Counting them as
  // plan_limited would also make this clean re-import 'partial' (the status
  // predicate treats plan_limited > 0 as partial) for no reason.
  check("cap: an unchanged re-import reports no plan-limited rows",
    reRun.body.plan_limited === 0, `got ${reRun.body.plan_limited}`);
  check("cap: an unchanged re-import records no plan_limited error rows",
    (reRun.body.errors || []).filter((e) => e.kind === "plan_limited").length === 0,
    JSON.stringify(reRun.body.errors));
  check("cap: an unchanged re-import reports completed, not partial",
    reRun.body.status === "completed", `got ${reRun.body.status}`);

  // --- 9b: the cap must STILL bite for genuinely new actives -------------
  // The fix exempts members who are already active. It must not exempt a
  // member who is actually being MOVED to active while the plan is full --
  // that is a real new active and the whole point of the cap.
  const lapsedAtCapEmail = `caplapsed-${stamp}@example.test`;
  await json(`/api/tenants/${capTenantId}/members`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ email: lapsedAtCapEmail, first_name: "Cap", last_name: "Lapsed",
                           status: "lapsed" }),
  });
  const newcomerEmail = `capnew-${stamp}@example.test`;
  const mixedRows = [
    ...rows,
    [lapsedAtCapEmail, "Cap", "Lapsed", "active"],
    [newcomerEmail, "Cap", "Newcomer", "active"],
  ];
  const mixedRun = await json(`/api/tenants/${capTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: capHeader, raw_rows: mixedRows, mapping: capMapping }),
  });
  const afterMixed = await statusByEmail(capTenantId);
  check("cap still bites: a LAPSED member asked to go active at a full cap is held at pending",
    afterMixed.get(lapsedAtCapEmail) === "pending",
    `got ${afterMixed.get(lapsedAtCapEmail)}`);
  check("cap still bites: a BRAND-NEW active member at a full cap is held at pending",
    afterMixed.get(newcomerEmail) === "pending", `got ${afterMixed.get(newcomerEmail)}`);
  check("cap still bites: exactly the 2 genuinely-new actives are counted plan_limited, not all 32",
    mixedRun.body.plan_limited === 2, `got ${mixedRun.body.plan_limited}`);
  check("cap still bites: both held rows are itemized as downloadable plan_limited errors",
    (mixedRun.body.errors || []).filter((e) => e.kind === "plan_limited").length === 2,
    JSON.stringify((mixedRun.body.errors || []).filter((e) => e.kind === "plan_limited")));
  check("cap still bites: a genuinely plan-limited import is partial",
    mixedRun.body.status === "partial", `got ${mixedRun.body.status}`);
  check("cap still bites: the 30 untouched actives are STILL active in that same mixed import",
    emails.every((e) => afterMixed.get(e) === "active"),
    JSON.stringify(countBy(emails.map((e) => afterMixed.get(e)))));
}

// --- 9c: the level-naming path (regression guard, already correct) -------
// This path consults the member's current status before spending a slot, so
// it never had the defect. Locked down so a future edit to the shared cap
// accounting can't introduce it here.
{
  const capLvlTenantId = await freePlanTenant("capdemolvl");
  await json(`/api/tenants/${capLvlTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });
  const lvlHeader = ["Email", "First Name", "Last Name", "Level"];
  const lvlMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
  };
  const lvlEmails = Array.from({ length: CAP }, (_, i) => `caplvl-${stamp}-${i}@example.test`);
  const lvlRows = lvlEmails.map((e, i) => [e, "Cap", `L${i}`, "Annual Membership"]);

  const lvlFirst = await json(`/api/tenants/${capLvlTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: lvlHeader, raw_rows: lvlRows, mapping: lvlMapping }),
  });
  check("cap/level: first import fills the plan and assigns all 30 memberships",
    lvlFirst.body.created === CAP && lvlFirst.body.memberships_assigned === CAP,
    JSON.stringify(lvlFirst.body).slice(0, 200));

  const lvlRe = await json(`/api/tenants/${capLvlTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: lvlHeader, raw_rows: lvlRows, mapping: lvlMapping }),
  });
  const afterLvl = await statusByEmail(capLvlTenantId);
  check("cap/level: already-active members stay active on an unchanged re-import",
    lvlEmails.every((e) => afterLvl.get(e) === "active"),
    JSON.stringify(countBy(lvlEmails.map((e) => afterLvl.get(e)))));
  check("cap/level: unchanged re-import reports no plan-limited rows",
    lvlRe.body.plan_limited === 0, `got ${lvlRe.body.plan_limited}`);
  // The invariant this whole area rests on (layer 4c): every row naming a
  // real level is accounted for by exactly one of assigned / failed /
  // plan-limited. A renewal re-import at a full cap is the case where an
  // exemption could silently drop rows out of all three counters.
  //
  // The response's `plan_limited` is an AGGREGATE of BOTH cap branches, so
  // it is only a valid term in this level-scoped invariant while no
  // no-level row can contribute to it. Rather than rely on this fixture
  // having no Status column (true today, one edit away from silently
  // false), count the level branch's own rows: the two branches push
  // distinguishable reasons -- "membership not assigned" (level) vs
  // "imported as pending instead of active" (no level).
  const lvlPlanLimited = (lvlRe.body.errors || []).filter(
    (e) => e.kind === "plan_limited" && e.reason.includes("membership not assigned")
  ).length;
  check("cap/level: no no-level plan-limited rows leaked into this level-only fixture",
    lvlPlanLimited === lvlRe.body.plan_limited,
    `level-branch=${lvlPlanLimited} aggregate=${lvlRe.body.plan_limited}`);
  check("cap/level: the accounting invariant still holds on a renewal re-import at a full cap",
    (lvlRe.body.memberships_assigned + lvlRe.body.membership_failures +
      lvlPlanLimited) === CAP,
    `assigned=${lvlRe.body.memberships_assigned} failed=${lvlRe.body.membership_failures} ` +
      `plan_limited(level)=${lvlPlanLimited} expected=${CAP}`);
}

// --- 9d: the PREVIEW must predict the same number of holds the apply path
// actually performs, on a MIXED file (fix round 6, review round 2) ---------
//
// 9a-9c only ever exercised single-shape files, so neither the estimate's
// old form (count every row wanting active, ignore who is already active)
// nor its first corrected form (which excluded an existing member whose
// Status cell is blank -- correct for a status-only file, badly wrong for a
// renewal file) was ever compared against what the import then did.
//
// The dangerous shape is a renewal export: existing LAPSED members, a Level
// column, no Status column. Those rows name a level, so the apply path's
// LEVEL branch forces them active and holds them at a full cap -- but they
// express no status opinion, so a predicate keyed on the Status column
// alone scores them as "wants nothing" and predicts zero holds. A guild
// shown "nothing will be held" who then has 7 members held is worse off
// than one shown an over-estimate.
//
// Level rows also consume slots from the SAME counter, in file order, so
// the two row kinds cannot be estimated independently -- hence one mixed
// file with all three kinds interleaved, competing for 3 remaining slots.
{
  const mixTenantId = await freePlanTenant("capmixed");
  await json(`/api/tenants/${mixTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });

  // 22 actives that are NOT in the file + 5 that are = 27 active, so the
  // free plan has exactly 3 slots left when the import starts.
  const FILLER = 22;
  for (let i = 0; i < FILLER; i++) {
    const r = await json(`/api/tenants/${mixTenantId}/members`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ email: `mixfill-${stamp}-${i}@example.test`, status: "active" }),
    });
    if (r.status >= 400) throw new Error(`mixed filler ${i} failed: ${JSON.stringify(r.body)}`);
  }
  const activeEmails = Array.from({ length: 5 }, (_, i) => `mixactive-${stamp}-${i}@example.test`);
  for (const e of activeEmails) {
    await json(`/api/tenants/${mixTenantId}/members`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ email: e, first_name: "Mix", last_name: "Active", status: "active" }),
    });
  }
  const lapsedEmails = Array.from({ length: 5 }, (_, i) => `mixlapsed-${stamp}-${i}@example.test`);
  for (const e of lapsedEmails) {
    await json(`/api/tenants/${mixTenantId}/members`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ email: e, first_name: "Mix", last_name: "Lapsed", status: "lapsed" }),
    });
  }
  const newEmails = Array.from({ length: 5 }, (_, i) => `mixnew-${stamp}-${i}@example.test`);

  const SLOTS_LEFT = 3;
  const preCount = await json(`/api/tenants/${mixTenantId}/members?limit=200&status=active`, { headers: auth });
  check("mixed: precondition -- exactly 27 active members, so 3 free-plan slots remain",
    (preCount.body.members || []).length === CAP - SLOTS_LEFT,
    `got ${(preCount.body.members || []).length}`);

  // ["Email", "First Name", "Last Name", "Status", "Level"]
  const mixHeader = ["Email", "First Name", "Last Name", "Status", "Level"];
  const mixMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "status" },
    4: { kind: "known", target: "level_name" },
  };
  // Interleaved so the three kinds genuinely compete for the 3 slots: an
  // already-active row first (must consume nothing), then a lapsed renewal,
  // then a newcomer, and so on. Two of the already-active rows arrive as
  // renewals (Level, blank Status) and three as plain Status=active rows,
  // so BOTH cap branches see an already-active member.
  const mixRows = [];
  for (let i = 0; i < 5; i++) {
    mixRows.push(i % 2 === 0
      ? [activeEmails[i], "Mix", "Active", "active", ""]
      : [activeEmails[i], "Mix", "Active", "", "Annual Membership"]);
    mixRows.push([lapsedEmails[i], "Mix", "Lapsed", "", "Annual Membership"]);
    mixRows.push([newEmails[i], "Mix", "New", "active", ""]);
  }

  // 10 rows would make someone NEWLY active (5 lapsed renewals + 5
  // newcomers); the 5 already-active rows ask for nothing. 10 - 3 = 7.
  const EXPECTED_HELD = 7;

  const mixDry = await json(`/api/tenants/${mixTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: mixHeader, raw_rows: mixRows, mapping: mixMapping, dry_run: true }),
  });
  const planWarn = (mixDry.body.warnings || []).find((w) => w.code === "plan_limit_will_hold");
  const predictedHeld = planWarn?.count ?? 0;

  const mixRun = await json(`/api/tenants/${mixTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: mixHeader, raw_rows: mixRows, mapping: mixMapping }),
  });
  const actuallyHeld = mixRun.body.plan_limited;

  console.log(`      mixed file: preview predicted ${predictedHeld} held, apply held ${actuallyHeld}`);
  check("mixed: the apply path holds exactly the 7 rows that would be newly active beyond the 3 free slots",
    actuallyHeld === EXPECTED_HELD, `got ${actuallyHeld}`);
  // THE ASSERTION. A preview that under-predicts is a false reassurance:
  // the guild is told nothing (or almost nothing) will be held, commits,
  // and finds members held anyway.
  check("THE REGRESSION: the dry-run prediction equals the number the apply path actually holds",
    predictedHeld === actuallyHeld, `preview predicted ${predictedHeld}, apply held ${actuallyHeld}`);
  check("mixed: the preview names the same count in its plan_limit_will_hold warning",
    predictedHeld === EXPECTED_HELD, `got ${predictedHeld}`);

  const mixStatuses = await statusByEmail(mixTenantId);
  check("mixed: none of the 5 already-active members were demoted",
    activeEmails.every((e) => mixStatuses.get(e) === "active"),
    JSON.stringify(countBy(activeEmails.map((e) => mixStatuses.get(e)))));
  check("mixed: none of the 5 already-active members were counted as held",
    (mixRun.body.errors || []).filter(
      (e) => e.kind === "plan_limited" && activeEmails.includes(e.email)).length === 0,
    JSON.stringify((mixRun.body.errors || []).filter((e) => e.kind === "plan_limited")));
  // Exactly 3 of the 10 candidates got the 3 remaining slots.
  const candidates = [...lapsedEmails, ...newEmails];
  const nowActive = candidates.filter((e) => mixStatuses.get(e) === "active");
  check("mixed: exactly the 3 remaining slots were spent -- 3 of the 10 candidates ended up active",
    nowActive.length === SLOTS_LEFT,
    `${nowActive.length} became active: ${JSON.stringify(nowActive)}`);
  check("mixed: every held row is itemized as a downloadable plan_limited error",
    (mixRun.body.errors || []).filter((e) => e.kind === "plan_limited").length === EXPECTED_HELD,
    JSON.stringify((mixRun.body.errors || []).filter((e) => e.kind === "plan_limited")));
}

console.log("\n--- layer 10: a roster with a Level column and a historical \"Member Since\" but NO expiry column must not import everyone already expired (fix round 7) ---");

// THE MOST LIKELY REAL MIGRATION FILE. A Wild Apricot roster exports a
// membership Level and a "Member Since" date; plenty of guilds' exports
// carry no renewal/expiry column at all.
//
// The chain that made that a silent disaster:
//   1. members.ts gates expiry parsing on `if (endRaw)`; an absent column
//      leaves endDate === undefined.
//   2. the row's `joined_at` (the HISTORICAL join date) is passed to
//      activateMembership as startDate.
//   3. activateMembership computed end = startDate + duration_months, so a
//      2019 join date produced an end date in 2020 -- already in the past --
//      AFTER expireActiveMemberships had already ended the member's real
//      membership window.
//   4. the nightly cron (src/lib/renewals.ts) expires every active
//      membership with date(end_date) < date(today) and flips the member to
//      `lapsed`, firing the lapse/win-back email.
//   5. nothing warned: there was no level_without_end_date code, and
//      end_date_without_level covers only the inverse case AND lives inside
//      the `if (endRaw)` guard -- so the import (and the dry run) reported
//      `completed` with zero errors and zero warnings.
//
// The guild is told "completed, nothing lost", then its entire roster
// lapses overnight. Both halves are asserted below: the end date, and the
// silence.
{
  const backdateTenantId = (await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `Backdate ${stamp}`, slug: `backdate-${stamp}` }),
  })).body.id;
  await json(`/api/tenants/${backdateTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });

  // Exactly the WA shape: Level present, Member Since present, NO expiry
  // column anywhere in the header.
  const bdHeader = ["Email", "First Name", "Last Name", "Member Since", "Level"];
  const bdMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "joined_at" },
    4: { kind: "known", target: "level_name" },
  };
  const bdEmail = `backdate1-${stamp}@example.test`;
  const bdRows = [[bdEmail, "Back", "Date", "2019-03-02", "Annual Membership"]];

  // The dry run tells the same story the apply does -- it must not promise
  // a clean, decision-free import either.
  const bdDry = await json(`/api/tenants/${backdateTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: bdHeader, raw_rows: bdRows, mapping: bdMapping, dry_run: true }),
  });
  check("dry run of a level-without-expiry roster says a renewal date will be chosen",
    (bdDry.body.warnings || []).some((w) => w.code === "level_without_end_date"),
    JSON.stringify(bdDry.body.warnings));

  const bdRun = await json(`/api/tenants/${backdateTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: bdHeader, raw_rows: bdRows, mapping: bdMapping }),
  });
  check("backdated-roster import creates the member and assigns the membership",
    bdRun.body.created === 1 && bdRun.body.memberships_assigned === 1,
    JSON.stringify(bdRun.body));

  // (a) THE DATA BUG. Read end_date straight out of D1 -- this is the value
  // renewals.ts's `date(end_date) < date(?)` sweep reads tonight.
  const bdMembership = d1Query(
    `SELECT m.start_date, m.end_date, m.status, mem.joined_at
     FROM memberships m JOIN members mem ON mem.id = m.member_id
     WHERE m.tenant_id = '${backdateTenantId}' AND mem.email = '${bdEmail}'
       AND m.status = 'active'`
  );
  check("precondition: exactly one active membership row was written",
    bdMembership.length === 1, JSON.stringify(bdMembership));
  const bdEnd = bdMembership[0]?.end_date;
  const todayIso = new Date().toISOString().slice(0, 10);
  check(`THE BUG (a): the membership end date is NOT already in the past (end_date=${bdEnd}, today=${todayIso})`,
    !!bdEnd && String(bdEnd).slice(0, 10) > todayIso,
    `end_date=${bdEnd} today=${todayIso} -- a 2019 join date + 12-month term computed from the JOIN DATE lands in 2020`);
  // The same sweep renewals.ts runs, expressed as SQL so this is the
  // database's own answer, not JavaScript's opinion of the string.
  const wouldLapse = d1Query(
    `SELECT count(*) as n FROM memberships
     WHERE tenant_id = '${backdateTenantId}' AND status = 'active'
       AND date(end_date) < date('now')`
  );
  check("THE BUG (a'): tonight's renewal cron would lapse nobody from this import",
    Number(wouldLapse[0]?.n) === 0, JSON.stringify(wouldLapse));

  // (b) THE SILENCE. Not "must be partial" -- level_without_end_date is
  // deliberately informational (see LOSSY_WARNING_CODES): after the fix
  // nothing is lost, so forcing `partial` on the single most common
  // migration shape would only teach admins that `partial` means nothing.
  // What must never happen again is a CLEAN completed: completed AND no
  // warnings AND no per-row errors, i.e. the guild is told we changed
  // nothing and decided nothing.
  const bdWarn = (bdRun.body.warnings || []);
  const bdErrs = (bdRun.body.errors || []);
  check("THE BUG (b): the batch does NOT report a clean `completed` (no warnings, no errors)",
    !(bdRun.body.status === "completed" && bdWarn.length === 0 && bdErrs.length === 0),
    `status=${bdRun.body.status} warnings=${JSON.stringify(bdWarn)} errors=${JSON.stringify(bdErrs)}`);
  check("the guild is told a renewal date was chosen for them (warning)",
    bdWarn.some((w) => w.code === "level_without_end_date"), JSON.stringify(bdWarn));
  check("the guild can see WHICH date we chose, per row, downloadable",
    bdErrs.some((e) => e.kind === "level_without_end_date" && e.row_number === 1 &&
      e.email === bdEmail && e.reason.includes(String(bdEnd).slice(0, 10))),
    JSON.stringify(bdErrs));
  check("the chosen-date decision is informational, not a loss: the batch is still `completed`",
    bdRun.body.status === "completed", `got ${bdRun.body.status}`);

  // The join date itself is the guild's own correct data and must survive
  // untouched -- only the TERM was wrong.
  check("`member since` is preserved on the member record (2019-03-02)",
    String(bdMembership[0]?.joined_at || "").startsWith("2019-03-02"),
    JSON.stringify(bdMembership[0]));
  check("the membership record still carries the guild's historical start date",
    String(bdMembership[0]?.start_date || "").startsWith("2019-03-02"),
    JSON.stringify(bdMembership[0]));

  // An explicit expiry in the file is still authoritative -- the fix must
  // only affect the COMPUTED fallback, never override a date the guild gave.
  const bdExplicitEmail = `backdateexplicit1-${stamp}@example.test`;
  const bdExplicitHeader = [...bdHeader, "Renewal"];
  const bdExplicitMapping = { ...bdMapping, 5: { kind: "known", target: "end_date" } };
  const bdExplicitRun = await json(`/api/tenants/${backdateTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      header: bdExplicitHeader,
      raw_rows: [[bdExplicitEmail, "Back", "Explicit", "2019-03-02", "Annual Membership", "2020-03-02"]],
      mapping: bdExplicitMapping,
    }),
  });
  check("an explicit (even past) expiry in the file is still honoured verbatim, not overridden",
    String(d1Query(
      `SELECT m.end_date FROM memberships m JOIN members mem ON mem.id = m.member_id
       WHERE m.tenant_id = '${backdateTenantId}' AND mem.email = '${bdExplicitEmail}'
         AND m.status = 'active'`
    )[0]?.end_date || "").startsWith("2020-03-02"),
    JSON.stringify(bdExplicitRun.body));
  check("a row that supplied its own expiry gets no level_without_end_date signal",
    !(bdExplicitRun.body.errors || []).some((e) => e.kind === "level_without_end_date"),
    JSON.stringify(bdExplicitRun.body.errors));

  // A FUTURE start date is a deliberate input (a term that begins next
  // month), and max(startDate, now) must leave it alone rather than
  // shortening the term to end 12 months from today.
  const bdFutureEmail = `backdatefuture1-${stamp}@example.test`;
  const futureStart = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await json(`/api/tenants/${backdateTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      header: bdHeader,
      raw_rows: [[bdFutureEmail, "Back", "Future", futureStart, "Annual Membership"]],
      mapping: bdMapping,
    }),
  });
  const bdFutureEnd = String(d1Query(
    `SELECT m.end_date FROM memberships m JOIN members mem ON mem.id = m.member_id
     WHERE m.tenant_id = '${backdateTenantId}' AND mem.email = '${bdFutureEmail}'
       AND m.status = 'active'`
  )[0]?.end_date || "").slice(0, 10);
  check("a FUTURE start date keeps its full term (measured from the start, not from today)",
    bdFutureEnd > String(bdEnd).slice(0, 10),
    `future-start end=${bdFutureEnd} today-start end=${String(bdEnd).slice(0, 10)}`);
}

console.log("\n--- layer 11: our own export must be safely re-importable -- a dead membership's level is not a current level (fix round 7) ---");

// members/export.csv used to emit `level` from the member's most recent
// membership of ANY status. importMapping auto-maps a `level` header to
// level_name, and the import treats a resolved level as an instruction to
// ACTIVATE (status_overridden_by_level). So exporting a roster and
// re-importing it reactivated every lapsed and cancelled member -- the
// exact "import your own roster as often as you like" promise the admin
// guide used to make.
{
  const expTenantId = (await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `Export RT ${stamp}`, slug: `exportrt-${stamp}` }),
  })).body.id;
  await json(`/api/tenants/${expTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });

  // A member who HAD a membership and has since lapsed: import with a
  // level (creates an active membership), then lapse them the way the
  // renewal cron does -- membership expired, member lapsed.
  const rtHeader = ["Email", "First Name", "Last Name", "Level"];
  const rtMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
  };
  const rtEmail = `exportrt1-${stamp}@example.test`;
  await json(`/api/tenants/${expTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: rtHeader, raw_rows: [[rtEmail, "Export", "Lapsed", "Annual Membership"]], mapping: rtMapping }),
  });
  d1Exec(
    `UPDATE memberships SET status = 'expired' WHERE tenant_id = '${expTenantId}';
     UPDATE members SET status = 'lapsed' WHERE tenant_id = '${expTenantId}' AND email = '${rtEmail}';`
  );

  const exportRes = await fetch(`${BASE}/api/tenants/${expTenantId}/members/export.csv`, { headers: auth });
  const exportCsv = await exportRes.text();
  const exportRows = parseCsv(exportCsv);
  const expHeader = exportRows[0];
  const expDataRows = exportRows.slice(1);
  const levelCol = expHeader.indexOf("level");
  const statusCol = expHeader.indexOf("status");
  const endCol = expHeader.indexOf("end_date");
  check("export has level, status and end_date columns", levelCol > -1 && statusCol > -1 && endCol > -1,
    JSON.stringify(expHeader));
  const rtRow = expDataRows.find((r) => r[0] === rtEmail);
  check("precondition: the exported member really is lapsed", rtRow?.[statusCol] === "lapsed",
    JSON.stringify(rtRow));
  check("THE BUG: a lapsed member's export carries NO level (a dead membership's level is not a current one)",
    rtRow?.[levelCol] === "", JSON.stringify(rtRow));
  check("a lapsed member's export carries no end_date either (nothing for the import to attach)",
    rtRow?.[endCol] === "", JSON.stringify(rtRow));

  // The promise the admin guide makes, tested end to end: feed our own
  // export straight back in through the auto-proposed mapping.
  const { mapping: rtProposed } = proposeMapping(expHeader, []);
  check("our own export's `level` header still auto-maps to level_name (the mapping is not the fix)",
    rtProposed[levelCol]?.target === "level_name", JSON.stringify(rtProposed[levelCol]));
  const roundTrip = await json(`/api/tenants/${expTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: expHeader, raw_rows: expDataRows, mapping: rtProposed }),
  });
  const rtAfter = await json(
    `/api/tenants/${expTenantId}/members?q=${encodeURIComponent(rtEmail)}`, { headers: auth });
  check("THE BUG: re-importing our own export leaves the lapsed member LAPSED, not reactivated",
    (rtAfter.body.members || [])[0]?.status === "lapsed",
    JSON.stringify({ import: roundTrip.body, member: rtAfter.body.members }));
  check("re-importing our own export assigns no membership to the lapsed member",
    roundTrip.body.memberships_assigned === 0, JSON.stringify(roundTrip.body));
}

console.log("\n--- layer 12: a Level-only re-import must never shorten or erase a membership already on record (fix round 8, critical 1) ---");

// The fix in layer 10 chose a renewal date when the FILE had none. It did
// not ask what was already in the DATABASE. activateMembership expires the
// member's current membership and writes a fresh term ending
// max(joined_at, now) + duration, consulting nothing -- so a guild that
// imported a proper roster with expiry dates (memberships running to 2029)
// and a month later re-imports a hand-maintained Level-only sheet sees a
// green "Import complete", status `completed`, and a per-row reason
// announcing a renewal date two years EARLIER, with ~2 years of paid
// membership silently deleted and no mention of what it replaced.
//
// "Nothing from the file is discarded" was true of the file and false of
// the database. Rule now enforced: when the row supplies no usable end
// date and the member already has an active membership ending LATER than
// the computed term (or with NO end date at all), the existing date wins.
{
  const keepTenantId = (await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `Keep ${stamp}`, slug: `keep-${stamp}` }),
  })).body.id;
  await json(`/api/tenants/${keepTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });

  const withExpiryHeader = ["Email", "First Name", "Last Name", "Level", "Renewal"];
  const withExpiryMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
    4: { kind: "known", target: "end_date" },
  };
  const levelOnlyHeader = ["Email", "First Name", "Last Name", "Level"];
  const levelOnlyMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
  };
  const activeEndFor = (email) => d1Query(
    `SELECT m.end_date, m.status FROM memberships m JOIN members mem ON mem.id = m.member_id
     WHERE m.tenant_id = '${keepTenantId}' AND mem.email = '${email}' AND m.status = 'active'`
  )[0];

  // 12a: the headline case. A membership running to 2029, then a Level-only
  // re-import.
  const keepEmail = `keeplater1-${stamp}@example.test`;
  await json(`/api/tenants/${keepTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: withExpiryHeader,
      raw_rows: [[keepEmail, "Keep", "Later", "Annual Membership", "2029-06-01"]],
      mapping: withExpiryMapping }),
  });
  check("12a precondition: the first import stored the guild's own 2029 expiry",
    String(activeEndFor(keepEmail)?.end_date || "").startsWith("2029-06-01"),
    JSON.stringify(activeEndFor(keepEmail)));

  const keepRun = await json(`/api/tenants/${keepTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: levelOnlyHeader,
      raw_rows: [[keepEmail, "Keep", "Later", "Annual Membership"]],
      mapping: levelOnlyMapping }),
  });
  check("12a: a Level-only re-import still updates the member and assigns a membership",
    keepRun.body.updated === 1 && keepRun.body.memberships_assigned === 1,
    JSON.stringify(keepRun.body));
  check("THE BUG (12a): ~2 years of paid membership is NOT deleted -- the 2029 expiry survives a Level-only re-import",
    String(activeEndFor(keepEmail)?.end_date || "").startsWith("2029-06-01"),
    `end_date is now ${activeEndFor(keepEmail)?.end_date}`);
  check("12a: the per-row record says the existing date was KEPT, and names it",
    (keepRun.body.errors || []).some(
      (e) => e.kind === "level_without_end_date" && e.email === keepEmail &&
        /kept/i.test(e.reason) && e.reason.includes("2029-06-01")),
    JSON.stringify(keepRun.body.errors));

  // 12b: variant (a) -- an OPEN-ENDED membership (end_date IS NULL). It is
  // creatable through the admin route with end_date:"" and is never lapsed
  // by the cron, because `date(end_date) < date(?)` is NULL-safe. It
  // exports with a BLANK end_date but a populated level, so it comes back
  // through the importer looking exactly like a Level-only row -- and used
  // to return as a 12-month term, which is what falsified the "our export
  // is safe to re-import" promise.
  const openEmail = `keepopen1-${stamp}@example.test`;
  const openMember = await json(`/api/tenants/${keepTenantId}/members`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ email: openEmail, first_name: "Keep", last_name: "Open", status: "active" }),
  });
  const openLevelId = (await json(`/api/tenants/${keepTenantId}/levels`, { headers: auth }))
    .body.find((l) => l.name === "Annual Membership").id;
  await json(`/api/tenants/${keepTenantId}/members/${openMember.body.id}/memberships`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ level_id: openLevelId, end_date: "", amount_paid_cents: 0 }),
  });
  check("12b precondition: an open-ended membership really has end_date NULL",
    activeEndFor(openEmail) && activeEndFor(openEmail).end_date === null,
    JSON.stringify(activeEndFor(openEmail)));

  const openRun = await json(`/api/tenants/${keepTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: levelOnlyHeader,
      raw_rows: [[openEmail, "Keep", "Open", "Annual Membership"]],
      mapping: levelOnlyMapping }),
  });
  check("THE BUG (12b): an open-ended membership stays open-ended -- it is not given a 12-month term",
    activeEndFor(openEmail) && activeEndFor(openEmail).end_date === null,
    `end_date is now ${JSON.stringify(activeEndFor(openEmail))} (import: ${JSON.stringify(openRun.body)})`);
  check("12b: the per-row record says the open-ended membership was kept as is",
    (openRun.body.errors || []).some(
      (e) => e.kind === "level_without_end_date" && e.email === openEmail && /kept/i.test(e.reason)),
    JSON.stringify(openRun.body.errors));

  // 12c: the rule must NOT block a genuine renewal. An existing membership
  // ending BEFORE the computed term is extended, exactly as before.
  const renewEmail = `keeprenew1-${stamp}@example.test`;
  const soon = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await json(`/api/tenants/${keepTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: withExpiryHeader,
      raw_rows: [[renewEmail, "Keep", "Renew", "Annual Membership", soon]],
      mapping: withExpiryMapping }),
  });
  await json(`/api/tenants/${keepTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: levelOnlyHeader,
      raw_rows: [[renewEmail, "Keep", "Renew", "Annual Membership"]],
      mapping: levelOnlyMapping }),
  });
  check("12c: an EARLIER existing expiry is still extended to a full term -- the rule never blocks a renewal",
    String(activeEndFor(renewEmail)?.end_date || "").slice(0, 10) > soon,
    `soon=${soon} end_date=${activeEndFor(renewEmail)?.end_date}`);

  // 12d: variant (b) -- the export truncates end_date to YYYY-MM-DD, so a
  // straight round trip re-parses it as UTC midnight and silently moves the
  // expiry earlier by the time-of-day. Same calendar day => keep the stored
  // instant.
  const todEmail = `keeptod1-${stamp}@example.test`;
  const todMember = await json(`/api/tenants/${keepTenantId}/members`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ email: todEmail, first_name: "Keep", last_name: "Tod", status: "active" }),
  });
  await json(`/api/tenants/${keepTenantId}/members/${todMember.body.id}/memberships`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ level_id: openLevelId, end_date: "2029-06-01T14:30:00.000Z", amount_paid_cents: 0 }),
  });
  const todBefore = activeEndFor(todEmail)?.end_date;
  await json(`/api/tenants/${keepTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: withExpiryHeader,
      raw_rows: [[todEmail, "Keep", "Tod", "Annual Membership", "2029-06-01"]],
      mapping: withExpiryMapping }),
  });
  check("THE BUG (12d): a same-calendar-day round trip keeps the stored time of day, not UTC midnight",
    activeEndFor(todEmail)?.end_date === todBefore,
    `before=${todBefore} after=${activeEndFor(todEmail)?.end_date}`);

  // 12e: a genuinely different date in the file still wins outright -- the
  // preservation rule must never override a date the guild actually typed.
  await json(`/api/tenants/${keepTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: withExpiryHeader,
      raw_rows: [[keepEmail, "Keep", "Later", "Annual Membership", "2027-01-15"]],
      mapping: withExpiryMapping }),
  });
  check("12e: an explicit, EARLIER date the guild typed still wins over the later stored one",
    String(activeEndFor(keepEmail)?.end_date || "").startsWith("2027-01-15"),
    JSON.stringify(activeEndFor(keepEmail)));
}

console.log("\n--- layer 13: a hand-lapsed member must not be resurrected by a round trip (fix round 8, critical 2) ---");

// The export filter added in fix round 7 assumed an invariant that did not
// hold: PATCH /:memberId writes members.status ONLY, never memberships. So
// an admin who marks someone lapsed by hand (or a status-only import row)
// leaves memberships.status = 'active'; the export then still emits their
// level AND end_date, and re-importing resolves the level and reactivates
// them -- resurrecting precisely the people an admin lapsed deliberately.
// Fixed at the invariant, not at the export.
{
  const invTenantId = (await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `Invariant ${stamp}`, slug: `invariant-${stamp}` }),
  })).body.id;
  await json(`/api/tenants/${invTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });
  const invHeader = ["Email", "First Name", "Last Name", "Level"];
  const invMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
  };
  const membershipStatuses = (email) => d1Query(
    `SELECT m.status FROM memberships m JOIN members mem ON mem.id = m.member_id
     WHERE m.tenant_id = '${invTenantId}' AND mem.email = '${email}'`
  ).map((r) => r.status);

  // 13a: admin marks a member lapsed BY HAND via PATCH.
  const patchEmail = `invpatch1-${stamp}@example.test`;
  await json(`/api/tenants/${invTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: invHeader, raw_rows: [[patchEmail, "Inv", "Patch", "Annual Membership"]], mapping: invMapping }),
  });
  const patchId = (await json(`/api/tenants/${invTenantId}/members?q=${encodeURIComponent(patchEmail)}`,
    { headers: auth })).body.members[0].id;
  await json(`/api/tenants/${invTenantId}/members/${patchId}`, {
    method: "PATCH", headers: auth, body: JSON.stringify({ status: "lapsed" }),
  });
  check("THE BUG (13a): marking a member lapsed by hand also ends their active membership",
    !membershipStatuses(patchEmail).includes("active"),
    JSON.stringify(membershipStatuses(patchEmail)));

  // 13b: the same through a status-only import row (no Level column).
  const rowEmail = `invrow1-${stamp}@example.test`;
  await json(`/api/tenants/${invTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: invHeader, raw_rows: [[rowEmail, "Inv", "Row", "Annual Membership"]], mapping: invMapping }),
  });
  const statusOnlyHeader = ["Email", "First Name", "Last Name", "Status"];
  const statusOnlyMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "status" },
  };
  await json(`/api/tenants/${invTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: statusOnlyHeader, raw_rows: [[rowEmail, "Inv", "Row", "Lapsed"]], mapping: statusOnlyMapping }),
  });
  check("THE BUG (13b): a status-only import row of Lapsed also ends the active membership",
    !membershipStatuses(rowEmail).includes("active"),
    JSON.stringify(membershipStatuses(rowEmail)));

  // 13c: the whole point -- export then re-import must leave both of them
  // where the admin put them.
  const invExport = parseCsv(await (await fetch(
    `${BASE}/api/tenants/${invTenantId}/members/export.csv`, { headers: auth })).text());
  const invHead = invExport[0];
  const invRows = invExport.slice(1);
  const lvlCol = invHead.indexOf("level");
  for (const [label, email] of [["hand-PATCHed", patchEmail], ["status-only import row", rowEmail]]) {
    check(`13c: the ${label} member exports with NO level (nothing for the importer to resolve)`,
      invRows.find((r) => r[0] === email)?.[lvlCol] === "",
      JSON.stringify(invRows.find((r) => r[0] === email)));
  }
  const { mapping: invProposed } = proposeMapping(invHead, []);
  const invRoundTrip = await json(`/api/tenants/${invTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: invHead, raw_rows: invRows, mapping: invProposed }),
  });
  const invStatuses = new Map((await json(`/api/tenants/${invTenantId}/members?limit=100`,
    { headers: auth })).body.members.map((m) => [m.email, m.status]));
  check("THE BUG (13c): re-importing our own export does NOT resurrect either deliberately-lapsed member",
    invStatuses.get(patchEmail) === "lapsed" && invStatuses.get(rowEmail) === "lapsed",
    JSON.stringify({ patch: invStatuses.get(patchEmail), row: invStatuses.get(rowEmail),
                     import: invRoundTrip.body }));
  check("13c: that round trip assigns no memberships at all",
    invRoundTrip.body.memberships_assigned === 0, JSON.stringify(invRoundTrip.body));

  // 13d: the invariant must not fire in the other direction -- moving a
  // member to `active` by hand must not invent a membership.
  const upEmail = `invup1-${stamp}@example.test`;
  const upMember = await json(`/api/tenants/${invTenantId}/members`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ email: upEmail, first_name: "Inv", last_name: "Up", status: "lapsed" }),
  });
  await json(`/api/tenants/${invTenantId}/members/${upMember.body.id}`, {
    method: "PATCH", headers: auth, body: JSON.stringify({ status: "active" }),
  });
  check("13d: PATCHing a member back to active does not invent a membership",
    membershipStatuses(upEmail).length === 0, JSON.stringify(membershipStatuses(upEmail)));
}

console.log("\n--- layer 14: the friendly plan-cap banner must survive an informational warning (fix round 8, important 3) ---");

// public/admin.html gates its "Import complete -- N waiting on your plan's
// limit" banner on `warnings.length === 0`. Every Level-column file now
// emits the informational level_without_end_date, so a free guild at its
// cap would see "Import finished with problems" when nothing is wrong with
// their file -- and both admin guides still promise the friendly banner.
// The server must therefore publish which codes are lossy, so the client
// can gate on "no LOSSY warning" instead of "no warning at all" without
// hand-maintaining a second copy of the set.
{
  const capTenantId = await freePlanTenant("bannercap");
  await json(`/api/tenants/${capTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });
  for (let i = 0; i < 30; i++) {
    await json(`/api/tenants/${capTenantId}/members`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ email: `bcfill-${stamp}-${i}@example.test`, status: "active" }),
    });
  }
  const capHeader = ["Email", "First Name", "Last Name", "Level"];
  const capMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
  };
  const capRun = await json(`/api/tenants/${capTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: capHeader,
      raw_rows: [[`bcover-${stamp}@example.test`, "Banner", "Cap", "Annual Membership"]],
      mapping: capMapping }),
  });
  check("14 precondition: the row really was held at the free-plan cap",
    capRun.body.plan_limited === 1, JSON.stringify(capRun.body));
  check("14: the server publishes lossy_warning_codes so the client need not keep its own copy",
    Array.isArray(capRun.body.lossy_warning_codes) &&
      capRun.body.lossy_warning_codes.includes("level_not_found") &&
      !capRun.body.lossy_warning_codes.includes("level_without_end_date"),
    JSON.stringify(capRun.body.lossy_warning_codes));
  // The exact predicate public/admin.html uses for the friendly banner.
  // Deliberately requires lossy_warning_codes to be an array: without it the
  // client has no way to tell an informational warning from a lossy one and
  // must fall back to `warnings.length === 0`, which a WA-shaped file can
  // never satisfy -- that IS the regression, so this must fail pre-fix.
  const lossyList = capRun.body.lossy_warning_codes;
  const lossy = new Set(Array.isArray(lossyList) ? lossyList : []);
  const errs = capRun.body.errors || [];
  const planLimitOnly = Array.isArray(lossyList) &&
    capRun.body.status === "partial" && errs.length > 0 &&
    errs.every((e) => e.kind === "plan_limited" || e.kind === "level_without_end_date") &&
    (capRun.body.warnings || []).every((w) => !lossy.has(w.code));
  check("THE BUG (14): a plan-capped WA-shaped file still qualifies for the friendly banner",
    planLimitOnly, JSON.stringify({ status: capRun.body.status, errors: errs,
      warnings: capRun.body.warnings, lossy: [...lossy] }));
}

console.log("\n--- layer 15: re-asserting a membership must not strip its billing -- an auto-renewing member stays auto-renewing (fix round 9, item 1) ---");

// Round 8 preserved `end_date` and called that "never overwrite a membership
// already on record". True of one column, false of the membership:
// activateMembership still expired the row and inserted a fresh one with
// amount_paid_cents 0, stripe_subscription_id NULL and auto_renew 0 -- the
// three columns renewals.ts reads. So a routine Level-only re-import
// silently converted an auto-renewing member to manual: Stripe stops
// charging them, the reminder ladder starts, and they lapse -- reported as
// `completed` with an informational code.
{
  const billTenantId = (await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `Billing ${stamp}`, slug: `billing-${stamp}` }),
  })).body.id;
  for (const name of ["Annual Membership", "Sustaining Membership"]) {
    await json(`/api/tenants/${billTenantId}/levels`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name, price_cents: 4500, duration_months: 12, renewal_type: "manual" }),
    });
  }
  const billHeader = ["Email", "First Name", "Last Name", "Level"];
  const billMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
  };
  const activeRow = (email) => d1Query(
    `SELECT m.id, m.level_id, m.end_date, m.auto_renew, m.stripe_subscription_id,
            m.amount_paid_cents, l.name as level_name
     FROM memberships m
     JOIN members mem ON mem.id = m.member_id
     JOIN membership_levels l ON l.id = m.level_id
     WHERE m.tenant_id = '${billTenantId}' AND mem.email = '${email}' AND m.status = 'active'`
  )[0];
  const rowCount = (email) => d1Query(
    `SELECT count(*) as n FROM memberships m JOIN members mem ON mem.id = m.member_id
     WHERE m.tenant_id = '${billTenantId}' AND mem.email = '${email}'`
  )[0].n;

  // A member paying by Stripe subscription, set up exactly as
  // routes/webhooks.ts leaves them after checkout: auto_renew on, the
  // subscription id stored, the amount recorded.
  const subEmail = `billsub1-${stamp}@example.test`;
  await json(`/api/tenants/${billTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: billHeader,
      raw_rows: [[subEmail, "Bill", "Sub", "Annual Membership"]], mapping: billMapping }),
  });
  d1Exec(
    `UPDATE memberships SET auto_renew = 1, stripe_subscription_id = 'sub_test_${stamp}',
       amount_paid_cents = 4500, end_date = '2029-06-01T00:00:00.000Z'
     WHERE tenant_id = '${billTenantId}' AND status = 'active'
       AND member_id = (SELECT id FROM members WHERE tenant_id = '${billTenantId}' AND email = '${subEmail}');`
  );
  const before = activeRow(subEmail);
  check("15 precondition: the member is auto-renewing on a Stripe subscription",
    before?.auto_renew === 1 && before?.stripe_subscription_id === `sub_test_${stamp}` &&
      before?.amount_paid_cents === 4500,
    JSON.stringify(before));

  // The routine our own admin guide recommends: re-import the roster.
  const billRun = await json(`/api/tenants/${billTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: billHeader,
      raw_rows: [[subEmail, "Bill", "Sub", "Annual Membership"]], mapping: billMapping }),
  });
  const after = activeRow(subEmail);
  check("THE BUG (15a): a Level-only re-import leaves the member AUTO-RENEWING",
    after?.auto_renew === 1, `auto_renew is now ${after?.auto_renew}`);
  check("THE BUG (15b): the Stripe subscription linkage survives the re-import",
    after?.stripe_subscription_id === `sub_test_${stamp}`,
    `stripe_subscription_id is now ${JSON.stringify(after?.stripe_subscription_id)}`);
  check("THE BUG (15c): the recorded amount paid is not reset to zero",
    after?.amount_paid_cents === 4500, `amount_paid_cents is now ${after?.amount_paid_cents}`);
  check("15d: the end date is still preserved (round 8's guarantee holds)",
    String(after?.end_date || "").startsWith("2029-06-01"), JSON.stringify(after));

  // The shape fix: a row that asserts what is already true must not churn
  // the ledger. Before this, every re-import expired one row and inserted
  // another, so re-importing a 500-member roster five times left 2,500
  // membership rows and four expired ones per member.
  check("15e: re-asserting an unchanged membership creates NO new membership row",
    rowCount(subEmail) === 1 && after?.id === before?.id,
    `rows=${rowCount(subEmail)} id ${before?.id} -> ${after?.id}`);
  check("15f: the row still counts as assigned, so the accounting invariant holds",
    billRun.body.memberships_assigned === 1, JSON.stringify(billRun.body));

  // A genuine level CHANGE must still write a new membership -- and must
  // still carry the billing relationship across, or the same silent
  // unsubscribe happens on the one import that really did change something.
  const changeRun = await json(`/api/tenants/${billTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: billHeader,
      raw_rows: [[subEmail, "Bill", "Sub", "Sustaining Membership"]], mapping: billMapping }),
  });
  const changed = activeRow(subEmail);
  check("15g: a level CHANGE does write a new membership at the new level",
    changed?.level_name === "Sustaining Membership" && changed?.id !== before?.id,
    JSON.stringify({ changed, changeRun: changeRun.body }));
  check("15h: a level change carries the auto-renew flag and subscription id forward",
    changed?.auto_renew === 1 && changed?.stripe_subscription_id === `sub_test_${stamp}`,
    JSON.stringify(changed));
  check("15i: the previous membership is kept as history, expired not deleted",
    rowCount(subEmail) === 2, `rows=${rowCount(subEmail)}`);

  // A brand-new member must NOT inherit anything -- the carry-forward is
  // strictly from the row being replaced.
  const freshEmail = `billfresh1-${stamp}@example.test`;
  await json(`/api/tenants/${billTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: billHeader,
      raw_rows: [[freshEmail, "Bill", "Fresh", "Annual Membership"]], mapping: billMapping }),
  });
  const fresh = activeRow(freshEmail);
  check("15j: a brand-new member starts manual, with no subscription and nothing paid",
    fresh?.auto_renew === 0 && fresh?.stripe_subscription_id === null &&
      fresh?.amount_paid_cents === 0,
    JSON.stringify(fresh));
}

console.log("\n--- layer 16: PATCHing a member to `pending` must also end their membership (fix round 9, item 4a) ---");

// Round 8 closed this for `lapsed` and `cancelled` and left `pending` open:
// same bug class, one status narrower. A pending member with
// memberships.status='active' still exports a level and comes back active.
{
  const pendTenantId = (await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `Pending ${stamp}`, slug: `pending-${stamp}` }),
  })).body.id;
  await json(`/api/tenants/${pendTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });
  const pendHeader = ["Email", "First Name", "Last Name", "Level"];
  const pendMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
  };
  const pendEmail = `pend1-${stamp}@example.test`;
  await json(`/api/tenants/${pendTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: pendHeader,
      raw_rows: [[pendEmail, "Pend", "One", "Annual Membership"]], mapping: pendMapping }),
  });
  const pendId = (await json(`/api/tenants/${pendTenantId}/members?q=${encodeURIComponent(pendEmail)}`,
    { headers: auth })).body.members[0].id;
  await json(`/api/tenants/${pendTenantId}/members/${pendId}`, {
    method: "PATCH", headers: auth, body: JSON.stringify({ status: "pending" }),
  });
  const pendStatuses = d1Query(
    `SELECT m.status FROM memberships m JOIN members mem ON mem.id = m.member_id
     WHERE m.tenant_id = '${pendTenantId}' AND mem.email = '${pendEmail}'`
  ).map((r) => r.status);
  check("THE BUG (16a): moving a member to `pending` also ends their active membership",
    !pendStatuses.includes("active"), JSON.stringify(pendStatuses));

  const pendExport = parseCsv(await (await fetch(
    `${BASE}/api/tenants/${pendTenantId}/members/export.csv`, { headers: auth })).text());
  const pendLevelCol = pendExport[0].indexOf("level");
  const pendRow = pendExport.slice(1).find((r) => r[0] === pendEmail);
  check("16b: a pending member exports with no level, so a re-import can't reactivate them",
    pendRow?.[pendLevelCol] === "", JSON.stringify(pendRow));
}

console.log("\n--- layer 17: the no-op path must still REACTIVATE a member whose status disagrees with their membership (fix round 10, item 3) ---");

// Fix round 9 made an import row that asserts what is already true write
// nothing -- no expire, no insert. That is right for the membership, but a
// no-op must not become a no-op for the MEMBER: if their `members.status`
// says pending or lapsed while they hold a live membership, the row is
// asking for them to be active and the importer has to say so. Round 9
// guarded that with a single `existingStatus.get(...) !== "active"` branch
// and nothing exercised it -- it was correct by inspection only, which is
// exactly the "silent no-op that should have been a reactivation" shape
// this task keeps finding.
//
// The inconsistent state is built with d1Exec deliberately. Since round 8
// and 9 it is no longer reachable through the API (PATCH and status-only
// import rows now end the membership alongside the member), but it is
// exactly what pre-round-8 data looks like on disk, which is what a pilot
// guild's database would contain.
{
  const reactTenantId = (await json("/api/tenants", {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: `React ${stamp}`, slug: `react-${stamp}` }),
  })).body.id;
  await json(`/api/tenants/${reactTenantId}/levels`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Annual Membership", price_cents: 0,
                           duration_months: 12, renewal_type: "manual" }),
  });
  const reactHeader = ["Email", "First Name", "Last Name", "Level", "Renewal"];
  const reactMapping = {
    0: { kind: "known", target: "email" },
    1: { kind: "known", target: "first_name" },
    2: { kind: "known", target: "last_name" },
    3: { kind: "known", target: "level_name" },
    4: { kind: "known", target: "end_date" },
  };
  const memberState = (email) => d1Query(
    `SELECT mem.status as member_status, m.id as membership_id, m.status as membership_status,
            m.end_date, m.auto_renew
     FROM members mem LEFT JOIN memberships m
       ON m.member_id = mem.id AND m.status = 'active' AND m.tenant_id = mem.tenant_id
     WHERE mem.tenant_id = '${reactTenantId}' AND mem.email = '${email}'`
  )[0];

  for (const flavour of ["lapsed", "pending"]) {
    const email = `react-${flavour}-${stamp}@example.test`;
    // An explicit expiry so the re-import below is byte-for-byte the same
    // assertion -- same level, same end date -- and therefore genuinely
    // takes the no-op branch rather than the write path.
    const row = [email, "React", flavour, "Annual Membership", "2029-06-01"];
    await json(`/api/tenants/${reactTenantId}/members/import`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ header: reactHeader, raw_rows: [row], mapping: reactMapping }),
    });
    // Desynchronise ONLY the member row, leaving the membership active --
    // the pre-round-8 state.
    d1Exec(
      `UPDATE members SET status = '${flavour}' WHERE tenant_id = '${reactTenantId}' AND email = '${email}';`
    );
    const before = memberState(email);
    check(`17 precondition (${flavour}): member reads ${flavour} while still holding an ACTIVE membership`,
      before?.member_status === flavour && before?.membership_status === "active",
      JSON.stringify(before));

    const reactRun = await json(`/api/tenants/${reactTenantId}/members/import`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ header: reactHeader, raw_rows: [row], mapping: reactMapping }),
    });
    const after = memberState(email);
    check(`THE GUARD (${flavour}): the no-op row still reactivates the member`,
      after?.member_status === "active",
      `member_status is ${after?.member_status} (import: ${JSON.stringify(reactRun.body)})`);
    check(`17 (${flavour}): it really was the NO-OP path -- the same membership row, untouched`,
      after?.membership_id === before?.membership_id &&
        after?.end_date === before?.end_date,
      JSON.stringify({ before, after }));
    check(`17 (${flavour}): the row is still counted as assigned`,
      reactRun.body.memberships_assigned === 1, JSON.stringify(reactRun.body));
  }

  // The counter-direction guard: for an already-active member the no-op path
  // must write NOTHING to memberships at all. Asserted on the membership's
  // own updated_at -- expireActiveMemberships, the INSERT, or a stray
  // status write would all move it. (members.updated_at is not usable here:
  // the import's ordinary UPDATE members statement always touches it for an
  // existing member, no-op branch or not.)
  const steadyEmail = `react-steady-${stamp}@example.test`;
  const steadyRow = [steadyEmail, "React", "Steady", "Annual Membership", "2029-06-01"];
  const steadyMembership = () => d1Query(
    `SELECT m.id, m.updated_at FROM memberships m JOIN members mem ON mem.id = m.member_id
     WHERE m.tenant_id = '${reactTenantId}' AND mem.email = '${steadyEmail}'`
  );
  await json(`/api/tenants/${reactTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: reactHeader, raw_rows: [steadyRow], mapping: reactMapping }),
  });
  const steadyBefore = steadyMembership();
  await json(`/api/tenants/${reactTenantId}/members/import`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ header: reactHeader, raw_rows: [steadyRow], mapping: reactMapping }),
  });
  const steadyAfter = steadyMembership();
  check("17: for an already-active member the no-op path writes nothing to memberships at all",
    steadyAfter.length === 1 && steadyBefore.length === 1 &&
      steadyAfter[0].id === steadyBefore[0].id &&
      steadyAfter[0].updated_at === steadyBefore[0].updated_at,
    JSON.stringify({ before: steadyBefore, after: steadyAfter }));
}

console.log(failures ? `\n${failures} failure(s)` : "\nall layers passed");
if (failures) process.exit(1);
