/**
 * Payment fulfillment helpers shared by the public checkout routes, the
 * Stripe webhook, and the cron sweeper.
 *
 * Model (PAY-1 / PAY-2 fixes):
 *
 *   checkout  -> a HOLD is taken atomically (conditional INSERT for an event
 *                seat, conditional stock decrements for a store order), with
 *                hold_expires_at = the Stripe Checkout session's expires_at.
 *   webhook   -> checkout.session.completed RECORDS the payment (INSERT OR
 *                IGNORE against the unique stripe ref index) and then, if the
 *                payments row still has fulfilled_at IS NULL, applies every
 *                side effect in ONE D1 batch that also stamps fulfilled_at.
 *                checkout.session.expired RELEASES the hold.
 *   sweeper   -> sweepExpiredHolds() releases holds whose Stripe session has
 *                expired but whose expired-webhook never arrived.
 *
 * Every statement built here is conditional so that running it twice is a
 * no-op: the batch is atomic, and the guards make each statement idempotent
 * on its own as well.
 */
import type { Env, MembershipLevel } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";

import { readDuesPolicy, computeTermEnd } from "./dues";

/**
 * Minutes past hold_expires_at before the sweeper releases a hold. Stripe
 * will not complete a payment after the session's expires_at, so anything
 * that arrives after this grace is a late webhook for an already-completed
 * payment, which the fulfillment path handles (see restock guards below).
 */
export const HOLD_GRACE_MINUTES = 10;

/** Legacy pending_payment rows (no hold_expires_at) are released after this. */
const LEGACY_HOLD_HOURS = 24;

export type OrderLine = { product_id: string; quantity: number };

export function parseOrderItems(itemsJson: string | null | undefined): OrderLine[] {
  try {
    const raw = JSON.parse(itemsJson || "[]") as Array<{
      product_id?: unknown;
      quantity?: unknown;
    }>;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((it) => ({
        product_id: typeof it.product_id === "string" ? it.product_id : "",
        quantity: Math.floor(Number(it.quantity) || 0),
      }))
      .filter((it) => it.product_id && it.quantity > 0);
  } catch {
    return [];
  }
}

/**
 * Collapse repeated SKUs into one line each (quantities summed) so a cart
 * like [{A,1},{A,1}] reserves 2 of A, and a stock check on A cannot pass
 * twice for the same unit. Per-line quantity is clamped to `maxPerLine`.
 */
export function normalizeOrderLines(
  items: Array<{ product_id?: unknown; quantity?: unknown }>,
  maxPerLine: number
): OrderLine[] {
  const byId = new Map<string, number>();
  for (const raw of items) {
    if (typeof raw?.product_id !== "string" || !raw.product_id) continue;
    const qty = Math.max(1, Math.floor(Number(raw.quantity) || 1));
    byId.set(raw.product_id, (byId.get(raw.product_id) ?? 0) + qty);
  }
  return [...byId.entries()].map(([product_id, quantity]) => ({
    product_id,
    quantity: Math.min(maxPerLine, quantity),
  }));
}

/**
 * The seat-count expression used for capacity decisions. Counts confirmed
 * seats plus UNEXPIRED payment holds. Rows with hold_expires_at IS NULL are
 * legacy pending rows from before the hold column existed; they count until
 * the sweeper retires them.
 *
 * Binds, in order: event_id, tenant_id, nowIso.
 */
export const SEAT_COUNT_SQL = `(
  SELECT COUNT(*) FROM event_registrations
  WHERE event_id = ? AND tenant_id = ?
    AND (
      status IN ('registered', 'checked_in')
      OR (status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > ?))
    )
)`;

/**
 * Conditional stock reservation: one statement per line, each succeeding
 * (meta.changes = 1) only if the product still has enough. Lines whose
 * product has NULL inventory (untracked) are skipped, so callers must treat
 * a missing statement as "nothing to reserve", not as a failure.
 */
export function buildReserveStockStatements(
  db: D1Database,
  tenantId: string,
  lines: OrderLine[],
  now: string
): Array<{ line: OrderLine; stmt: D1PreparedStatement }> {
  return lines.map((line) => ({
    line,
    stmt: db
      .prepare(
        `UPDATE products SET inventory = inventory - ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND inventory IS NOT NULL AND inventory >= ?`
      )
      .bind(line.quantity, now, line.product_id, tenantId, line.quantity),
  }));
}

/**
 * Release an order's reservation: restock `lines` and flip the order to
 * `status`, atomically, and only if the order is still a pending reserved
 * order. The restock statements are guarded by the SAME predicate the flip
 * uses, so a concurrent fulfillment (pending -> paid) makes every statement
 * here a no-op instead of restocking sold units.
 *
 * Callers pass exactly the lines that were actually decremented (a partial
 * reservation failure restocks only the lines that succeeded).
 */
export function buildReleaseOrderStatements(
  db: D1Database,
  params: {
    tenantId: string;
    orderId: string;
    lines: OrderLine[];
    now: string;
    status: "expired" | "cancelled";
  }
): D1PreparedStatement[] {
  const { tenantId, orderId, lines, now, status } = params;
  const stmts = lines.map((line) =>
    db
      .prepare(
        `UPDATE products SET inventory = inventory + ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND inventory IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM store_orders
             WHERE id = ? AND tenant_id = ? AND status = 'pending' AND reserved_at IS NOT NULL
           )`
      )
      .bind(line.quantity, now, line.product_id, tenantId, orderId, tenantId)
  );
  stmts.push(
    db
      .prepare(
        `UPDATE store_orders SET status = ?, reserved_at = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending' AND reserved_at IS NOT NULL`
      )
      .bind(status, now, orderId, tenantId)
  );
  return stmts;
}

/**
 * Fulfill a store order at payment time. Reserved orders already had their
 * stock taken at checkout, so the only work is the status flip. Orders whose
 * stock is NOT currently reserved (legacy pre-migration orders, or a hold the
 * sweeper released before a late webhook arrived) are decremented here,
 * clamped at zero: the customer has paid, so the unit is sold regardless.
 *
 * The decrement guard reads the order's reservation state INSIDE the batch,
 * so it is correct even if a release raced this fulfillment.
 */
export function buildFulfillOrderStatements(
  db: D1Database,
  params: {
    tenantId: string;
    orderId: string;
    paymentId: string;
    lines: OrderLine[];
    stripeSessionId: string | null;
    now: string;
  }
): D1PreparedStatement[] {
  const { tenantId, orderId, paymentId, lines, stripeSessionId, now } = params;
  const stmts = lines.map((line) =>
    db
      .prepare(
        `UPDATE products SET
           inventory = CASE
             WHEN inventory IS NULL THEN NULL
             WHEN inventory >= ? THEN inventory - ?
             ELSE 0
           END,
           updated_at = ?
         WHERE id = ? AND tenant_id = ?
           AND EXISTS (
             SELECT 1 FROM store_orders
             WHERE id = ? AND tenant_id = ? AND status <> 'paid' AND reserved_at IS NULL
           )
           AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND fulfilled_at IS NULL)`
      )
      .bind(
        line.quantity,
        line.quantity,
        now,
        line.product_id,
        tenantId,
        orderId,
        tenantId,
        paymentId
      )
  );
  stmts.push(
    db
      .prepare(
        `UPDATE store_orders SET
           status = 'paid', fulfilled_at = ?, updated_at = ?,
           stripe_session_id = coalesce(?, stripe_session_id)
         WHERE id = ? AND tenant_id = ? AND status <> 'paid'`
      )
      .bind(now, now, stripeSessionId, orderId, tenantId)
  );
  return stmts;
}

/**
 * Legacy single-product purchase (checkout sessions created before orders
 * existed for the /buy route): decrement at fulfillment, clamped at zero,
 * guarded by the payment's fulfilled_at so it can never apply twice.
 */
export function buildLegacyProductDecrementStatement(
  db: D1Database,
  params: {
    tenantId: string;
    productId: string;
    quantity: number;
    paymentId: string;
    now: string;
  }
): D1PreparedStatement {
  const { tenantId, productId, quantity, paymentId, now } = params;
  return db
    .prepare(
      `UPDATE products SET
         inventory = CASE
           WHEN inventory IS NULL THEN NULL
           WHEN inventory >= ? THEN inventory - ?
           ELSE 0
         END,
         updated_at = ?
       WHERE id = ? AND tenant_id = ?
         AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND fulfilled_at IS NULL)`
    )
    .bind(quantity, quantity, now, productId, tenantId, paymentId);
}

/**
 * The statements activateMembership() (lib/memberships.ts) runs, as a list
 * the webhook can commit in one batch with the payment's fulfilled_at stamp.
 * The INSERT is guarded by the payment's fulfilled_at so two fulfillment
 * attempts for the same payment cannot create two memberships.
 */
export function buildActivateMembershipStatements(
  db: D1Database,
  params: {
    tenantId: string;
    memberId: string;
    level: MembershipLevel;
    amountPaidCents: number;
    paymentId: string;
    stripeSubscriptionId: string | null;
    autoRenew: boolean;
    now: string;
    /** Overrides the policy calculation (imports and admin corrections). */
    endDate?: string;
  }
): { membershipId: string; stmts: D1PreparedStatement[] } {
  const { tenantId, memberId, level, amountPaidCents, paymentId, now } = params;
  const membershipId = generateId();
  // A paid join must land on the same term the public price was quoted for:
  // a calendar-year level ends on its anchor, not a year from the payment.
  // computeTermEnd falls back to the anniversary math for untouched levels.
  const endDate = params.endDate ?? computeTermEnd(readDuesPolicy(level), now, now);
  const guard = `EXISTS (SELECT 1 FROM payments WHERE id = ? AND fulfilled_at IS NULL)`;

  /* ——— Household (migration 0031) ———
   *
   * The public join form writes the household and its people BEFORE opening
   * Stripe Checkout, exactly as it has always written the payer's own pending
   * member row, so the roster the payment activates is already known here and
   * no household data has to ride through Stripe metadata.
   *
   * Both statements below are correlated subqueries against that household.
   * On the ordinary individual join there is no household row, the subquery
   * yields nothing, household_id lands NULL and the second statement matches
   * no rows — byte-identical behavior for every level nobody has edited.
   */
  const householdOfPayer = `(SELECT h.id FROM households h
      WHERE h.tenant_id = ? AND h.payer_member_id = ?)`;

  const stmts = [
    db
      .prepare(
        `UPDATE memberships SET status = 'expired', updated_at = ?
         WHERE tenant_id = ? AND member_id = ? AND status = 'active' AND ${guard}`
      )
      .bind(now, tenantId, memberId, paymentId),
    db
      .prepare(
        `INSERT INTO memberships
         (id, tenant_id, member_id, level_id, start_date, end_date, status,
          amount_paid_cents, stripe_subscription_id, auto_renew, household_id,
          created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ${householdOfPayer}, ?, ?
         WHERE ${guard}`
      )
      .bind(
        membershipId,
        tenantId,
        memberId,
        level.id,
        now,
        endDate,
        amountPaidCents,
        params.stripeSubscriptionId,
        params.autoRenew ? 1 : 0,
        tenantId,
        memberId,
        now,
        now,
        paymentId
      ),
    db
      .prepare(
        `UPDATE members SET status = 'active', joined_at = coalesce(joined_at, ?), updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(now, now, memberId, tenantId),
    // Everybody else this one payment covers. They were created 'pending' at
    // join time and become members the moment the payer's card clears.
    db
      .prepare(
        `UPDATE members SET status = 'active', joined_at = coalesce(joined_at, ?), updated_at = ?
         WHERE tenant_id = ? AND id IN (
           SELECT hm.member_id FROM household_members hm
            WHERE hm.household_id = ${householdOfPayer}
         ) AND ${guard}`
      )
      .bind(now, now, tenantId, tenantId, memberId, paymentId),
  ];
  return { membershipId, stmts };
}

/** Release one event seat hold. No-op unless the row is still pending_payment. */
export function buildReleaseSeatStatement(
  db: D1Database,
  tenantId: string,
  registrationId: string,
  now: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE event_registrations SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'pending_payment'`
    )
    .bind(now, registrationId, tenantId);
}

/**
 * Cron: release seat holds and stock reservations whose Stripe session has
 * expired (plus grace) without a checkout.session.expired webhook arriving.
 * Intended for the every-minute schedule alongside sweepOutbox. Bounded per
 * call; anything left over is picked up on the next tick.
 */
export async function sweepExpiredHolds(
  env: Env,
  limit = 200
): Promise<{ registrations_released: number; orders_released: number; errors: string[] }> {
  const result = { registrations_released: 0, orders_released: 0, errors: [] as string[] };
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - HOLD_GRACE_MINUTES * 60_000).toISOString();
  const legacyCutoff = new Date(nowMs - LEGACY_HOLD_HOURS * 3_600_000).toISOString();

  try {
    const r = await env.DB.prepare(
      `UPDATE event_registrations SET status = 'cancelled', updated_at = ?
       WHERE status = 'pending_payment'
         AND (
           (hold_expires_at IS NOT NULL AND hold_expires_at < ?)
           OR (hold_expires_at IS NULL AND created_at < ?)
         )`
    )
      .bind(now, cutoff, legacyCutoff)
      .run();
    result.registrations_released = r.meta?.changes ?? 0;
  } catch (e) {
    result.errors.push(`registrations: ${(e as Error).message}`);
  }

  let orders: Array<{ id: string; tenant_id: string; items_json: string }> = [];
  try {
    orders = await all<{ id: string; tenant_id: string; items_json: string }>(
      env.DB.prepare(
        `SELECT id, tenant_id, items_json FROM store_orders
         WHERE status = 'pending' AND reserved_at IS NOT NULL
           AND hold_expires_at IS NOT NULL AND hold_expires_at < ?
         ORDER BY hold_expires_at LIMIT ?`
      ).bind(cutoff, limit)
    );
  } catch (e) {
    result.errors.push(`orders select: ${(e as Error).message}`);
  }

  for (const o of orders) {
    try {
      const stmts = buildReleaseOrderStatements(env.DB, {
        tenantId: o.tenant_id,
        orderId: o.id,
        lines: parseOrderItems(o.items_json),
        now,
        status: "expired",
      });
      const results = await env.DB.batch(stmts);
      const flip = results[results.length - 1];
      if ((flip?.meta?.changes ?? 0) > 0) result.orders_released++;
    } catch (e) {
      result.errors.push(`order ${o.id}: ${(e as Error).message}`);
    }
  }

  return result;
}

/** Read a payments row by Stripe ref (payment_intent or session id). */
export async function findPaymentByStripeRef(
  db: D1Database,
  refs: Array<string | null | undefined>
): Promise<{ id: string; fulfilled_at: string | null } | null> {
  const list = [...new Set(refs.filter((r): r is string => !!r))];
  if (!list.length) return null;
  const placeholders = list.map(() => "?").join(", ");
  return first<{ id: string; fulfilled_at: string | null }>(
    db
      .prepare(
        `SELECT id, fulfilled_at FROM payments
         WHERE stripe_payment_intent_id IN (${placeholders})
            OR stripe_invoice_id IN (${placeholders})
         LIMIT 1`
      )
      .bind(...list, ...list)
  );
}
