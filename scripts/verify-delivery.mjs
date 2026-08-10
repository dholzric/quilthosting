/**
 * Delivery reliability harness.
 * Usage: node scripts/verify-delivery.mjs   (wrangler dev on :8787)
 */
import { randomUUID } from "node:crypto";
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
check("forced outbox failure rejects the request", bad.status >= 400, `got ${bad.status}`);
check("forced outbox failure leaves NO member behind",
  (after.body.total ?? 0) === (before.body.total ?? 0),
  `${before.body.total} -> ${after.body.total}`);

console.log(failures ? `\n${failures} failure(s)` : "\nall delivery checks passed");
if (failures) process.exit(1);
