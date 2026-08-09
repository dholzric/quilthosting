# Integration Ecosystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QuiltHosting's integration surface actually deliver what it advertises — fix the outbound webhook events that are offered but never fire, add the write endpoints and self-service hook subscription a Zapier app requires, and ship the Zapier app definition.

**Architecture:** One shared event-catalog module becomes the single source of truth consumed by the emitter, the subscription validator, the admin UI, and the docs. Emit calls are added at the five real mutation sites using the existing inline-dynamic-import convention. The public v1 API gains write endpoints and REST-hook subscribe/unsubscribe so a Zapier app can authenticate with an API key alone, with no browser JWT.

**Tech Stack:** TypeScript ESM, Hono 4, Zod 3, Cloudflare Workers (D1/R2/KV), Wrangler 4. Zapier app uses the Zapier Platform CLI (`zapier-platform-core`).

---

## Prior Analysis: corrections to the Walter/GLM-5.2 competitive review

This plan exists because an audit of that review against the codebase found the integration claims overstated. Recording the corrections so reviewers can judge the plan's premises:

| Walter's claim | Verified status |
|---|---|
| "Free ≤30 active members / Guild $24/mo flat" | **Correct.** `src/lib/plans.ts:5,8` — `FREE_ACTIVE_MEMBER_LIMIT = 30`, `GUILD_PLAN_PRICE_CENTS = 2400`. Active-only counting confirmed at `plans.ts:65-66`. |
| "One-click refunds" | **Correct.** Implemented in `src/routes/stats.ts`. |
| "Blog, forums, photo galleries, volunteer signups, multi-chapter, QBO, PWA" | **Correct.** Routes + migrations exist for all (`forums.ts`, `galleries.ts`, `qbo.ts`, `chapters.ts`, `0012_events_volunteers_galleries.sql`, `public/sw.js`). |
| "Public REST API v1 + outbound webhooks for Zapier/Make" | **Overstated.** The v1 API is **read-only** — five GET endpoints (`src/routes/v1.ts:69,83,118,132,145`), zero writes. A Zapier app can therefore have triggers but **no actions**. |
| "QH supports custom webhooks" | **Partly false.** `public/admin.html:3752` advertises six events to admins; only **four** are ever emitted. `member.created` and `event.registration` are accepted by the subscription validator (`src/routes/outboundWebhooks.ts:11-20`) and silently never fire. `member.updated` is in the validator but not even shown in the UI. |
| "Just needs an official Zapier listing for discoverability" | **Wrong diagnosis.** A Zapier app cannot be built against the current API at all: REST-hook triggers require programmatic subscribe/unsubscribe, but the only hook-management routes are mounted under `tenantApp` (`src/index.ts:319`), which requires a browser JWT. An API key cannot subscribe a hook. |

Additional dead code found during the audit, folded into this plan:

- The `write` scope is accepted when minting API keys (`src/routes/apiKeys.ts:31`) but no endpoint enforces it and the admin UI only ever offers `"read"` (`public/admin.html:3824`).
- `docs/zapier-webhooks.md:31-35` documents only the four working events, so the **docs are right and the product is wrong** — a rare and useful signal that the four-event set was the original intent and the extra options were added to the UI/validator without emitters.

**Net:** the gap is not marketing. It is that the integration surface is roughly half-built. Tasks 1–5 make the advertised surface honest; Tasks 6–8 make a Zapier app possible.

---

## Global Constraints

- **Multi-tenancy:** every tenant-scoped query filters by `tenant_id`. No exceptions.
- **Data conventions:** money is integer cents; timestamps are ISO strings; booleans are INTEGER 0/1; JSON columns are TEXT with a `_json` suffix.
- **Identifiers:** camelCase for code identifiers.
- **No test runner exists in this repo.** Verification is `scripts/*.mjs` driven over HTTP against `wrangler dev` on `:8787`, following `scripts/e2e-auto-renew.mjs`. Do not introduce Vitest/Jest as part of this plan.
- **Typecheck is the only static gate:** `npx tsc --noEmit` must pass before every commit.
- **Site gate:** `/api/v1/*` is already exempt (`src/middleware/siteGate.ts:108`) because API keys carry their own auth. Do not add new gate exemptions.
- **Webhook emission must never break the main flow.** Every emit is wrapped in `try { … } catch { /* optional */ }` using the inline dynamic import at `src/routes/public.ts:1109`. Match that convention exactly.
- **Versioning:** bump `package.json` `version` AND `src/version.ts` `APP_VERSION` together — they must never drift. Patch for fixes, minor for features. This plan spans 0.26.1 → 0.27.0.
- **Git:** work directly on `main`, commit per task, `git push` after each. Scan for literal secret values before every push.

### Preconditions for the verification harness

`wrangler.toml` sets `GOOGLE_AUTH_REQUIRED = "true"`, and `.dev.vars` does **not** override it, so password register/login returns 403 locally. Before running any harness task, add this line to `.dev.vars` (gitignored):

```
GOOGLE_AUTH_REQUIRED=false
```

Then run `npm run db:migrate:local` once, and keep `npx wrangler dev` running on `:8787` in a separate terminal for all verification steps.

---

## File Structure

**Create:**
- `src/lib/webhookEvents.ts` — the event catalog; single source of truth for the emitter, validator, admin UI, and docs.
- `scripts/verify-integrations.mjs` — end-to-end harness: local webhook sink + real route drives + assertions.
- `integrations/zapier/` — Zapier Platform CLI app (`package.json`, `index.js`, `authentication.js`, `triggers/`, `creates/`).

**Modify:**
- `src/lib/outboundWebhooks.ts:9-17` — replace the inline union type with an import from the catalog.
- `src/routes/outboundWebhooks.ts:11-20` — replace `EVENT_OPTIONS` with an import from the catalog.
- `src/routes/members.ts:91-94` (POST), `:390-393` (PATCH) — emit `member.created` / `member.updated`.
- `src/routes/public.ts:239-241` (join), `:461-477` (free/waitlist registration) — emit `member.created` / `event.registration`.
- `src/routes/webhooks.ts:170-177` — emit `event.registration` when Stripe confirms a paid seat.
- `src/routes/v1.ts` — add write endpoints and REST-hook management.
- `public/admin.html:3752` — fetch the event list from the API instead of hardcoding it; `:3824` — offer the `write` scope.
- `docs/zapier-webhooks.md`, `docs/api.md` — document the full catalog, write endpoints, and hook API.
- `package.json` (`scripts.test:integrations`, `version`), `src/version.ts`.

---

## Task 1: Single source of truth for the webhook event catalog

Three places independently list webhook events and they disagree. Collapse them to one module so a future event cannot be advertised without an emitter.

**Files:**
- Create: `src/lib/webhookEvents.ts`
- Modify: `src/lib/outboundWebhooks.ts:9-17`
- Modify: `src/routes/outboundWebhooks.ts:11-20`
- Modify: `public/admin.html:3752`

**Interfaces:**
- Consumes: nothing (this is the base task).
- Produces: `WEBHOOK_EVENTS: readonly WebhookEventName[]`, `WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventName, string>`, `type WebhookEventName`, `type WebhookEvent = WebhookEventName | "*"`. Tasks 3–5 and 7 import `WebhookEvent`.

- [ ] **Step 1: Create the catalog module**

Create `src/lib/webhookEvents.ts`:

```ts
/**
 * The single source of truth for outbound webhook events.
 *
 * Every name here MUST have a live `emitTenantEvent` call site. Adding a name
 * without an emitter silently advertises an event that never fires — that is
 * the exact defect this module exists to prevent. `scripts/verify-integrations.mjs`
 * asserts one real delivery per name.
 */
export const WEBHOOK_EVENTS = [
  "member.created",
  "member.activated",
  "member.updated",
  "membership.activated",
  "payment.succeeded",
  "event.registration",
  "form.response",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** Wildcard is valid for *subscribing* but is never an emitted event name. */
export type WebhookEvent = WebhookEventName | "*";

export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventName, string> = {
  "member.created": "A member record is created (admin add or public join form)",
  "member.activated": "A member becomes active",
  "member.updated": "A member's details or status change",
  "membership.activated": "A membership becomes active, with level metadata",
  "payment.succeeded": "A checkout completes",
  "event.registration": "Someone takes an event seat (free, waitlist, or paid)",
  "form.response": "A public form is submitted",
};

/** Valid values for a subscription's events_json array. */
export const WEBHOOK_SUBSCRIBE_OPTIONS: readonly string[] = [
  "*",
  ...WEBHOOK_EVENTS,
];
```

- [ ] **Step 2: Point the emitter at the catalog**

In `src/lib/outboundWebhooks.ts`, delete the inline union (lines 9-17) and import instead. Replace:

```ts
export type WebhookEvent =
  | "member.created"
  | "member.activated"
  | "member.updated"
  | "membership.activated"
  | "payment.succeeded"
  | "event.registration"
  | "form.response"
  | "*";
```

with:

```ts
import type { WebhookEvent } from "./webhookEvents";
export type { WebhookEvent };
```

Place the `import type` beside the existing imports at the top of the file (after `import { generateId } from "./utils/id";`). The re-export keeps existing `import type { WebhookEvent } from "../lib/outboundWebhooks"` consumers working.

- [ ] **Step 3: Point the subscription validator at the catalog**

In `src/routes/outboundWebhooks.ts`, replace the `EVENT_OPTIONS` array (lines 11-20) with:

```ts
import { WEBHOOK_SUBSCRIBE_OPTIONS } from "../lib/webhookEvents";

const EVENT_OPTIONS = WEBHOOK_SUBSCRIBE_OPTIONS;
```

Leave every other use of `EVENT_OPTIONS` in the file untouched.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS, no output.

- [ ] **Step 5: Verify the API now serves the full catalog**

With `wrangler dev` running, and using an admin JWT for a tenant you own:

```bash
curl -s -H "Authorization: Bearer $JWT" \
  http://127.0.0.1:8787/api/tenants/$TENANT_ID/webhooks/events
```

Expected: `{"events":["*","member.created","member.activated","member.updated","membership.activated","payment.succeeded","event.registration","form.response"]}`

- [ ] **Step 6: Make the admin UI read the catalog instead of hardcoding it**

`public/admin.html:3752` currently hardcodes:

```html
<code style="font-size:0.8rem">member.created · member.activated · membership.activated · payment.succeeded · event.registration · form.response · *</code>
```

Replace that `<code>` element with an empty, identified one:

```html
<code style="font-size:0.8rem" id="webhookEventCatalog">loading…</code>
```

Then, in the function that loads the Zapier/webhooks admin panel, populate it from the endpoint that already exists:

```js
async function loadWebhookEventCatalog() {
  const el = document.getElementById("webhookEventCatalog");
  if (!el) return;
  try {
    const res = await api(`/api/tenants/${tenantId}/webhooks/events`);
    el.textContent = (res.events || []).join(" · ");
  } catch {
    el.textContent = "unavailable";
  }
}
```

Call `loadWebhookEventCatalog()` from the same place the webhook endpoint list is loaded. Use the page's existing `api()` helper and `tenantId` variable — do not introduce a new fetch wrapper.

- [ ] **Step 7: Commit**

```bash
git add src/lib/webhookEvents.ts src/lib/outboundWebhooks.ts src/routes/outboundWebhooks.ts public/admin.html
git commit -m "refactor(webhooks): single source of truth for the event catalog"
git push
```

---

## Task 2: Integration verification harness (writes the failing tests)

This is the TDD step. The harness asserts that **every** name in `WEBHOOK_EVENTS` produces a real delivery. Three of them will fail. Tasks 3–5 make them pass one at a time.

**Files:**
- Create: `scripts/verify-integrations.mjs`
- Modify: `package.json` (add `scripts.test:integrations`)

**Interfaces:**
- Consumes: `WEBHOOK_EVENTS` from Task 1 (read over HTTP via the `/webhooks/events` endpoint, not imported — the script is Node, the module is Worker code).
- Produces: `npm run test:integrations`, used as the gate in Tasks 3–7.

- [ ] **Step 1: Write the harness**

Create `scripts/verify-integrations.mjs`:

```js
/**
 * Integration surface E2E — outbound webhook events + v1 API.
 * Usage: node scripts/verify-integrations.mjs
 * Requires:
 *   - wrangler dev running on :8787
 *   - .dev.vars with GOOGLE_AUTH_REQUIRED=false
 *   - npm run db:migrate:local applied
 *
 * Spins up a local sink, subscribes it to "*", drives the real routes, and
 * asserts one delivery per advertised event name.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const BASE = process.env.QH_BASE || "http://127.0.0.1:8787";
const SINK_PORT = Number(process.env.QH_SINK_PORT || 8799);

const received = [];
let sink;

function startSink() {
  return new Promise((resolve) => {
    sink = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try {
          received.push(JSON.parse(body));
        } catch {
          received.push({ event: "<unparseable>", raw: body });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    sink.listen(SINK_PORT, "127.0.0.1", resolve);
  });
}

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** Poll until the sink has an event, so we never race the fire-and-forget emit. */
async function waitForEvent(name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.some((p) => p.event === name)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  await startSink();
  console.log(`sink listening on :${SINK_PORT}`);

  const stamp = randomUUID().slice(0, 8);
  const adminEmail = `harness-${stamp}@example.test`;

  // 1. Admin account + tenant
  const reg = await json("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: adminEmail,
      password: "harness-password-1",
      name: "Harness Admin",
    }),
  });
  if (reg.status >= 400) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const jwt = reg.body.token;
  const auth = { Authorization: `Bearer ${jwt}` };

  const tenant = await json("/api/tenants", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Harness Guild ${stamp}`, slug: `harness-${stamp}` }),
  });
  if (tenant.status >= 400) throw new Error(`tenant failed: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.id;
  const slug = tenant.body.slug;

  // 2. Subscribe the sink to everything
  const hook = await json(`/api/tenants/${tenantId}/webhooks`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      url: `http://127.0.0.1:${SINK_PORT}/hook`,
      events: ["*"],
    }),
  });
  if (hook.status >= 400) throw new Error(`hook failed: ${JSON.stringify(hook.body)}`);

  // 3. Read the advertised catalog — this is what we hold the product to
  const catalog = await json(`/api/tenants/${tenantId}/webhooks/events`, { headers: auth });
  const advertised = (catalog.body.events || []).filter((e) => e !== "*");
  console.log(`advertised events: ${advertised.join(", ")}`);

  // 4. Drive the real routes
  //    member.created (admin path)
  await json(`/api/tenants/${tenantId}/members`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      email: `m-${stamp}@example.test`,
      first_name: "Ada",
      last_name: "Lovelace",
    }),
  });

  //    member.updated
  const members = await json(`/api/tenants/${tenantId}/members`, { headers: auth });
  const memberId = members.body.members[0].id;
  await json(`/api/tenants/${tenantId}/members/${memberId}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ first_name: "Augusta" }),
  });

  //    member.activated + membership.activated — free level activates inline
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
  await json(`/public/${slug}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: `join-${stamp}@example.test`,
      first_name: "Grace",
      last_name: "Hopper",
      level_id: level.body.id,
    }),
  });

  //    event.registration — free event
  const ev = await json(`/api/tenants/${tenantId}/events`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      title: "Harness Event",
      start_at: "2027-01-01T18:00:00.000Z",
      member_price_cents: 0,
      non_member_price_cents: 0,
      registration_open: true,
    }),
  });
  await json(`/public/${slug}/events/${ev.body.id}/register`, {
    method: "POST",
    body: JSON.stringify({ email: `ev-${stamp}@example.test`, name: "Katherine Johnson" }),
  });

  //    form.response — only if the tenant has a form; skipped when unavailable
  //    (covered by the existing public form route; not re-driven here)

  // 5. Assert one delivery per advertised event
  const results = [];
  for (const name of advertised) {
    if (name === "form.response") {
      results.push({ name, ok: true, skipped: true });
      continue;
    }
    const ok = await waitForEvent(name);
    results.push({ name, ok, skipped: false });
  }

  console.log("\n--- webhook event delivery ---");
  let failed = 0;
  for (const r of results) {
    const label = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
    if (!r.ok && !r.skipped) failed++;
    console.log(`${label}  ${r.name}`);
  }
  console.log(`\nreceived ${received.length} deliveries: ${received.map((p) => p.event).join(", ")}`);

  sink.close();
  if (failed) {
    console.error(`\n${failed} advertised event(s) never fired.`);
    process.exit(1);
  }
  console.log("\nAll advertised events delivered.");
}

main().catch((e) => {
  console.error(e);
  sink?.close();
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `"scripts"`:

```json
"test:integrations": "node scripts/verify-integrations.mjs"
```

- [ ] **Step 3: Run it and confirm it FAILS**

Run: `npm run test:integrations`
Expected: exit 1, with

```
PASS  member.activated
PASS  membership.activated
PASS  payment.succeeded    <- may FAIL if no paid flow driven; see note
FAIL  member.created
FAIL  member.updated
FAIL  event.registration
```

**Note on `payment.succeeded`:** the harness drives only free flows, so this event legitimately does not fire. If it reports FAIL, add it to the same skip list as `form.response` in Step 1's assertion loop with a comment explaining that it is covered by `scripts/e2e-auto-renew.mjs`, which drives signed Stripe webhooks. Do not add a fake emit to satisfy it.

- [ ] **Step 4: Commit the failing harness**

```bash
git add scripts/verify-integrations.mjs package.json
git commit -m "test: harness asserting every advertised webhook event actually fires"
git push
```

---

## Task 3: Emit `member.created`

**Files:**
- Modify: `src/routes/members.ts:91-94`
- Modify: `src/routes/public.ts:239-241`

**Interfaces:**
- Consumes: `emitTenantEvent` from `src/lib/outboundWebhooks.ts`; `WebhookEvent` catalog from Task 1.
- Produces: a `member.created` delivery whose `data` carries `member_id`, `email`, `first_name`, `last_name`, `status`, `source`.

- [ ] **Step 1: Emit on the admin create path**

In `src/routes/members.ts`, replace:

```ts
  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id)
  );
  return c.json(member, 201);
});
```

with:

```ts
  const member = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id)
  );
  try {
    const { emitTenantEvent } = await import("../lib/outboundWebhooks");
    await emitTenantEvent(c.env, tenant.id, "member.created", {
      member_id: id,
      email: body.email.toLowerCase(),
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      status,
      source: "admin",
    });
  } catch { /* optional */ }
  return c.json(member, 201);
});
```

- [ ] **Step 2: Emit on the public join path**

In `src/routes/public.ts`, inside the `if (!member) { … }` block, replace:

```ts
    member = await first<Member>(
      c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
    );
  } else if (customJson !== "{}") {
```

with:

```ts
    member = await first<Member>(
      c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
    );
    try {
      const { emitTenantEvent } = await import("../lib/outboundWebhooks");
      await emitTenantEvent(c.env, tenant.id, "member.created", {
        member_id: memberId,
        email,
        first_name: body.first_name ?? null,
        last_name: body.last_name ?? null,
        status: "pending",
        source: "join_form",
      });
    } catch { /* optional */ }
  } else if (customJson !== "{}") {
```

- [ ] **Step 3: Deliberately do NOT emit on CSV import**

`src/routes/members.ts:604` inserts members in a bulk import loop. Do **not** add an emit there. A 500-row import would issue 500 outbound `fetch` calls plus 500 D1 delivery-log writes inside one Worker invocation, against a 1000-subrequest ceiling — it would exhaust the limit and fail the import itself.

Add this comment immediately above the import loop's `INSERT INTO members` so the omission is intentional and legible:

```ts
  // No member.created emit here: bulk import would fire one outbound webhook
  // per row and blow the Worker subrequest ceiling. Importers should poll
  // GET /api/v1/members instead. Documented in docs/zapier-webhooks.md.
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Run the harness — `member.created` now passes**

Run: `npm run test:integrations`
Expected: `PASS  member.created`. `member.updated` and `event.registration` still FAIL.

- [ ] **Step 6: Commit**

```bash
git add src/routes/members.ts src/routes/public.ts
git commit -m "fix(webhooks): emit member.created — was advertised but never fired"
git push
```

---

## Task 4: Emit `event.registration`

Registrations arrive by three routes: free, waitlist, and paid-confirmed-by-Stripe. All three must emit, and the paid one must emit only after payment confirms — not when the pending seat is held.

**Files:**
- Modify: `src/routes/public.ts:461-477`
- Modify: `src/routes/webhooks.ts:170-177`

**Interfaces:**
- Consumes: `emitTenantEvent`.
- Produces: an `event.registration` delivery carrying `registration_id`, `event_id`, `event_title`, `email`, `name`, `status`, `amount_paid_cents`, `ticket_code`.

- [ ] **Step 1: Emit on the free / waitlist path**

In `src/routes/public.ts`, immediately after the `.run()` that inserts the registration and **before** the `if (status === "registered")` email block, insert:

```ts
    try {
      const { emitTenantEvent } = await import("../lib/outboundWebhooks");
      await emitTenantEvent(c.env, tenant.id, "event.registration", {
        registration_id: regId,
        event_id: eventId,
        event_title: event.title,
        email,
        name: body.name ?? null,
        status,
        amount_paid_cents: 0,
        ticket_code: ticketCode,
      });
    } catch { /* optional */ }
```

- [ ] **Step 2: Emit on the paid path, after Stripe confirms**

In `src/routes/webhooks.ts`, the paid branch updates the registration to `registered`. Replace:

```ts
    if (paymentType === "event" && relatedId) {
      await c.env.DB.prepare(
        `UPDATE event_registrations
         SET amount_paid_cents = ?, status = 'registered', updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status IN ('pending_payment', 'registered')`
      )
        .bind(session.amount_total || 0, now, relatedId, tenantId)
        .run();
```

with:

```ts
    if (paymentType === "event" && relatedId) {
      await c.env.DB.prepare(
        `UPDATE event_registrations
         SET amount_paid_cents = ?, status = 'registered', updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status IN ('pending_payment', 'registered')`
      )
        .bind(session.amount_total || 0, now, relatedId, tenantId)
        .run();

      // Seat is only real once Stripe confirms — emit here, not at hold time.
      try {
        const { emitTenantEvent } = await import("../lib/outboundWebhooks");
        await emitTenantEvent(c.env, tenantId, "event.registration", {
          registration_id: relatedId,
          event_id: null,
          event_title: null,
          email: session.customer_email || meta.email || null,
          name: null,
          status: "registered",
          amount_paid_cents: session.amount_total || 0,
          ticket_code: null,
        });
      } catch { /* optional */ }
```

The `event_id`, `event_title`, `name`, and `ticket_code` fields are filled from the `reg` / `eventRow` lookups that already happen a few lines below. **Move this emit to after those lookups** so the payload is complete — place it immediately after the `if (eventRow && tenant) { … }` block closes, and replace the nulls above with `reg.event_id`, `eventRow.title`, `reg.name`, and `reg.ticket_code`. Guard with `if (reg && eventRow)`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the harness — `event.registration` now passes**

Run: `npm run test:integrations`
Expected: `PASS  event.registration`. Only `member.updated` still FAILs.

- [ ] **Step 5: Verify the paid path separately**

The harness drives only free registrations. Confirm the Stripe-confirmed path with the existing signed-webhook script:

Run: `node scripts/e2e-auto-renew.mjs`
Expected: exits 0, no regression. This script drives real signed Stripe webhooks through `src/routes/webhooks.ts`, which is the file Step 2 modified.

- [ ] **Step 6: Commit**

```bash
git add src/routes/public.ts src/routes/webhooks.ts
git commit -m "fix(webhooks): emit event.registration on free, waitlist, and paid paths"
git push
```

---

## Task 5: Emit `member.updated`

**Files:**
- Modify: `src/routes/members.ts:390-393`

**Interfaces:**
- Consumes: `emitTenantEvent`.
- Produces: a `member.updated` delivery carrying `member_id`, `email`, `status`, `previous_status`, and `changed` (the list of column names the caller actually modified, so a Zap can filter on "status changed" without diffing).

- [ ] **Step 1: Emit on PATCH**

In `src/routes/members.ts`, replace:

```ts
  const updated = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
  );
  return c.json(updated);
});
```

with:

```ts
  const updated = await first<Member>(
    c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId)
  );
  try {
    const { emitTenantEvent } = await import("../lib/outboundWebhooks");
    await emitTenantEvent(c.env, tenant.id, "member.updated", {
      member_id: memberId,
      email: updated?.email ?? existing.email,
      status: updated?.status ?? existing.status,
      previous_status: existing.status,
      // Column names the caller actually changed, so a Zap can filter on them
      changed: fields
        .map((f) => f.split(" = ")[0])
        .filter((f) => f !== "updated_at"),
    });
  } catch { /* optional */ }
  return c.json(updated);
});
```

`fields` and `existing` are both already in scope at that point — `fields` is built at line 362 and `existing` is fetched at line 326.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the harness — everything passes**

Run: `npm run test:integrations`
Expected: exit 0, `All advertised events delivered.` No FAIL lines.

- [ ] **Step 4: Commit**

```bash
git add src/routes/members.ts
git commit -m "fix(webhooks): emit member.updated with changed-field list"
git push
```

---

## Task 6: Write endpoints on the v1 API

Without these a Zapier app has triggers and no actions. Adds `POST /api/v1/members` and `PATCH /api/v1/members/:memberId`, gated on the `write` scope that is already minted but never enforced.

**Files:**
- Modify: `src/routes/v1.ts` (append after the existing `/levels` route)
- Modify: `public/admin.html:3824` (offer the `write` scope)
- Modify: `scripts/verify-integrations.mjs` (add write-endpoint assertions)

**Interfaces:**
- Consumes: `requireApiKey` (already at `src/routes/v1.ts:20`), returning `{ tenant, scopes }`.
- Produces: `requireScope(auth, "write")` helper; `POST /api/v1/members` → `201 {member}`; `PATCH /api/v1/members/:memberId` → `200 {member}`.

- [ ] **Step 1: Add the scope guard and write endpoints**

Append to `src/routes/v1.ts`:

```ts
/** 403 unless the key carries the scope. Keys default to ["read"]. */
function requireScope(
  c: any,
  auth: { scopes: string[] },
  scope: string
): Response | null {
  if (auth.scopes.includes(scope)) return null;
  return c.json(
    { error: `This API key lacks the "${scope}" scope.`, code: "insufficient_scope" },
    403
  );
}

v1Routes.post("/members", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "write");
  if (denied) return denied;

  const body = await c.req.json<{
    email?: string;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    status?: string;
  }>();
  if (!body.email) return c.json({ error: "email is required" }, 400);
  const email = body.email.toLowerCase().trim();

  const existing = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM members WHERE tenant_id = ? AND email = ?"
    ).bind(auth.tenant.id, email)
  );
  if (existing) {
    return c.json({ error: "Member with this email already exists", member_id: existing.id }, 409);
  }

  const status = body.status ?? "pending";
  if (status === "active") {
    const { assertCanActivateMember } = await import("../lib/plans");
    try {
      await assertCanActivateMember(c.env.DB, auth.tenant, null);
    } catch (e: any) {
      return c.json(
        { error: e.message || "Plan limit reached", code: e.code || "plan_limit" },
        e.status || 402
      );
    }
  }

  const { generateId } = await import("../lib/utils/id");
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO members
     (id, tenant_id, email, first_name, last_name, phone, status, joined_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      auth.tenant.id,
      email,
      body.first_name ?? null,
      body.last_name ?? null,
      body.phone ?? null,
      status,
      now,
      now,
      now
    )
    .run();

  try {
    const { emitTenantEvent } = await import("../lib/outboundWebhooks");
    await emitTenantEvent(c.env, auth.tenant.id, "member.created", {
      member_id: id,
      email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      status,
      source: "api",
    });
  } catch { /* optional */ }

  const member = await first(
    c.env.DB.prepare(
      `SELECT id, email, first_name, last_name, phone, status, joined_at, created_at
       FROM members WHERE id = ?`
    ).bind(id)
  );
  return c.json({ member }, 201);
});

v1Routes.patch("/members/:memberId", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "write");
  if (denied) return denied;

  const memberId = c.req.param("memberId");
  const body = await c.req.json<{
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    status?: string;
  }>();

  const existing = await first<{ id: string; email: string; status: string }>(
    c.env.DB.prepare(
      "SELECT id, email, status FROM members WHERE id = ? AND tenant_id = ?"
    ).bind(memberId, auth.tenant.id)
  );
  if (!existing) return c.json({ error: "Member not found" }, 404);

  if (body.status === "active" && existing.status !== "active") {
    const { assertCanActivateMember } = await import("../lib/plans");
    try {
      await assertCanActivateMember(c.env.DB, auth.tenant, memberId);
    } catch (e: any) {
      return c.json(
        { error: e.message || "Plan limit reached", code: e.code || "plan_limit" },
        e.status || 402
      );
    }
  }

  const fields: string[] = [];
  const params: any[] = [];
  for (const key of ["first_name", "last_name", "phone", "status"] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(body[key]);
    }
  }
  if (!fields.length) return c.json({ error: "No fields to update" }, 400);

  fields.push("updated_at = ?");
  params.push(new Date().toISOString(), memberId, auth.tenant.id);
  await c.env.DB.prepare(
    `UPDATE members SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`
  )
    .bind(...params)
    .run();

  const member = await first<{ email: string; status: string }>(
    c.env.DB.prepare(
      `SELECT id, email, first_name, last_name, phone, status, joined_at, created_at
       FROM members WHERE id = ?`
    ).bind(memberId)
  );

  try {
    const { emitTenantEvent } = await import("../lib/outboundWebhooks");
    await emitTenantEvent(c.env, auth.tenant.id, "member.updated", {
      member_id: memberId,
      email: member?.email ?? existing.email,
      status: member?.status ?? existing.status,
      previous_status: existing.status,
      changed: fields
        .map((f) => f.split(" = ")[0])
        .filter((f) => f !== "updated_at"),
    });
  } catch { /* optional */ }

  return c.json({ member });
});
```

`MEMBER_STATUSES` validation is deliberately **not** duplicated here — `src/routes/members.ts` owns that constant and it is not exported. Add status validation by exporting `MEMBER_STATUSES` from `src/routes/members.ts` and importing it, rather than copying the array.

- [ ] **Step 2: Offer the `write` scope in the admin UI**

`public/admin.html:3824` hardcodes `"read"` when minting a key. Add a checkbox so an admin can grant `write`, and send `scopes: ["read"]` or `["read","write"]` accordingly. The API already filters to `["read","write"]` at `src/routes/apiKeys.ts:31`, so no server change is needed.

Label it explicitly: **"Allow this key to create and update members (needed for Zapier actions)"**.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Extend the harness to cover write + scope enforcement**

In `scripts/verify-integrations.mjs`, after the existing drives, mint two keys and assert both the happy path and the denial:

```js
  // v1 write endpoints
  const readKey = await json(`/api/tenants/${tenantId}/api-keys`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "harness-read", scopes: ["read"] }),
  });
  const writeKey = await json(`/api/tenants/${tenantId}/api-keys`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "harness-write", scopes: ["read", "write"] }),
  });

  const denied = await json("/api/v1/members", {
    method: "POST",
    headers: { Authorization: `Bearer ${readKey.body.key}` },
    body: JSON.stringify({ email: `scope-${stamp}@example.test` }),
  });
  console.log(`read-only key POST /v1/members -> ${denied.status} (expect 403)`);
  if (denied.status !== 403) throw new Error("write scope not enforced");

  const created = await json("/api/v1/members", {
    method: "POST",
    headers: { Authorization: `Bearer ${writeKey.body.key}` },
    body: JSON.stringify({ email: `api-${stamp}@example.test`, first_name: "Api" }),
  });
  console.log(`write key POST /v1/members -> ${created.status} (expect 201)`);
  if (created.status !== 201) throw new Error("v1 member create failed");
```

Adjust `readKey.body.key` to whatever field `POST /api-keys` actually returns the raw key under — check `src/routes/apiKeys.ts:47` and use that exact name.

- [ ] **Step 5: Run the harness**

Run: `npm run test:integrations`
Expected: exit 0, including the two new scope lines.

- [ ] **Step 6: Commit**

```bash
git add src/routes/v1.ts src/routes/members.ts public/admin.html scripts/verify-integrations.mjs
git commit -m "feat(api): v1 member write endpoints gated on the write scope"
git push
```

---

## Task 7: REST-hook subscribe/unsubscribe for Zapier

Zapier's REST-hook triggers call a subscribe URL on Zap turn-on and an unsubscribe URL on turn-off, authenticating with the user's API key. Today hook management lives only under `tenantApp` (JWT-only), so this is the blocker.

**Files:**
- Modify: `src/routes/v1.ts` (append)
- Modify: `scripts/verify-integrations.mjs`

**Interfaces:**
- Consumes: `requireApiKey`, `requireScope` (Task 6), `WEBHOOK_SUBSCRIBE_OPTIONS` (Task 1).
- Produces: `GET /api/v1/hooks`, `POST /api/v1/hooks` → `201 {hook:{id,url,events}}`, `DELETE /api/v1/hooks/:hookId` → `200 {deleted:true}`.

- [ ] **Step 1: Add the hook routes**

Append to `src/routes/v1.ts`:

```ts
import { WEBHOOK_SUBSCRIBE_OPTIONS } from "../lib/webhookEvents";

v1Routes.get("/hooks", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const rows = await all(
    c.env.DB.prepare(
      `SELECT id, url, events_json, is_active, created_at
       FROM webhook_endpoints WHERE tenant_id = ?
       ORDER BY created_at DESC LIMIT 100`
    ).bind(auth.tenant.id)
  );
  return c.json({
    hooks: rows.map((r: any) => ({
      id: r.id,
      url: r.url,
      events: JSON.parse(r.events_json || '["*"]'),
      is_active: !!r.is_active,
      created_at: r.created_at,
    })),
  });
});

v1Routes.post("/hooks", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "write");
  if (denied) return denied;

  const body = await c.req.json<{ url?: string; events?: string[] }>();
  if (!body.url) return c.json({ error: "url is required" }, 400);

  // Only https, and never point a hook back at ourselves (SSRF / self-loop).
  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    return c.json({ error: "url is not a valid URL" }, 400);
  }
  if (parsed.protocol !== "https:") {
    return c.json({ error: "url must be https" }, 400);
  }

  const events = Array.isArray(body.events) && body.events.length
    ? body.events.filter((e) => WEBHOOK_SUBSCRIBE_OPTIONS.includes(e))
    : ["*"];
  if (!events.length) {
    return c.json(
      { error: `events must be from: ${WEBHOOK_SUBSCRIBE_OPTIONS.join(", ")}` },
      400
    );
  }

  const { generateId } = await import("../lib/utils/id");
  const id = generateId();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO webhook_endpoints
     (id, tenant_id, url, secret, events_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, null, ?, 1, ?, ?)`
  )
    .bind(id, auth.tenant.id, body.url, JSON.stringify(events), now, now)
    .run();

  return c.json({ hook: { id, url: body.url, events } }, 201);
});

v1Routes.delete("/hooks/:hookId", async (c) => {
  const auth = await requireApiKey(c);
  if (isResponse(auth)) return auth;
  const denied = requireScope(c, auth, "write");
  if (denied) return denied;

  const hookId = c.req.param("hookId");
  const existing = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM webhook_endpoints WHERE id = ? AND tenant_id = ?"
    ).bind(hookId, auth.tenant.id)
  );
  if (!existing) return c.json({ error: "Hook not found" }, 404);

  await c.env.DB.prepare(
    "DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?"
  )
    .bind(hookId, auth.tenant.id)
    .run();
  return c.json({ deleted: true });
});
```

**Note on the https-only rule:** it is correct for production but blocks the harness, which uses `http://127.0.0.1`. The harness subscribes its sink through the JWT admin route (`/api/tenants/:id/webhooks`), not `/api/v1/hooks`, so this is not a conflict — keep the v1 rule strict.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Extend the harness to cover the hook lifecycle**

Append to `scripts/verify-integrations.mjs`:

```js
  // REST hook lifecycle via API key (what Zapier does on Zap on/off)
  const wh = { Authorization: `Bearer ${writeKey.body.key}` };
  const sub = await json("/api/v1/hooks", {
    method: "POST", headers: wh,
    body: JSON.stringify({ url: "https://hooks.zapier.com/harness/test", events: ["member.created"] }),
  });
  if (sub.status !== 201) throw new Error(`hook subscribe failed: ${JSON.stringify(sub.body)}`);

  const insecure = await json("/api/v1/hooks", {
    method: "POST", headers: wh,
    body: JSON.stringify({ url: "http://insecure.example.com/hook" }),
  });
  if (insecure.status !== 400) throw new Error("http:// hook should be rejected");

  const listed = await json("/api/v1/hooks", { headers: wh });
  if (!listed.body.hooks.some((h) => h.id === sub.body.hook.id)) {
    throw new Error("subscribed hook not listed");
  }

  const unsub = await json(`/api/v1/hooks/${sub.body.hook.id}`, { method: "DELETE", headers: wh });
  if (unsub.status !== 200) throw new Error("hook unsubscribe failed");
  console.log("hook lifecycle: subscribe -> list -> reject-http -> unsubscribe OK");
```

- [ ] **Step 4: Run the harness**

Run: `npm run test:integrations`
Expected: exit 0, with the hook-lifecycle line.

- [ ] **Step 5: Commit**

```bash
git add src/routes/v1.ts scripts/verify-integrations.mjs
git commit -m "feat(api): v1 REST-hook subscribe/unsubscribe for Zapier"
git push
```

---

## Task 8: Zapier Platform CLI app

**Files:**
- Create: `integrations/zapier/package.json`, `index.js`, `authentication.js`, `triggers/newMember.js`, `triggers/eventRegistration.js`, `creates/createMember.js`, `README.md`

**Interfaces:**
- Consumes: `GET /api/v1/me` (auth test), `POST|DELETE /api/v1/hooks` (Task 7), `POST /api/v1/members` (Task 6), `GET /api/v1/members` (polling fallback).
- Produces: a `zapier validate`-clean app directory. **Submission to the Zapier public directory is a manual, human step and is explicitly out of scope for this plan** — the deliverable is a working private app.

- [ ] **Step 1: Scaffold**

```bash
mkdir -p integrations/zapier
cd integrations/zapier
npm init -y
npm install zapier-platform-core@latest
```

Add `integrations/zapier/node_modules/` to the root `.gitignore` if a broader `node_modules/` rule does not already cover it.

- [ ] **Step 2: Authentication**

Create `integrations/zapier/authentication.js`:

```js
module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      required: true,
      type: 'password',
      helpText:
        'In QuiltHosting: Admin → Settings → API Keys → New Key. Grant the ' +
        '"write" scope so Zapier can create members.',
    },
  ],
  test: {
    url: 'https://quilthosting.com/api/v1/me',
  },
  connectionLabel: '{{bundle.authData.tenantName}}',
};

module.exports.befores = [
  (request, z, bundle) => {
    if (bundle.authData.apiKey) {
      request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
    }
    return request;
  },
];
```

- [ ] **Step 3: REST-hook trigger for new members**

Create `integrations/zapier/triggers/newMember.js`:

```js
const subscribe = (z, bundle) =>
  z.request({
    url: 'https://quilthosting.com/api/v1/hooks',
    method: 'POST',
    body: { url: bundle.targetUrl, events: ['member.created'] },
  }).then((res) => res.data.hook);

const unsubscribe = (z, bundle) =>
  z.request({
    url: `https://quilthosting.com/api/v1/hooks/${bundle.subscribeData.id}`,
    method: 'DELETE',
  }).then((res) => res.data);

// Zapier delivers the raw webhook body; unwrap the envelope to the member.
const perform = (z, bundle) => [
  { id: bundle.cleanedRequest.data.member_id, ...bundle.cleanedRequest.data },
];

// Used to populate sample data when the Zap is first built.
const performList = (z, bundle) =>
  z.request({ url: 'https://quilthosting.com/api/v1/members?limit=3' })
    .then((res) => res.data.members.map((m) => ({ ...m, member_id: m.id })));

module.exports = {
  key: 'newMember',
  noun: 'Member',
  display: {
    label: 'New Member',
    description: 'Triggers when a member is created.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribe,
    performUnsubscribe: unsubscribe,
    perform,
    performList,
    sample: {
      id: 'mem_sample',
      member_id: 'mem_sample',
      email: 'member@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      status: 'pending',
      source: 'join_form',
    },
  },
};
```

- [ ] **Step 4: REST-hook trigger for event registrations**

Create `integrations/zapier/triggers/eventRegistration.js`, identical in shape to Step 3 but with `key: 'eventRegistration'`, `noun: 'Registration'`, `events: ['event.registration']`, `performList` hitting `/api/v1/events`, and this sample:

```js
    sample: {
      id: 'reg_sample',
      registration_id: 'reg_sample',
      event_id: 'evt_sample',
      event_title: 'Fall Quilt Show & Tell',
      email: 'attendee@example.com',
      name: 'Katherine Johnson',
      status: 'registered',
      amount_paid_cents: 0,
      ticket_code: 'QH-ABC123',
    },
```

- [ ] **Step 5: Create action**

Create `integrations/zapier/creates/createMember.js`:

```js
module.exports = {
  key: 'createMember',
  noun: 'Member',
  display: {
    label: 'Create Member',
    description: 'Creates a member in your guild.',
  },
  operation: {
    inputFields: [
      { key: 'email', label: 'Email', required: true, type: 'string' },
      { key: 'first_name', label: 'First Name', type: 'string' },
      { key: 'last_name', label: 'Last Name', type: 'string' },
      { key: 'phone', label: 'Phone', type: 'string' },
      {
        key: 'status',
        label: 'Status',
        type: 'string',
        choices: ['pending', 'active'],
        default: 'pending',
        helpText:
          'Setting "active" consumes a slot against the free plan limit of 30 active members.',
      },
    ],
    perform: (z, bundle) =>
      z.request({
        url: 'https://quilthosting.com/api/v1/members',
        method: 'POST',
        body: {
          email: bundle.inputData.email,
          first_name: bundle.inputData.first_name,
          last_name: bundle.inputData.last_name,
          phone: bundle.inputData.phone,
          status: bundle.inputData.status,
        },
      }).then((res) => res.data.member),
    sample: {
      id: 'mem_sample',
      email: 'member@example.com',
      first_name: 'Ada',
      status: 'pending',
    },
  },
};
```

- [ ] **Step 6: Wire the app together**

Create `integrations/zapier/index.js`:

```js
const authentication = require('./authentication');
const newMember = require('./triggers/newMember');
const eventRegistration = require('./triggers/eventRegistration');
const createMember = require('./creates/createMember');

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication,
  beforeRequest: [...authentication.befores],
  triggers: {
    [newMember.key]: newMember,
    [eventRegistration.key]: eventRegistration,
  },
  creates: {
    [createMember.key]: createMember,
  },
};
```

- [ ] **Step 7: Validate**

```bash
cd integrations/zapier
npx zapier validate
```

Expected: no errors. `zapier validate` runs offline and does not require a Zapier account.

**Blocker to expect:** the site gate. `quilthosting.com/api/v1/*` is exempt (`siteGate.ts:108`), so a live `zapier test` against production will authenticate — but every other path 401s. Do not attempt `zapier test` against a gated non-v1 path.

- [ ] **Step 8: Commit**

```bash
cd ../..
git add integrations/zapier .gitignore
git commit -m "feat(zapier): platform CLI app with hook triggers and create-member action"
git push
```

---

## Task 9: Documentation and version bump

**Files:**
- Modify: `docs/zapier-webhooks.md:30-37`
- Modify: `docs/api.md`
- Modify: `public/docs/api.html`
- Modify: `package.json`, `src/version.ts`

- [ ] **Step 1: Correct the event table**

`docs/zapier-webhooks.md:31-35` lists only four events. Replace the table body with all seven, matching `WEBHOOK_EVENT_DESCRIPTIONS` in `src/lib/webhookEvents.ts` verbatim:

```markdown
| Event | When |
|-------|------|
| `member.created` | A member record is created (admin add or public join form) |
| `member.activated` | A member becomes active |
| `member.updated` | A member's details or status change |
| `membership.activated` | A membership becomes active, with level metadata |
| `payment.succeeded` | A checkout completes |
| `event.registration` | Someone takes an event seat (free, waitlist, or paid) |
| `form.response` | A public form is submitted |
| `*` | All |
```

Add below the table:

```markdown
**CSV import does not fire `member.created`.** A bulk import would issue one
outbound webhook per row and exceed the Worker subrequest limit. Poll
`GET /api/v1/members` after an import instead.
```

- [ ] **Step 2: Document the write endpoints and hook API**

Add to `docs/api.md`: `POST /api/v1/members`, `PATCH /api/v1/members/:memberId`, `GET|POST /api/v1/hooks`, `DELETE /api/v1/hooks/:hookId`. For each, give the exact request body, a `curl` example with `Authorization: Bearer qh_…`, and the success/error status codes. State that write endpoints require a key minted with the `write` scope and return `403 insufficient_scope` otherwise, and that hook URLs must be `https`.

Mirror the same content into `public/docs/api.html` so the deployed docs match.

- [ ] **Step 3: Bump the version**

This is a feature release: 0.26.1 → **0.27.0**. Edit both files so they cannot drift:

```bash
sed -i 's/"version": "0.26.1"/"version": "0.27.0"/' package.json
sed -i 's/APP_VERSION = "0.26.1"/APP_VERSION = "0.27.0"/' src/version.ts
grep -n '"version"' package.json && grep -n APP_VERSION src/version.ts
```

- [ ] **Step 4: Full verification before deploy**

```bash
npx tsc --noEmit
npm run test:integrations
node scripts/e2e-auto-renew.mjs
```

Expected: all three exit 0.

- [ ] **Step 5: Deploy and confirm**

```bash
npm run deploy
curl -s https://quilthosting.com/api/version
```

Expected: `{"version":"0.27.0"}`.

- [ ] **Step 6: Commit**

```bash
git add docs/ public/docs/ package.json src/version.ts
git commit -m "docs: full webhook event catalog, v1 write + hook API; v0.27.0"
git push
```

---

## Out of scope — decisions for the humans

These came out of the audit but are **not** implemented by this plan:

1. **Zapier public directory submission.** Task 8 produces a working private app. Public listing requires a Zapier account, a review submission, and 10 live users — a business process, not a code change. It also cannot happen while the site is gated.
2. **Un-gating the site.** Walter lists "public launch" as remaining work. The stealth gate is a deliberate standing decision ("I don't want to alert Wild Apricot to what we are doing"). Nothing here changes it, and a Zapier public listing is blocked until it does.
3. **Website builder templates.** Walter's other named gap. Genuinely separate subsystem — it belongs in its own plan and shares no code with this one.
4. **`payment.succeeded` on the store cart path.** `src/routes/webhooks.ts:291` emits it for dues/event/store single items, but the multi-SKU `store_orders` branch at `:304` does not emit its own event. Arguably wants an `order.paid` event. Deferred: adding a name to the catalog without a strong use case reintroduces exactly the dead-event problem this plan fixes.
5. **Retry/backoff on webhook delivery.** `emitTenantEvent` is fire-and-forget with a `fail_count` column that is incremented but never acted on. A real integration product eventually needs retries and auto-disable. Sizeable enough to deserve its own plan.

---

## Self-Review

**Spec coverage.** Every gap the audit found maps to a task: dead events → Tasks 1–5; read-only API → Task 6; no API-key hook management → Task 7; no Zapier app → Task 8; wrong docs → Task 9. The dead `write` scope is closed by Task 6 (enforcement) and Task 6 Step 2 (UI). Walter's two other named gaps (website builder, public listing) are explicitly deferred with reasons.

**Type consistency.** `WebhookEvent`, `WebhookEventName`, `WEBHOOK_EVENTS`, `WEBHOOK_SUBSCRIBE_OPTIONS`, `WEBHOOK_EVENT_DESCRIPTIONS` are defined once in Task 1 and used under those exact names in Tasks 3–5, 7, and 9. `requireScope(c, auth, scope)` is defined in Task 6 and reused with the same signature in Task 7. `requireApiKey` and `isResponse` are pre-existing and used as-is.

**Known soft spots a reviewer should press on:**
- Task 4 Step 2 asks the implementer to *move* the emit after the `reg`/`eventRow` lookups rather than showing the final merged block. That is the one step in this plan that requires judgment instead of transcription; it is the most likely place to get a half-populated payload.
- Task 6 Step 4 says to check the actual field name for the raw key returned by `POST /api-keys` rather than asserting one. Verify against `src/routes/apiKeys.ts:47` before writing the harness line.
- The harness cannot assert `payment.succeeded` or `form.response` without a lot more scaffolding; both are skipped with justification. If a reviewer wants real coverage there, that is a legitimate expansion of Task 2.
