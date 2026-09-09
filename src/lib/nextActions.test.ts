// src/lib/nextActions.test.ts
// nextActions() answers one question for a volunteer officer: "what should I
// do next?". It derives at most three cards from real rows, ranked so the
// things that stop money arriving come before the things that make the site
// look unfinished, which come before growth.
//
// Two layers are tested: buildNextActions() (pure, drives every ranking and
// copy branch off a signals object) and nextActions() (the one batched query
// set that produces those signals).
import { describe, it, expect } from "vitest";
import {
  buildNextActions,
  nextActions,
  MAX_NEXT_ACTIONS,
  type NextActionSignals,
  type NextActionsTenant,
} from "./nextActions";
import { SAMPLE_MARKER } from "./starterSite";
import { FREE_ACTIVE_MEMBER_LIMIT } from "./plans";

const NOW = new Date("2026-09-08T12:00:00.000Z");

function tenant(overrides: Partial<NextActionsTenant> = {}): NextActionsTenant {
  return {
    id: "t1",
    name: "Prairie Star Quilters",
    slug: "prairie-star",
    custom_domain: null,
    tenant_type: "guild",
    public_launched: 0,
    stripe_account_id: null,
    plan: "free",
    status: "active",
    settings_json: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    domain_status: "active",
    domain_error: null,
    onboarding_json: null,
    ...overrides,
  };
}

/** A guild with nothing wrong: the baseline every test perturbs one field of. */
function healthy(overrides: Partial<NextActionSignals> = {}): NextActionSignals {
  return {
    samplePages: 0,
    levelCount: 2,
    paidLevelCount: 1,
    eventsNext60: 3,
    activeMembers: 18,
    membersWithoutConsent: 0,
    renewalsDue30: 0,
    soonestRenewalEnd: "2027-06-01T00:00:00.000Z",
    failedBlast: null,
    now: NOW,
    ...overrides,
  };
}

const ids = (cards: { id: string }[]) => cards.map((c) => c.id);

describe("buildNextActions — which card fires", () => {
  it("no membership level: the top card is 'add a level'", () => {
    const cards = buildNextActions(healthy({ levelCount: 0, paidLevelCount: 0 }), tenant());
    expect(cards[0].id).toBe("add_level");
    expect(cards[0].severity).toBe("do");
    expect(cards[0].cta.href).toBe("#levels");
  });

  it("a paid level with no payouts connected blocks money and says so", () => {
    const cards = buildNextActions(healthy(), tenant({ stripe_account_id: null }));
    const card = cards.find((c) => c.id === "connect_payouts")!;
    expect(card).toBeTruthy();
    expect(card.severity).toBe("do");
    expect(card.cta.href).toBe("#settings");
    expect(card.body.toLowerCase()).toContain("guild");
  });

  it("payouts connected: the card disappears", () => {
    const cards = buildNextActions(healthy(), tenant({ stripe_account_id: "acct_1" }));
    expect(ids(cards)).not.toContain("connect_payouts");
  });

  it("all-free levels never ask for payouts", () => {
    const cards = buildNextActions(healthy({ paidLevelCount: 0 }), tenant());
    expect(ids(cards)).not.toContain("connect_payouts");
  });

  it("a blast that finished with failures offers to send just the ones that failed", () => {
    const cards = buildNextActions(
      healthy({ failedBlast: { id: "b1", subject: "October newsletter", errorCount: 4 } }),
      tenant({ stripe_account_id: "acct_1" })
    );
    const card = cards.find((c) => c.id === "email_failures")!;
    expect(card.severity).toBe("do");
    expect(card.title).toContain("4");
    expect(card.body).toContain("October newsletter");
    expect(card.cta.href).toBe("#comms");
  });

  it("sample copy left on the site names the page count and links to the editor", () => {
    const cards = buildNextActions(
      healthy({ samplePages: 3 }),
      tenant({ stripe_account_id: "acct_1" })
    );
    const card = cards.find((c) => c.id === "sample_copy")!;
    expect(card.title).toContain("3");
    expect(card.cta.href).toBe("#pages");
    expect(card.severity).toBe("do");
  });

  it("nothing on the calendar for 60 days is a suggestion, not an order", () => {
    const cards = buildNextActions(
      healthy({ eventsNext60: 0 }),
      tenant({ stripe_account_id: "acct_1" })
    );
    const card = cards.find((c) => c.id === "add_event")!;
    expect(card.severity).toBe("consider");
    expect(card.cta.href).toBe("#events");
    expect(card.body).toContain("skip this for now");
  });

  it("members who cannot be emailed are surfaced with the count", () => {
    const cards = buildNextActions(
      healthy({ membersWithoutConsent: 5 }),
      tenant({ stripe_account_id: "acct_1" })
    );
    const card = cards.find((c) => c.id === "email_consent")!;
    expect(card.title).toContain("5");
    expect(card.severity).toBe("consider");
    expect(card.cta.href).toBe("#members");
  });

  it("renewal reminders already sending: the card says so and offers a preview", () => {
    const cards = buildNextActions(
      healthy({ renewalsDue30: 7, soonestRenewalEnd: "2026-09-20T00:00:00.000Z" }),
      tenant({ stripe_account_id: "acct_1" })
    );
    const card = cards.find((c) => c.id === "renewal_reminders")!;
    expect(card.title.toLowerCase()).toContain("going out");
    expect(card.body).toContain("7");
    expect(card.cta.label.toLowerCase()).toContain("preview");
  });

  it("renewal reminders starting soon count the days until the first one", () => {
    // First membership ends 2026-10-20; reminders begin 30 days before, on
    // 2026-09-20 — twelve days after NOW.
    const cards = buildNextActions(
      healthy({ renewalsDue30: 0, soonestRenewalEnd: "2026-10-20T12:00:00.000Z" }),
      tenant({ stripe_account_id: "acct_1" })
    );
    const card = cards.find((c) => c.id === "renewal_reminders")!;
    expect(card.title).toContain("12 days");
    expect(card.body).toContain("October 20");
  });

  it("a renewal far in the future does not nag", () => {
    const cards = buildNextActions(
      healthy({ soonestRenewalEnd: "2027-06-01T00:00:00.000Z" }),
      tenant({ stripe_account_id: "acct_1" })
    );
    expect(ids(cards)).not.toContain("renewal_reminders");
  });

  it("no memberships at all: no renewal card", () => {
    const cards = buildNextActions(
      healthy({ soonestRenewalEnd: null }),
      tenant({ stripe_account_id: "acct_1" })
    );
    expect(ids(cards)).not.toContain("renewal_reminders");
  });

  it("at the free member limit: a blocker card that never threatens existing records", () => {
    const cards = buildNextActions(
      healthy({ activeMembers: FREE_ACTIVE_MEMBER_LIMIT }),
      tenant({ stripe_account_id: "acct_1" })
    );
    const card = cards.find((c) => c.id === "member_cap")!;
    expect(card.severity).toBe("do");
    expect(card.body).toContain("safe");
    expect(card.cta.href).toBe("#settings");
  });

  it("approaching the free member limit: a gentler card", () => {
    const cards = buildNextActions(
      healthy({ activeMembers: FREE_ACTIVE_MEMBER_LIMIT - 2 }),
      tenant({ stripe_account_id: "acct_1" })
    );
    const card = cards.find((c) => c.id === "member_cap")!;
    expect(card.severity).toBe("consider");
    expect(card.title).toContain("2");
  });

  it("a paid plan has no member cap card", () => {
    const cards = buildNextActions(
      healthy({ activeMembers: 400 }),
      tenant({ plan: "starter", stripe_account_id: "acct_1" })
    );
    expect(ids(cards)).not.toContain("member_cap");
  });

  it("nothing to do: exactly one celebratory card naming what is healthy", () => {
    const cards = buildNextActions(healthy(), tenant({ stripe_account_id: "acct_1" }));
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("all_clear");
    expect(cards[0].severity).toBe("celebrate");
    expect(cards[0].body).toContain("18");
    expect(cards[0].body).toContain("3");
    expect(cards[0].cta.href).toBeTruthy();
  });
});

describe("buildNextActions — ranking and shape", () => {
  it("money blockers outrank an unfinished site, which outranks growth", () => {
    const cards = buildNextActions(
      healthy({
        levelCount: 0,
        paidLevelCount: 0,
        samplePages: 4,
        eventsNext60: 0,
        membersWithoutConsent: 9,
      }),
      tenant()
    );
    expect(ids(cards)).toEqual(["add_level", "sample_copy", "add_event"]);
  });

  it("delivery failures rank with the money blockers, above the site copy", () => {
    const cards = buildNextActions(
      healthy({
        paidLevelCount: 1,
        samplePages: 4,
        failedBlast: { id: "b1", subject: "Newsletter", errorCount: 2 },
      }),
      tenant({ stripe_account_id: null })
    );
    expect(ids(cards)).toEqual(["connect_payouts", "email_failures", "sample_copy"]);
  });

  it("never returns more than three cards, and never mixes in the celebration", () => {
    const cards = buildNextActions(
      healthy({
        levelCount: 0,
        paidLevelCount: 0,
        samplePages: 4,
        eventsNext60: 0,
        membersWithoutConsent: 9,
        renewalsDue30: 3,
        activeMembers: FREE_ACTIVE_MEMBER_LIMIT,
        failedBlast: { id: "b1", subject: "Newsletter", errorCount: 2 },
      }),
      tenant()
    );
    expect(cards.length).toBeLessThanOrEqual(MAX_NEXT_ACTIONS);
    expect(ids(cards)).not.toContain("all_clear");
  });

  it("every card is complete and speaks volunteer, not software", () => {
    const perturbations: Partial<NextActionSignals>[] = [
      {},
      { levelCount: 0, paidLevelCount: 0 },
      { samplePages: 2 },
      { eventsNext60: 0 },
      { membersWithoutConsent: 3 },
      { renewalsDue30: 4, soonestRenewalEnd: "2026-09-15T00:00:00.000Z" },
      { failedBlast: { id: "b1", subject: "News", errorCount: 1 } },
      { activeMembers: FREE_ACTIVE_MEMBER_LIMIT },
    ];
    const jargon = /\btenant\b|\bblocks?_json\b|\bJSON\b|\bbps\b|\bcents\b|\bAPI\b|\bstripe_account\b/i;
    for (const p of perturbations) {
      for (const t of [tenant(), tenant({ stripe_account_id: "acct_1" })]) {
        for (const card of buildNextActions(healthy(p), t)) {
          expect(card.id, JSON.stringify(p)).toMatch(/^[a-z_]+$/);
          expect(card.title.length, card.id).toBeGreaterThan(0);
          expect(card.body.length, card.id).toBeGreaterThan(0);
          expect(card.cta.label.length, card.id).toBeGreaterThan(0);
          expect(card.cta.href, card.id).toMatch(/^#[a-z-]+$/);
          expect(["do", "consider", "celebrate"]).toContain(card.severity);
          expect(`${card.title} ${card.body} ${card.cta.label}`, card.id).not.toMatch(jargon);
        }
      }
    }
  });
});

describe("buildNextActions — business tenants", () => {
  it("never asks a business for a membership level or waves the member cap", () => {
    const biz = tenant({ tenant_type: "business", stripe_account_id: "acct_1" });
    const cards = buildNextActions(
      healthy({ levelCount: 0, paidLevelCount: 0, activeMembers: 500, samplePages: 2 }),
      biz
    );
    expect(ids(cards)).not.toContain("add_level");
    expect(ids(cards)).not.toContain("member_cap");
    expect(ids(cards)).toContain("sample_copy");
  });

  it("sends a business to its own website screen and never calls it a guild", () => {
    const biz = tenant({ tenant_type: "business" });
    const cards = buildNextActions(healthy({ samplePages: 2 }), biz);
    const card = cards.find((c) => c.id === "sample_copy")!;
    expect(card.cta.href).toBe("#site-pages");
    for (const c of cards) {
      expect(`${c.title} ${c.body}`.toLowerCase(), c.id).not.toContain("guild");
    }
  });
});

// ---------------------------------------------------------------------------
// nextActions(): the batched query set that feeds buildNextActions.
// ---------------------------------------------------------------------------

type FakeRows = {
  samplePages?: number;
  levels?: number;
  paidLevels?: number;
  events?: number;
  members?: number;
  noConsent?: number;
  renewalsDue30?: number;
  soonestEnd?: string | null;
  blast?: { id: string; subject: string; error_count: number } | null;
};

function fakeDb(rows: FakeRows) {
  const queries: { sql: string; binds: unknown[] }[] = [];
  const answer = (sql: string) => {
    if (sql.includes("FROM pages")) return { n: rows.samplePages ?? 0 };
    if (sql.includes("FROM membership_levels")) {
      return { n: rows.levels ?? 0, paid: rows.paidLevels ?? 0 };
    }
    if (sql.includes("FROM events")) return { n: rows.events ?? 0 };
    if (sql.includes("FROM members")) {
      return { n: rows.members ?? 0, no_consent: rows.noConsent ?? 0 };
    }
    if (sql.includes("FROM memberships")) {
      return { due30: rows.renewalsDue30 ?? 0, soonest: rows.soonestEnd ?? null };
    }
    if (sql.includes("FROM blasts")) return rows.blast ?? null;
    return null;
  };
  const stmt = (sql: string, binds: unknown[]) => ({
    sql,
    binds,
    async first() {
      return answer(sql);
    },
  });
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          queries.push({ sql, binds });
          return stmt(sql, binds);
        },
      };
    },
    async batch(stmts: { sql: string }[]) {
      return stmts.map((s) => ({ success: true, results: [answer(s.sql)] }));
    },
  };
  return { db: db as unknown as D1Database, queries };
}

describe("nextActions — the batched query set", () => {
  it("scopes every query to the guild and looks for the sample marker with a LIKE", async () => {
    const { db, queries } = fakeDb({ samplePages: 2, levels: 1, paidLevels: 1 });
    await nextActions(db, tenant(), NOW);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q.binds, q.sql).toContain("t1");
    const like = queries.find((q) => q.sql.includes("LIKE"))!;
    expect(like.binds).toContain(`%${SAMPLE_MARKER}%`);
  });

  it("reads real rows into real cards", async () => {
    const { db } = fakeDb({
      samplePages: 4,
      levels: 1,
      paidLevels: 1,
      events: 0,
      members: 22,
      noConsent: 3,
      blast: { id: "b9", subject: "Fall news", error_count: 2 },
    });
    const cards = await nextActions(db, tenant(), NOW);
    expect(ids(cards)).toEqual(["connect_payouts", "email_failures", "sample_copy"]);
  });

  it("a healthy guild gets the celebration", async () => {
    const { db } = fakeDb({
      samplePages: 0,
      levels: 2,
      paidLevels: 1,
      events: 2,
      members: 12,
      noConsent: 0,
    });
    const cards = await nextActions(db, tenant({ stripe_account_id: "acct_1" }), NOW);
    expect(ids(cards)).toEqual(["all_clear"]);
  });

  it("works without batch() (sequential fallback) and survives missing rows", async () => {
    const { db } = fakeDb({});
    delete (db as unknown as { batch?: unknown }).batch;
    const cards = await nextActions(db, tenant(), NOW);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(MAX_NEXT_ACTIONS);
  });

  it("strips control characters out of an officer-written email subject", async () => {
    const { db } = fakeDb({
      levels: 1,
      paidLevels: 0,
      events: 1,
      blast: { id: "b1", subject: "News\u0007letter\u0000", error_count: 1 },
    });
    const cards = await nextActions(db, tenant({ stripe_account_id: "acct_1" }), NOW);
    const card = cards.find((c) => c.id === "email_failures")!;
    expect(card.body).toContain("Newsletter");
    expect(card.body).not.toMatch(/[\u0000-\u001f]/);
  });
});
