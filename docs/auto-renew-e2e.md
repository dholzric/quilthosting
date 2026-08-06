# Auto-renew end-to-end test (Stripe test mode)

Use this checklist to verify `renewal_type: auto` memberships before going live.

## Automated run (preferred)

With local Worker + D1 (stealth password in `.dev.vars`):

```bash
npx wrangler dev --port 8787 --ip 127.0.0.1
# other terminal:
node scripts/e2e-auto-renew.mjs
```

### Last automated run

| Field | Value |
|--------|--------|
| Date | 2026-08-06 |
| Mode | Stripe **test** keys + local Worker |
| Result | **PASSED** |

Coverage:

1. `checkout.session.completed` → one active membership, `auto_renew=1`, `stripe_subscription_id` set, member active, one payment  
2. `invoice.paid` / `subscription_create` → **no** double-extend of end_date  
3. `invoice.paid` / `subscription_cycle` → end_date extended by 1 month, second payment  
4. Replay same invoice id → still two payments (idempotent)

## Manual dashboard checklist (optional)

1. Stripe **test mode** keys; webhook: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`
2. Level: price &gt; 0, **Renewal = Auto**, duration 1 month
3. Join via `/g/{slug}` with card `4242…`
4. Confirm membership active + subscription id in D1 / admin
5. Stripe test clock or next invoice → `subscription_cycle` extends end_date
6. Portal → cancel auto-renew → Stripe cancels at period end

## Pass criteria

- [x] First payment activates membership once (no duplicates) — automated
- [x] Renewal invoice extends end date without double-charging in our DB — automated
- [x] Replay idempotent — automated
- [ ] Cancel auto-renew stops future invoices — portal UX present; confirm in Stripe dashboard when convenient
- [ ] Free plan limits after trial ends — covered by plan logic + cron; spot-check if needed

## Notes

- First invoice after Checkout is handled by `checkout.session.completed`; `subscription_create` invoices do not re-extend (by design).
- Only `subscription_cycle` renewals call `extendMembership`.
