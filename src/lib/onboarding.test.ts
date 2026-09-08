// src/lib/onboarding.test.ts
// computeOnboarding() derives every checklist step from real rows. Drive it
// with a keyword-routed fake D1 across the states that matter: a fresh
// guild, one with a paid level but no Stripe, an all-free guild, a finished
// one, and the dismissed flag.
import { describe, it, expect } from "vitest";
import { computeOnboarding, hasLogo, type OnboardingTenant } from "./onboarding";
import { SAMPLE_MARKER } from "./starterSite";

type Counts = {
  pages?: number;
  samplePages?: number;
  levels?: number;
  paidLevels?: number;
  members?: number;
  team?: number;
};

function fakeDb(counts: Counts) {
  const queries: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          queries.push({ sql, binds });
          return {
            async first() {
              if (sql.includes("FROM pages") && sql.includes("LIKE")) {
                return { n: counts.samplePages ?? 0 };
              }
              if (sql.includes("FROM pages")) return { n: counts.pages ?? 0 };
              if (sql.includes("FROM membership_levels")) {
                return { n: counts.levels ?? 0, paid: counts.paidLevels ?? 0 };
              }
              if (sql.includes("FROM members")) return { n: counts.members ?? 0 };
              if (sql.includes("FROM tenant_users")) return { n: counts.team ?? 0 };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, queries };
}

function tenant(overrides: Partial<OnboardingTenant> = {}): OnboardingTenant {
  return {
    id: "t1",
    name: "Guild",
    slug: "guild",
    custom_domain: null,
    tenant_type: "guild",
    public_launched: 0,
    stripe_account_id: null,
    plan: "free",
    status: "active",
    settings_json: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    domain_status: "pending",
    domain_error: null,
    onboarding_json: null,
    ...overrides,
  };
}

const byKey = (s: Awaited<ReturnType<typeof computeOnboarding>>) =>
  Object.fromEntries(s.steps.map((st) => [st.key, st]));

describe("computeOnboarding", () => {
  it("fresh seeded guild: site seeded, sample copy pending, nothing else done, not ready", async () => {
    const { db, queries } = fakeDb({ pages: 5, samplePages: 5, team: 1 });
    const state = await computeOnboarding(db, tenant());
    const s = byKey(state);
    expect(s.site_seeded.done).toBe(true);
    expect(s.sample_content_replaced.done).toBe(false);
    expect(s.sample_content_replaced.hint).toContain("5 pages still have");
    expect(s.logo.done).toBe(false);
    expect(s.level.done).toBe(false);
    expect(s.payments.done).toBe(false);
    expect(s.first_member.done).toBe(false);
    expect(s.team_invited.done).toBe(false);
    expect(s.domain.done).toBe(false);
    expect(s.domain.hint).toContain("Setting up your free subdomain");
    expect(state.ready_for_members).toBe(false);
    expect(state.dismissed).toBe(false);
    expect(state.domain_status).toBe("pending");
    // Every tenant-scoped query is bound to this tenant.
    for (const q of queries) expect(q.binds[0]).toBe("t1");
    // Sample detection uses the marker in a LIKE, not a literal in SQL.
    const like = queries.find((q) => q.sql.includes("LIKE"))!;
    expect(like.binds[1]).toBe(`%${SAMPLE_MARKER}%`);
  });

  it("paid level without Stripe: level done, payments blocks readiness", async () => {
    const { db } = fakeDb({ pages: 5, samplePages: 0, levels: 2, paidLevels: 1, team: 1 });
    const state = await computeOnboarding(db, tenant());
    const s = byKey(state);
    expect(s.sample_content_replaced.done).toBe(true);
    expect(s.level.done).toBe(true);
    expect(s.payments.done).toBe(false);
    expect(s.payments.hint).toContain("paid level");
    expect(state.ready_for_members).toBe(false);
  });

  it("all-free levels: payments counts as done with an explanatory hint, and the guild is ready", async () => {
    const { db } = fakeDb({ pages: 5, levels: 1, paidLevels: 0, team: 1 });
    const state = await computeOnboarding(db, tenant());
    const s = byKey(state);
    expect(s.payments.done).toBe(true);
    expect(s.payments.hint).toContain("free");
    expect(state.ready_for_members).toBe(true);
  });

  it("Stripe connected with a paid level: ready", async () => {
    const { db } = fakeDb({ pages: 5, levels: 1, paidLevels: 1, team: 1 });
    const state = await computeOnboarding(db, tenant({ stripe_account_id: "acct_1" }));
    expect(byKey(state).payments.done).toBe(true);
    expect(state.ready_for_members).toBe(true);
  });

  it("no level at all: never ready even if Stripe is connected", async () => {
    const { db } = fakeDb({ pages: 5, levels: 0 });
    const state = await computeOnboarding(db, tenant({ stripe_account_id: "acct_1" }));
    expect(state.ready_for_members).toBe(false);
  });

  it("logo, members, team, and domain flip on real state", async () => {
    const { db } = fakeDb({ pages: 5, members: 12, team: 3 });
    const state = await computeOnboarding(
      db,
      tenant({
        settings_json: JSON.stringify({ profile: { logo_file_id: "f1" } }),
        domain_status: "active",
      })
    );
    const s = byKey(state);
    expect(s.logo.done).toBe(true);
    expect(s.first_member.done).toBe(true);
    expect(s.first_member.hint).toContain("12 members");
    expect(s.team_invited.done).toBe(true);
    expect(s.domain.done).toBe(true);
    expect(s.domain.hint).toContain("live");
  });

  it("business tenants: the logo the site builder stores under settings.assets counts, and copy never says guild", async () => {
    const { db } = fakeDb({ pages: 3, levels: 1, paidLevels: 0, team: 3 });
    const state = await computeOnboarding(
      db,
      tenant({
        tenant_type: "business",
        stripe_account_id: "acct_1",
        settings_json: JSON.stringify({ assets: { logo_file_id: "f-biz" } }),
      })
    );
    const s = byKey(state);
    expect(s.logo.done).toBe(true);
    for (const st of state.steps) {
      expect(`${st.label} ${st.hint}`.toLowerCase(), st.key).not.toContain("guild");
    }
  });

  it("hasLogo accepts either storage shape and tolerates junk", () => {
    expect(hasLogo(JSON.stringify({ profile: { logo_file_id: "f1" } }))).toBe(true);
    expect(hasLogo(JSON.stringify({ assets: { logo_file_id: "f2" } }))).toBe(true);
    expect(hasLogo(JSON.stringify({ profile: { logo_file_id: "" }, assets: {} }))).toBe(false);
    expect(hasLogo(JSON.stringify({ profile: null }))).toBe(false);
    expect(hasLogo("{}")).toBe(false);
    expect(hasLogo(null)).toBe(false);
    expect(hasLogo("{not json")).toBe(false);
  });

  it("custom domain counts as domain done regardless of subdomain status", async () => {
    const { db } = fakeDb({ pages: 1 });
    const state = await computeOnboarding(
      db,
      tenant({ custom_domain: "prairiestar.org", domain_status: "failed", domain_error: "boom" })
    );
    expect(byKey(state).domain.done).toBe(true);
    expect(state.domain_status).toBe("failed");
    expect(state.domain_error).toBe("boom");
  });

  it("failed subdomain surfaces the error and stays optional (does not block readiness)", async () => {
    const { db } = fakeDb({ pages: 1, levels: 1, paidLevels: 0 });
    const state = await computeOnboarding(
      db,
      tenant({ domain_status: "failed", domain_error: "DNS record already exists" })
    );
    const d = byKey(state).domain;
    expect(d.done).toBe(false);
    expect(d.optional).toBe(true);
    expect(d.hint).toContain("DNS record already exists");
    expect(state.ready_for_members).toBe(true);
  });

  it("no pages at all: site_seeded undone and sample step is not falsely done", async () => {
    const { db } = fakeDb({ pages: 0, samplePages: 0 });
    const s = byKey(await computeOnboarding(db, tenant()));
    expect(s.site_seeded.done).toBe(false);
    expect(s.sample_content_replaced.done).toBe(false);
  });

  it("reads the dismissed flag from onboarding_json and tolerates junk", async () => {
    const { db } = fakeDb({});
    const dismissed = await computeOnboarding(
      db,
      tenant({ onboarding_json: JSON.stringify({ dismissed_at: "2026-09-01T00:00:00.000Z" }) })
    );
    expect(dismissed.dismissed).toBe(true);
    expect(dismissed.dismissed_at).toBe("2026-09-01T00:00:00.000Z");
    const junk = await computeOnboarding(db, tenant({ onboarding_json: "{not json" }));
    expect(junk.dismissed).toBe(false);
    const unknownStatus = await computeOnboarding(db, tenant({ domain_status: "weird" }));
    expect(unknownStatus.domain_status).toBeNull();
  });

  it("every step links somewhere the admin can act", async () => {
    const { db } = fakeDb({});
    const state = await computeOnboarding(db, tenant());
    for (const st of state.steps) {
      expect(st.href).toMatch(/^#[a-z-]+$/);
      expect(st.label.length).toBeGreaterThan(0);
      expect(st.hint.length).toBeGreaterThan(0);
    }
  });
});
