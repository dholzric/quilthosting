/**
 * Delivery reliability harness.
 * Usage: node scripts/verify-delivery.mjs   (wrangler dev on :8787)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BASE = process.env.QH_BASE || "http://127.0.0.1:8787";
let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) return void console.log(`  ok  ${label}`);
  failures++; console.error(`  FAIL ${label} ${detail}`);
};
async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; }
  catch { return { status: res.status, body: { raw: t.slice(0, 200) } }; }
}

// Stable harness account — registering per run exhausts the 10-per-10-min limit.
const EMAIL = "harness@example.test", PASSWORD = "harness-password-1";
let jwt;
{
  const login = await json("/api/auth/login", { method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (login.status === 200) jwt = login.body.token;
  else {
    const reg = await json("/api/auth/register", { method: "POST",
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Harness" }) });
    if (reg.status >= 400) throw new Error(`auth failed: login ${login.status}, register ${reg.status}`);
    jwt = reg.body.token;
  }
}
const auth = { Authorization: `Bearer ${jwt}` };
const stamp = randomUUID().slice(0, 8);
const tenant = await json("/api/tenants", { method: "POST", headers: auth,
  body: JSON.stringify({ name: `Delivery ${stamp}`, slug: `delivery-${stamp}` }) });
const tenantId = tenant.body.id;

console.log("--- atomicity ---");
// A payload that fails schema validation must abort the whole batch, so the
// member must NOT exist afterwards. `status` is required by the member.created
// schema; the route always supplies it, so we force the failure with a header
// the route honours only in development.
const before = await json(`/api/tenants/${tenantId}/members`, { headers: auth });
const bad = await json(`/api/tenants/${tenantId}/members`, {
  method: "POST", headers: { ...auth, "X-QH-Force-Outbox-Failure": "1" },
  body: JSON.stringify({ email: `atomic-${stamp}@example.test`, first_name: "Atomic" }),
});
const after = await json(`/api/tenants/${tenantId}/members`, { headers: auth });
// Guard against a vacuous pass: if either list call itself failed (e.g. tenant
// creation failed and tenantId is undefined), before/after would both be
// `undefined ?? 0 === undefined ?? 0` -> 0 === 0 -> green on a broken run.
check("before/after member list calls succeeded",
  typeof before.body.total === "number" && typeof after.body.total === "number",
  `before ${before.status} ${JSON.stringify(before.body)}, after ${after.status} ${JSON.stringify(after.body)}`);
check("forced outbox failure rejects the request", bad.status >= 400, `got ${bad.status}`);
check("forced outbox failure leaves NO member behind",
  after.body.total === before.body.total,
  `${before.body.total} -> ${after.body.total}`);

console.log("--- lease ---");
// Two concurrent dispatches of the same row: exactly one may win the claim.
// Driven through the admin replay endpoint, which enqueues a dispatch.
const hook = await json(`/api/tenants/${tenantId}/webhooks`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ url: "http://127.0.0.1:8798/never-listens", events: ["*"] }),
});
await json(`/api/tenants/${tenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: `lease-${stamp}@example.test` }),
});
await new Promise((r) => setTimeout(r, 3000));
const ob = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
const row = ob.body.outbox?.[0];
check("outbox row exists for the lease test", !!row);
const [a, b] = await Promise.all([
  json(`/api/tenants/${tenantId}/webhooks/outbox/${row.id}/replay`, { method: "POST", headers: auth }),
  json(`/api/tenants/${tenantId}/webhooks/outbox/${row.id}/replay`, { method: "POST", headers: auth }),
]);
check("concurrent replays both answered", a.status === 200 && b.status === 200);
await new Promise((r) => setTimeout(r, 4000));
const ob2 = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
const row2 = ob2.body.outbox.find((r) => r.id === row.id);
check("concurrent dispatch did not double-count attempts",
  row2.attempts <= 2, `attempts=${row2.attempts}`);

console.log("--- lease (deterministic) ---");
// The HTTP-driven check above is timing-dependent: with a connection-refused
// target the whole dispatch (SELECT + failed fetch + UPDATE) finishes fast
// enough that two concurrent replay calls rarely straddle the race window,
// so it passed both before and after claimOutboxRow existed in this run.
// That is not a reliable regression signal for the thing this task adds:
// the atomic compare-and-set in claimOutboxRow (src/lib/webhookOutbox.ts).
//
// Instead we exercise that exact SQL directly against the same local D1 file
// wrangler dev is using, via `wrangler d1 execute --local`, launching two
// processes concurrently with spawn (not spawnSync) so they truly overlap.
// SQLite serializes writers, so the outcome is deterministic every run:
// exactly one UPDATE's WHERE clause matches. This SQL must be kept in sync
// with claimOutboxRow's WHERE clause if that ever changes.
const workDir = mkdtempSync(join(tmpdir(), "qh-lease-"));
function runD1(sql) {
  const file = join(workDir, `${randomUUID()}.sql`);
  writeFileSync(file, sql, "utf8");
  return new Promise((resolve, reject) => {
    const p = spawn(
      "npx",
      ["wrangler", "d1", "execute", "quilthosting-db", "--local", "--json", "--file", file],
      { shell: true }
    );
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`wrangler d1 execute failed: ${err || out}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`could not parse d1 output: ${out}`)); }
    });
  });
}
// Last statement's row count, via SQLite's changes() bound to the connection
// that ran the preceding UPDATE.
const claimedCount = (result) => result.at(-1)?.results?.[0]?.n ?? -1;

const leaseId = `lease-det-${stamp}`;
await runD1(`
  INSERT INTO webhook_outbox
    (id, tenant_id, event, schema_version, payload_json, status, attempts, created_at, updated_at)
  VALUES ('${leaseId}', '${tenantId}', 'member.created', 1, '{}', 'pending', 0,
          datetime('now'), datetime('now'));
`);

// Mirrors claimOutboxRow's UPDATE exactly (see src/lib/webhookOutbox.ts).
const claimSql = (nowIso, leaseUntilIso) => `
  UPDATE webhook_outbox
     SET status = 'delivering', claimed_at = '${nowIso}', lease_until = '${leaseUntilIso}', updated_at = '${nowIso}'
   WHERE id = '${leaseId}'
     AND (status = 'pending' OR (status = 'delivering' AND lease_until <= '${nowIso}'))
     AND (next_attempt_at IS NULL OR next_attempt_at <= '${nowIso}');
  SELECT changes() as n;
`;

{
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 120_000).toISOString();
  const [ra, rb] = await Promise.all([
    runD1(claimSql(now, leaseUntil)),
    runD1(claimSql(now, leaseUntil)),
  ]);
  const wins = [claimedCount(ra), claimedCount(rb)];
  check("exactly one of two concurrent claims on a pending row wins",
    wins.filter((n) => n === 1).length === 1 && wins.filter((n) => n === 0).length === 1,
    `changes=[${wins.join(",")}]`);
}

{
  // Lease still fresh (in the future): a third claim attempt must NOT win.
  const now = new Date().toISOString();
  const rc = await runD1(claimSql(now, new Date(Date.now() + 120_000).toISOString()));
  check("a live (unexpired) lease blocks another claim", claimedCount(rc) === 0,
    `changes=${claimedCount(rc)}`);
}

{
  // Force the row into a stuck state: delivering, lease expired in the past
  // (simulates a Worker that crashed mid-delivery).
  const past = new Date(Date.now() - 5000).toISOString();
  await runD1(`
    UPDATE webhook_outbox SET status = 'delivering', lease_until = '${past}' WHERE id = '${leaseId}';
  `);
  const now = new Date().toISOString();
  const rd = await runD1(claimSql(now, new Date(Date.now() + 120_000).toISOString()));
  check("an expired lease on a 'delivering' row is reclaimable", claimedCount(rd) === 1,
    `changes=${claimedCount(rd)}`);
}

await runD1(`DELETE FROM webhook_outbox WHERE id = '${leaseId}';`);
rmSync(workDir, { recursive: true, force: true });

console.log(failures ? `\n${failures} failure(s)` : "\nall delivery checks passed");
if (failures) process.exit(1);
