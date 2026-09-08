// src/routes/stats.test.ts
// POST /payments/:id/refund used to flip payments.status only, leaving the
// membership active (member keeps benefits for free) or the event seat
// taken. The refund now reverses what was bought: dues -> membership
// cancelled (+ member lapsed when nothing else is active), event -> the
// registration is cancelled so the seat is released. Keyword-routed fake
// D1; Stripe is mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env, Tenant, TenantVariables } from "../types";

const stripe = vi.hoisted(() => ({
  stripeRequest: vi.fn(async (_env: unknown, _m: string, _p: string, _b?: unknown) => ({ id: "re_1" })),
}));
vi.mock("../lib/stripe", () => stripe);

import { paymentRoutes } from "./stats";

const TENANT_ID = "tenant-1";
type Row = Record<string, any>;

function fakeDb(state: {
  payment: Row;
  memberships?: Row[];
  members?: Row[];
  registrations?: Row[];
}) {
  const memberships = state.memberships ?? [];
  const members = state.members ?? [];
  const registrations = state.registrations ?? [];
  const runs: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM payments")) {
                return binds[0] === state.payment.id && binds[1] === TENANT_ID ? state.payment : null;
              }
              if (sql.includes("FROM memberships WHERE id = ?")) {
                return memberships.find((m) => m.id === binds[0] && m.tenant_id === binds[1]) ?? null;
              }
              if (sql.includes("FROM memberships") && sql.includes("level_id = ?")) {
                return (
                  memberships.find(
                    (m) =>
                      m.tenant_id === binds[0] &&
                      m.member_id === binds[1] &&
                      m.level_id === binds[2] &&
                      m.status === "active"
                  ) ?? null
                );
              }
              if (sql.includes("FROM memberships") && sql.includes("id <> ?")) {
                return (
                  memberships.find(
                    (m) =>
                      m.tenant_id === binds[0] &&
                      m.member_id === binds[1] &&
                      m.status === "active" &&
                      m.id !== binds[2]
                  ) ?? null
                );
              }
              return null;
            },
            async run() {
              runs.push({ sql, binds });
              let changes = 0;
              if (sql.includes("UPDATE payments SET status = 'refunded'")) {
                state.payment.status = "refunded";
                changes = 1;
              } else if (sql.includes("UPDATE memberships SET status = 'cancelled'")) {
                const m = memberships.find((x) => x.id === binds[1] && x.tenant_id === binds[2]);
                if (m && m.status !== "cancelled") {
                  m.status = "cancelled";
                  changes = 1;
                }
              } else if (sql.includes("UPDATE members SET status = 'lapsed'")) {
                const m = members.find((x) => x.id === binds[1] && x.tenant_id === binds[2]);
                if (m && m.status === "active") {
                  m.status = "lapsed";
                  changes = 1;
                }
              } else if (sql.includes("UPDATE event_registrations SET status = 'cancelled'")) {
                const r = registrations.find((x) => x.id === binds[1] && x.tenant_id === binds[2]);
                if (r && r.status !== "cancelled") {
                  r.status = "cancelled";
                  changes = 1;
                }
              }
              return { success: true, meta: { changes } };
            },
          };
        },
      };
    },
  };
  return { db, runs };
}

function app(db: unknown) {
  const a = new Hono<{ Bindings: Env; Variables: TenantVariables }>();
  a.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, name: "Guild" } as Tenant);
    await next();
  });
  a.route("/", paymentRoutes);
  const env = { DB: db, STRIPE_SECRET_KEY: "sk_test" } as unknown as Env;
  return (path: string) => a.request(path, { method: "POST" }, env);
}

const stripeDues = (over: Row = {}): Row => ({
  id: "pay-1",
  status: "succeeded",
  stripe_payment_intent_id: "pi_1",
  amount_cents: 3500,
  type: "dues",
  member_id: "mem-1",
  related_id: "lvl-1",
  ...over,
});

beforeEach(() => {
  stripe.stripeRequest.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /payments/:id/refund reverses the purchase", () => {
  it("Stripe dues (related_id = level id): cancels the active membership for that level and lapses the member", async () => {
    const memberships = [
      { id: "ms-1", tenant_id: TENANT_ID, member_id: "mem-1", level_id: "lvl-1", status: "active" },
    ];
    const members = [{ id: "mem-1", tenant_id: TENANT_ID, status: "active" }];
    const { db } = fakeDb({ payment: stripeDues(), memberships, members });
    const res = await app(db)("/pay-1/refund");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      refunded_cents: 3500,
      reversed: { membership_id: "ms-1", member_lapsed: true },
    });
    expect(stripe.stripeRequest).toHaveBeenCalledWith(expect.anything(), "POST", "/refunds", {
      payment_intent: "pi_1",
    });
    expect(memberships[0].status).toBe("cancelled");
    expect(members[0].status).toBe("lapsed");
  });

  it("offline-style dues (related_id = membership id) resolve directly; member stays active when another membership is active", async () => {
    const memberships = [
      { id: "ms-1", tenant_id: TENANT_ID, member_id: "mem-1", level_id: "lvl-1", status: "active" },
      { id: "ms-2", tenant_id: TENANT_ID, member_id: "mem-1", level_id: "lvl-2", status: "active" },
    ];
    const members = [{ id: "mem-1", tenant_id: TENANT_ID, status: "active" }];
    const { db } = fakeDb({ payment: stripeDues({ related_id: "ms-1" }), memberships, members });
    const res = await app(db)("/pay-1/refund");
    expect(((await res.json()) as Row).reversed).toEqual({ membership_id: "ms-1" });
    expect(memberships[0].status).toBe("cancelled");
    expect(memberships[1].status).toBe("active");
    expect(members[0].status).toBe("active");
  });

  it("event fee: cancels the registration (seat released)", async () => {
    const registrations = [{ id: "reg-1", tenant_id: TENANT_ID, status: "registered" }];
    const { db } = fakeDb({
      payment: stripeDues({ type: "event", member_id: null, related_id: "reg-1" }),
      registrations,
    });
    const res = await app(db)("/pay-1/refund");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).reversed).toEqual({ registration_id: "reg-1" });
    expect(registrations[0].status).toBe("cancelled");
  });

  it("unresolvable related_id: payment is still refunded, nothing else is touched, and it is logged", async () => {
    const { db, runs } = fakeDb({ payment: stripeDues({ related_id: "lvl-gone" }), memberships: [] });
    const res = await app(db)("/pay-1/refund");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).reversed).toEqual({});
    expect(runs.map((r) => r.sql.slice(0, 40))).toEqual(["UPDATE payments SET status = 'refunded',"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not reverse anything when Stripe rejects the refund", async () => {
    stripe.stripeRequest.mockRejectedValueOnce(new Error("card_declined"));
    const memberships = [
      { id: "ms-1", tenant_id: TENANT_ID, member_id: "mem-1", level_id: "lvl-1", status: "active" },
    ];
    const { db, runs } = fakeDb({ payment: stripeDues(), memberships });
    const res = await app(db)("/pay-1/refund");
    expect(res.status).toBe(502);
    expect(runs.length).toBe(0);
    expect(memberships[0].status).toBe("active");
  });

  it("refuses a non-succeeded payment and a payment with no Stripe intent", async () => {
    let r = await app(fakeDb({ payment: stripeDues({ status: "refunded" }) }).db)("/pay-1/refund");
    expect(r.status).toBe(400);
    r = await app(fakeDb({ payment: stripeDues({ stripe_payment_intent_id: null }) }).db)("/pay-1/refund");
    expect(r.status).toBe(400);
    expect(stripe.stripeRequest).not.toHaveBeenCalled();
  });
});
