// src/lib/automations.test.ts
//
// The automation_runs state machine: lease, wait steps, retry-with-backoff that
// never advances the step, cancellation, subject resolution for all four
// subject types, the event_ended sweep, and the legacy automation_enrollments
// drain that must not double-send once a subject has a run.
//
// Real SQLite + the real 0029 migration (see automations/testDb.ts).
import { describe, it, expect, vi } from "vitest";
import type { Env } from "../types";
import type { SendEmailParams, SendEmailResult } from "./email";
import {
  acquireRunLease,
  processAutomationRuns,
  sweepEndedEvents,
  runAutomationJob,
  enrollMemberActivated,
  parseSteps,
  serializeSteps,
  wrapLinksForTracking,
} from "./automations";
import {
  createTestDb,
  seedTenant,
  seedMember,
  seedSequence,
  type TestDb,
} from "./automations/testDb";
import { enqueueTrigger } from "./automations/triggers";

function envFor(db: TestDb): Env {
  return {
    DB: db,
    APP_URL: "https://quilthosting.com",
    JWT_SECRET: "test-secret",
  } as unknown as Env;
}

/** Recording stub for sendEmail. */
function recorder(
  outcome: (p: SendEmailParams, n: number) => SendEmailResult = () => ({
    id: "msg-1",
    success: true,
  })
) {
  const calls: SendEmailParams[] = [];
  const send = async (_env: Env, p: SendEmailParams): Promise<SendEmailResult> => {
    calls.push(p);
    return outcome(p, calls.length);
  };
  return { calls, send };
}

type RunRow = {
  id: string;
  tenant_id: string;
  sequence_id: string;
  subject_type: string;
  subject_id: string;
  step: number;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  error: string | null;
  attempts: number;
  lease_until: string | null;
  lease_owner: string | null;
};

const allRuns = (db: TestDb) => db.rows<RunRow>(`SELECT * FROM automation_runs`);
const oneRun = (db: TestDb) => allRuns(db)[0];
const logs = (db: TestDb) =>
  db.rows<{ id: string; template: string; status: string; to_email: string; delivery_status: string | null }>(
    `SELECT * FROM email_logs ORDER BY created_at, id`
  );

/** A tenant + member + active sequence with `steps`, already enqueued and due. */
async function dueRun(steps: unknown, opts: { trigger?: string } = {}) {
  const db = createTestDb();
  seedTenant(db);
  seedMember(db);
  seedSequence(db, { steps, trigger: opts.trigger });
  await enqueueTrigger(envFor(db), "tenant-1", "member_activated", { id: "member-1" });
  return db;
}

const TWO_STEPS = [
  { waitDays: 0, subject: "Welcome {{first_name}}", bodyHtml: "<p>Hi from {{guild_name}}</p>" },
  { waitDays: 3, subject: "Second", bodyHtml: "<p>More</p>" },
];

describe("acquireRunLease", () => {
  it("gives the lease to exactly one owner", async () => {
    const db = await dueRun(TWO_STEPS);
    const id = oneRun(db).id;
    expect(await acquireRunLease(db as unknown as D1Database, id, "w1", Date.now())).toBe(true);
    expect(await acquireRunLease(db as unknown as D1Database, id, "w2", Date.now())).toBe(false);
    expect(oneRun(db).lease_owner).toBe("w1");
    expect(oneRun(db).status).toBe("sending");
  });

  it("hands an expired lease to the next worker (a crashed run is not stuck)", async () => {
    const db = await dueRun(TWO_STEPS);
    const id = oneRun(db).id;
    const t0 = Date.now();
    expect(await acquireRunLease(db as unknown as D1Database, id, "w1", t0)).toBe(true);
    expect(
      await acquireRunLease(db as unknown as D1Database, id, "w2", t0 + 10 * 60 * 1000)
    ).toBe(true);
    expect(oneRun(db).lease_owner).toBe("w2");
  });

  it("never leases a finished run", async () => {
    const db = await dueRun(TWO_STEPS);
    const id = oneRun(db).id;
    db.sqlite.prepare(`UPDATE automation_runs SET status = 'completed'`).run();
    expect(await acquireRunLease(db as unknown as D1Database, id, "w1", Date.now())).toBe(false);
  });
});

describe("processAutomationRuns — the happy path", () => {
  it("sends the due step, advances, and schedules the next by its waitDays", async () => {
    const db = await dueRun(TWO_STEPS);
    const rec = recorder();
    const before = Date.now();
    const res = await processAutomationRuns(envFor(db), { send: rec.send });

    expect(res.sent).toBe(1);
    expect(res.completed).toBe(0);
    expect(rec.calls).toHaveLength(1);
    const run = oneRun(db);
    expect(run.status).toBe("pending");
    expect(run.step).toBe(1);
    expect(run.attempts).toBe(0);
    expect(run.error).toBeNull();
    expect(run.lease_owner).toBeNull();
    expect(run.sent_at).toBeTruthy();
    const gap = Date.parse(run.scheduled_at!) - before;
    expect(gap).toBeGreaterThan(2.9 * 86400000);
    expect(gap).toBeLessThan(3.1 * 86400000);
  });

  it("completes the run after the last step and clears scheduled_at", async () => {
    const db = await dueRun([TWO_STEPS[0]]);
    const rec = recorder();
    const res = await processAutomationRuns(envFor(db), { send: rec.send });
    expect(res.sent).toBe(1);
    expect(res.completed).toBe(1);
    const run = oneRun(db);
    expect(run.status).toBe("completed");
    expect(run.step).toBe(1);
    expect(run.scheduled_at).toBeNull();
  });

  it("leaves a run that is not due yet completely alone", async () => {
    const db = await dueRun([{ waitDays: 5, subject: "Later", bodyHtml: "<p>x</p>" }]);
    const rec = recorder();
    const res = await processAutomationRuns(envFor(db), { send: rec.send });
    expect(res.sent).toBe(0);
    expect(rec.calls).toHaveLength(0);
    expect(oneRun(db).status).toBe("pending");
    expect(oneRun(db).step).toBe(0);
  });

  it("walks a two-step sequence to completion across ticks", async () => {
    const db = await dueRun(TWO_STEPS);
    const rec = recorder();
    await processAutomationRuns(envFor(db), { send: rec.send });
    // Nothing due until the wait elapses.
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(rec.calls).toHaveLength(1);
    // Fast-forward the schedule instead of the clock.
    db.sqlite.prepare(`UPDATE automation_runs SET scheduled_at = ?`).run("2000-01-01T00:00:00.000Z");
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(rec.calls.map((c) => c.subject)).toEqual(["Welcome Ada", "Second"]);
    expect(oneRun(db).status).toBe("completed");
  });
});

describe("processAutomationRuns — marketing send contract", () => {
  it("sends as marketing with the tenant, log id and unsubscribe url, like blastSend", async () => {
    const db = await dueRun(TWO_STEPS);
    const rec = recorder();
    await processAutomationRuns(envFor(db), { send: rec.send });
    const p = rec.calls[0];
    expect(p.kind).toBe("marketing");
    expect(p.tenantId).toBe("tenant-1");
    expect(p.emailLogId).toBeTruthy();
    expect(p.unsubscribeUrl).toMatch(/^https:\/\/quilthosting\.com\/u\//);
    expect(p.guildName).toBe("River Quilters");
    expect(p.to).toBe("ada@example.com");
    expect(p.tags?.some((t) => t.name === "template" && t.value === "automation")).toBe(true);
  });

  it("applies merge fields and wraps links for click tracking", async () => {
    const db = await dueRun([
      {
        waitDays: 0,
        subject: "Hi {{first_name}}",
        bodyHtml: '<p>See <a href="https://example.com/x">this</a>, {{guild_name}}</p>',
      },
    ]);
    const rec = recorder();
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(rec.calls[0].subject).toBe("Hi Ada");
    expect(rec.calls[0].html).toContain("River Quilters");
    expect(rec.calls[0].html).toContain("/t/c/");
    expect(rec.calls[0].html).toContain(encodeURIComponent("https://example.com/x"));
  });

  it("writes one email_logs row per send, keyed to the emailLogId it passed", async () => {
    const db = await dueRun([TWO_STEPS[0]]);
    const rec = recorder();
    await processAutomationRuns(envFor(db), { send: rec.send });
    const rows = logs(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(rec.calls[0].emailLogId);
    expect(rows[0].template).toBe("automation");
    expect(rows[0].status).toBe("sent");
    expect(rows[0].delivery_status).toBe("accepted");
    expect(rows[0].to_email).toBe("ada@example.com");
  });
});

describe("processAutomationRuns — failure and retry", () => {
  const failing = (): SendEmailResult => ({
    id: "",
    success: false,
    error: "provider 503",
    retryable: true,
  });

  it("retries with backoff without advancing the step or duplicating the send", async () => {
    const db = await dueRun(TWO_STEPS);
    const rec = recorder(failing);
    const before = Date.now();
    const res = await processAutomationRuns(envFor(db), { send: rec.send });

    expect(res.sent).toBe(0);
    expect(res.retried).toBe(1);
    expect(rec.calls).toHaveLength(1);
    const run = oneRun(db);
    expect(run.status).toBe("pending");
    expect(run.step).toBe(0); // NOT advanced
    expect(run.attempts).toBe(1);
    expect(run.error).toMatch(/503/);
    expect(run.sent_at).toBeNull();
    expect(Date.parse(run.scheduled_at!)).toBeGreaterThan(before);
    // Not due again in this tick, so a second pass sends nothing.
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(rec.calls).toHaveLength(1);
  });

  it("backs off further each attempt and gives up as failed after three", async () => {
    const db = await dueRun(TWO_STEPS);
    const rec = recorder(failing);
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await processAutomationRuns(envFor(db), { send: rec.send });
      const r = oneRun(db);
      if (r.scheduled_at) gaps.push(Date.parse(r.scheduled_at) - t);
      db.sqlite.prepare(`UPDATE automation_runs SET scheduled_at = ? WHERE status = 'pending'`)
        .run("2000-01-01T00:00:00.000Z");
    }
    expect(rec.calls).toHaveLength(3);
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    const run = oneRun(db);
    expect(run.status).toBe("failed");
    expect(run.attempts).toBe(3);
    expect(run.step).toBe(0);
  });

  it("a step that finally succeeds clears attempts and the error", async () => {
    const db = await dueRun(TWO_STEPS);
    const rec = recorder((_p, n) => (n === 1 ? failing() : { id: "m", success: true }));
    await processAutomationRuns(envFor(db), { send: rec.send });
    db.sqlite.prepare(`UPDATE automation_runs SET scheduled_at = ?`).run("2000-01-01T00:00:00.000Z");
    await processAutomationRuns(envFor(db), { send: rec.send });
    const run = oneRun(db);
    expect(run.step).toBe(1);
    expect(run.attempts).toBe(0);
    expect(run.error).toBeNull();
    expect(logs(db).filter((l) => l.status === "sent")).toHaveLength(1);
  });

  it("records the failed attempt in email_logs without pretending it sent", async () => {
    const db = await dueRun(TWO_STEPS);
    await processAutomationRuns(envFor(db), { send: recorder(failing).send });
    const rows = logs(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].delivery_status).toBe("failed");
  });
});

describe("processAutomationRuns — cancellation", () => {
  it("cancels the run when the recipient is suppressed", async () => {
    const db = await dueRun(TWO_STEPS);
    const rec = recorder(() => ({
      id: "",
      success: false,
      suppressed: true,
      reason: "unsubscribe",
    }));
    const res = await processAutomationRuns(envFor(db), { send: rec.send });
    expect(res.cancelled).toBe(1);
    const run = oneRun(db);
    expect(run.status).toBe("cancelled");
    expect(run.error).toMatch(/unsubscribe/);
    // No further steps are attempted.
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(rec.calls).toHaveLength(1);
  });

  it("cancels when the sequence has been paused or deleted", async () => {
    const paused = await dueRun(TWO_STEPS);
    paused.sqlite.prepare(`UPDATE automation_sequences SET is_active = 0`).run();
    const a = recorder();
    await processAutomationRuns(envFor(paused), { send: a.send });
    expect(oneRun(paused).status).toBe("cancelled");
    expect(a.calls).toHaveLength(0);

    const gone = await dueRun(TWO_STEPS);
    gone.sqlite.prepare(`DELETE FROM automation_sequences`).run();
    const b = recorder();
    await processAutomationRuns(envFor(gone), { send: b.send });
    expect(oneRun(gone).status).toBe("cancelled");
    expect(b.calls).toHaveLength(0);
  });

  it("cancels when the subject has gone or has no email", async () => {
    const db = await dueRun(TWO_STEPS);
    db.sqlite.prepare(`DELETE FROM members`).run();
    const rec = recorder();
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(oneRun(db).status).toBe("cancelled");
    expect(rec.calls).toHaveLength(0);
  });
});

describe("processAutomationRuns — subject resolution", () => {
  it("resolves an event registration and offers the attendee name", async () => {
    const db = createTestDb();
    seedTenant(db);
    db.sqlite
      .prepare(`INSERT INTO events (id, tenant_id, title, start_at, end_at) VALUES (?,?,?,?,?)`)
      .run("ev-1", "tenant-1", "Sit and Sew", "2026-09-01T15:00:00Z", "2026-09-01T18:00:00Z");
    db.sqlite
      .prepare(
        `INSERT INTO event_registrations (id, tenant_id, event_id, email, name, status) VALUES (?,?,?,?,?,?)`
      )
      .run("reg-1", "tenant-1", "ev-1", "bea@example.com", "Bea Cutter", "registered");
    seedSequence(db, {
      trigger: "event_registered",
      steps: [{ waitDays: 0, subject: "See you, {{first_name}}", bodyHtml: "<p>ok</p>" }],
    });
    await enqueueTrigger(envFor(db), "tenant-1", "event_registered", { id: "reg-1", eventId: "ev-1" });
    const rec = recorder();
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(rec.calls[0].to).toBe("bea@example.com");
    expect(rec.calls[0].subject).toBe("See you, Bea");
  });

  it("resolves a form response", async () => {
    const db = createTestDb();
    seedTenant(db);
    db.sqlite.prepare(`INSERT INTO forms (id, tenant_id, name) VALUES (?,?,?)`).run("f-1", "tenant-1", "Contact");
    db.sqlite
      .prepare(`INSERT INTO form_responses (id, tenant_id, form_id, email, name) VALUES (?,?,?,?,?)`)
      .run("resp-1", "tenant-1", "f-1", "cara@example.com", "Cara");
    seedSequence(db, {
      trigger: "form_submitted",
      steps: [{ waitDays: 0, subject: "Thanks {{first_name}}", bodyHtml: "<p>ok</p>" }],
    });
    await enqueueTrigger(envFor(db), "tenant-1", "form_submitted", { id: "resp-1", formId: "f-1" });
    const rec = recorder();
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(rec.calls[0].to).toBe("cara@example.com");
    expect(rec.calls[0].subject).toBe("Thanks Cara");
  });

  it("resolves a payment through its member", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedMember(db, { id: "m-9", email: "dee@example.com", firstName: "Dee" });
    db.sqlite
      .prepare(`INSERT INTO payments (id, tenant_id, member_id, amount_cents) VALUES (?,?,?,?)`)
      .run("pay-1", "tenant-1", "m-9", 4500);
    seedSequence(db, {
      trigger: "payment_received",
      steps: [{ waitDays: 0, subject: "Got it, {{first_name}}", bodyHtml: "<p>ok</p>" }],
    });
    await enqueueTrigger(envFor(db), "tenant-1", "payment_received", { id: "pay-1", amountCents: 4500 });
    const rec = recorder();
    await processAutomationRuns(envFor(db), { send: rec.send });
    expect(rec.calls[0].to).toBe("dee@example.com");
    expect(rec.calls[0].subject).toBe("Got it, Dee");
  });
});

describe("sweepEndedEvents", () => {
  function endedEventDb() {
    const db = createTestDb();
    seedTenant(db);
    const ended = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    db.sqlite
      .prepare(`INSERT INTO events (id, tenant_id, title, start_at, end_at) VALUES (?,?,?,?,?)`)
      .run("ev-done", "tenant-1", "Retreat", ended, ended);
    db.sqlite
      .prepare(`INSERT INTO events (id, tenant_id, title, start_at, end_at) VALUES (?,?,?,?,?)`)
      .run("ev-soon", "tenant-1", "Next month", future, future);
    const reg = db.sqlite.prepare(
      `INSERT INTO event_registrations (id, tenant_id, event_id, email, status) VALUES (?,?,?,?,?)`
    );
    reg.run("r-1", "tenant-1", "ev-done", "a@example.com", "registered");
    reg.run("r-2", "tenant-1", "ev-done", "b@example.com", "registered");
    reg.run("r-3", "tenant-1", "ev-done", "c@example.com", "cancelled");
    reg.run("r-4", "tenant-1", "ev-soon", "d@example.com", "registered");
    return db;
  }

  it("enqueues one run per attendee of an event that just ended", async () => {
    const db = endedEventDb();
    seedSequence(db, {
      trigger: "event_ended",
      steps: [{ waitDays: 1, subject: "Thanks", bodyHtml: "<p>ok</p>" }],
    });
    const res = await sweepEndedEvents(envFor(db));
    expect(res.enqueued).toBe(2);
    expect(allRuns(db).map((r) => r.subject_id).sort()).toEqual(["r-1", "r-2"]);
  });

  it("is safe to re-run — the unique index absorbs the second sweep", async () => {
    const db = endedEventDb();
    seedSequence(db, {
      trigger: "event_ended",
      steps: [{ waitDays: 1, subject: "Thanks", bodyHtml: "<p>ok</p>" }],
    });
    await sweepEndedEvents(envFor(db));
    const second = await sweepEndedEvents(envFor(db));
    expect(second.enqueued).toBe(0);
    expect(allRuns(db)).toHaveLength(2);
  });

  it("does nothing when no tenant has an active event_ended sequence", async () => {
    const db = endedEventDb();
    seedSequence(db, { trigger: "member_activated" });
    const res = await sweepEndedEvents(envFor(db));
    expect(res.enqueued).toBe(0);
    expect(allRuns(db)).toHaveLength(0);
    expect(db.queries.some((q) => /FROM event_registrations/i.test(q))).toBe(false);
  });
});

describe("enrollMemberActivated and the legacy enrollment drain", () => {
  it("now writes an automation_runs row", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedMember(db);
    seedSequence(db, { steps: TWO_STEPS });
    await enrollMemberActivated(envFor(db), "tenant-1", "member-1");
    const rows = allRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_type).toBe("member");
    expect(rows[0].subject_id).toBe("member-1");
    expect(db.rows(`SELECT * FROM automation_enrollments`)).toHaveLength(0);
  });

  it("is idempotent, so a re-activation does not start a second copy", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedMember(db);
    seedSequence(db, { steps: TWO_STEPS });
    await enrollMemberActivated(envFor(db), "tenant-1", "member-1");
    await enrollMemberActivated(envFor(db), "tenant-1", "member-1");
    expect(allRuns(db)).toHaveLength(1);
  });

  it("never throws when the runs table is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { prepare: () => { throw new Error("no such table"); } };
    await expect(
      enrollMemberActivated({ DB: broken } as unknown as Env, "t", "m")
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("still drains a pre-0029 enrollment row", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedMember(db);
    seedSequence(db, { steps: [TWO_STEPS[0]] });
    db.sqlite
      .prepare(
        `INSERT INTO automation_enrollments (id, tenant_id, sequence_id, member_id, current_step, next_send_at, status)
         VALUES (?,?,?,?,0,?, 'active')`
      )
      .run("en-1", "tenant-1", "seq-1", "member-1", "2000-01-01T00:00:00.000Z");
    const rec = recorder();
    const res = await runAutomationJob(envFor(db), { send: rec.send });
    expect(res.sent).toBe(1);
    expect(rec.calls[0].kind).toBe("marketing");
    expect(
      db.rows<{ status: string }>(`SELECT status FROM automation_enrollments`)[0].status
    ).toBe("completed");
  });

  it("cancels a legacy enrollment whose subject already has a run — never two copies", async () => {
    const db = createTestDb();
    seedTenant(db);
    seedMember(db);
    seedSequence(db, { steps: [TWO_STEPS[0]] });
    db.sqlite
      .prepare(
        `INSERT INTO automation_enrollments (id, tenant_id, sequence_id, member_id, current_step, next_send_at, status)
         VALUES (?,?,?,?,0,?, 'active')`
      )
      .run("en-1", "tenant-1", "seq-1", "member-1", "2000-01-01T00:00:00.000Z");
    await enrollMemberActivated(envFor(db), "tenant-1", "member-1");

    const rec = recorder();
    await runAutomationJob(envFor(db), { send: rec.send });
    expect(rec.calls).toHaveLength(1); // the run, not the enrollment
    expect(
      db.rows<{ status: string }>(`SELECT status FROM automation_enrollments`)[0].status
    ).toBe("cancelled");
  });
});

describe("runAutomationJob", () => {
  it("keeps its {sent, completed, errors} shape and folds the runs in", async () => {
    const db = await dueRun([TWO_STEPS[0]]);
    const rec = recorder();
    const res = await runAutomationJob(envFor(db), { send: rec.send });
    expect(res.sent).toBe(1);
    expect(res.completed).toBe(1);
    expect(res.errors).toEqual([]);
  });

  it("survives a database with none of the automation tables", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { prepare: () => { throw new Error("no such table"); } };
    const res = await runAutomationJob({ DB: broken } as unknown as Env);
    expect(res.sent).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
    warn.mockRestore();
  });
});

describe("step parsing (unchanged public surface)", () => {
  it("still accepts the legacy delay_days/body_html spelling", () => {
    const steps = parseSteps(
      JSON.stringify([{ delay_days: 2, subject: "Old", body_html: "<p>x</p>" }])
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].delay_days).toBe(2);
    expect(steps[0].waitDays).toBe(2);
    expect(steps[0].body_html).toBe("<p>x</p>");
    expect(steps[0].bodyHtml).toBe("<p>x</p>");
  });

  it("drops steps with no subject or body, clamps the wait and caps the length", () => {
    expect(parseSteps(JSON.stringify([{ waitDays: 1, subject: "", bodyHtml: "x" }]))).toEqual([]);
    expect(parseSteps(JSON.stringify([{ waitDays: -5, subject: "a", bodyHtml: "b" }]))[0].waitDays).toBe(0);
    expect(parseSteps(JSON.stringify([{ waitDays: 9999, subject: "a", bodyHtml: "b" }]))[0].waitDays).toBe(365);
    const many = Array.from({ length: 30 }, () => ({ waitDays: 1, subject: "a", bodyHtml: "b" }));
    expect(parseSteps(JSON.stringify(many))).toHaveLength(12);
    expect(parseSteps("nonsense")).toEqual([]);
    expect(parseSteps(null)).toEqual([]);
  });

  it("serializeSteps writes only the v2 spelling", () => {
    const steps = parseSteps(JSON.stringify([{ delay_days: 4, subject: "s", body_html: "b" }]));
    expect(JSON.parse(serializeSteps(steps))).toEqual([{ waitDays: 4, subject: "s", bodyHtml: "b" }]);
  });
});

describe("wrapLinksForTracking (unchanged)", () => {
  it("rewrites http anchors through /t/c/:logId", () => {
    const out = wrapLinksForTracking(
      '<a href="https://x.test/a">a</a>',
      "https://quilthosting.com/",
      "log-1"
    );
    expect(out).toContain("https://quilthosting.com/t/c/log-1?u=");
  });
});
