/**
 * Idempotency-Key correctness — operation scoping + reservation concurrency.
 * Usage: node scripts/verify-idempotency.mjs
 * Requires:
 *   - wrangler dev on :8787
 *   - GOOGLE_AUTH_REQUIRED=false in .dev.vars
 *   - npm run db:migrate:local applied (migration 0015)
 *
 * Modeled on scripts/verify-integrations.mjs: reuse the stable
 * harness@example.test account rather than registering per run, or the
 * /register rate limit (10 per 10 min) makes the harness unrunnable.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.QH_BASE || "http://127.0.0.1:8787";

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

/**
 * Fire `calls` concurrent reserve() calls, all with the same
 * (tenant, operation, key, requestHash), from INSIDE a single Worker
 * invocation via the dev-only route. Two separate HTTP requests to a fast
 * local wrangler dev are not guaranteed to actually overlap -- the first can
 * complete its whole D1 round trip before the second is even dispatched, in
 * which case the contended path (the unique-constraint catch, or the
 * takeover UPDATE's compare-and-swap) never runs and a passing assertion
 * proves nothing. Promise.all inside one request guarantees the calls are
 * in flight together every run.
 */
async function devReserve(writeAuth, operation, key, requestHash, calls = 1) {
  return json("/api/v1/_dev/idempotency/reserve", {
    method: "POST",
    headers: writeAuth,
    body: JSON.stringify({ operation, key, requestHash, calls }),
  });
}

async function devComplete(writeAuth, recordId, reservedUntil, status, respJson) {
  return json("/api/v1/_dev/idempotency/complete", {
    method: "POST",
    headers: writeAuth,
    body: JSON.stringify({ recordId, reservedUntil, status, json: respJson }),
  });
}

/** Seed a lapsed ('reserved', reserved_until in the past) row directly in D1. */
function seedLapsedReservation({ id, tenantId, operation, key, requestHash }) {
  const past = new Date(Date.now() - 120_000).toISOString(); // well past RESERVATION_SECONDS=60
  const farFuture = new Date(Date.now() + 3600_000).toISOString();
  const now = new Date().toISOString();
  const sql = `INSERT INTO api_idempotency
    (id, tenant_id, operation, idempotency_key, request_hash, status, reserved_until, expires_at, created_at, updated_at)
    VALUES ('${id}', '${tenantId}', '${operation}', '${key}', '${requestHash}', 'reserved', '${past}', '${farFuture}', '${now}', '${now}');`;
  const sqlPath = join(tmpdir(), `qh-idem-seed-${id}.sql`);
  writeFileSync(sqlPath, sql, "utf8");
  try {
    // execFileSync + arg array (no shell string interpolation) even though
    // every value here is our own randomUUID()/ISO-timestamp output, not
    // externally-controlled input.
    // On Windows, npx resolves to npx.cmd, which node can only invoke via a
    // shell (spawnSync fails with EINVAL otherwise). `shell: true` still
    // passes args as an array -- node quotes each element itself, so this
    // is not the same as building a shell string by hand.
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "quilthosting-db", "--local", `--file=${sqlPath}`],
      { stdio: "pipe", shell: true }
    );
  } finally {
    unlinkSync(sqlPath);
  }
}

async function main() {
  const stamp = randomUUID().slice(0, 8);

  const HARNESS_EMAIL = "harness@example.test";
  const HARNESS_PASSWORD = "harness-password-1";

  let jwt;
  const login = await json("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: HARNESS_EMAIL, password: HARNESS_PASSWORD }),
  });
  if (login.status === 200 && login.body.token) {
    jwt = login.body.token;
  } else {
    const reg = await json("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: HARNESS_EMAIL,
        password: HARNESS_PASSWORD,
        name: "Harness Admin",
      }),
    });
    if (reg.status >= 400) {
      throw new Error(
        `could not log in or register the harness account (login ${login.status}, ` +
          `register ${reg.status}). If register says 403, set ` +
          `GOOGLE_AUTH_REQUIRED=false in .dev.vars. If 429, the rate limit ` +
          `window is 10 minutes. ${JSON.stringify(reg.body)}`
      );
    }
    jwt = reg.body.token;
  }
  const auth = { Authorization: `Bearer ${jwt}` };

  const tenant = await json("/api/tenants", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Idem Guild ${stamp}`, slug: `idem-${stamp}` }),
  });
  if (tenant.status >= 400) throw new Error(`tenant: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.id;

  const writeKey = await json(`/api/tenants/${tenantId}/api-keys`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "idem-write",
      scopes: ["read", "members:write"],
    }),
  });
  if (writeKey.status >= 400) throw new Error(`api-key: ${JSON.stringify(writeKey.body)}`);
  const writeAuth = { Authorization: `Bearer ${writeKey.body.api_key}` };

  console.log("--- 1. operation scoping (headline fix) ---");
  const key = `scope-${stamp}`;
  const create = await json("/api/v1/members", {
    method: "POST",
    headers: { ...writeAuth, "Idempotency-Key": key },
    body: JSON.stringify({ email: `a-${stamp}@example.test` }),
  });
  check("create with key succeeds", create.status === 201, `got ${create.status} ${JSON.stringify(create.body)}`);
  const patch = await json(`/api/v1/members/${create.body.member?.id}`, {
    method: "PATCH",
    headers: { ...writeAuth, "Idempotency-Key": key },
    body: JSON.stringify({ first_name: "Scoped" }),
  });
  // Against the CURRENT code this returns 422 (hash differs) or replays the
  // create's 201 — both wrong. It must run as its own operation.
  check(
    "same key on a different operation is independent",
    patch.status === 200,
    `got ${patch.status} ${JSON.stringify(patch.body)}`
  );

  console.log("--- 2. concurrency: two simultaneous identical firsts -> ONE member ---");
  const cKey = `conc-${stamp}`;
  const cBody = JSON.stringify({ email: `conc-${stamp}@example.test` });
  const [r1, r2] = await Promise.all([
    json("/api/v1/members", {
      method: "POST",
      headers: { ...writeAuth, "Idempotency-Key": cKey },
      body: cBody,
    }),
    json("/api/v1/members", {
      method: "POST",
      headers: { ...writeAuth, "Idempotency-Key": cKey },
      body: cBody,
    }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  // Exactly one may execute. The loser is either replayed (201) or told the
  // operation is in flight (409 idempotency_in_progress) — never a second
  // create, never a 409 duplicate_email surfaced from the database. Plain
  // status-code equality is not enough here: duplicate_email is ALSO a 409,
  // so a loser that ran the handler and hit the database's own uniqueness
  // guard would slip past a check that only compares status codes -- which
  // is exactly the failure mode this assertion exists to catch. Require the
  // 409's code to be idempotency_in_progress specifically.
  const codesOfConflicts = [r1, r2]
    .filter((r) => r.status === 409)
    .map((r) => r.body?.code);
  check(
    "concurrent identical requests never both execute",
    statuses.every((s) => s === 201 || s === 409) &&
      codesOfConflicts.every((code) => code === "idempotency_in_progress"),
    `got ${JSON.stringify(statuses)} bodies=${JSON.stringify([r1.body, r2.body])}`
  );
  const listed = await json(`/api/v1/members?limit=100`, { headers: writeAuth });
  const dupes = (listed.body.members || []).filter((m) => m.email === `conc-${stamp}@example.test`);
  check("concurrent requests created exactly one member", dupes.length === 1, `found ${dupes.length}`);

  console.log("--- 3. unchanged behaviour: same key + same body replays; different body 422s ---");
  const uKey = `unchanged-${stamp}`;
  const uBody = JSON.stringify({ email: `u-${stamp}@example.test`, first_name: "Una" });
  const u1 = await json("/api/v1/members", {
    method: "POST",
    headers: { ...writeAuth, "Idempotency-Key": uKey },
    body: uBody,
  });
  check("first create succeeds", u1.status === 201, `got ${u1.status} ${JSON.stringify(u1.body)}`);
  const u2 = await json("/api/v1/members", {
    method: "POST",
    headers: { ...writeAuth, "Idempotency-Key": uKey },
    body: uBody,
  });
  check("same key + same body replays", u2.status === 201 && u2.body.member?.id === u1.body.member?.id, `got ${u2.status} ${JSON.stringify(u2.body)}`);
  const u3 = await json("/api/v1/members", {
    method: "POST",
    headers: { ...writeAuth, "Idempotency-Key": uKey },
    body: JSON.stringify({ email: `different-${stamp}@example.test` }),
  });
  check("same key + different body is 422", u3.status === 422, `got ${u3.status}`);

  console.log("--- 4. no key at all: unchanged, records nothing ---");
  const n1 = await json("/api/v1/members", {
    method: "POST",
    headers: writeAuth,
    body: JSON.stringify({ email: `nokey-${stamp}@example.test` }),
  });
  check("create without a key succeeds", n1.status === 201, `got ${n1.status} ${JSON.stringify(n1.body)}`);

  console.log("--- 5. deterministic proof of reservation exclusivity (drives reserve() directly, not over HTTP) ---");

  // 5.1: two concurrent reserve() calls, same (tenant, operation, key) ->
  // exactly one execute, one in_progress.
  const op1 = "dev-race-op-1";
  const key1 = `race-${stamp}-1`;
  const hash1 = "hash-a";
  const race1 = await devReserve(writeAuth, op1, key1, hash1, 2);
  check(
    "dev idempotency route reachable",
    race1.status === 200,
    `got ${race1.status} ${JSON.stringify(race1.body)}`
  );
  const kinds1 = (race1.body.outcomes || []).map((o) => o.kind).sort();
  check(
    "assertion 1: two concurrent reserve() calls yield exactly one execute + one in_progress",
    JSON.stringify(kinds1) === JSON.stringify(["execute", "in_progress"]),
    `got ${JSON.stringify(kinds1)} full=${JSON.stringify(race1.body)}`
  );
  const executeOutcome1 = (race1.body.outcomes || []).find((o) => o.kind === "execute");

  // 5.2: after complete(), a third reserve() replays the stored status+body.
  const respBody = { hello: "world", stamp };
  const comp = await devComplete(
    writeAuth,
    executeOutcome1?.recordId,
    executeOutcome1?.reservedUntil,
    201,
    respBody
  );
  check(
    "complete() succeeds on the winning reservation",
    comp.status === 200 && comp.body.won === true,
    `got ${comp.status} ${JSON.stringify(comp.body)}`
  );
  const race1b = await devReserve(writeAuth, op1, key1, hash1, 1);
  const replay = race1b.body.outcomes?.[0];
  check(
    "assertion 2: reserve() after complete() replays the stored status + body",
    replay?.kind === "replay" &&
      replay.status === 201 &&
      JSON.stringify(replay.json) === JSON.stringify(respBody),
    `got ${JSON.stringify(replay)}`
  );

  // 5.3: same key, different requestHash -> conflict.
  const race1c = await devReserve(writeAuth, op1, key1, "hash-b-different", 1);
  const conflict = race1c.body.outcomes?.[0];
  check(
    "assertion 3: reserve() with a different requestHash returns conflict",
    conflict?.kind === "conflict",
    `got ${JSON.stringify(conflict)}`
  );

  // 5.4: a lapsed reservation (reserved_until in the past) is taken over,
  // keeping the EXISTING record id rather than minting a fresh one.
  const takeoverOp4 = "dev-race-op-2";
  const takeoverKey4 = `race-${stamp}-2`;
  const takeoverHash4 = "hash-takeover-4";
  const seededId4 = randomUUID();
  seedLapsedReservation({
    id: seededId4,
    tenantId,
    operation: takeoverOp4,
    key: takeoverKey4,
    requestHash: takeoverHash4,
  });
  const race4 = await devReserve(writeAuth, takeoverOp4, takeoverKey4, takeoverHash4, 1);
  const takeoverOutcome = race4.body.outcomes?.[0];
  check(
    "assertion 4: reserve() takes over a lapsed reservation, keeping the existing record id",
    takeoverOutcome?.kind === "execute" && takeoverOutcome.recordId === seededId4,
    `got ${JSON.stringify(takeoverOutcome)} expected recordId=${seededId4}`
  );

  // 5.5: the takeover itself is exclusive -- two concurrent takeover
  // attempts on the SAME lapsed reservation yield exactly one execute.
  const takeoverOp5 = "dev-race-op-3";
  const takeoverKey5 = `race-${stamp}-3`;
  const takeoverHash5 = "hash-takeover-5";
  const seededId5 = randomUUID();
  seedLapsedReservation({
    id: seededId5,
    tenantId,
    operation: takeoverOp5,
    key: takeoverKey5,
    requestHash: takeoverHash5,
  });
  const race5 = await devReserve(writeAuth, takeoverOp5, takeoverKey5, takeoverHash5, 2);
  const kinds5 = (race5.body.outcomes || []).map((o) => o.kind).sort();
  check(
    "assertion 5: two concurrent takeover attempts on the same lapsed reservation yield exactly one execute",
    JSON.stringify(kinds5) === JSON.stringify(["execute", "in_progress"]),
    `got ${JSON.stringify(kinds5)} full=${JSON.stringify(race5.body)}`
  );
  const winningOutcome5 = (race5.body.outcomes || []).find((o) => o.kind === "execute");
  check(
    "assertion 5b: the winning takeover carries the existing seeded record id, not a fresh one",
    winningOutcome5?.recordId === seededId5,
    `got ${JSON.stringify(winningOutcome5)} expected recordId=${seededId5}`
  );

  if (failures) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll idempotency assertions passed.");
}

main().catch((e) => {
  console.error(`\n${e.stack || e.message}`);
  process.exit(1);
});
