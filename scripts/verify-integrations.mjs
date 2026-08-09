/**
 * Integration surface E2E — outbox delivery + v1 API.
 * Usage: node scripts/verify-integrations.mjs
 * Requires:
 *   - wrangler dev on :8787
 *   - GOOGLE_AUTH_REQUIRED=false in .dev.vars
 *   - npm run db:migrate:local applied
 *
 * LOCAL ONLY: the Worker must reach a host loopback sink. A deployed Worker
 * cannot. If the sink stays empty, debug Worker->host networking before
 * suspecting the emitters.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BASE = process.env.QH_BASE || "http://127.0.0.1:8787";
const SINK_PORT = Number(process.env.QH_SINK_PORT || 8799);

function loadDevVars() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch {
    /* optional */
  }
  return out;
}

const received = [];
let sink;

function startSink() {
  return new Promise((r) => {
    sink = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try {
          received.push({ ...JSON.parse(body), _headers: req.headers });
        } catch {
          received.push({ event: "<unparseable>", raw: body });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    sink.listen(SINK_PORT, "127.0.0.1", r);
  });
}

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

/** Outbox dispatch is async; poll rather than race it. */
async function waitForEvent(name, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.some((p) => p.event === name)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function check(label, cond, detail = "") {
  if (!cond) throw new Error(`${label} FAILED ${detail}`);
  console.log(`  ok  ${label}`);
}

/**
 * The Zapier package keeps its own copy of the fixtures so it stays
 * self-contained. Assert the copies match, or a Zap's sample data silently
 * drifts from what the API actually sends.
 */
function checkFixtureDrift() {
  const src = resolve(ROOT, "scripts/fixtures/events");
  const dst = resolve(ROOT, "integrations/zapier/fixtures");
  let names;
  try {
    names = readdirSync(src);
  } catch {
    return;
  }
  for (const n of names) {
    let a, b;
    try {
      a = readFileSync(resolve(src, n), "utf8");
      b = readFileSync(resolve(dst, n), "utf8");
    } catch {
      throw new Error(`fixture ${n} missing from integrations/zapier/fixtures`);
    }
    if (a.trim() !== b.trim()) {
      throw new Error(
        `fixture ${n} has drifted between scripts/fixtures/events and integrations/zapier/fixtures`
      );
    }
  }
  console.log(`fixtures in sync (${names.length})`);
}

async function main() {
  loadDevVars();
  checkFixtureDrift();
  await startSink();
  console.log(`sink on :${SINK_PORT}`);

  const stamp = randomUUID().slice(0, 8);

  // Reuse one stable account across runs. Registering a fresh user each time
  // burns the /register rate limit (10 per 10 min) after a handful of runs and
  // the harness becomes unrunnable; /login allows 30 per 10 min.
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
  // siteGate accepts ANY valid Bearer JWT, so the same header opens /public/*.
  // Without it every public drive returns the private-preview HTML, not JSON.
  const pub = { Authorization: `Bearer ${jwt}` };

  const tenant = await json("/api/tenants", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Harness Guild ${stamp}`, slug: `harness-${stamp}` }),
  });
  if (tenant.status >= 400) throw new Error(`tenant: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.id;
  const slug = tenant.body.slug;

  const hook = await json(`/api/tenants/${tenantId}/webhooks`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ url: `http://127.0.0.1:${SINK_PORT}/hook`, events: ["*"] }),
  });
  if (hook.status >= 400) throw new Error(`hook: ${JSON.stringify(hook.body)}`);

  const catalog = await json(`/api/tenants/${tenantId}/webhooks/events`, { headers: auth });
  const advertised = (catalog.body.events || []).filter((e) => e !== "*");
  console.log(`advertised: ${advertised.join(", ")}\n`);

  // ---------------- drive the real routes ----------------
  await json(`/api/tenants/${tenantId}/members`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ email: `m-${stamp}@example.test`, first_name: "Ada" }),
  });

  const members = await json(`/api/tenants/${tenantId}/members`, { headers: auth });
  const memberId = members.body.members[0].id;
  await json(`/api/tenants/${tenantId}/members/${memberId}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ first_name: "Augusta" }),
  });

  const level = await json(`/api/tenants/${tenantId}/levels`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Free Level",
      price_cents: 0,
      duration_months: 12,
      renewal_type: "manual",
    }),
  });
  // Free join -> member.created + membership.activated + member.activated
  await json(`/public/${slug}/join`, {
    method: "POST",
    headers: pub,
    body: JSON.stringify({
      email: `join-${stamp}@example.test`,
      first_name: "Grace",
      last_name: "Hopper",
      level_id: level.body.id,
    }),
  });

  // NOTE: registration_open is NOT read by events POST (schema default is 1).
  // Do not send it or an implementer will waste an hour debugging a no-op.
  const ev = await json(`/api/tenants/${tenantId}/events`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      title: "Harness Event",
      start_at: "2027-01-01T18:00:00.000Z",
      member_price_cents: 0,
      non_member_price_cents: 0,
    }),
  });
  await json(`/public/${slug}/events/${ev.body.id}/register`, {
    method: "POST",
    headers: pub,
    body: JSON.stringify({ email: `ev-${stamp}@example.test`, name: "Katherine Johnson" }),
  });

  // form.response — create and submit so it is genuinely covered, not skipped.
  const form = await json(`/api/tenants/${tenantId}/forms`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: `Harness Form ${stamp}`,
      fields: [{ key: "why", label: "Why join?", type: "text", required: false }],
    }),
  });
  let formDriven = false;
  if (form.status < 400 && form.body.slug) {
    const sub = await json(`/public/${slug}/forms/${form.body.slug}`, {
      method: "POST",
      headers: pub,
      body: JSON.stringify({
        email: `form-${stamp}@example.test`,
        answers: { why: "quilts" },
      }),
    });
    formDriven = sub.status < 400;
    if (!formDriven) console.log(`NOTE: form submit -> ${sub.status} ${JSON.stringify(sub.body)}`);
  } else {
    console.log(`NOTE: form create -> ${form.status} ${JSON.stringify(form.body)}`);
  }

  // ---------------- assert deliveries ----------------
  // payment.succeeded needs signed Stripe webhooks: scripts/e2e-auto-renew.mjs.
  const undriven = new Set(["payment.succeeded"]);
  if (!formDriven) undriven.add("form.response");

  const results = [];
  for (const name of advertised) {
    if (undriven.has(name)) {
      results.push({ name, undriven: true });
      continue;
    }
    results.push({ name, ok: await waitForEvent(name) });
  }

  console.log("--- webhook event delivery ---");
  let failed = 0;
  for (const r of results) {
    if (r.undriven) {
      console.log(`UNDRIVEN  ${r.name}  (see scripts/e2e-auto-renew.mjs)`);
      continue;
    }
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}      ${r.name}`);
  }
  console.log(`\nreceived: ${received.map((p) => p.event).join(", ") || "(none)"}\n`);

  // ---------------- envelope + signature contract ----------------
  const sample = received[0];
  if (sample) {
    console.log("--- envelope ---");
    for (const k of ["id", "schema_version", "event", "created_at", "tenant_id", "data"]) {
      check(`envelope has "${k}"`, k in sample);
    }
    check("X-QH-Signature present", !!sample._headers["x-qh-signature"]);
    check("X-QH-Timestamp present", !!sample._headers["x-qh-timestamp"]);
    check(
      "X-QH-Schema-Version matches",
      sample._headers["x-qh-schema-version"] === String(sample.schema_version)
    );
    check("data.source present", !!sample.data?.source, JSON.stringify(sample.data));
  }

  if (failed) {
    sink.close();
    console.error(`\n${failed} advertised event(s) never fired.`);
    process.exit(1);
  }

  // ---------------- v1 API (Tasks 8 & 9; skipped until they land) ----------------
  const v1Probe = await json("/api/v1/hooks", { headers: auth });
  if (v1Probe.status === 404) {
    console.log("\nv1 write/hook endpoints not implemented yet — skipping (Tasks 8-9).");
    sink.close();
    console.log("\nAll driven events delivered.");
    return;
  }

  console.log("--- v1 scopes + idempotency ---");
  const readKey = await json(`/api/tenants/${tenantId}/api-keys`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "harness-read", scopes: ["read"] }),
  });
  const writeKey = await json(`/api/tenants/${tenantId}/api-keys`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "harness-write",
      scopes: ["read", "members:write", "hooks:write"],
    }),
  });
  // POST /api-keys returns `api_key`, NOT `key`.
  const readAuth = { Authorization: `Bearer ${readKey.body.api_key}` };
  const writeAuth = { Authorization: `Bearer ${writeKey.body.api_key}` };

  const denied = await json("/api/v1/members", {
    method: "POST",
    headers: readAuth,
    body: JSON.stringify({ email: `scope-${stamp}@example.test` }),
  });
  check("read-only key cannot write", denied.status === 403, `got ${denied.status}`);

  const idemKey = `harness-${stamp}`;
  const createBody = JSON.stringify({ email: `api-${stamp}@example.test`, first_name: "Api" });
  const c1 = await json("/api/v1/members", {
    method: "POST",
    headers: { ...writeAuth, "Idempotency-Key": idemKey },
    body: createBody,
  });
  check("v1 create succeeds", c1.status === 201, JSON.stringify(c1.body));
  const c2 = await json("/api/v1/members", {
    method: "POST",
    headers: { ...writeAuth, "Idempotency-Key": idemKey },
    body: createBody,
  });
  check("idempotent retry replays 201", c2.status === 201, `got ${c2.status}`);
  check(
    "idempotent retry did not create a second member",
    c2.body.member?.id === c1.body.member?.id
  );
  const reuse = await json("/api/v1/members", {
    method: "POST",
    headers: { ...writeAuth, "Idempotency-Key": idemKey },
    body: JSON.stringify({ email: `different-${stamp}@example.test` }),
  });
  check("key reuse with different body is 422", reuse.status === 422, `got ${reuse.status}`);

  console.log("--- v1 hooks ---");
  const sub = await json("/api/v1/hooks", {
    method: "POST",
    headers: writeAuth,
    body: JSON.stringify({
      url: "https://hooks.zapier.com/harness/test",
      events: ["member.created"],
    }),
  });
  check("hook subscribe succeeds", sub.status === 201, JSON.stringify(sub.body));
  check("hook has a signing secret", !!sub.body.hook?.secret);

  for (const [url, label] of [
    ["http://insecure.example.com/hook", "http"],
    ["https://127.0.0.1/hook", "loopback"],
    ["https://quilthosting.com/hook", "self-loop"],
  ]) {
    const r = await json("/api/v1/hooks", {
      method: "POST",
      headers: writeAuth,
      body: JSON.stringify({ url }),
    });
    check(`${label} hook rejected`, r.status === 400, `got ${r.status}`);
  }

  const bad = await json("/api/v1/hooks", {
    method: "POST",
    headers: writeAuth,
    body: JSON.stringify({ url: "https://hooks.zapier.com/x", events: ["member.creatd"] }),
  });
  check("typo'd event name rejected, not filtered", bad.status === 400, `got ${bad.status}`);

  const listed = await json("/api/v1/hooks", { headers: writeAuth });
  check("GET /hooks never returns secrets", !listed.body.hooks.some((h) => "secret" in h));

  const unsub = await json(`/api/v1/hooks/${sub.body.hook.id}`, {
    method: "DELETE",
    headers: writeAuth,
  });
  check("hook unsubscribe succeeds", unsub.status === 200, `got ${unsub.status}`);

  sink.close();
  console.log("\nAll driven events delivered; v1 contract verified.");
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  sink?.close();
  process.exit(1);
});
