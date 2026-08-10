/**
 * Delivery reliability harness.
 * Usage: node scripts/verify-delivery.mjs   (wrangler dev on :8787)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Read-only D1 inspection, used to assert on observable state (status,
// lease_until, claimed_at, attempts, delivery counts) produced by the real
// shipped dispatch path — never to re-implement its SQL. Runs against the
// same local D1 file wrangler dev uses.
const d1WorkDir = mkdtempSync(join(tmpdir(), "qh-d1-"));
function runD1(sql) {
  const file = join(d1WorkDir, `${randomUUID()}.sql`);
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
async function d1Select(sql) {
  const result = await runD1(sql);
  return result.at(-1)?.results ?? [];
}

/**
 * Seeds a webhook endpoint straight into D1, bypassing the admin route.
 *
 * Task 6 made the admin route require https and apply validateHookUrl's
 * deny list (loopback, private ranges, link-local/metadata, our own
 * domains) -- correctly, since the Worker later fetches whatever URL is
 * stored there. But this harness's dispatch/lease/fan-out/retry tests need
 * to point real outbox dispatch at host-loopback sinks the local Worker can
 * actually reach, which that same rule now (rightly) forbids through the
 * route. Insert the row directly instead of weakening the route's
 * validation. Mirrors the admin POST response shape ({status, body:{id}})
 * so call sites need no other changes.
 */
async function seedHook(tId, url, events) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const eventsJson = JSON.stringify(events).replace(/'/g, "''");
  await runD1(
    `INSERT INTO webhook_endpoints
       (id, tenant_id, url, secret, events_json, is_active, created_at, updated_at)
     VALUES ('${id}', '${tId}', '${url}', NULL, '${eventsJson}', 1, '${now}', '${now}');`
  );
  return { status: 201, body: { id } };
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
// NOTE: this block does not prove concurrency safety. With a connection-
// refused target, replay resets attempts=0 and a single dispatch can add at
// most 1, so `attempts <= 2` is unfalsifiable regardless of whether the two
// concurrent replays actually double-dispatched. Kept for basic endpoint
// sanity; see "--- lease (real dispatch) ---" below for the actual guard.
const hook = await seedHook(tenantId, "http://127.0.0.1:8798/never-listens", ["*"]);
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
check("replay endpoint answers concurrent calls", a.status === 200 && b.status === 200);
await new Promise((r) => setTimeout(r, 4000));
const ob2 = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
const row2 = ob2.body.outbox.find((r) => r.id === row.id);
check("outbox attempts stays bounded after concurrent replays (not a concurrency guard)",
  row2.attempts <= 2, `attempts=${row2.attempts}`);
// Firing two concurrent replays against a fast-failing target reliably
// leaves this row 'pending' with a live (unexpired) lease and
// next_attempt_at=null: both replay calls clear next_attempt_at, but by the
// time their queue-triggered dispatches run, claimOutboxRow's lease guard
// (this fix round's item 1) correctly refuses both, since the original
// claim's lease has not yet expired. That is correct behaviour, not a bug —
// but left alone the row would sit "due" and unclaimable for up to
// LEASE_SECONDS, and pollute later sweep runs in this same long-lived dev
// database. Clean it up rather than let it accumulate across runs.
if (row) await runD1(`DELETE FROM webhook_outbox WHERE id = '${row.id}';`);

console.log("--- lease (real dispatch) ---");
// Drives the SHIPPED code end to end -- real member.created event, real
// queue-triggered dispatchOutboxRow/claimOutboxRow, real admin replay HTTP
// call -- rather than re-typing claimOutboxRow's SQL into the test (fix
// round 1 flagged that pattern: it proves the mechanism can work, not that
// this implementation is correct, since it stays green even if the shipped
// predicate regresses).
//
// A slow-but-live sink holds a row in status='delivering' with a real,
// in-force lease for ~3.5s. Firing the admin replay endpoint into that
// window is the exact scenario fix round 1 found reachable from the admin
// UI: replay resets status='pending' without touching lease_until, so if
// claimOutboxRow's pending branch does not also check lease_until, the
// replay-triggered redispatch wins the claim while the first delivery is
// still in flight and BOTH deliver to the slow endpoint. We assert on
// webhook_deliveries actually written -- that can only be 2 if a double
// dispatch really happened, so unlike `attempts <= 2` above this is
// falsifiable in both directions.
const slowPort = 8797;
const slow = createServer((req, res) => {
  setTimeout(() => { res.writeHead(200); res.end("ok"); }, 3500);
});
await new Promise((resolve) => slow.listen(slowPort, "127.0.0.1", resolve));

// Not asserted: seedHook always returns {status: 201} by construction (a
// tautology, not a check on any real route behaviour) -- the D1 insert it
// performs either succeeds or the harness throws inside runD1 itself.
const slowHook = await seedHook(tenantId, `http://127.0.0.1:${slowPort}/slow`, ["*"]);

const obBefore = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
const beforeIds = new Set((obBefore.body.outbox || []).map((r) => r.id));

await json(`/api/tenants/${tenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: `lease-real-${stamp}@example.test` }),
});

async function pollOutbox(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ob = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
    const found = (ob.body.outbox || []).find(
      (r) => !beforeIds.has(r.id) && r.event === "member.created" && pred(r)
    );
    if (found) return found;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// Best-effort: catch it mid-delivery so the replay lands squarely inside the
// live-lease window. If the queue is slower than our poll and we only ever
// see it 'pending', the assertion below still discriminates correctly (a
// stale-but-unexpired lease blocks the replay's claim either way under the
// fix; only the buggy pending-branch-ignores-lease-until predicate lets it
// through), so we fall back to any new row rather than failing outright.
const inFlight =
  (await pollOutbox((r) => r.status === "delivering", 3000)) ||
  (await pollOutbox(() => true, 2000));
check("outbox row exists for the real-dispatch lease test", !!inFlight);

if (inFlight) {
  const replay = await json(
    `/api/tenants/${tenantId}/webhooks/outbox/${inFlight.id}/replay`,
    { method: "POST", headers: auth }
  );
  check("replay fired into the live-lease window is answered",
    replay.status === 200, `got ${replay.status}`);

  // Long enough for the original delivery's 3.5s fetch, plus a second one at
  // full length if the bug let it through, plus overhead.
  await new Promise((r) => setTimeout(r, 8000));

  const finalRows = await d1Select(
    `SELECT status, attempts, lease_until, claimed_at FROM webhook_outbox
     WHERE id = '${inFlight.id}' AND tenant_id = '${tenantId}'`
  );
  const finalRow = finalRows[0];
  check("row is not stuck in 'delivering' after settling",
    !!finalRow && finalRow.status !== "delivering", `status=${finalRow?.status}`);

  const deliveryRows = await d1Select(
    `SELECT COUNT(*) as n FROM webhook_deliveries
     WHERE tenant_id = '${tenantId}' AND endpoint_id = '${slowHook.body.id}' AND event = 'member.created'`
  );
  const deliveryCount = Number(deliveryRows[0]?.n);
  check("slow endpoint received exactly one delivery despite the mid-flight replay",
    deliveryCount === 1, `deliveries=${deliveryCount}`);
}

await new Promise((resolve) => slow.close(resolve));

console.log("--- lease (stuck-row reclaim via real sweep) ---");
// Simulates a Worker that crashed mid-delivery: a row stuck in 'delivering'
// with an expired lease. The row's initial state is a test fixture (a plain
// INSERT, not a reimplementation of any claim logic); reclaiming it is done
// entirely by the real sweepOutbox -> dispatchOutboxRow -> claimOutboxRow
// path, triggered here via wrangler dev's built-in scheduled-event trigger
// (unauthenticated by design -- a dev-only wrangler feature, not an app
// route) rather than by re-typing the CAS SQL into the test.
const stuckId = `lease-stuck-${stamp}`;
const stuckClaimedAt = "2020-01-01T00:00:00.000Z";
const stuckLeaseUntil = new Date(Date.now() - 5000).toISOString();
await runD1(`
  INSERT INTO webhook_outbox
    (id, tenant_id, event, schema_version, payload_json, status, attempts,
     claimed_at, lease_until, created_at, updated_at)
  VALUES ('${stuckId}', '${tenantId}', 'member.created', 1, '{}', 'delivering', 0,
          '${stuckClaimedAt}', '${stuckLeaseUntil}', datetime('now'), datetime('now'));
`);

const beforeSweep = await d1Select(
  `SELECT status, claimed_at FROM webhook_outbox WHERE id = '${stuckId}' AND tenant_id = '${tenantId}'`
);
check("stuck row fixture set up as 'delivering' with an expired lease",
  beforeSweep[0]?.status === "delivering" && beforeSweep[0]?.claimed_at === stuckClaimedAt);

const sweepTrigger = await fetch(
  `${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`
);
// Informational, not asserted: wrangler dev's local scheduled-event trigger
// can report a non-200 here on an unrelated concurrent D1 write (this
// dev database is shared with many other test runs in the same session),
// even though ctx.waitUntil(sweepOutbox(...)) still completes. The D1
// state assertions below are the real pass/fail signal, since they observe
// what the real sweep actually did to the row, not whether the trigger
// endpoint's own HTTP response looked clean.
console.log(`  ..  scheduled sweep trigger responded ${sweepTrigger.status}`);

await new Promise((r) => setTimeout(r, 6000));

const afterSweep = await d1Select(
  `SELECT status, claimed_at FROM webhook_outbox WHERE id = '${stuckId}' AND tenant_id = '${tenantId}'`
);
check("the real sweep reclaimed the stuck row (claimed_at moved off the fixture value)",
  !!afterSweep[0] && afterSweep[0].claimed_at !== stuckClaimedAt,
  `claimed_at=${afterSweep[0]?.claimed_at}`);
check("the reclaimed row is no longer stuck in 'delivering'",
  !!afterSweep[0] && afterSweep[0].status !== "delivering",
  `status=${afterSweep[0]?.status}`);

await runD1(`DELETE FROM webhook_outbox WHERE id = '${stuckId}';`);

console.log("--- fan-out (per-endpoint retry) ---");
// Two endpoints subscribed to the same event: one healthy, one that never
// answers. A naive fan-out retries BOTH when the row is redriven, so the
// healthy endpoint sees an avoidable duplicate. This drives the SHIPPED
// dispatch path twice (real member.created event, real queue-triggered
// dispatchOutboxRow, then a real sweep-triggered redispatch) and asserts on
// webhook_deliveries counts, which can only move if a real send happened --
// unlike an attempts counter, this is falsifiable in both directions.
const healthyPort = 8796;
const healthy = createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
});
await new Promise((resolve) => healthy.listen(healthyPort, "127.0.0.1", resolve));

// Not asserted here either, same reason as slowHook above.
const healthyHook = await seedHook(tenantId, `http://127.0.0.1:${healthyPort}/ok`, ["*"]);
// Nothing listens on this port -> every send fails with ECONNREFUSED, fast.
const deadHook = await seedHook(tenantId, "http://127.0.0.1:8795/dead", ["*"]);

const obBeforeFanout = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
const beforeFanoutIds = new Set((obBeforeFanout.body.outbox || []).map((r) => r.id));

await json(`/api/tenants/${tenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: `fanout-${stamp}@example.test` }),
});

async function pollOutboxFanout(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ob = await json(`/api/tenants/${tenantId}/webhooks/outbox`, { headers: auth });
    const found = (ob.body.outbox || []).find(
      (r) => !beforeFanoutIds.has(r.id) && r.event === "member.created" && pred(r)
    );
    if (found) return found;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// Wait for the first round to fully settle: attempts >= 1 and no longer
// 'delivering' (the dead endpoint fails, so this lands back in 'pending').
const fanoutRow = await pollOutboxFanout(
  (r) => r.attempts >= 1 && r.status !== "delivering",
  8000
);
check("fan-out outbox row exists after round 1", !!fanoutRow);

if (fanoutRow) {
  const healthyDeliveries1 = await d1Select(
    `SELECT COUNT(*) as n FROM webhook_deliveries
     WHERE tenant_id = '${tenantId}' AND endpoint_id = '${healthyHook.body.id}' AND event = 'member.created'`
  );
  check("healthy endpoint received exactly one delivery after round 1",
    Number(healthyDeliveries1[0]?.n) === 1, `deliveries=${healthyDeliveries1[0]?.n}`);

  // Force round 2 immediately rather than waiting out the real backoff:
  // clear the lease and back-date next_attempt_at. This exercises the same
  // claim/dispatch code as production, just without the wait.
  await runD1(
    `UPDATE webhook_outbox SET status = 'pending', lease_until = NULL,
       next_attempt_at = datetime('now','-5 seconds')
     WHERE id = '${fanoutRow.id}';`
  );
  const sweepTrigger2 = await fetch(
    `${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`
  );
  console.log(`  ..  scheduled sweep trigger (round 2) responded ${sweepTrigger2.status}`);
  await new Promise((r) => setTimeout(r, 4000));

  const healthyDeliveries2 = await d1Select(
    `SELECT COUNT(*) as n FROM webhook_deliveries
     WHERE tenant_id = '${tenantId}' AND endpoint_id = '${healthyHook.body.id}' AND event = 'member.created'`
  );
  check("healthy endpoint still has exactly one delivery after round 2 (not re-sent)",
    Number(healthyDeliveries2[0]?.n) === 1, `deliveries=${healthyDeliveries2[0]?.n}`);

  const deadDeliveries2 = await d1Select(
    `SELECT COUNT(*) as n FROM webhook_deliveries
     WHERE tenant_id = '${tenantId}' AND endpoint_id = '${deadHook.body.id}' AND event = 'member.created'`
  );
  check("dead endpoint was retried and now has two deliveries",
    Number(deadDeliveries2[0]?.n) === 2, `deliveries=${deadDeliveries2[0]?.n}`);
}

await new Promise((resolve) => healthy.close(resolve));
// Remove this block's endpoints rather than leaving them registered-but-dead:
// the retry-pacing test below dispatches to every subscribed endpoint
// sequentially, and each additional dead one it has to fail through eats
// into its fixed 8s observation window.
if (healthyHook.body?.id) {
  await json(`/api/tenants/${tenantId}/webhooks/${healthyHook.body.id}`, { method: "DELETE", headers: auth });
}
if (deadHook.body?.id) {
  await json(`/api/tenants/${tenantId}/webhooks/${deadHook.body.id}`, { method: "DELETE", headers: auth });
}

console.log("--- retry pacing ---");
// Isolated tenant with exactly one freshly-created dead endpoint: the shared
// `tenantId` above has accumulated several dead endpoints from earlier
// blocks, and dispatchOutboxRow fetches each sequentially, so their combined
// (non-instant, workerd-local) connection-refusal latency alone can eat a
// short observation window and produce a false failure unrelated to retry
// pacing.
const paceTenant = await json("/api/tenants", { method: "POST", headers: auth,
  body: JSON.stringify({ name: `Pace ${stamp}`, slug: `pace-${stamp}` }) });
const paceTenantId = paceTenant.body.id;
await seedHook(paceTenantId, "http://127.0.0.1:8799/never-listens", ["*"]);
await json(`/api/tenants/${paceTenantId}/members`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ email: `pace-${stamp}@example.test` }),
});

async function pollPaceOutbox(pred, timeoutMs, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ob = await json(`/api/tenants/${paceTenantId}/webhooks/outbox`, { headers: auth });
    const row = ob.body.outbox?.[0];
    if (row && pred(row)) return row;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// Round 1 settles quickly (a single dead endpoint fails fast): the row goes
// back to 'pending' with attempts=1 and a next_attempt_at computed by
// backoffFor(1) (150-300s out). Capture it as the ground truth for how long
// the retry must actually wait.
const round1 = await pollPaceOutbox((r) => r.attempts >= 1 && r.status !== "delivering", 20000);
check("round 1 settles (dead endpoint fails fast, row back to pending)", !!round1, JSON.stringify(round1));

if (round1) {
  check("failing delivery is not dead after round 1", round1.status !== "dead", `status=${round1.status}`);
  check("attempts did not run away in round 1", round1.attempts <= 2, `attempts=${round1.attempts}`);
  check("next_attempt_at is in the future after round 1",
    !!round1.next_attempt_at && new Date(round1.next_attempt_at) > new Date(),
    `next_attempt_at=${round1.next_attempt_at}`);
}

// !! THIS IS A PROXY FOR BEHAVIOUR, NOT A BEHAVIOURAL CHECK. !!
// It reads the shipped source instead of observing what the system does,
// which is normally the wrong shape for a test. It is here because the
// behaviour it guards is, by construction, unobservable from outside:
//
// claimOutboxRow's lease guard (Task 3) already blocks an immediate
// same-lease re-claim for LEASE_SECONDS, so an undelayed msg.retry() no
// longer visibly "burns attempts in seconds" the way it did before Task 3 --
// it gets bounced by the lease and silently ack'd as a dropped pre-backoff
// redelivery (see the consumer's ack comment), leaving ZERO trace in the
// outbox row, in webhook_deliveries, or anywhere else this harness can read.
// There is no state to assert on.
//
// The remaining timing-based option -- "does a second attempt land via the
// queue before some deadline" -- is not usable either: backoffFor is jittered
// over [base/2, base), and the first real retry is 150-300s out, so a truthful
// wait would dominate the harness runtime and still only sample one draw.
// Waiting it out would make this flaky on GOOD code, not discriminating on
// BAD code.
//
// So: assert on the one deterministic thing, that the consumer hands
// msg.retry() a delaySeconds at all. It fails immediately and reliably if that
// call is ever reverted to a bare msg.retry() -- the literal regression this
// exists to catch -- and it is honest about being a stand-in for the
// behavioural test that cannot be written here.
//
// (Fix round 1: dispatchOutboxRow now draws the backoff ONCE and ships the
// exact seconds on the thrown error, so the queue delay and the row's
// next_attempt_at are the same number rather than two independent jittered
// draws. Under the old double-draw the queue undershot the row's own deadline
// about half the time and those retries were silently dropped.)
const consumerPath = fileURLToPath(new URL("../src/consumers/webhookConsumer.ts", import.meta.url));
const consumerSrc = readFileSync(consumerPath, "utf8");
// Strip comments first: the consumer's own comments discuss the bare
// `msg.retry()` this check forbids, and a naive scan of raw source reads those
// as real call sites. Then walk balanced parens rather than using `[^)]*`,
// which truncates `msg.retry({ delaySeconds: backoffFor(attempts) })` at the
// inner call's `)` and loses the closing brace. The delaySeconds match is
// deliberately name-only, not `delaySeconds\s*:`, so the shorthand form
// `msg.retry({ delaySeconds })` counts -- a bare `msg.retry()` still fails.
const codeOnly = consumerSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
function extractCalls(src, needle) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    let depth = 0, j = i + needle.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}
const retryCalls = extractCalls(codeOnly, "msg.retry(");
check("consumer source has a msg.retry(...) call", retryCalls.length > 0, "no msg.retry call found");
check("every msg.retry() call passes delaySeconds (no immediate bare retry)",
  retryCalls.length > 0 && retryCalls.every((c) => /\bdelaySeconds\b/.test(c)),
  `retry calls: ${JSON.stringify(retryCalls)}`);

console.log("--- hook validation parity ---");
// The admin route used to accept http://, skip validateHookUrl entirely, and
// let PATCH write events_json with no validation at all. These assert the
// admin route now rejects exactly what the v1 route already rejects.
for (const [payload, label] of [
  [{ url: "http://insecure.example.com/h" }, "http"],
  [{ url: "https://127.0.0.1/h" }, "loopback"],
  [{ url: "https://quilthosting.com/h" }, "self-loop"],
  [{ url: "https://hooks.zapier.com/h", events: ["member.creatd"] }, "typo'd event"],
]) {
  const r = await json(`/api/tenants/${tenantId}/webhooks`, {
    method: "POST", headers: auth, body: JSON.stringify(payload),
  });
  check(`admin POST rejects ${label}`, r.status === 400, `got ${r.status}`);
}
const good = await json(`/api/tenants/${tenantId}/webhooks`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ url: "https://hooks.zapier.com/ok", events: ["member.created"] }),
});
// Positive control: without this, a validator that rejected everything would
// surface only as a confusing 404 on the PATCH check below (good.body.id
// would be undefined), not as a clearly-attributed failure here.
check("admin POST accepts a valid hook (positive control)",
  good.status === 201 && !!good.body.id, `got ${good.status} ${JSON.stringify(good.body)}`);
const patched = await json(`/api/tenants/${tenantId}/webhooks/${good.body.id}`, {
  method: "PATCH", headers: auth, body: JSON.stringify({ events: ["member.creatd"] }),
});
check("admin PATCH rejects a typo'd event", patched.status === 400, `got ${patched.status}`);

console.log("--- hook validation parity (deny-list edge cases, fix round 1) ---");
// validateHookUrl matches on u.hostname, which WHATWG normalises before the
// deny list ever sees it -- but normalisation is not the same as sanitising.
// These five hostnames survive normalisation looking like they route
// straight to a blocked target, yet the pre-round-1 deny list let them
// through: a trailing dot is a DNS no-op but defeats the `$`-anchored
// localhost/self-loop patterns, and IPv4-mapped / unspecified / link-local
// IPv6 forms simply weren't in the pattern list at all.
for (const [payload, label] of [
  [{ url: "https://localhost./h" }, "trailing-dot localhost"],
  [{ url: "https://quilthosting.com./h" }, "trailing-dot self-loop"],
  [{ url: "https://[::ffff:127.0.0.1]/h" }, "IPv4-mapped loopback"],
  [{ url: "https://[::]/h" }, "unspecified address"],
  [{ url: "https://[fe80::1]/h" }, "link-local"],
]) {
  const r = await json(`/api/tenants/${tenantId}/webhooks`, {
    method: "POST", headers: auth, body: JSON.stringify(payload),
  });
  check(`admin POST rejects ${label}`, r.status === 400, `got ${r.status}`);
}

console.log("--- hook validation parity (malformed PATCH body) ---");
// PATCH used to parse the body with a TypeScript generic and no runtime
// check, so a malformed field (null where a string is expected, a bare
// string where an array is expected) reached `.trim()` / `.filter()`
// directly and threw -> 500, not a clean 400.
const malformedUrl = await json(`/api/tenants/${tenantId}/webhooks/${good.body.id}`, {
  method: "PATCH", headers: auth, body: JSON.stringify({ url: null }),
});
check("admin PATCH rejects a null url (400, not 500)",
  malformedUrl.status === 400, `got ${malformedUrl.status}`);
const malformedEvents = await json(`/api/tenants/${tenantId}/webhooks/${good.body.id}`, {
  method: "PATCH", headers: auth, body: JSON.stringify({ events: "member.created" }),
});
check("admin PATCH rejects a non-array events (400, not 500)",
  malformedEvents.status === 400, `got ${malformedEvents.status}`);

rmSync(d1WorkDir, { recursive: true, force: true });

console.log(failures ? `\n${failures} failure(s)` : "\nall delivery checks passed");
if (failures) process.exit(1);
