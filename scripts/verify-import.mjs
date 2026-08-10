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
