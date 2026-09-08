-- Payment correctness (PAY-1 / PAY-2).
--
-- 1. Stripe event inbox: one row per Stripe event id. The webhook handler
--    claims the row with INSERT OR IGNORE before doing any work, so a retry
--    or a concurrent delivery of the same event can be recognised and either
--    short-circuited (done / in-flight) or re-claimed (failed / stale).
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',   -- processing | done | failed
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  received_at TEXT NOT NULL,                   -- refreshed on every claim (lease start)
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_stripe_events_status ON stripe_events(status, received_at);

-- 2. Recording a payment and fulfilling it are now two idempotent steps.
--    fulfilled_at is the marker that separates them: a payments row with
--    fulfilled_at IS NULL is "money received, side effects not yet applied"
--    and a retry will apply them.
ALTER TABLE payments ADD COLUMN fulfilled_at TEXT;

-- One payments row per Stripe object (payment_intent, or checkout session id
-- when there is no payment_intent). Partial so NULL / manual payments are
-- unaffected. PRE-CHECK before applying to prod (must return zero rows):
--   SELECT stripe_payment_intent_id, COUNT(*) c FROM payments
--    WHERE stripe_payment_intent_id IS NOT NULL
--    GROUP BY stripe_payment_intent_id HAVING c > 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_pi_unique
  ON payments(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
-- Same for subscription invoices (invoice.paid renewals). PRE-CHECK:
--   SELECT stripe_invoice_id, COUNT(*) c FROM payments
--    WHERE stripe_invoice_id IS NOT NULL
--    GROUP BY stripe_invoice_id HAVING c > 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_invoice_unique
  ON payments(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;

-- 3. Event seat holds. A pending_payment registration holds a seat only until
--    hold_expires_at (= the Stripe Checkout session's expires_at). The seat
--    claim in routes/public.ts counts only unexpired holds, and
--    sweepExpiredHolds() cancels expired ones. stripe_session_id lets a
--    repeat POST from the same email reuse the open Checkout instead of
--    taking a second hold. member_price_verified records whether member
--    pricing was proven by a portal session (1), merely claimed by an email
--    match (0), or not applied (NULL).
ALTER TABLE event_registrations ADD COLUMN hold_expires_at TEXT;
ALTER TABLE event_registrations ADD COLUMN stripe_session_id TEXT;
ALTER TABLE event_registrations ADD COLUMN member_price_verified INTEGER;
-- 0001 has idx_regs_status(tenant_id, event_id, status); the seat-claim
-- subquery filters on event_id first, so give it a matching index.
CREATE INDEX IF NOT EXISTS idx_regs_event_status ON event_registrations(event_id, status);
CREATE INDEX IF NOT EXISTS idx_regs_hold_expiry ON event_registrations(status, hold_expires_at);

-- 4. Store orders now reserve stock at checkout time (conditional decrements
--    in one batch) instead of decrementing at webhook time. reserved_at marks
--    an order whose items_json quantities are currently subtracted from
--    products.inventory; releasing (expiry / cancel / sweep) adds them back.
--    Orders with reserved_at IS NULL are legacy (pre-migration) and are still
--    decremented at fulfillment time.
ALTER TABLE store_orders ADD COLUMN reserved_at TEXT;
ALTER TABLE store_orders ADD COLUMN hold_expires_at TEXT;
ALTER TABLE store_orders ADD COLUMN fulfilled_at TEXT;
CREATE INDEX IF NOT EXISTS idx_store_orders_status_hold ON store_orders(status, hold_expires_at);
