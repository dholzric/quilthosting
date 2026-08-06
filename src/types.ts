// Cloudflare Bindings
export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  KV: KVNamespace;
  ASSETS: Fetcher;
  SITE_ACCESS_PASSWORD?: string;
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
  ENVIRONMENT: string;
  APP_URL: string;
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
  stripe_account_id: string | null;
  /** Platform billing (guild pays QuiltHosting) */
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
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
