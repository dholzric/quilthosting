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
 */
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unstable_dev } from "wrangler";

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
    check("shows the platform credit", r.body.includes("Powered by"));
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
    check("/site still emits legacy theme.primary", typeof r.json?.theme?.primary === "string");
    check("/site emits the full token set", typeof r.json?.theme_tokens?.textMuted === "string");
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

  console.log("\nRenewals exclusion:");
  {
    // A business tenant must not appear in the guild-only trial-expiry scan
    // (src/lib/renewals.ts). Same guard clause, verbatim.
    const n = d1Query(
      `SELECT count(*) AS n FROM tenants WHERE id = '${TENANT}' AND coalesce(tenant_type,'guild') = 'guild';`
    );
    check("business tenant excluded by the guild guard", n[0]?.n === 0, `matched ${n[0]?.n}`);
  }
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
