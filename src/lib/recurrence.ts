/**
 * Event recurrence — guild meetings are almost always "first Wednesday" or
 * "every other Tuesday", so we support weekly, monthly-by-date, and
 * monthly-by-nth-weekday. Occurrences are materialized as real event rows so
 * every existing feature (registration, capacity, calendar, ics) just works.
 */

export type RecurrenceRule = {
  freq: "weekly" | "monthly_day" | "monthly_nth";
  /** every N weeks/months (default 1) */
  interval?: number;
  /** how many occurrences to generate, including the first (max 60) */
  count: number;
  /** monthly_nth: 1-5 (5 = last), and weekday 0=Sun..6=Sat */
  nth?: number;
  weekday?: number;
};

export const MAX_OCCURRENCES = 60;

export function parseRecurrence(input: unknown): RecurrenceRule | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const freq = String(r.freq || "");
  if (!["weekly", "monthly_day", "monthly_nth"].includes(freq)) return null;
  const count = Math.min(Math.max(Number(r.count) || 0, 1), MAX_OCCURRENCES);
  const interval = Math.min(Math.max(Number(r.interval) || 1, 1), 12);
  const rule: RecurrenceRule = { freq: freq as RecurrenceRule["freq"], count, interval };
  if (freq === "monthly_nth") {
    const nth = Number(r.nth);
    const weekday = Number(r.weekday);
    if (!(nth >= 1 && nth <= 5)) return null;
    if (!(weekday >= 0 && weekday <= 6)) return null;
    rule.nth = nth;
    rule.weekday = weekday;
  }
  return rule;
}

/** Date of the nth given weekday in a month (nth=5 → last occurrence). */
function nthWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
  nth: number
): Date | null {
  if (nth === 5) {
    const last = new Date(Date.UTC(year, monthIndex + 1, 0));
    const shift = (last.getUTCDay() - weekday + 7) % 7;
    return new Date(Date.UTC(year, monthIndex, last.getUTCDate() - shift));
  }
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + shift + (nth - 1) * 7;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return new Date(Date.UTC(year, monthIndex, day));
}

/**
 * Occurrence start times (ISO strings) beginning at `startAt`, which is always
 * the first occurrence. Preserves the time-of-day of the seed date.
 */
export function expandOccurrences(startAt: string, rule: RecurrenceRule): string[] {
  const seed = new Date(startAt);
  if (isNaN(seed.getTime())) return [];
  const out: string[] = [seed.toISOString()];
  const interval = rule.interval || 1;

  if (rule.freq === "weekly") {
    for (let i = 1; i < rule.count; i++) {
      const d = new Date(seed.getTime());
      d.setUTCDate(d.getUTCDate() + i * 7 * interval);
      out.push(d.toISOString());
    }
    return out;
  }

  if (rule.freq === "monthly_day") {
    const dom = seed.getUTCDate();
    for (let i = 1; i < rule.count; i++) {
      const y = seed.getUTCFullYear();
      const m = seed.getUTCMonth() + i * interval;
      const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const d = new Date(
        Date.UTC(
          y,
          m,
          Math.min(dom, daysInMonth),
          seed.getUTCHours(),
          seed.getUTCMinutes(),
          seed.getUTCSeconds()
        )
      );
      out.push(d.toISOString());
    }
    return out;
  }

  // monthly_nth — e.g. "first Wednesday"
  const weekday = rule.weekday ?? seed.getUTCDay();
  const nth = rule.nth ?? 1;
  let produced = 1;
  let i = 1;
  while (produced < rule.count && i < rule.count * 3 + 24) {
    const y = seed.getUTCFullYear();
    const m = seed.getUTCMonth() + i * interval;
    const base = nthWeekdayOfMonth(
      new Date(Date.UTC(y, m, 1)).getUTCFullYear(),
      new Date(Date.UTC(y, m, 1)).getUTCMonth(),
      weekday,
      nth
    );
    i++;
    if (!base) continue;
    const d = new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        seed.getUTCHours(),
        seed.getUTCMinutes(),
        seed.getUTCSeconds()
      )
    );
    out.push(d.toISOString());
    produced++;
  }
  return out;
}

/** Human-readable summary for admin UI and emails. */
export function describeRecurrence(rule: RecurrenceRule): string {
  const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const ORD = ["", "first", "second", "third", "fourth", "last"];
  const every = (rule.interval || 1) > 1 ? `every ${rule.interval} ` : "";
  if (rule.freq === "weekly") return `Weekly (${every || "every "}week) × ${rule.count}`;
  if (rule.freq === "monthly_day") return `Monthly on the same date × ${rule.count}`;
  return `Monthly on the ${ORD[rule.nth || 1]} ${WD[rule.weekday ?? 0]} × ${rule.count}`;
}
