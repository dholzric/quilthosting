// Cloudflare Bindings
export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  KV: KVNamespace;
  ASSETS: Fetcher;
  /**
   * Outbound webhook dispatch queue. Optional so local dev and tests still run
   * without the binding — enqueueEvent falls back to the cron sweeper.
   */
  WEBHOOK_QUEUE?: Queue<{ outboxId: string }>;
  SITE_ACCESS_PASSWORD?: string;
  /** When "true", site is public even if SITE_ACCESS_PASSWORD is unset. Default: open when password unset. */
  PUBLIC_LAUNCH?: string;
  EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_AUTH_REQUIRED?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** Optional: basis points platform fee on Connect destination charges (0 = no fee). */
  STRIPE_PLATFORM_FEE_BPS?: string;
  /** Optional: pre-created Stripe Price id for Guild plan; else ad-hoc $24/mo. */
  STRIPE_GUILD_PRICE_ID?: string;
  RESEND_API_KEY: string;
  JWT_SECRET: string;
  /** AES-GCM key (base64, 32 bytes) for tenant_credentials. Required in production. */
  CREDENTIAL_KEY?: string;
  ENVIRONMENT: string;
  APP_URL: string;
  /** Intuit QuickBooks Online app (optional) */
  QBO_CLIENT_ID?: string;
  QBO_CLIENT_SECRET?: string;
  /**
   * Optional: Cloudflare API token for attaching Workers custom domains
   * (guild slug.quilthosting.com + customer domains on zones in this account).
   */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_WORKER_NAME?: string;
  /** Guilds CNAME here for Cloudflare for SaaS (default customers.{APP host}). */
  SAAS_CNAME_TARGET?: string;
};

export type Plan = "free" | "starter" | "pro";
export type MemberStatus = "pending" | "active" | "lapsed" | "cancelled";
export type MembershipStatus = "active" | "expired" | "cancelled";
export type RegistrationStatus = "pending_payment" | "registered" | "waitlist" | "cancelled" | "checked_in";
export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded";
export type PaymentType = "dues" | "event" | "store" | "donation";
export type TenantRole = "owner" | "admin" | "membership" | "events" | "viewer";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  custom_domain: string | null;
  /** 'guild' (default) or 'business'. Read via isBusiness() in lib/tenantType. */
  tenant_type: "guild" | "business";
  /** 1 = this tenant's public site bypasses the site gate. Businesses only. */
  public_launched: number;
  stripe_account_id: string | null;
  /** Platform billing (guild pays QuiltHosting) */
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  /** ISO date when free Guild trial ends (null = no trial / already converted). */
  trial_ends_at?: string | null;
  plan: Plan;
  status: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface Member {
  id: string;
  tenant_id: string;
  user_id: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  address_json: string;
  custom_fields_json: string;
  status: MemberStatus;
  joined_at: string | null;
  notes: string | null;
  /** 1 = show in member/public directory */
  directory_visible?: number;
  created_at: string;
  updated_at: string;
}

export interface MembershipLevel {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  duration_months: number;
  renewal_type: "manual" | "auto";
  benefits_json: string;
  is_public: number;
  sort_order: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string | null;
  capacity: number | null;
  is_public: number;
  member_price_cents: number;
  non_member_price_cents: number;
  registration_open: number;
  waitlist_enabled: number;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export type TenantVariables = {
  tenant: Tenant;
};
