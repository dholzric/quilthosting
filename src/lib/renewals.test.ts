// src/lib/renewals.test.ts
// The daily renewal job's reminder series. Members whose level auto-renews
// AND who have a Stripe subscription attached are charged by Stripe, so they
// must not get the manual 30/14/7/1-day "Renew Now" emails; they get one
// "renews automatically on <date>" heads-up at 7 days instead. Everyone
// else keeps the full series. Pure-unit with a keyword-routed fake D1 and
// a stubbed provider call.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../types";

const email = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_env: unknown, _params: unknown) => ({ id: "msg", success: true })),
}));
vi.mock("./email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email")>()),
  sendEmail: email.sendEmail,
}));

import { runRenewalJob, isAutoRenewing } from "./renewals";

type Row = Record<string, unknown>;

function endDateIn(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) + "T00:00:00.000Z";
}

function membership(over: Row): Row {
  return {
    id: "ms",
    tenant_id: "t1",
    member_id: "mem",
    level_id: "lvl",
    status: "active",
    auto_renew: 0,
    amount_paid_cents: 3500,
    stripe_subscription_id: null,
    email: "member@example.test",
    first_name: "Jo",
    level_name: "Individual",
    price_cents: 3500,
    duration_months: 12,
    renewal_type: "manual",
    tenant_name: "Prairie Star",
    tenant_slug: "prairiestar",
    ...over,
  };
}

function fakeDb(memberships: Row[]) {
  const logs: { template: string; member_id: string; status: string }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM email_logs")) {
                const [, memberId, template] = binds as string[];
                return logs.find((l) => l.member_id === memberId && l.template === template) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM memberships m") && sql.includes("date(m.end_date) = date(?)")) {
                const target = binds[0] as string;
                return {
                  results: memberships.filter(
                    (m) => String(m.end_date).slice(0, 10) === target.slice(0, 10)
                  ),
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO email_logs")) {
                const [, , memberId, , template, , status] = binds as string[];
                logs.push({ template, member_id: memberId, status });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, logs };
}

function env(db: D1Database): Env {
  return { DB: db, APP_URL: "https://quilthosting.com/" } as unknown as Env;
}

beforeEach(() => {
  email.sendEmail.mockClear();
});

describe("isAutoRenewing", () => {
  it("needs BOTH an auto level and an attached Stripe subscription", () => {
    expect(isAutoRenewing({ renewal_type: "auto", stripe_subscription_id: "sub_1" })).toBe(true);
    expect(isAutoRenewing({ renewal_type: "auto", stripe_subscription_id: null })).toBe(false);
    expect(isAutoRenewing({ renewal_type: "auto", stripe_subscription_id: "  " })).toBe(false);
    expect(isAutoRenewing({ renewal_type: "manual", stripe_subscription_id: "sub_1" })).toBe(false);
    expect(isAutoRenewing({ renewal_type: undefined, stripe_subscription_id: "sub_1" })).toBe(false);
  });
});

describe("runRenewalJob reminders", () => {
  it("manual members get the Renew Now series at 30/14/7/1 days", async () => {
    const rows = [30, 14, 7, 1].map((d) =>
      membership({ id: `ms-${d}`, member_id: `mem-${d}`, end_date: endDateIn(d) })
    );
    const { db, logs } = fakeDb(rows);
    const result = await runRenewalJob(env(db));
    expect(result.reminders_sent).toBe(4);
    expect(logs.map((l) => l.template).sort()).toEqual(
      ["renewal_14d", "renewal_1d", "renewal_30d", "renewal_7d"].sort()
    );
    for (const call of email.sendEmail.mock.calls) {
      const params = call[1] as Row;
      expect(params.subject).toMatch(/renews in \d+ days/);
      expect(params.html).toContain("Renew Now");
      expect(params.html).toContain("/portal?slug=prairiestar&renew=1");
    }
  });

  it("auto-renew members with a subscription get ONLY the 7-day automatic-renewal notice", async () => {
    const rows = [30, 14, 7, 1].map((d) =>
      membership({
        id: `ms-${d}`,
        member_id: `mem-${d}`,
        end_date: endDateIn(d),
        renewal_type: "auto",
        auto_renew: 1,
        stripe_subscription_id: "sub_123",
      })
    );
    const { db, logs } = fakeDb(rows);
    const result = await runRenewalJob(env(db));
    expect(result.reminders_sent).toBe(1);
    expect(logs).toEqual([{ template: "autorenew_7d", member_id: "mem-7", status: "sent" }]);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    const params = email.sendEmail.mock.calls[0][1] as Row;
    expect(params.to).toBe("member@example.test");
    expect(params.subject).toMatch(/renews automatically on/);
    expect(params.html).not.toContain("Renew Now");
    expect(params.html).toContain("$35.00");
    expect((params.tags as { name: string; value: string }[])[0].value).toBe("autorenew_7d");
    // The renewal date in the notice is the membership end date.
    const expected = new Date(endDateIn(7)).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    expect(params.subject).toContain(expected);
  });

  it("an auto level WITHOUT a Stripe subscription (paid by check / admin-activated) still gets the manual series", async () => {
    const { db, logs } = fakeDb([
      membership({ end_date: endDateIn(30), renewal_type: "auto", auto_renew: 1, stripe_subscription_id: null }),
    ]);
    await runRenewalJob(env(db));
    expect(logs.map((l) => l.template)).toEqual(["renewal_30d"]);
  });

  it("the auto-renew notice is sent once per day per member (email_logs dedup)", async () => {
    const { db, logs } = fakeDb([
      membership({ end_date: endDateIn(7), renewal_type: "auto", stripe_subscription_id: "sub_1" }),
    ]);
    await runRenewalJob(env(db));
    await runRenewalJob(env(db));
    expect(logs.length).toBe(1);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
  });
});
