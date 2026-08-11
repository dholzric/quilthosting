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
import { unstable_dev, getPlatformProxy } from "wrangler";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "stitchstudioquilting.test";
const TENANT = "tnt_demo_business";
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
DELETE FROM memberships WHERE tenant_id = '${TENANT}';
DELETE FROM members WHERE tenant_id = '${TENANT}';
DELETE FROM membership_levels WHERE tenant_id = '${TENANT}';
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
DELETE FROM memberships WHERE tenant_id = '${TENANT}';
DELETE FROM members WHERE tenant_id = '${TENANT}';
DELETE FROM membership_levels WHERE tenant_id = '${TENANT}';
DELETE FROM pages WHERE tenant_id = '${TENANT}';
DELETE FROM tenants WHERE id = '${TENANT}';
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
