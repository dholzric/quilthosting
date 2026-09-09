// src/lib/automations/triggers.test.ts
//
// enqueueTrigger's contract: idempotent per (sequence, subject) enforced by the
// unique index (never a pre-read), silent on every failure, and honouring the
// per-sequence conditions and trigger config. Runs against real SQLite with the
// real 0029 migration — see testDb.ts for why.
import { describe, it, expect, vi } from "vitest";
import type { Env } from "../../types";
import {
  TRIGGERS,
  TRIGGER_SUBJECT,
  TRIGGER_LABELS,
  isTrigger,
  parseConditions,
  parseTriggerConfig,
  conditionsMatch,
  enqueueTrigger,
} from "./triggers";
import { createTestDb, seedTenant, seedSequence, type TestDb } from "./testDb";

function envFor(db: TestDb): Env {
  return { DB: db, APP_URL: "https://quilthosting.com" } as unknown as Env;
}

type RunRow = {
  id: string;
  sequence_id: string;
  subject_type: string;
  subject_id: string;
  step: number;
  status: string;
  scheduled_at: string;
  attempts: number;
};

const runs = (db: TestDb) =>
  db.rows<RunRow>(`SELECT * FROM automation_runs ORDER BY created_at, id`);

describe("trigger catalog", () => {
  it("names exactly the six triggers the plan specifies", () => {
    expect([...TRIGGERS]).toEqual([
      "member_activated",
      "membership_lapsed",
      "event_registered",
      "event_ended",
      "form_submitted",
      "payment_received",
    ]);
  });

  it("gives every trigger a subject type and a plain-language label", () => {
    for (const t of TRIGGERS) {
      expect(TRIGGER_SUBJECT[t]).toBeTruthy();
      expect(TRIGGER_LABELS[t]).toMatch(/[a-z]/);
    }
  });

  it("isTrigger rejects junk", () => {
    expect(isTrigger("member_activated")).toBe(true);
    expect(isTrigger("member_deleted")).toBe(false);
    expect(isTrigger(null)).toBe(false);
    expect(isTrigger(42)).toBe(false);
  });
});

describe("conditions and trigger config", () => {
  it("parses the narrowing fields and drops junk", () => {
    expect(
      parseConditions(
        JSON.stringify({
          level_ids: ["a", "", 7],
          event_ids: [],
          min_amount_cents: 2500.7,
          nope: true,
        })
      )
    ).toEqual({ level_ids: ["a"], min_amount_cents: 2500 });
    expect(parseConditions(null)).toEqual({});
    expect(parseConditions("not json")).toEqual({});
    expect(parseConditions("[1,2]")).toEqual({});
  });

  it("parses trigger config with clamping", () => {
    expect(
      parseTriggerConfig(
        JSON.stringify({ delay_days: 900.9, active_from: "2026-01-01", recipe: "welcome_series" })
      )
    ).toEqual({ delay_days: 365, active_from: "2026-01-01", recipe: "welcome_series" });
    expect(parseTriggerConfig("{}")).toEqual({});
    expect(parseTriggerConfig(undefined)).toEqual({});
  });

  it("an empty condition set matches everything", () => {
    expect(conditionsMatch({}, { id: "x" })).toBe(true);
  });

  it("matches on level, event, form and minimum amount", () => {
    expect(conditionsMatch({ level_ids: ["l1"] }, { id: "x", levelId: "l1" })).toBe(true);
    expect(conditionsMatch({ level_ids: ["l1"] }, { id: "x", levelId: "l2" })).toBe(false);
    expect(conditionsMatch({ level_ids: ["l1"] }, { id: "x" })).toBe(false);
    expect(conditionsMatch({ event_ids: ["e1"] }, { id: "x", eventId: "e1" })).toBe(true);
    expect(conditionsMatch({ form_ids: ["f1"] }, { id: "x", formId: "f2" })).toBe(false);
    expect(conditionsMatch({ min_amount_cents: 5000 }, { id: "x", amountCents: 5000 })).toBe(true);
    expect(conditionsMatch({ min_amount_cents: 5000 }, { id: "x", amountCents: 4999 })).toBe(false);
    expect(conditionsMatch({ min_amount_cents: 5000 }, { id: "x" })).toBe(false);
  });
});

describe("enqueueTrigger", () => {
  it("creates one pending run per matching active sequence", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db, { id: "seq-a" });
    seedSequence(db, { id: "seq-b", name: "Second" });
    seedSequence(db, { id: "seq-paused", active: false });
    seedSequence(db, { id: "seq-other", trigger: "membership_lapsed" });
    seedSequence(db, { id: "seq-elsewhere", tenantId: "tenant-2" });

    const res = await enqueueTrigger(envFor(db), "tenant-1", "member_activated", {
      id: "member-1",
    });

    expect(res).toEqual({ enqueued: 2, skipped: 0 });
    const rows = runs(db);
    expect(rows.map((r) => r.sequence_id).sort()).toEqual(["seq-a", "seq-b"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.subject_type === "member")).toBe(true);
    expect(rows.every((r) => r.step === 0 && r.attempts === 0)).toBe(true);
  });

  it("is idempotent per (sequence, subject) — a second call adds nothing", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db);

    const a = await enqueueTrigger(envFor(db), "tenant-1", "member_activated", {
      id: "member-1",
    });
    const b = await enqueueTrigger(envFor(db), "tenant-1", "member_activated", {
      id: "member-1",
    });

    expect(a.enqueued).toBe(1);
    expect(b.enqueued).toBe(0);
    expect(b.skipped).toBe(1);
    expect(runs(db)).toHaveLength(1);
  });

  it("enforces idempotency with the index, not a pre-read", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db);
    await enqueueTrigger(envFor(db), "tenant-1", "member_activated", { id: "member-1" });
    db.queries.length = 0;
    await enqueueTrigger(envFor(db), "tenant-1", "member_activated", { id: "member-1" });
    // The only read is the sequence list; nothing SELECTs automation_runs.
    expect(db.queries.some((q) => /SELECT[\s\S]*automation_runs/i.test(q))).toBe(false);
    expect(db.queries.some((q) => /INSERT OR IGNORE INTO automation_runs/i.test(q))).toBe(true);
  });

  it("keeps different subjects and different sequences apart", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db, { id: "seq-a" });
    seedSequence(db, { id: "seq-b" });
    await enqueueTrigger(envFor(db), "tenant-1", "member_activated", { id: "member-1" });
    await enqueueTrigger(envFor(db), "tenant-1", "member_activated", { id: "member-2" });
    expect(runs(db)).toHaveLength(4);
  });

  it("schedules step 0 by its waitDays plus the config delay", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db, {
      id: "seq-wait",
      steps: [{ waitDays: 3, subject: "Later", bodyHtml: "<p>x</p>" }],
      triggerConfig: { delay_days: 2 },
    });
    const before = Date.now();
    await enqueueTrigger(envFor(db), "tenant-1", "member_activated", { id: "member-1" });
    const row = runs(db)[0];
    const delta = Date.parse(row.scheduled_at) - before;
    expect(delta).toBeGreaterThan(4.9 * 86400000);
    expect(delta).toBeLessThan(5.1 * 86400000);
  });

  it("skips sequences whose conditions do not match", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db, {
      id: "seq-paid",
      trigger: "payment_received",
      conditions: { min_amount_cents: 5000 },
    });
    const small = await enqueueTrigger(envFor(db), "tenant-1", "payment_received", {
      id: "pay-1",
      amountCents: 1000,
    });
    expect(small).toEqual({ enqueued: 0, skipped: 1 });
    const big = await enqueueTrigger(envFor(db), "tenant-1", "payment_received", {
      id: "pay-2",
      amountCents: 9000,
    });
    expect(big.enqueued).toBe(1);
  });

  it("skips subjects older than active_from (a fresh recipe never back-fills)", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db, { triggerConfig: { active_from: "2026-06-01T00:00:00.000Z" } });
    const old = await enqueueTrigger(envFor(db), "tenant-1", "member_activated", {
      id: "member-old",
      occurredAt: "2025-01-01T00:00:00.000Z",
    });
    expect(old).toEqual({ enqueued: 0, skipped: 1 });
    const fresh = await enqueueTrigger(envFor(db), "tenant-1", "member_activated", {
      id: "member-new",
      occurredAt: "2026-07-01T00:00:00.000Z",
    });
    expect(fresh.enqueued).toBe(1);
  });

  it("skips a sequence with no usable steps", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db, { steps: [{ waitDays: 0, subject: "", bodyHtml: "" }] });
    expect(await enqueueTrigger(envFor(db), "tenant-1", "member_activated", { id: "m" })).toEqual({
      enqueued: 0,
      skipped: 1,
    });
    expect(runs(db)).toHaveLength(0);
  });

  it("does nothing (and touches nothing) when no sequence uses the trigger", async () => {
    const db = createTestDb();
    seedTenant(db);
    const res = await enqueueTrigger(envFor(db), "tenant-1", "form_submitted", { id: "resp-1" });
    expect(res).toEqual({ enqueued: 0, skipped: 0 });
    expect(runs(db)).toHaveLength(0);
  });

  it("rejects a bad trigger or a subject with no id without hitting the database", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedSequence(db);
    expect(
      await enqueueTrigger(envFor(db), "tenant-1", "nope" as never, { id: "m" })
    ).toEqual({ enqueued: 0, skipped: 0 });
    expect(
      await enqueueTrigger(envFor(db), "tenant-1", "member_activated", { id: "" })
    ).toEqual({ enqueued: 0, skipped: 0 });
    expect(db.queries).toHaveLength(0);
  });

  it("never throws when the database is broken — the caller's payment still lands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      prepare() {
        throw new Error("no such table: automation_runs");
      },
    };
    const res = await enqueueTrigger(
      { DB: broken } as unknown as Env,
      "tenant-1",
      "payment_received",
      { id: "pay-1" }
    );
    expect(res.enqueued).toBe(0);
    expect(res.error).toMatch(/no such table/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
