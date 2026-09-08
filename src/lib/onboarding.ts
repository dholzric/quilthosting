// Server-side onboarding checklist. Every step is derived from real rows at
// request time, so the checklist is truthful and follows the admin to any
// device; the only stored state is the dismissal flag in tenants.onboarding_json.

import type { Tenant } from "../types";
import { first } from "./db";
import { SAMPLE_MARKER } from "./starterSite";

export type DomainStatus = "pending" | "active" | "failed" | "skipped";

/** Tenant row plus the columns migration 0024 adds (not on the shared Tenant type). */
export type OnboardingTenant = Tenant & {
  domain_status?: DomainStatus | string | null;
  domain_error?: string | null;
  onboarding_json?: string | null;
};

export type OnboardingStep = {
  key: string;
  label: string;
  done: boolean;
  /** "#<admin page>" to navigate inside admin.html, or an absolute URL. */
  href: string;
  hint: string;
  /** Optional steps never block ready_for_members and are shown de-emphasised. */
  optional?: boolean;
};

export type OnboardingState = {
  steps: OnboardingStep[];
  dismissed: boolean;
  dismissed_at: string | null;
  ready_for_members: boolean;
  domain_status: DomainStatus | null;
  domain_error: string | null;
};

type CountRow = { n: number | null };

async function count(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await first<CountRow>(db.prepare(sql).bind(...binds));
  return Number(row?.n || 0);
}

export function parseOnboardingJson(raw: string | null | undefined): { dismissed_at: string | null } {
  try {
    const o = JSON.parse(raw || "{}") as { dismissed_at?: unknown };
    return { dismissed_at: typeof o.dismissed_at === "string" ? o.dismissed_at : null };
  } catch {
    return { dismissed_at: null };
  }
}

function hasLogo(settingsJson: string | null | undefined): boolean {
  try {
    const s = JSON.parse(settingsJson || "{}") as { profile?: { logo_file_id?: unknown } };
    return !!(s.profile && s.profile.logo_file_id);
  } catch {
    return false;
  }
}

export function normalizeDomainStatus(v: unknown): DomainStatus | null {
  return v === "pending" || v === "active" || v === "failed" || v === "skipped" ? v : null;
}

export async function computeOnboarding(
  db: D1Database,
  tenant: OnboardingTenant
): Promise<OnboardingState> {
  const like = `%${SAMPLE_MARKER}%`;
  const [pageCount, sampleCount, levelRow, memberCount, teamCount] = await Promise.all([
    count(db, "SELECT COUNT(*) AS n FROM pages WHERE tenant_id = ?", tenant.id),
    count(
      db,
      "SELECT COUNT(*) AS n FROM pages WHERE tenant_id = ? AND (blocks_json LIKE ? OR content_json LIKE ?)",
      tenant.id,
      like,
      like
    ),
    first<{ n: number | null; paid: number | null }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n, SUM(CASE WHEN price_cents > 0 THEN 1 ELSE 0 END) AS paid
           FROM membership_levels WHERE tenant_id = ? AND status = 'active'`
        )
        .bind(tenant.id)
    ),
    count(db, "SELECT COUNT(*) AS n FROM members WHERE tenant_id = ?", tenant.id),
    count(db, "SELECT COUNT(*) AS n FROM tenant_users WHERE tenant_id = ?", tenant.id),
  ]);

  const levelCount = Number(levelRow?.n || 0);
  const paidLevels = Number(levelRow?.paid || 0);
  const hasLevel = levelCount > 0;
  const allFree = hasLevel && paidLevels === 0;
  const stripeConnected = !!tenant.stripe_account_id;
  const paymentsDone = stripeConnected || allFree;
  const domainStatus = normalizeDomainStatus(tenant.domain_status);
  const domainDone = !!tenant.custom_domain || domainStatus === "active";

  const steps: OnboardingStep[] = [
    {
      key: "site_seeded",
      label: "Starter website created",
      done: pageCount > 0,
      href: "#pages",
      hint:
        pageCount > 0
          ? `${pageCount} page${pageCount === 1 ? "" : "s"} on your public site.`
          : "Add a Home page in the website builder so visitors see something.",
    },
    {
      key: "sample_content_replaced",
      label: "Replace the sample text on your pages",
      done: pageCount > 0 && sampleCount === 0,
      href: "#pages",
      hint:
        sampleCount > 0
          ? `${sampleCount} page${sampleCount === 1 ? " still has" : "s still have"} sample text starting "${SAMPLE_MARKER}".`
          : pageCount > 0
            ? "All sample copy has been replaced."
            : "Create a page first.",
    },
    {
      key: "logo",
      label: "Upload your guild logo",
      done: hasLogo(tenant.settings_json),
      href: "#settings",
      hint: "Shown in the header of your public site and on emails.",
    },
    {
      key: "level",
      label: "Add a membership level",
      done: hasLevel,
      href: "#levels",
      hint: hasLevel
        ? `${levelCount} level${levelCount === 1 ? "" : "s"} defined.`
        : "Members need at least one level (for example, Individual $35/yr) to join.",
    },
    {
      key: "payments",
      label: "Connect Stripe for dues payouts",
      done: paymentsDone,
      href: "#settings",
      hint: stripeConnected
        ? "Stripe is connected; dues and event fees pay out to your guild."
        : allFree
          ? "All your levels are free, so payments are not needed yet. Connect Stripe when you add a paid level."
          : hasLevel
            ? "You have a paid level — members cannot pay dues until Stripe is connected."
            : "Needed once you add a paid membership level.",
    },
    {
      key: "first_member",
      label: "Add or import your first member",
      done: memberCount > 0,
      href: "#members",
      hint: memberCount > 0
        ? `${memberCount} member${memberCount === 1 ? "" : "s"} on the roster.`
        : "Import a spreadsheet of your current roster, or add members one at a time.",
    },
    {
      key: "team_invited",
      label: "Invite another officer to help",
      done: teamCount >= 2,
      href: "#settings",
      hint: teamCount >= 2
        ? `${teamCount} people can sign in to manage this guild.`
        : "Give your treasurer or membership chair their own login so you are not the only admin.",
      optional: true,
    },
    {
      key: "domain",
      label: "Your web address",
      done: domainDone,
      href: "#settings",
      optional: true,
      hint: tenant.custom_domain
        ? `Custom domain ${tenant.custom_domain} is set.`
        : domainStatus === "active"
          ? "Your free subdomain is live."
          : domainStatus === "pending"
            ? "Setting up your free subdomain — your /g/ link works in the meantime."
            : domainStatus === "failed"
              ? `Subdomain setup failed: ${tenant.domain_error || "unknown error"}. Retry below; your /g/ link still works.`
              : "Your /g/ link always works. A free subdomain or your own domain is optional.",
    },
  ];

  const { dismissed_at } = parseOnboardingJson(tenant.onboarding_json);
  return {
    steps,
    dismissed: !!dismissed_at,
    dismissed_at,
    ready_for_members: hasLevel && paymentsDone,
    domain_status: domainStatus,
    domain_error: tenant.domain_error || null,
  };
}
