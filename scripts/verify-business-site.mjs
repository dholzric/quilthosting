/**
 * Business site + gate matrix E2E.
 * Usage: node scripts/verify-business-site.mjs   (no `npm run dev` needed)
 *
 * WHY THIS DOESN'T DRIVE `wrangler dev` OVER HTTP:
 * The real wrangler.toml declares `[[routes]] pattern = "quilthosting.com"
 * custom_domain = true`. Under both plain `wrangler dev` and `curl`/`fetch`
 * with a spoofed `Host` header, that route config coerces every request's
 * effective host to `quilthosting.com` -- there is no way to make the
 * running worker see any other hostname, which makes host-based tenant
 * routing (the entire point of this test) untestable that way. Verified
 * empirically before writing this file.
 *
 * Instead this script:
 *   1. Derives a throwaway copy of wrangler.toml with the `[[routes]]`
 *      tables stripped (everything else identical -- same D1/KV/R2 ids, same
 *      vars) and absolute-izes its `main` / `assets.directory` /
 *      `migrations_dir` paths so it's valid regardless of where it's
 *      written. Written to a temp file, never to the real wrangler.toml.
 *   2. Boots that worker with `unstable_dev` (`wrangler`, already a
 *      devDependency), `persistTo` pointed at THIS repo's real
 *      `.wrangler/state` dir -- the same local D1/KV/R2 state
 *      `wrangler d1 execute --local` reads and writes. (Note: `persistTo`
 *      must be `.wrangler/state`, NOT `.wrangler/state/v3` --
 *      `unstable_dev` appends its own `v3` segment; passing the `v3`-suffixed
 *      path makes it read/write `.wrangler/state/v3/v3/...`, a second,
 *      never-seeded copy. Proved by inspecting the on-disk state dir after a
 *      seed + fetch round trip -- see task-12-report.md.)
 *   3. Drives it with ABSOLUTE URLs (`worker.fetch("https://host/path")`).
 *      A `Host` header alone is ignored by the Workers runtime; the request
 *      URL's authority IS the effective Host header. Every host-dependent
 *      request below uses this form, never a bare path + header.
 *
 * Same D1-via-temp-.sql-file idiom as scripts/verify-import.mjs (an inline
 * --command string with spaces does not survive quoting reliably on this
 * Windows setup).
 *
 * The renewals-exclusion section (see `renewalsExclusionCheck` below) uses a
 * different mechanism, `getPlatformProxy`, not `unstable_dev`: it hands back
 * real bindings against the same persisted local state without booting an
 * HTTP server, so the real `runRenewalJob` can be called in-process, bundled
 * via esbuild the same way scripts/verify-import.mjs bundles
 * importMapping.ts. That check runs after the HTTP worker is stopped so the
 * two D1 sessions never overlap.
 */
import { writeFileSync, unlinkSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { unstable_dev, getPlatformProxy } from "wrangler";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "stitchstudioquilting.test";
const TENANT = "tnt_demo_business";
// Task 14: tenant image serving (GET /img/:fileId inside serveBusinessSite)
// and the cross-tenant isolation it must enforce. A second, unrelated
// business tenant with its own file lets the "foreign tenant's file id
// 404s on my host" check prove the real WHERE tenant_id = ? clause is
// doing the work, not just that the id doesn't exist at all.
const FOREIGN_TENANT = "tnt_demo_foreign_biz";
const IMG_FILE_ID = "img_test_biz_logo1";
const FOREIGN_FILE_ID = "img_test_foreign_logo1";
// Review round 1, Fix 2: a files row whose recorded content_type is NOT a
// real image type. Proves GET /img/:fileId refuses to echo it back (would
// be stored XSS on the tenant's own first-party origin otherwise -- see the
// "Tenant images" check block below).
const HTML_FILE_ID = "img_test_biz_htmlpayload1";
// Matches getTenantByHost's platform-apex check for this repo's local dev
// APP_URL (.dev.vars: APP_URL=http://localhost:8787) -- appHostname() strips
// scheme/port, leaving "localhost" as the platform host in this environment.
const PLATFORM_HOST = "localhost";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) { console.log(`  ok  ${label}`); return; }
  failures++;
  console.error(`  FAIL ${label} ${detail}`);
}

/** Node-side mirror of src/lib/projects/hash.ts's sha256Hex: plain UTF-8 text
 * to lowercase hex SHA-256, no salt. Used below to (a) mint a synthetic
 * expired/cross-tenant token fixture by pre-computing the hash the real
 * hashToken() would produce, without ever needing to read a raw token back
 * out of the database (it isn't stored), and (b) independently recompute the
 * agreement fingerprint from a stored agreement_text row to prove
 * agreement_sha256 really is SHA-256(agreement_text), not just some string
 * that happens to look like one. */
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function d1Exec(sql) {
  const p = join(tmpdir(), `qh-bs-exec-${randomUUID()}.sql`);
  writeFileSync(p, sql, "utf8");
  try {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "quilthosting-db", "--local", `--file=${p}`],
      { stdio: "pipe", shell: true }
    );
  } finally {
    unlinkSync(p);
  }
}

function d1Query(sql) {
  const p = join(tmpdir(), `qh-bs-query-${randomUUID()}.sql`);
  writeFileSync(p, sql, "utf8");
  try {
    const out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "quilthosting-db", "--local", `--file=${p}`, "--json"],
      { stdio: "pipe", shell: true }
    ).toString("utf8");
    return JSON.parse(out)[0]?.results ?? [];
  } finally {
    unlinkSync(p);
  }
}

/**
 * Derive a test-only wrangler config: the real wrangler.toml minus its
 * [[routes]] tables, with path fields made absolute so the temp file works
 * no matter where it's written. Never touches the real wrangler.toml.
 */
function buildTestConfig() {
  let toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8").replace(/\r\n/g, "\n");

  // Strip every [[routes]] table. Line-based: once a "[[routes]]" header is
  // seen, skip lines until the next blank line (which ends that table).
  const out = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (line.trim() === "[[routes]]") { skipping = true; continue; }
    if (skipping) {
      if (line.trim() === "") { skipping = false; }
      continue;
    }
    out.push(line);
  }
  toml = out.join("\n");

  const abs = (p) => join(ROOT, p).replace(/\\/g, "/");
  toml = toml.replace(/^main = "src\/index\.ts"$/m, `main = "${abs("src/index.ts")}"`);
  toml = toml.replace(/^directory = "\.\/public"$/m, `directory = "${abs("public")}"`);
  toml = toml.replace(/^migrations_dir = "migrations"$/m, `migrations_dir = "${abs("migrations")}"`);

  // A prose comment elsewhere in the file legitimately contains the literal
  // substring "[[routes]]" (see wrangler.toml's own comment above the real
  // routes block) -- only a line that IS exactly "[[routes]]" once trimmed
  // is a real TOML table header, so check line-by-line, not substring.
  if (toml.split("\n").some((l) => l.trim() === "[[routes]]")) {
    throw new Error("buildTestConfig: [[routes]] survived stripping -- refusing to boot with real routes");
  }

  const p = join(tmpdir(), `qh-bs-wrangler-${randomUUID()}.toml`);
  writeFileSync(p, toml, "utf8");
  return p;
}

/** Same esbuild-bundle-then-dynamic-import idiom as scripts/verify-import.mjs,
 * used below to call the real `runRenewalJob` in-process rather than
 * retyping its guard-clause SQL as a separate literal. */
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

async function req(host, path, opts = {}) {
  const res = await globalThis.__worker.fetch(`https://${host}${path}`, opts);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}
async function reqJson(host, path, opts = {}) {
  const r = await req(host, path, opts);
  let json; try { json = JSON.parse(r.body); } catch { json = null; }
  return { ...r, json };
}

/**
 * Exercises the real `runRenewalJob` (src/lib/renewals.ts) directly --
 * bundled with esbuild and dynamic-imported, the same idiom
 * scripts/verify-import.mjs uses for importMapping.ts -- rather than
 * re-typing its `coalesce(tenant_type,'guild') = 'guild'` guard clause as a
 * separate literal SQL string. A hand-typed copy of the predicate proves the
 * copy is self-consistent, never that the real guard exists: deleting all
 * four of renewals.ts's guard clauses would leave a re-typed check green.
 *
 * Seeds a guild/business PAIR for each of the four guarded queries in
 * renewals.ts (reminder line ~64, expire line ~133, winback line ~183,
 * trial line ~238) with state that makes the job act if the guild guard is
 * present, calls the real function once, and asserts BOTH that the guild
 * side WAS processed (positive control -- proves the job isn't simply
 * no-oping) AND that the business side was NOT (the actual requirement).
 *
 * `getPlatformProxy` (not `unstable_dev`) is used here: it hands back real
 * bindings (env.DB backed by the exact same persisted local D1 state)
 * without booting an HTTP server, so this can call `runRenewalJob(env)`
 * in-process, scoped to exactly the function under test -- not the heavier
 * `/__scheduled` route, which also runs event reminders, blasts,
 * automations, and an idempotency sweep across the whole DB.
 *
 * Safety: `env.RESEND_API_KEY` is blanked before the call. `sendEmail()`
 * (src/lib/email/index.ts) early-returns with no network call when the key
 * is falsy -- confirmed empirically (its own "RESEND_API_KEY not set"
 * warning fires) -- so the reminder/winback branches below still run their
 * real guarded SQL and still write real `email_logs` rows (the send
 * attempt is logged as failed, same code path as a real provider outage),
 * without ever calling the real Resend API. Without this, invoking the
 * reminder/winback branches for real would attempt live sends via whatever
 * key is in `.dev.vars`.
 */
async function renewalsExclusionCheck() {
  const OUT = join(ROOT, "scripts/.verify-business-site-out");
  mkdirSync(OUT, { recursive: true });

  const ids = {
    expireGuild: "tnt_ri_exp_g", expireBiz: "tnt_ri_exp_b",
    remindGuild: "tnt_ri_rem_g", remindBiz: "tnt_ri_rem_b",
    winbackGuild: "tnt_ri_win_g", winbackBiz: "tnt_ri_win_b",
    trialGuild: "tnt_ri_tri_g", trialBiz: "tnt_ri_tri_b",
  };
  const inList = Object.values(ids).map((id) => `'${id}'`).join(",");

  let proxy;
  try {
    d1Exec(`
DELETE FROM memberships WHERE tenant_id IN (${inList});
DELETE FROM members WHERE tenant_id IN (${inList});
DELETE FROM membership_levels WHERE tenant_id IN (${inList});
DELETE FROM email_logs WHERE tenant_id IN (${inList});
DELETE FROM tenants WHERE id IN (${inList});

-- reminder guard (renewals.ts ~line 64): active membership, end_date = today+30d
INSERT INTO tenants (id, name, slug, plan, status, tenant_type, public_launched, settings_json) VALUES
  ('${ids.remindGuild}', 'RI Remind Guild', 'riremindguild', 'free', 'active', 'guild', 0, '{}'),
  ('${ids.remindBiz}', 'RI Remind Biz', 'riremindbiz', 'free', 'active', 'business', 1, '{}');
INSERT INTO membership_levels (id, tenant_id, name, price_cents, duration_months, renewal_type, status) VALUES
  ('lvl_ri_rem_g', '${ids.remindGuild}', 'L', 0, 12, 'manual', 'active'),
  ('lvl_ri_rem_b', '${ids.remindBiz}', 'L', 0, 12, 'manual', 'active');
INSERT INTO members (id, tenant_id, email, status, joined_at) VALUES
  ('mem_ri_rem_g', '${ids.remindGuild}', 'rem-g@renewals-probe.test', 'active', datetime('now')),
  ('mem_ri_rem_b', '${ids.remindBiz}', 'rem-b@renewals-probe.test', 'active', datetime('now'));
INSERT INTO memberships (id, tenant_id, member_id, level_id, start_date, end_date, status) VALUES
  ('msh_ri_rem_g', '${ids.remindGuild}', 'mem_ri_rem_g', 'lvl_ri_rem_g', date('now','-30 days'), date('now','+30 days'), 'active'),
  ('msh_ri_rem_b', '${ids.remindBiz}', 'mem_ri_rem_b', 'lvl_ri_rem_b', date('now','-30 days'), date('now','+30 days'), 'active');

-- expire guard (renewals.ts ~line 133): active membership, end_date yesterday
INSERT INTO tenants (id, name, slug, plan, status, tenant_type, public_launched, settings_json) VALUES
  ('${ids.expireGuild}', 'RI Expire Guild', 'riexpireguild', 'free', 'active', 'guild', 0, '{}'),
  ('${ids.expireBiz}', 'RI Expire Biz', 'riexpirebiz', 'free', 'active', 'business', 1, '{}');
INSERT INTO membership_levels (id, tenant_id, name, price_cents, duration_months, renewal_type, status) VALUES
  ('lvl_ri_exp_g', '${ids.expireGuild}', 'L', 0, 12, 'manual', 'active'),
  ('lvl_ri_exp_b', '${ids.expireBiz}', 'L', 0, 12, 'manual', 'active');
INSERT INTO members (id, tenant_id, email, status, joined_at) VALUES
  ('mem_ri_exp_g', '${ids.expireGuild}', 'exp-g@renewals-probe.test', 'active', datetime('now')),
  ('mem_ri_exp_b', '${ids.expireBiz}', 'exp-b@renewals-probe.test', 'active', datetime('now'));
INSERT INTO memberships (id, tenant_id, member_id, level_id, start_date, end_date, status) VALUES
  ('msh_ri_exp_g', '${ids.expireGuild}', 'mem_ri_exp_g', 'lvl_ri_exp_g', date('now','-400 days'), date('now','-1 day'), 'active'),
  ('msh_ri_exp_b', '${ids.expireBiz}', 'mem_ri_exp_b', 'lvl_ri_exp_b', date('now','-400 days'), date('now','-1 day'), 'active');

-- winback guard (renewals.ts ~line 183): lapsed member, updated_at = today-7d
INSERT INTO tenants (id, name, slug, plan, status, tenant_type, public_launched, settings_json) VALUES
  ('${ids.winbackGuild}', 'RI Winback Guild', 'riwinbackguild', 'free', 'active', 'guild', 0, '{}'),
  ('${ids.winbackBiz}', 'RI Winback Biz', 'riwinbackbiz', 'free', 'active', 'business', 1, '{}');
INSERT INTO members (id, tenant_id, email, status, joined_at, updated_at) VALUES
  ('mem_ri_win_g', '${ids.winbackGuild}', 'win-g@renewals-probe.test', 'lapsed', datetime('now','-40 days'), datetime('now','-7 days')),
  ('mem_ri_win_b', '${ids.winbackBiz}', 'win-b@renewals-probe.test', 'lapsed', datetime('now','-40 days'), datetime('now','-7 days'));

-- trial guard (renewals.ts ~line 238): trial_ends_at yesterday, plan free, no stripe sub
INSERT INTO tenants (id, name, slug, plan, status, tenant_type, public_launched, settings_json, trial_ends_at) VALUES
  ('${ids.trialGuild}', 'RI Trial Guild', 'ritrialguild', 'free', 'active', 'guild', 0, '{}', datetime('now','-1 day')),
  ('${ids.trialBiz}', 'RI Trial Biz', 'ritrialbiz', 'free', 'active', 'business', 1, '{}', datetime('now','-1 day'));
`);

    const bundled = bundle(join(ROOT, "src/lib/renewals.ts"), join(OUT, "renewals.mjs"));
    const { runRenewalJob } = await import("file://" + bundled);

    proxy = await getPlatformProxy({
      configPath: join(ROOT, "wrangler.toml"),
      envFiles: [join(ROOT, ".dev.vars")],
      // NOT the double-"v3" pitfall documented above for unstable_dev's
      // persistTo -- getPlatformProxy's `persist.path` is used AS-IS (no
      // segment appended), proven empirically: passing ".wrangler/state"
      // here landed on a fresh, empty, table-less DB, while
      // ".wrangler/state/v3" (this repo's real default persistence dir)
      // correctly saw the actual seeded data.
      persist: { path: join(ROOT, ".wrangler/state/v3") },
    });
    proxy.env.RESEND_API_KEY = "";

    const result = await runRenewalJob(proxy.env);
    await proxy.dispose();
    proxy = null;

    check("runRenewalJob ran without throwing (errors array empty or explainable)",
      Array.isArray(result?.errors), JSON.stringify(result));

    // --- reminder guard (line ~64): positive + negative -----------------
    const remindLogs = d1Query(
      `SELECT tenant_id FROM email_logs WHERE tenant_id IN ('${ids.remindGuild}','${ids.remindBiz}') AND template = 'renewal_30d'`
    );
    check("reminder guard: guild tenant WAS processed (positive control)",
      remindLogs.some((r) => r.tenant_id === ids.remindGuild), JSON.stringify(remindLogs));
    check("reminder guard: business tenant was NOT processed",
      !remindLogs.some((r) => r.tenant_id === ids.remindBiz), JSON.stringify(remindLogs));

    // --- expire guard (line ~133): positive + negative -------------------
    const expireAfter = d1Query(
      `SELECT id, status FROM memberships WHERE id IN ('msh_ri_exp_g','msh_ri_exp_b') ORDER BY id`
    );
    const expGuild = expireAfter.find((r) => r.id === "msh_ri_exp_g");
    const expBiz = expireAfter.find((r) => r.id === "msh_ri_exp_b");
    check("expire guard: guild membership WAS expired (positive control)",
      expGuild?.status === "expired", JSON.stringify(expireAfter));
    check("expire guard: business membership was NOT touched (still active)",
      expBiz?.status === "active", JSON.stringify(expireAfter));

    // --- winback guard (line ~183): positive + negative -------------------
    const winbackLogs = d1Query(
      `SELECT tenant_id FROM email_logs WHERE tenant_id IN ('${ids.winbackGuild}','${ids.winbackBiz}') AND template = 'winback_7d'`
    );
    check("winback guard: guild tenant WAS processed (positive control)",
      winbackLogs.some((r) => r.tenant_id === ids.winbackGuild), JSON.stringify(winbackLogs));
    check("winback guard: business tenant was NOT processed",
      !winbackLogs.some((r) => r.tenant_id === ids.winbackBiz), JSON.stringify(winbackLogs));

    // --- trial guard (line ~238): positive + negative ---------------------
    const trialAfter = d1Query(
      `SELECT id, trial_ends_at FROM tenants WHERE id IN ('${ids.trialGuild}','${ids.trialBiz}') ORDER BY id`
    );
    const triGuild = trialAfter.find((r) => r.id === ids.trialGuild);
    const triBiz = trialAfter.find((r) => r.id === ids.trialBiz);
    check("trial guard: guild tenant's trial WAS ended (positive control)",
      triGuild?.trial_ends_at === null, JSON.stringify(trialAfter));
    check("trial guard: business tenant's trial was NOT touched (still set)",
      !!triBiz?.trial_ends_at, JSON.stringify(trialAfter));
  } finally {
    if (proxy) { try { await proxy.dispose(); } catch {} }
    try {
      d1Exec(`
DELETE FROM memberships WHERE tenant_id IN (${inList});
DELETE FROM members WHERE tenant_id IN (${inList});
DELETE FROM membership_levels WHERE tenant_id IN (${inList});
DELETE FROM email_logs WHERE tenant_id IN (${inList});
DELETE FROM tenants WHERE id IN (${inList});
`);
    } catch (e) {
      console.error("renewals-check cleanup failed (non-fatal):", e?.message || e);
    }
  }
}

let testConfigPath;
let worker;

try {
  testConfigPath = buildTestConfig();

  console.log("Seeding business tenant...");
  d1Exec(`
DELETE FROM files WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM memberships WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM members WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM membership_levels WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM pages WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
-- Project tables cleaned up here too (not just in the finally block below):
-- the P1 chain section further down inserts fixture rows under FIXED ids
-- (prj_verify_expired, prj_verify_crosstenant), which would collide on the
-- primary key if a previous run crashed before reaching its own cleanup.
DELETE FROM agreement_signatures WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM project_lines WHERE project_id IN (SELECT id FROM projects WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}'));
DELETE FROM projects WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM project_counters WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM tenants WHERE id IN ('${TENANT}', '${FOREIGN_TENANT}');
INSERT INTO tenants (id, name, slug, custom_domain, plan, status, tenant_type, public_launched, settings_json)
VALUES ('${TENANT}', 'Stitch Studio Quilting', 'stitchstudio', '${HOST}', 'free', 'active', 'business', 1,
  '{"theme":{"primary":"#8a2060"},"business":{"name":"Stitch Studio Quilting","phone":"555-867-5309","city":"Wimberley","state":"TX"},"assets":{"logo_file_id":"${IMG_FILE_ID}"}}');
INSERT INTO pages (id, tenant_id, slug, title, blocks_json, published, sort_order)
VALUES ('pg_bs_home', '${TENANT}', 'home', 'Stitch Studio Quilting',
  '[{"type":"hero","title":"Stitch Studio Quilting","subtitle":"Longarm quilting"}]', 1, 0);
INSERT INTO pages (id, tenant_id, slug, title, blocks_json, published, sort_order, noindex)
VALUES ('pg_bs_secret', '${TENANT}', 'secret', 'Hidden', '[]', 1, 1, 1);

-- Unrelated business tenant used only for the /img/:fileId cross-tenant
-- isolation check below -- never given its own host/pages.
INSERT INTO tenants (id, name, slug, plan, status, tenant_type, public_launched, settings_json)
VALUES ('${FOREIGN_TENANT}', 'Foreign Biz', 'foreignbiz-imgtest', 'free', 'active', 'business', 1, '{}');

-- Review round 1, Fix 3: image/png, not image/jpeg -- image/jpeg is also
-- the route's old hardcoded fallback (now removed by Fix 2's allowlist, but
-- keeping this off the fallback value is what makes "content type matches
-- the files row" a real assertion about reading the column, not a check
-- that can't tell the column from a default).
INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, created_at)
VALUES ('${IMG_FILE_ID}', '${TENANT}', '${TENANT}/${IMG_FILE_ID}/logo.png', 'logo.png', 'image/png', 24, datetime('now'));
INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, created_at)
VALUES ('${FOREIGN_FILE_ID}', '${FOREIGN_TENANT}', '${FOREIGN_TENANT}/${FOREIGN_FILE_ID}/secret.png', 'secret.png', 'image/png', 24, datetime('now'));
-- Review round 1, Fix 2: a file whose recorded content_type is text/html --
-- uploadable today because fileRoutes.post("/") accepts any Content-Type a
-- caller with upload rights sends. GET /img/:fileId must not echo this back
-- as text/html (stored XSS on the tenant's own origin).
INSERT INTO files (id, tenant_id, r2_key, filename, content_type, size, created_at)
VALUES ('${HTML_FILE_ID}', '${TENANT}', '${TENANT}/${HTML_FILE_ID}/payload.html', 'payload.html', 'text/html', 40, datetime('now'));
`);

  console.log("Writing R2 object bytes for the seeded files (D1 rows above point at these keys)...");
  {
    // R2 isn't reachable through the wrangler CLI the way D1 is (no
    // `wrangler r2 object put --local` equivalent used elsewhere in this
    // script), so this uses getPlatformProxy for real FILES bindings against
    // the same on-disk state -- sequenced strictly BEFORE `unstable_dev`
    // boots below, for the same reason `renewalsExclusionCheck` waits until
    // AFTER the HTTP worker stops: two independent D1/R2 sessions against
    // the same persisted state should never be open concurrently.
    const imgProxy = await getPlatformProxy({
      configPath: join(ROOT, "wrangler.toml"),
      envFiles: [join(ROOT, ".dev.vars")],
      persist: { path: join(ROOT, ".wrangler/state/v3") },
    });
    try {
      const bytes = new TextEncoder().encode("fake-png-bytes-for-verify-business-site");
      await imgProxy.env.FILES.put(`${TENANT}/${IMG_FILE_ID}/logo.png`, bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      await imgProxy.env.FILES.put(`${FOREIGN_TENANT}/${FOREIGN_FILE_ID}/secret.png`, bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      const htmlBytes = new TextEncoder().encode("<script>alert(document.domain)</script>");
      await imgProxy.env.FILES.put(`${TENANT}/${HTML_FILE_ID}/payload.html`, htmlBytes, {
        httpMetadata: { contentType: "text/html" },
      });
    } finally {
      await imgProxy.dispose();
    }
  }

  console.log("\nStarting the worker (stripped-routes config, real local D1/KV/R2 state)...");
  worker = await unstable_dev("src/index.ts", {
    config: testConfigPath,
    local: true,
    persist: true,
    persistTo: join(ROOT, ".wrangler/state"),
    envFiles: [join(ROOT, ".dev.vars")],
    // Safety, not a test requirement: .dev.vars carries a real Resend API
    // key (see task-12-report.md), and this script's join-flow check below
    // activates a free membership, which unconditionally calls sendEmail().
    // Blanking it here makes that call a harmless local no-op
    // (sendEmail() itself early-returns when the key is falsy) instead of a
    // live network call to a real email provider for a synthetic address.
    // Confirmed empirically: this override wins over the value loaded from
    // .dev.vars (sendEmail's own "RESEND_API_KEY not set" warning fires).
    vars: { RESEND_API_KEY: "" },
    logLevel: "warn",
  });
  globalThis.__worker = worker;

  console.log("\nRendered site:");
  {
    const r = await req(HOST, "/");
    check("home renders 200", r.status === 200, `got ${r.status}`);
    check("is server-rendered html", r.body.startsWith("<!DOCTYPE html>"));
    check("contains hero title in the source", r.body.includes("Stitch Studio Quilting"));
    check("carries theme custom properties", r.body.includes("--color-primary:#8a2060"));
    check("emits LocalBusiness json-ld", r.body.includes('"@type":"LocalBusiness"'));
    // Task 14: business identity (settings.business.phone) flows through
    // readBusinessIdentity -> buildLocalBusinessJsonLd into the rendered
    // page's structured data -- the same field the task brief's own
    // curl-and-grep manual check (Step 7) targets.
    check("business identity (phone) appears in the LocalBusiness json-ld",
      r.body.includes('"telephone":"555-867-5309"'), r.body.slice(0, 4000));
    // Task 14: logoUrl is now computed from settings.assets.logo_file_id and
    // wired into renderPageHtml -- it must resolve to this tenant's own
    // /img/:fileId route, not sit unset like Task 9 deliberately left it.
    check("logo renders as an <img> pointing at this tenant's own /img/:fileId route",
      r.body.includes(`<img src="https://${HOST}/img/${IMG_FILE_ID}"`), r.body.slice(0, 4000));
    check("shows the platform credit linking to the platform",
      r.body.includes('Powered by <a href="https://quilthosting.com">QuiltHosting</a>'));
    check("is not noindexed", !r.body.includes('content="noindex'));
  }

  console.log("\nSEO endpoints:");
  {
    const s = await req(HOST, "/sitemap.xml");
    check("sitemap 200", s.status === 200, `got ${s.status}`);
    check("sitemap lists home", s.body.includes(`https://${HOST}/`));
    check("sitemap omits noindex pages", !s.body.includes("/secret"));

    const rb = await req(HOST, "/robots.txt");
    check("robots 200", rb.status === 200, `got ${rb.status}`);
    check("robots allows crawling", rb.body.includes("Allow: /"));
    check("robots points at the sitemap", rb.body.includes("sitemap.xml"));
  }

  console.log("\nTenant images (GET /img/:fileId inside serveBusinessSite):");
  {
    const img = await req(HOST, `/img/${IMG_FILE_ID}`);
    check("uploaded image serves 200", img.status === 200, `got ${img.status}`);
    check("content type matches the files row (image/png, not the old jpeg fallback)",
      (img.headers.get("content-type") || "").includes("image/png"),
      img.headers.get("content-type"));
    check("cache header is public, 1-year, immutable",
      (img.headers.get("cache-control") || "").includes("immutable") &&
      (img.headers.get("cache-control") || "").includes("max-age=31536000"),
      img.headers.get("cache-control"));
    check("X-Content-Type-Options: nosniff is set (Fix 2)",
      (img.headers.get("x-content-type-options") || "") === "nosniff",
      img.headers.get("x-content-type-options"));

    // The actual security requirement (Task 14 brief): tenant_id scoping is
    // the only thing stopping one tenant's file id from reading another
    // tenant's image. FOREIGN_FILE_ID genuinely exists in `files` -- just
    // under FOREIGN_TENANT's tenant_id, not TENANT's -- so a pass here
    // proves the WHERE tenant_id = ? clause is doing the work, not merely
    // that some made-up id 404s.
    const foreign = await req(HOST, `/img/${FOREIGN_FILE_ID}`);
    check("a foreign tenant's real file id 404s on this tenant's host (tenant_id scoping)",
      foreign.status === 404, `got ${foreign.status}`);

    const bogus = await req(HOST, "/img/does-not-exist-at-all");
    check("a nonexistent file id also 404s", bogus.status === 404, `got ${bogus.status}`);

    // Review round 1, Fix 2: stored XSS check. HTML_FILE_ID is a REAL row
    // under THIS tenant's own tenant_id (not a cross-tenant or bogus id --
    // tenant_id scoping alone would let this one through) whose content_type
    // is text/html. The allowlist in src/routes/site.ts must refuse to
    // serve it as anything but a 404, regardless of ownership.
    const html = await req(HOST, `/img/${HTML_FILE_ID}`);
    check("a same-tenant file recorded as text/html does NOT serve as text/html",
      !(html.headers.get("content-type") || "").includes("text/html"),
      html.headers.get("content-type"));
    check("a same-tenant text/html-typed file 404s instead (not on the image allowlist)",
      html.status === 404, `got ${html.status}`);
  }

  // Hoisted out of the block below so the site-builder editor section near
  // the end of this file can reuse the same owner-scoped Authorization
  // header instead of registering and tenant-linking a second harness user.
  // Assigned once, inside that block, immediately after the token is proved.
  let ownerAuth = null;

  console.log("\nCache invalidation on Business Details save (Fix 1: tenant.updated_at folded into the cache key):");
  {
    // Real PATCH /api/tenants/:id round trip -- not a direct SQL write to
    // tenants.settings_json -- proves the actual save path an owner uses
    // through the Business Details panel invalidates a previously-cached
    // render, not merely that cachedRender's key would change in principle
    // if something bumped tenant.updated_at.
    const HARNESS_EMAIL = "harness@example.test";
    const HARNESS_PASSWORD = "harness-password-1";
    let jwt, userId;
    const login = await reqJson(PLATFORM_HOST, "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: HARNESS_EMAIL, password: HARNESS_PASSWORD }),
    });
    if (login.status === 200) {
      jwt = login.json?.token;
      userId = login.json?.user?.id;
    } else {
      const reg = await reqJson(PLATFORM_HOST, "/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: HARNESS_EMAIL, password: HARNESS_PASSWORD, name: "Harness" }),
      });
      jwt = reg.json?.token;
      userId = reg.json?.user?.id;
    }
    check("harness auth obtained a token", !!jwt && !!userId,
      JSON.stringify({ loginStatus: login.status }));

    // tenant_users has no API for "add an existing user to a tenant they
    // don't already belong to" -- a direct, tenant-scoped seed write, same
    // idiom as every other d1Exec fixture in this file. TENANT was deleted
    // and recreated fresh earlier in this run, so there is no pre-existing
    // row to conflict with.
    d1Exec(`
DELETE FROM tenant_users WHERE tenant_id = '${TENANT}' AND user_id = '${userId}';
INSERT INTO tenant_users (tenant_id, user_id, role) VALUES ('${TENANT}', '${userId}', 'owner');
`);
    const auth = { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };
    ownerAuth = auth;

    const before = await req(HOST, "/");
    check("precondition: home page still carries the ORIGINAL phone number before the save",
      before.body.includes('"telephone":"555-867-5309"'), before.body.slice(0, 4000));

    // Review round 2, Fix 2: the control. The render -> PATCH -> re-render
    // check below would pass identically even if the Cache API never
    // engaged at all under unstable_dev -- if every render is always
    // "fresh," a settings change showing up on the next request proves
    // nothing about invalidation, because there was never anything to
    // invalidate. This proves the opposite direction first: mutate
    // something the cache key does NOT cover (blocks_json, via a direct SQL
    // UPDATE that deliberately leaves pages.updated_at untouched -- the one
    // column the key IS built from), then re-render and assert the STALE,
    // pre-mutation content is still what comes back. That can only happen
    // if a previous render is genuinely being served from the Cache API
    // rather than rebuilt on every request. Paired with the PATCH check
    // below, the two together prove both halves: caching is real, AND a
    // settings save busts it.
    const STALE_MARKER = "MUTATED-STALE-CHECK-DO-NOT-SERVE-FRESH";
    d1Exec(`
UPDATE pages SET blocks_json = '[{"type":"hero","title":"${STALE_MARKER}","subtitle":"x"}]'
WHERE id = 'pg_bs_home' AND tenant_id = '${TENANT}';
`);
    const controlRender = await req(HOST, "/");
    const cacheIsLive =
      !controlRender.body.includes(STALE_MARKER) &&
      controlRender.body.includes("Stitch Studio Quilting");
    check(
      "CONTROL: caching is genuinely engaged in this harness (a DB change the cache key doesn't cover does NOT appear on re-render)",
      cacheIsLive,
      `stale marker present: ${controlRender.body.includes(STALE_MARKER)}`
    );
    if (!cacheIsLive) {
      console.error(
        "\n  !!! CACHE CONTROL FAILED: the Cache API does not appear to be engaged under unstable_dev in this harness.\n" +
        "  !!! Every render here would be rebuilt fresh regardless of the cache key, which means the\n" +
        "  !!! PATCH-then-re-render invalidation check immediately below is VACUOUS -- it would pass\n" +
        "  !!! identically whether or not the Fix 1 cache-key change does anything at all.\n" +
        "  !!! This is not being papered over: it needs to reach the whole-branch review as an open question,\n" +
        "  !!! not treated as a pass.\n"
      );
    }
    // Revert -- leave the fixture the way the rest of this file expects it
    // (matches the "contains hero title in the source" check earlier in
    // this run). Still not touching updated_at either way, so the cache
    // key is unaffected by this revert regardless of which way the control
    // above went.
    d1Exec(`
UPDATE pages SET blocks_json = '[{"type":"hero","title":"Stitch Studio Quilting","subtitle":"Longarm quilting"}]'
WHERE id = 'pg_bs_home' AND tenant_id = '${TENANT}';
`);

    const site = await reqJson(HOST, `/api/tenants/${TENANT}`, { headers: auth });
    check("harness (now owner) can read the tenant record", site.status === 200,
      `got ${site.status} ${JSON.stringify(site.json).slice(0, 200)}`);
    let settings = {};
    try { settings = JSON.parse(site.json?.settings_json || "{}"); } catch { settings = {}; }
    const NEW_PHONE = "555-222-9999";
    settings.business = { ...(settings.business || {}), phone: NEW_PHONE };

    const patch = await reqJson(HOST, `/api/tenants/${TENANT}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ settings }),
    });
    check("Business Details PATCH (the real admin save path) succeeds", patch.status === 200,
      `got ${patch.status} ${JSON.stringify(patch.json).slice(0, 200)}`);

    const after = await req(HOST, "/");
    check("home page re-renders with the NEW phone number after the save (cache invalidated)",
      after.body.includes(`"telephone":"${NEW_PHONE}"`), after.body.slice(0, 4000));
    check("home page no longer carries the stale phone number",
      !after.body.includes('"telephone":"555-867-5309"'), after.body.slice(0, 4000));
  }

  console.log("\nA real 404 (not the guild SPA shell):");
  {
    const r = await req(HOST, "/this-page-does-not-exist-xyz");
    check("unmatched path on the business tenant is a real 404",
      r.status === 404, `got ${r.status}`);
    check("404 body is not the guild SPA shell",
      !r.body.includes('id="guild-app"') && !r.body.includes("guild.js"),
      r.body.slice(0, 200));
  }

  console.log("\nGate matrix:");
  {
    const platform = await req(PLATFORM_HOST, "/");
    check("platform apex still gated", platform.status === 401, `got ${platform.status}`);

    const admin = await req(HOST, "/admin");
    check("/admin gated on the tenant domain", admin.status === 401, `got ${admin.status}`);

    const portal = await req(HOST, "/portal");
    check("/portal gated on the tenant domain", portal.status === 401, `got ${portal.status}`);

    d1Exec(`UPDATE tenants SET public_launched = 0 WHERE id = '${TENANT}';`);
    const dark = await req(HOST, "/");
    check("unlaunched tenant is gated", dark.status === 401, `got ${dark.status}`);

    d1Exec(`UPDATE tenants SET tenant_type = 'guild', public_launched = 1 WHERE id = '${TENANT}';`);
    const guild = await req(HOST, "/");
    check("a guild is never launch-exempt", guild.status === 401, `got ${guild.status}`);

    d1Exec(`UPDATE tenants SET tenant_type = 'business', public_launched = 1 WHERE id = '${TENANT}';`);
    const relaunched = await req(HOST, "/");
    check("re-launched business tenant is gate-exempt again (sanity check on the toggles above)",
      relaunched.status === 200, `got ${relaunched.status}`);
  }

  console.log("\nGuild theme compatibility (/public/<slug>/site):");
  {
    // Unauthenticated and not on siteGate's always-exempt list -- reachable
    // only via rule 4 of the launched tenant's own allowlist (its own host +
    // its own slug under /public/), so this MUST be fetched against HOST.
    const r = await reqJson(HOST, "/public/stitchstudio/site");
    check("/public/<slug>/site is reachable on the launched tenant's own host",
      r.status === 200, `got ${r.status}`);
    // Exact seeded value, not just a type check -- the rendered-site theme
    // check above already pins "--color-primary:#8a2060"; be consistent so
    // a regression that returns a plausible-but-wrong color is caught here
    // too, not just a missing/renamed field.
    check("/site still emits legacy theme.primary with the seeded color",
      r.json?.theme?.primary === "#8a2060", JSON.stringify(r.json?.theme));
    check("/site emits the full token set (textMuted from DEFAULT_THEME, unconfigured)",
      r.json?.theme_tokens?.textMuted === "#504852", JSON.stringify(r.json?.theme_tokens));
  }

  console.log("\nMember cap exemption (business tenants are exempt from the free-plan 30-active cap):");
  {
    d1Exec(`
DELETE FROM memberships WHERE tenant_id = '${TENANT}';
DELETE FROM members WHERE tenant_id = '${TENANT}';
DELETE FROM membership_levels WHERE tenant_id = '${TENANT}';
INSERT INTO membership_levels (id, tenant_id, name, price_cents, duration_months, renewal_type, status)
VALUES ('lvl_bs_free', '${TENANT}', 'Free Plan', 0, 12, 'manual', 'active');
`);
    const fillStmts = [];
    for (let i = 0; i < 30; i++) {
      fillStmts.push(
        `INSERT INTO members (id, tenant_id, email, status, joined_at) VALUES ` +
        `('mem_bs_fill_${i}', '${TENANT}', 'fill-${i}@stitchstudio.test', 'active', datetime('now'));`
      );
    }
    d1Exec(fillStmts.join("\n"));

    const before = d1Query(
      `SELECT count(*) AS n FROM members WHERE tenant_id = '${TENANT}' AND status = 'active'`
    );
    check("precondition: 30 active members already seeded on the business tenant",
      before[0]?.n === 30, `got ${before[0]?.n}`);

    const join = await reqJson(HOST, "/public/stitchstudio/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level_id: "lvl_bs_free",
        email: "newmember@stitchstudio.test",
        first_name: "New",
        last_name: "Member",
      }),
    });
    check("join succeeds despite 30 active members (business tenants are cap-exempt)",
      join.status === 200, `got ${join.status} ${JSON.stringify(join.json).slice(0, 200)}`);
    check("join activated the membership, not a plan-limit error",
      join.json?.status === "active", JSON.stringify(join.json));
    check("join response is not the plan_limit error code",
      join.json?.code !== "plan_limit", JSON.stringify(join.json));
  }

  // ---------------------------------------------------------------------
  // Closes the one `[~]` item in the plan's Definition of Done. Tasks 13-14
  // shipped the site-builder panels (pages, blocks, appearance, nav, domain)
  // with no end-to-end assertion behind them -- only Business Details and the
  // launch toggle were covered. Every check below drives the SAME endpoint
  // public/qh-site-builder.js calls from the owner's browser, with the same
  // body shape, and then asserts the PUBLIC RENDER changed. Asserting the API
  // returned 200 alone would be near-worthless here: the POST /pages handler
  // has a catch-fallback that silently re-inserts WITHOUT blocks_json, so a
  // status-only check would pass on a page whose content had been dropped.
  //
  // Placed last among the HTTP sections on purpose: it mutates theme, nav,
  // pages, and custom_domain, and the "Guild theme compatibility" section
  // above pins theme.primary to the seeded #8a2060. Each sub-block still
  // restores what it touched, but the ordering means a restore bug surfaces
  // as a failure here rather than as a confusing failure in an earlier
  // section that has nothing to do with the site builder.
  // ---------------------------------------------------------------------
  console.log("\nSite builder editor round trips (Tasks 13-14: pages, blocks, appearance, nav, domain):");
  {
    const PAGE_SLUG = "harness-services";
    const HERO_V1 = "HARNESS-HERO-V1-longarm";
    const HERO_V2 = "HARNESS-HERO-V2-edited";
    const TEXT_V1 = "HARNESS-TEXT-V1-body-copy";
    const SEO_TITLE = "Harness SEO Title For Services";
    const SEO_DESC = "Harness SEO description for the services page.";

    check("precondition: an owner-scoped token is available from the section above",
      !!ownerAuth, "ownerAuth was never assigned");

    // ---- Pages: create -------------------------------------------------
    const created = await reqJson(HOST, `/api/tenants/${TENANT}/pages`, {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({
        title: "Harness Services",
        slug: PAGE_SLUG,
        blocks: [
          { type: "hero", title: HERO_V1, subtitle: "Edge to edge and custom" },
          { type: "text", html: `<p>${TEXT_V1}</p>` },
        ],
        seo_title: SEO_TITLE,
        seo_description: SEO_DESC,
        noindex: false,
        published: true,
      }),
    });
    check("New page POST (the real 'New page' -> Save path) succeeds",
      created.status === 200 || created.status === 201,
      `got ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
    const pageId = created.json?.id || created.json?.page?.id;
    check("the created page came back with an id", !!pageId,
      JSON.stringify(created.json).slice(0, 200));

    const rendered = await req(HOST, `/${PAGE_SLUG}`);
    check("the new page is served at its own slug", rendered.status === 200,
      `got ${rendered.status}`);
    // This is the check that catches the POST handler's silent
    // no-blocks_json fallback: the row would exist and 200, with no content.
    check("the hero block the owner authored is in the rendered HTML",
      rendered.body.includes(HERO_V1), rendered.body.slice(0, 1500));
    check("the text block is rendered too (multi-block page, not just the first)",
      rendered.body.includes(TEXT_V1), rendered.body.slice(0, 1500));
    // Deliberately NOT `body.includes(SEO_TITLE)` with an `||` fallback: that
    // string also appears in the meta description block, so the loose form
    // would pass even if seo_title never reached <title> at all.
    check("seo_title drives the <title> tag",
      rendered.body.includes(`<title>${SEO_TITLE}`), rendered.body.slice(0, 800));
    check("seo_description drives the meta description",
      rendered.body.includes(SEO_DESC), rendered.body.slice(0, 800));

    // ---- Blocks: edit an existing page ---------------------------------
    // Also a second, independent proof that the page-level half of the
    // cache key (pages.updated_at) invalidates -- the Business Details
    // section above only exercised the tenant.updated_at half.
    const edited = await reqJson(HOST, `/api/tenants/${TENANT}/pages/${pageId}`, {
      method: "PATCH",
      headers: ownerAuth,
      body: JSON.stringify({
        title: "Harness Services",
        slug: PAGE_SLUG,
        blocks: [{ type: "hero", title: HERO_V2, subtitle: "Edited" }],
        seo_title: SEO_TITLE,
        seo_description: SEO_DESC,
        noindex: false,
        published: true,
      }),
    });
    check("Blocks edit PATCH succeeds", edited.status === 200,
      `got ${edited.status} ${JSON.stringify(edited.json).slice(0, 200)}`);

    const afterEdit = await req(HOST, `/${PAGE_SLUG}`);
    check("the edited hero block is rendered", afterEdit.body.includes(HERO_V2),
      afterEdit.body.slice(0, 1500));
    check("the pre-edit block content is GONE (page-level cache invalidated)",
      !afterEdit.body.includes(HERO_V1) && !afterEdit.body.includes(TEXT_V1),
      afterEdit.body.slice(0, 1500));

    // ---- Published toggle ----------------------------------------------
    const unpub = await reqJson(HOST, `/api/tenants/${TENANT}/pages/${pageId}`, {
      method: "PATCH",
      headers: ownerAuth,
      body: JSON.stringify({ published: false }),
    });
    check("unpublish PATCH succeeds", unpub.status === 200, `got ${unpub.status}`);
    const whileUnpublished = await req(HOST, `/${PAGE_SLUG}`);
    check("an unpublished page 404s to the public (published = 1 filter is real)",
      whileUnpublished.status === 404, `got ${whileUnpublished.status}`);

    const repub = await reqJson(HOST, `/api/tenants/${TENANT}/pages/${pageId}`, {
      method: "PATCH",
      headers: ownerAuth,
      body: JSON.stringify({ published: true }),
    });
    check("re-publish PATCH succeeds", repub.status === 200, `got ${repub.status}`);
    const afterRepub = await req(HOST, `/${PAGE_SLUG}`);
    check("the re-published page is public again",
      afterRepub.status === 200, `got ${afterRepub.status}`);

    // ---- Appearance ----------------------------------------------------
    // Capture the tenant's real settings first so theme AND nav below can be
    // restored to exactly what the rest of this file expects.
    const tenantBefore = await reqJson(HOST, `/api/tenants/${TENANT}`, { headers: ownerAuth });
    let baseSettings = {};
    try { baseSettings = JSON.parse(tenantBefore.json?.settings_json || "{}"); } catch { baseSettings = {}; }

    const THEME_PRIMARY = "#123456";
    const THEME_MUTED = "#654321";
    const THEME_COLOR = "#0f0f0f";
    const appearance = await reqJson(HOST, `/api/tenants/${TENANT}`, {
      method: "PATCH",
      headers: ownerAuth,
      body: JSON.stringify({
        settings: {
          ...baseSettings,
          theme: {
            ...(baseSettings.theme || {}),
            primary: THEME_PRIMARY,
            textMuted: THEME_MUTED,
            themeColor: THEME_COLOR,
          },
          fonts: { heading: "fraunces", body: "inter" },
        },
      }),
    });
    check("Save appearance PATCH succeeds", appearance.status === 200,
      `got ${appearance.status} ${JSON.stringify(appearance.json).slice(0, 200)}`);

    const themed = await req(HOST, "/");
    check("the saved primary color reaches the inline :root custom properties",
      themed.body.includes(`--color-primary:${THEME_PRIMARY}`), themed.body.slice(0, 2500));
    // A token the seed never set: proves the whole token set is written from
    // the save, not just the one field the fixture happened to carry.
    check("a token the fixture never seeded (textMuted) is written from the save too",
      themed.body.includes(`--color-text-muted:${THEME_MUTED}`), themed.body.slice(0, 2500));
    check("themeColor drives <meta name=\"theme-color\">",
      themed.body.includes(THEME_COLOR), themed.body.slice(0, 2500));
    check("the pre-save primary color is gone from the render",
      !themed.body.includes("--color-primary:#8a2060"), themed.body.slice(0, 2500));

    // ---- Navigation ----------------------------------------------------
    const NAV_LABEL = "Harness Nav Item";
    const navSaved = await reqJson(HOST, `/api/tenants/${TENANT}`, {
      method: "PATCH",
      headers: ownerAuth,
      body: JSON.stringify({
        settings: {
          ...baseSettings,
          nav: [{ label: NAV_LABEL, href: `/${PAGE_SLUG}` }],
        },
      }),
    });
    check("Navigation save (part of the Business details panel) succeeds",
      navSaved.status === 200, `got ${navSaved.status}`);

    const withNav = await req(HOST, "/");
    check("the explicit nav item is rendered in the site nav",
      withNav.body.includes(NAV_LABEL) && withNav.body.includes(`href="/${PAGE_SLUG}"`),
      withNav.body.slice(0, 3000));
    check("the explicit nav is inside the <nav class=\"qh-site-nav\"> element",
      /<nav class="qh-site-nav">[\s\S]*?Harness Nav Item[\s\S]*?<\/nav>/.test(withNav.body),
      withNav.body.slice(0, 3000));

    // Empty nav must fall back to listing published pages -- the admin panel
    // documents that behavior ("Leave empty to list published pages
    // automatically"), so it is part of the contract, not an implementation
    // detail.
    const navCleared = await reqJson(HOST, `/api/tenants/${TENANT}`, {
      method: "PATCH",
      headers: ownerAuth,
      body: JSON.stringify({ settings: { ...baseSettings, nav: [] } }),
    });
    check("clearing the nav succeeds", navCleared.status === 200, `got ${navCleared.status}`);
    const navFallback = await req(HOST, "/");
    check("an empty nav falls back to auto-listing published pages",
      navFallback.body.includes("Harness Services"), navFallback.body.slice(0, 3000));
    check("the removed explicit nav label is no longer rendered",
      !navFallback.body.includes(NAV_LABEL), navFallback.body.slice(0, 3000));

    // Restore theme + nav to exactly the seeded settings object.
    const restored = await reqJson(HOST, `/api/tenants/${TENANT}`, {
      method: "PATCH",
      headers: ownerAuth,
      body: JSON.stringify({ settings: baseSettings }),
    });
    check("settings restored to the seeded fixture", restored.status === 200,
      `got ${restored.status}`);
    const afterRestore = await req(HOST, "/");
    check("the seeded primary color is back after the restore",
      afterRestore.body.includes("--color-primary:#8a2060"), afterRestore.body.slice(0, 2500));

    // ---- Domain --------------------------------------------------------
    // SAFE TO RUN: domain.ts calls provisionSaasDomain -> createSaasCustomHostname,
    // which returns early with "CLOUDFLARE_API_TOKEN not configured" when that
    // var is absent -- and it is absent from BOTH .dev.vars and wrangler.toml
    // [vars] in this repo (verified). So no request ever reaches
    // api.cloudflare.com and no real SaaS hostname is created by this test.
    // The assertion on saas.www.ok below is what keeps that true: if someone
    // adds a live token to local config, this check FAILS loudly instead of
    // quietly provisioning a bogus hostname on the real zone.
    const TEST_DOMAIN = "harness-domain-check.test";
    const domainSaved = await reqJson(HOST, `/api/tenants/${TENANT}/domain`, {
      method: "PUT",
      headers: ownerAuth,
      body: JSON.stringify({ domain: TEST_DOMAIN }),
    });
    check("Save domain PUT succeeds", domainSaved.status === 200,
      `got ${domainSaved.status} ${JSON.stringify(domainSaved.json).slice(0, 200)}`);
    check("the response echoes the normalized custom domain",
      domainSaved.json?.custom_domain === TEST_DOMAIN,
      JSON.stringify(domainSaved.json?.custom_domain));
    check("SAFETY: no live Cloudflare token in local config, so no real SaaS hostname was created",
      domainSaved.json?.saas?.www?.ok === false &&
        /CLOUDFLARE_API_TOKEN not configured/.test(domainSaved.json?.saas?.www?.error || ""),
      JSON.stringify(domainSaved.json?.saas));
    check("the owner still gets DNS instructions to act on despite the failed provision",
      !!domainSaved.json?.dns && !!domainSaved.json?.cname_target,
      JSON.stringify(domainSaved.json?.dns).slice(0, 200));

    // The real proof the save took effect: host-based tenant routing follows
    // the new domain, and stops answering on the old one.
    const onNewDomain = await req(TEST_DOMAIN, "/");
    check("the site is served on the newly saved domain", onNewDomain.status === 200,
      `got ${onNewDomain.status}`);
    check("the site on the new domain is this tenant's site",
      onNewDomain.body.includes("Stitch Studio Quilting"), onNewDomain.body.slice(0, 800));
    const onOldDomain = await req(HOST, "/");
    check("the previous host no longer resolves to this tenant (it is gated, not served)",
      onOldDomain.status === 401, `got ${onOldDomain.status}`);

    // Restore -- everything after this point, including the fixture cleanup
    // in the finally block, expects HOST to be this tenant's domain.
    const domainRestored = await reqJson(TEST_DOMAIN, `/api/tenants/${TENANT}/domain`, {
      method: "PUT",
      headers: ownerAuth,
      body: JSON.stringify({ domain: HOST }),
    });
    check("domain restored to the fixture host", domainRestored.status === 200,
      `got ${domainRestored.status} ${JSON.stringify(domainRestored.json).slice(0, 200)}`);
    const backOnHost = await req(HOST, "/");
    check("the original host serves the site again after the restore",
      backOnHost.status === 200, `got ${backOnHost.status}`);

    // ---- Pages: delete -------------------------------------------------
    const deleted = await reqJson(HOST, `/api/tenants/${TENANT}/pages/${pageId}`, {
      method: "DELETE",
      headers: ownerAuth,
    });
    check("page DELETE succeeds", deleted.status === 200 || deleted.status === 204,
      `got ${deleted.status}`);
    const afterDelete = await req(HOST, `/${PAGE_SLUG}`);
    check("the deleted page 404s", afterDelete.status === 404, `got ${afterDelete.status}`);
  }

  console.log("\nP1 longarm chain (intake -> estimate -> sign):");
  {
    check("precondition: an owner-scoped token is available from the sections above",
      !!ownerAuth, "ownerAuth was never assigned");

    // Fetch the tenant's CURRENT settings fresh rather than reusing the
    // site-builder section's block-scoped `baseSettings` (out of scope here)
    // -- this also means the PATCH below is robust to whatever that section
    // already restored, rather than assuming its restore succeeded.
    const preP1 = await reqJson(HOST, `/api/tenants/${TENANT}`, { headers: ownerAuth });
    let baseSettings = {};
    try { baseSettings = JSON.parse(preP1.json?.settings_json || "{}"); } catch { baseSettings = {}; }

    // Rates must exist or the ballpark suppresses -- set them through the real
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
      `SELECT id, status, member_id FROM projects WHERE tenant_id = '${TENANT}' AND reference = '${reference}'`
    );
    check("project row written at status submitted", row[0]?.status === "submitted", JSON.stringify(row[0]));
    // The other half of "created at send time, not at intake" -- checked
    // HERE, immediately after intake and before send-estimate runs at all,
    // not merely inferred from member_id being set later. Without this half,
    // a member created (wrongly) during intake would still show a non-null
    // member_id after send-estimate's own find-or-create upsert runs on the
    // same email, and the later check alone would never catch the mistake.
    check("no customer record exists yet immediately after intake",
      row[0]?.member_id == null, JSON.stringify(row[0]));
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

    // The signing form round-trips the agreement fingerprint through a
    // hidden field so the POST can prove the text it's about to hash and
    // sign is the text that was actually rendered -- extract it from the
    // page exactly the way the real form's own JS does (quote.ts's inline
    // script reads f.agreement_sha256.value), rather than recomputing it
    // independently, which would only prove the harness's own math is
    // self-consistent, never that it matches what the server rendered.
    const sha256Match = quote.body.match(/name="agreement_sha256" value="([0-9a-f]{64})"/);
    check("quote page emits the agreement_sha256 hidden field", !!sha256Match, quote.body.slice(0, 2000));
    const agreementSha256 = sha256Match ? sha256Match[1] : "";

    const badToken = await req(HOST, `/quote/${"z".repeat(43)}`);
    check("an unknown token 404s", badToken.status === 404, `got ${badToken.status}`);
    check("the unknown-token page does not reveal whether the token existed",
      badToken.body.includes("no longer valid"), badToken.body.slice(0, 400));

    // --- Negative control: an unknown token and an expired (unsigned) token
    // must be INDISTINGUISHABLE from outside -- same status, same body.
    // Minted synthetically (hash pre-computed the same way hashToken() would
    // produce it) because the harness has no other way to get a token whose
    // project row it can also set an already-past token_expires_at on.
    const expiredRawToken = randomBytes(32).toString("base64url");
    const expiredHash = sha256Hex(expiredRawToken);
    d1Exec(`
INSERT INTO projects
  (id, tenant_id, project_type, status, reference, customer_name, customer_email,
   intake_json, subtotal_cents, total_cents, access_token_hash, token_expires_at, created_at, updated_at)
VALUES
  ('prj_verify_expired', '${TENANT}', 'longarm', 'estimated', 'SSQ-EXP1', 'Expired Test', 'expired@example.test',
   '{}', 12000, 12000, '${expiredHash}', datetime('now','-1 day'), datetime('now'), datetime('now'));
`);
    const expiredResp = await req(HOST, `/quote/${expiredRawToken}`);
    check("an expired (unsigned) token also 404s", expiredResp.status === 404, `got ${expiredResp.status}`);
    check("an unknown token and an expired token return byte-identical bodies (no existence oracle)",
      expiredResp.status === badToken.status && expiredResp.body === badToken.body,
      `expired: ${expiredResp.status} ${expiredResp.body.slice(0, 200)} | unknown: ${badToken.status} ${badToken.body.slice(0, 200)}`);

    // --- Negative control: a token minted for ANOTHER tenant's project must
    // not resolve on this tenant's host. FOREIGN_TENANT is a real,
    // pre-existing tenant (seeded above for the /img cross-tenant check) --
    // this project genuinely exists in `projects`, just under a different
    // tenant_id, so a pass here proves the `AND tenant_id = ?` clause in
    // site.ts's lookup is doing the work, not merely that a made-up token
    // fails.
    const crossRawToken = randomBytes(32).toString("base64url");
    const crossHash = sha256Hex(crossRawToken);
    d1Exec(`
INSERT INTO projects
  (id, tenant_id, project_type, status, reference, customer_name, customer_email,
   intake_json, subtotal_cents, total_cents, access_token_hash, token_expires_at, created_at, updated_at)
VALUES
  ('prj_verify_crosstenant', '${FOREIGN_TENANT}', 'longarm', 'estimated', 'FRN-0001', 'Cross Tenant Test', 'cross@example.test',
   '{}', 5000, 5000, '${crossHash}', datetime('now','+90 days'), datetime('now'), datetime('now'));
`);
    const crossResp = await req(HOST, `/quote/${crossRawToken}`);
    check("a cross-tenant token does not resolve on this tenant's host",
      crossResp.status === 404 && crossResp.body === badToken.body, `got ${crossResp.status}`);

    const signed = await reqJson(HOST, `/quote/${token}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signer_name: "Jane Quilter", consent: true, agreement_sha256: agreementSha256 }),
    });
    check("signing succeeds", signed.status === 200, `got ${signed.status} ${JSON.stringify(signed.json)}`);

    const sigRows = d1Query(
      `SELECT signer_name, agreement_sha256, agreement_text FROM agreement_signatures WHERE project_id = '${projectId}'`
    );
    check("exactly one signature row exists", sigRows.length === 1, `got ${sigRows.length}`);
    check("the snapshot captured the agreement body",
      (sigRows[0]?.agreement_text || "").includes("performed at the customer's risk"),
      sigRows[0]?.agreement_text);
    // The actual integrity guarantee this whole table exists for: the stored
    // fingerprint must equal SHA-256 of the stored document, independently
    // recomputed here -- not merely "some 64-hex-char string was stored".
    check("stored agreement_sha256 equals SHA-256(stored agreement_text)",
      sigRows[0]?.agreement_sha256 === sha256Hex(sigRows[0]?.agreement_text || ""),
      `stored hash: ${sigRows[0]?.agreement_sha256}`);

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

  // Stop the HTTP worker before the renewals check below: that check opens
  // a second, independent local D1 session via getPlatformProxy against the
  // same on-disk SQLite/WAL files, and there is no reason to have two
  // separate D1 sessions open concurrently against the same state when a
  // simple sequencing avoids it entirely.
  console.log("\nStopping worker...");
  await worker.stop();
  worker = null;

  console.log("\nRenewals exclusion (real runRenewalJob invocation, not a re-typed guard string):");
  await renewalsExclusionCheck();
} finally {
  if (worker) {
    console.log("\nStopping worker...");
    await worker.stop();
  }
  console.log("Cleaning up business tenant fixture...");
  try {
    d1Exec(`
DELETE FROM files WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM memberships WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM members WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM membership_levels WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM pages WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM agreement_signatures WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM project_lines WHERE project_id IN (SELECT id FROM projects WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}'));
DELETE FROM projects WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM project_counters WHERE tenant_id IN ('${TENANT}', '${FOREIGN_TENANT}');
DELETE FROM tenants WHERE id IN ('${TENANT}', '${FOREIGN_TENANT}');
`);
  } catch (e) {
    console.error("cleanup failed (non-fatal):", e?.message || e);
  }
  if (testConfigPath) {
    try { unlinkSync(testConfigPath); } catch {}
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
