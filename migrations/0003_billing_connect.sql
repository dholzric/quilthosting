-- Platform billing fields on tenants (Stripe Connect already has stripe_account_id)
ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT;
