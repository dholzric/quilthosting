/**
 * Auto-renew E2E (local Worker + D1 + signed Stripe webhooks).
 * Usage: node scripts/e2e-auto-renew.mjs
 * Requires: wrangler dev running on :8787 with .dev.vars (test Stripe keys).
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BASE = process.env.QH_BASE || "http://127.0.0.1:8787";

function loadDevVars() {
  const text = readFileSync(resolve(ROOT, ".dev.vars"), "utf8");
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function stripeSign(payload, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function postWebhook(event, secret) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": stripeSign(payload, secret),
    },
    body: payload,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Webhook ${event.type} → ${res.status} ${text}`);
  }
  return json;
}

async function d1(sql) {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const file = join(tmpdir(), `qh-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`);
  writeFileSync(file, oneLine + "\n", "utf8");
  let out;
  try {
    out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "quilthosting-db", "--local", "--json", `--file=${file}`],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: true }
    );
  } catch (e) {
    try {
      unlinkSync(file);
    } catch {}
    throw new Error(`d1 failed: ${e.stderr || e.stdout || e.message}`);
  }
  try {
    unlinkSync(file);
  } catch {}
  const start = out.indexOf("[");
  if (start < 0) throw new Error("No JSON from wrangler: " + out.slice(0, 300));
  const parsed = JSON.parse(out.slice(start));
  // --file returns results per statement; flatten
  if (Array.isArray(parsed) && parsed[0]?.results !== undefined) {
    return parsed.flatMap((p) => p.results || []);
  }
  return parsed[0]?.results ?? parsed.results ?? [];
}

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ✓", msg);
}

async function main() {
  const env = loadDevVars();
  assert(env.STRIPE_SECRET_KEY?.startsWith("sk_test"), "STRIPE_SECRET_KEY is test mode");
  assert(env.STRIPE_WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET set");
  assert(env.SITE_ACCESS_PASSWORD, "SITE_ACCESS_PASSWORD set (stealth)");

  // Health: webhooks exempt from gate
  const health = await fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", body: "{}" });
  assert(health.status === 400 || health.status === 200, `Worker reachable (status ${health.status})`);

  const tenantId = randomUUID();
  const memberId = randomUUID();
  const levelId = randomUUID();
  const subId = "sub_e2e_" + randomUUID().slice(0, 8);
  const sessionId = "cs_e2e_" + randomUUID().slice(0, 8);
  const pi1 = "pi_e2e_" + randomUUID().slice(0, 8);
  const inv1 = "in_e2e_" + randomUUID().slice(0, 8);
  const inv2 = "in_e2e_" + randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const email = `e2e-${Date.now()}@example.com`;

  console.log("\n1) Seed local D1 (tenant, auto level, pending member)");
  await d1(
    `INSERT INTO tenants (id, name, slug, plan, status, settings_json, created_at, updated_at)
     VALUES ('${tenantId}', 'E2E Guild', 'e2e-${Date.now()}', 'free', 'active', '{}', '${now}', '${now}')`
  );
  await d1(
    `INSERT INTO membership_levels
     (id, tenant_id, name, price_cents, duration_months, renewal_type, is_public, status, created_at, updated_at)
     VALUES ('${levelId}', '${tenantId}', 'Auto Monthly', 2500, 1, 'auto', 1, 'active', '${now}', '${now}')`
  );
  await d1(
    `INSERT INTO members
     (id, tenant_id, email, first_name, last_name, status, joined_at, created_at, updated_at)
     VALUES ('${memberId}', '${tenantId}', '${email}', 'E2E', 'Tester', 'pending', '${now}', '${now}', '${now}')`
  );
  console.log("  seed ok", { tenantId, memberId, levelId, subId });

  console.log("\n2) checkout.session.completed (first dues payment)");
  await postWebhook(
    {
      id: "evt_e2e_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          amount_total: 2500,
          payment_intent: pi1,
          subscription: subId,
          customer_email: email,
          metadata: {
            tenant_id: tenantId,
            member_id: memberId,
            related_id: levelId,
            type: "dues",
            email,
          },
        },
      },
    },
    env.STRIPE_WEBHOOK_SECRET
  );

  const memberships = await d1(
    `SELECT id, status, auto_renew, stripe_subscription_id, end_date, amount_paid_cents
     FROM memberships WHERE member_id = '${memberId}' AND tenant_id = '${tenantId}'`
  );
  assert(memberships.length === 1, "exactly one membership after checkout");
  assert(memberships[0].status === "active", "membership active");
  assert(Number(memberships[0].auto_renew) === 1, "auto_renew = 1");
  assert(memberships[0].stripe_subscription_id === subId, "stripe_subscription_id stored");
  const end1 = memberships[0].end_date;

  const members = await d1(
    `SELECT status FROM members WHERE id = '${memberId}'`
  );
  assert(members[0]?.status === "active", "member status active");

  const payments1 = await d1(
    `SELECT id, status, type FROM payments WHERE tenant_id = '${tenantId}' AND member_id = '${memberId}'`
  );
  assert(payments1.length === 1, "one payment after checkout");
  assert(payments1[0].status === "succeeded", "payment succeeded");

  console.log("\n3) invoice.paid subscription_create (should NOT double-extend)");
  await postWebhook(
    {
      id: "evt_e2e_inv_create",
      type: "invoice.paid",
      data: {
        object: {
          id: inv1,
          subscription: subId,
          amount_paid: 2500,
          billing_reason: "subscription_create",
          payment_intent: pi1,
        },
      },
    },
    env.STRIPE_WEBHOOK_SECRET
  );
  const afterCreate = await d1(
    `SELECT end_date FROM memberships WHERE member_id = '${memberId}'`
  );
  assert(afterCreate[0].end_date === end1, "end_date unchanged after subscription_create invoice");

  console.log("\n4) invoice.paid subscription_cycle (renewal → extend)");
  await postWebhook(
    {
      id: "evt_e2e_inv_cycle",
      type: "invoice.paid",
      data: {
        object: {
          id: inv2,
          subscription: subId,
          amount_paid: 2500,
          billing_reason: "subscription_cycle",
          payment_intent: "pi_e2e_renew_" + Date.now(),
        },
      },
    },
    env.STRIPE_WEBHOOK_SECRET
  );
  const afterCycle = await d1(
    `SELECT end_date, status FROM memberships WHERE member_id = '${memberId}'`
  );
  assert(afterCycle[0].status === "active", "still active after cycle");
  assert(
    new Date(afterCycle[0].end_date) > new Date(end1),
    `end_date extended (${end1} → ${afterCycle[0].end_date})`
  );

  const payments2 = await d1(
    `SELECT id FROM payments WHERE tenant_id = '${tenantId}' AND member_id = '${memberId}' AND status = 'succeeded'`
  );
  assert(payments2.length === 2, "two payments after renewal invoice");

  console.log("\n5) Idempotency: replay cycle invoice");
  await postWebhook(
    {
      id: "evt_e2e_inv_cycle_replay",
      type: "invoice.paid",
      data: {
        object: {
          id: inv2,
          subscription: subId,
          amount_paid: 2500,
          billing_reason: "subscription_cycle",
          payment_intent: "pi_e2e_renew_" + Date.now(),
        },
      },
    },
    env.STRIPE_WEBHOOK_SECRET
  );
  const payments3 = await d1(
    `SELECT id FROM payments WHERE tenant_id = '${tenantId}' AND member_id = '${memberId}' AND status = 'succeeded'`
  );
  assert(payments3.length === 2, "replay does not add third payment");

  // 6) Outbound events from the Stripe path.
  //
  // These payloads predate the event catalog. When schema validation landed in
  // v0.27.0 they became silently droppable — enqueueEvent logs and returns if a
  // payload does not match, so the paid path would stop emitting with no visible
  // failure anywhere else in this script. Assert them explicitly.
  //
  // NOTE: this must run BEFORE the cleanup below. webhook_outbox has
  // ON DELETE CASCADE on tenant_id, so deleting the seed tenant erases them.
  console.log("\n6) outbound webhook events (Stripe path)");
  const outbox = await d1(
    `SELECT event, payload_json FROM webhook_outbox WHERE tenant_id = '${tenantId}'`
  );
  const byEvent = new Map(outbox.map((r) => [r.event, JSON.parse(r.payload_json)]));
  for (const name of ["membership.activated", "member.activated", "payment.succeeded"]) {
    assert(byEvent.has(name), `${name} enqueued`);
    assert(
      byEvent.get(name).source === "stripe",
      `${name} carries source="stripe" (schema requires it)`
    );
  }

  // cleanup seed (best effort)
  await d1(`DELETE FROM webhook_outbox WHERE tenant_id = '${tenantId}'`);
  await d1(`DELETE FROM payments WHERE tenant_id = '${tenantId}'`);
  await d1(`DELETE FROM memberships WHERE tenant_id = '${tenantId}'`);
  await d1(`DELETE FROM members WHERE tenant_id = '${tenantId}'`);
  await d1(`DELETE FROM membership_levels WHERE tenant_id = '${tenantId}'`);
  await d1(`DELETE FROM tenants WHERE id = '${tenantId}'`);

  console.log("\n✅ Auto-renew E2E PASSED\n");
}

main().catch((e) => {
  console.error("\n❌", e.message || e);
  process.exit(1);
});
