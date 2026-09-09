/**
 * Automation step parsing.
 *
 * Lives in its own module so `lib/automations.ts` (the job) and
 * `lib/automations/triggers.ts` (the enqueue side) can both use it without an
 * import cycle.
 *
 * Two spellings exist on the wire:
 *   legacy (pre-0029, still on disk): { delay_days, subject, body_html }
 *   v2 (what the builder and recipes write): { waitDays, subject, bodyHtml }
 * parseSteps accepts either and returns BOTH namings on every step so the old
 * enrollment code path and the new runs path can share one parser.
 * serializeSteps writes the v2 spelling only.
 */

export type AutomationStep = {
  /** Legacy alias of waitDays; kept so existing callers are untouched. */
  delay_days: number;
  /** Days to wait after the previous step (or the trigger, for step 0). */
  waitDays: number;
  subject: string;
  /** Legacy alias of bodyHtml. */
  body_html: string;
  bodyHtml: string;
};

/** What the builder posts and what we store. */
export type AutomationStepInput = {
  waitDays?: unknown;
  delay_days?: unknown;
  subject?: unknown;
  bodyHtml?: unknown;
  body_html?: unknown;
  body?: unknown;
};

export const MAX_STEPS = 12;
export const MAX_WAIT_DAYS = 365;

function clampDays(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_WAIT_DAYS, n));
}

export function parseSteps(raw: string | null | undefined): AutomationStep[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s: AutomationStepInput) => {
        const waitDays = clampDays(s?.waitDays ?? s?.delay_days ?? 0);
        const subject = String(s?.subject ?? "").slice(0, 200);
        const bodyHtml = String(s?.bodyHtml ?? s?.body_html ?? s?.body ?? "").slice(
          0,
          50000
        );
        return {
          delay_days: waitDays,
          waitDays,
          subject,
          body_html: bodyHtml,
          bodyHtml,
        };
      })
      .filter((s: AutomationStep) => s.subject && s.bodyHtml)
      .slice(0, MAX_STEPS);
  } catch {
    return [];
  }
}

/** Canonical storage form: the v2 spelling, nothing else. */
export function serializeSteps(steps: AutomationStep[]): string {
  return JSON.stringify(
    steps.map((s) => ({
      waitDays: s.waitDays,
      subject: s.subject,
      bodyHtml: s.bodyHtml,
    }))
  );
}
