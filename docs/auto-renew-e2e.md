# Auto-renew end-to-end test (Stripe test mode)

Use this checklist to verify `renewal_type: auto` memberships before going live.

## Prerequisites

1. Stripe **test mode** keys in secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)
2. Webhook endpoint: `https://quilthosting.com/api/webhooks/stripe` listening for:
   - `checkout.session.completed`
   - `invoice.paid`
   - `customer.subscription.deleted`
3. A guild with Connect optional (platform Stripe works for this test)
4. Membership level: price &gt; 0, **Renewal = Auto**, duration 1 month (easier to test)

## Steps

1. **Join** via public page `/g/{slug}` with a test card `4242…`
2. Confirm webhook: member becomes **active**, membership row has `stripe_subscription_id`, `auto_renew=1`
3. In Stripe Dashboard → Subscriptions → open the subscription
4. Use **“Update subscription” → advance clock** (or wait for next invoice in test clocks)
5. Confirm `invoice.paid` with `billing_reason=subscription_cycle`:
   - New payment row in admin
   - Membership `end_date` extended by duration
6. In member portal → cancel auto-renew (if shown)
7. Confirm Stripe subscription cancels at period end; membership stays active until end_date

## Pass criteria

- [ ] First payment activates membership once (no duplicates)
- [ ] Renewal invoice extends end date without double-charging in our DB
- [ ] Cancel auto-renew stops future invoices
- [ ] Free plan limits still apply after trial ends (if testing trials)

## Notes

- First invoice after Checkout is handled by `checkout.session.completed`; `subscription_create` invoices are ignored for membership extend (by design).
- Only `subscription_cycle` renewals call `extendMembership`.
