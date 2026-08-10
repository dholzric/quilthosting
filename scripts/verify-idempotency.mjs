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
