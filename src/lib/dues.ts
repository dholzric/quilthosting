/**
 * src/lib/dues.ts — the dues policy engine.
 *
 * A quilt guild sells a membership YEAR. Most of them run January to
 * December: "dues are $35, the year runs January through December, join
 * after July 1 and pay $18." Until phase 4 a level was only
 * `duration_months` counted from the join date, so a member who joined in
 * October got a term ending next October and the roster never lined up with
 * the treasurer's year.
 *
 * Migration 0030 adds four columns to `membership_levels`:
 *
 *   term_mode   anniversary | calendar | fixed_date   (default anniversary)
 *   term_anchor 'MM-DD' for fixed_date; NULL otherwise
 *   proration   none | half_year | monthly            (default none)
 *   grace_days  days after end_date before a lapse    (default 0)
 *
 * Every date and price those columns imply is computed HERE and nowhere
 * else, so there is one place to read when a treasurer asks why a member's
 * card says what it says.
 *
 * THE INVARIANT: a level nobody edits behaves exactly as it did before this
 * file existed. The column defaults reproduce today's rows, `readDuesPolicy`
 * turns a row with no policy columns at all into the anniversary policy, and
 * the anniversary branch below IS the body `computeMembershipEnd` used to
 * have (memberships.ts now calls into it, so the two cannot drift).
 */

export type TermMode = "anniversary" | "calendar" | "fixed_date";
export type Proration = "none" | "half_year" | "monthly";

export type DuesPolicy = {
  termMode: TermMode;
  /** 'MM-DD' when termMode is fixed_date; null for anniversary and calendar. */
  termAnchor?: string | null;
  durationMonths: number;
  proration: Proration;
  graceDays: number;
};

/** Shared with the levels route's zod schemas and the admin's radio group. */
export const TERM_MODES: readonly TermMode[] = ["anniversary", "calendar", "fixed_date"];
export const PRORATIONS: readonly Proration[] = ["none", "half_year", "monthly"];

/** Longest grace period an officer may set (a year would be a bug, not a policy). */
export const MAX_GRACE_DAYS = 365;
/** Same bound levels.ts already enforces on duration_months. */
const MAX_DURATION_MONTHS = 120;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * A non-leap reference year for the WORDS in describePolicy. February 29 is
 * a legal anchor (the engine clamps it to February 28 in the other three
 * years out of four), but the sentence has to name one date, and the
 * non-leap reading is the one that is true three years in four.
 */
const LABEL_YEAR = 2027;

const ANCHOR_RE = /^(\d{2})-(\d{2})$/;

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Parse 'MM-DD' into a 1-based month and day, or null if it is not one. */
function parseAnchor(anchor: string | null | undefined): { month: number; day: number } | null {
  if (typeof anchor !== "string") return null;
  const m = ANCHOR_RE.exec(anchor.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12) return null;
  // February 29 is allowed (it exists in leap years and is clamped below);
  // February 30 and April 31 are not dates at all.
  const maxDay = month === 2 ? 29 : daysInMonth(2027, month - 1);
  if (day < 1 || day > maxDay) return null;
  return { month, day };
}

/** True when 'MM-DD' names a day that exists in at least one year. */
export function isValidTermAnchor(anchor: string | null | undefined): boolean {
  return parseAnchor(anchor) !== null;
}

/** The anchor's UTC midnight in a given year, clamped to that month's length. */
function anchorInYear(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, Math.min(day, daysInMonth(year, month - 1)));
}

/** UTC midnight of the calendar day a timestamp falls on. */
function dayStart(t: Date): number {
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** Add whole months, clamping the day to the target month (Jan 31 + 1 = Feb 28). */
function addMonthsClamped(utcMs: number, months: number): number {
  const d = new Date(utcMs);
  const year = d.getUTCFullYear();
  const monthIndex = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  return Date.UTC(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

function parseOrThrow(value: string, what: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`${what} "${value}" is not a valid date`);
  }
  return d;
}

function toInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * Normalize a `membership_levels` row (or anything shaped like one) into a
 * policy. Anything unreadable falls back to the pre-0030 default rather than
 * throwing: a bad column value must never stop a member from joining.
 */
export function readDuesPolicy(level: {
  term_mode?: string | null;
  term_anchor?: string | null;
  duration_months?: number | null;
  proration?: string | null;
  grace_days?: number | null;
}): DuesPolicy {
  let termMode: TermMode = TERM_MODES.includes(level.term_mode as TermMode)
    ? (level.term_mode as TermMode)
    : "anniversary";

  // calendar IS the January 1 anchor, so it never carries one of its own;
  // fixed_date without a usable anchor would have nothing to compute from,
  // and the January 1 year is the least surprising reading of "a fixed year
  // whose date we cannot read".
  let termAnchor: string | null = null;
  if (termMode === "fixed_date") {
    const parsed = parseAnchor(level.term_anchor);
    if (parsed) termAnchor = `${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
    else termMode = "calendar";
  }

  const months = toInt(level.duration_months);
  const durationMonths = months !== null && months >= 1 && months <= MAX_DURATION_MONTHS ? months : 12;

  // Proration divides a SHARED year; an anniversary term already starts the
  // day the member pays, so there is nothing to prorate into.
  let proration: Proration = PRORATIONS.includes(level.proration as Proration)
    ? (level.proration as Proration)
    : "none";
  if (termMode === "anniversary") proration = "none";

  const grace = toInt(level.grace_days);
  const graceDays = grace !== null && grace >= 0 && grace <= MAX_GRACE_DAYS ? grace : 0;

  return { termMode, termAnchor, durationMonths, proration, graceDays };
}

/**
 * The anniversary term end: one full term of `durationMonths` measured from
 * `max(startDate, now)`. This is verbatim the body `computeMembershipEnd`
 * carried before phase 4 — `src/lib/memberships.ts` now delegates to it, and
 * `src/lib/dues.test.ts` asserts the two agree on every input, so the
 * "a level nobody edited behaves exactly as before" promise cannot rot.
 *
 * See computeMembershipEnd's doc comment for WHY max() and not startDate
 * (the CSV import's historical join dates) and why not simply now (a
 * deliberately future start).
 */
export function anniversaryTermEnd(
  startDate: string,
  durationMonths: number | null | undefined,
  now: string
): string {
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    throw new RangeError(`start date "${startDate}" is not a valid date`);
  }
  const nowDate = new Date(now);
  const base = start.getTime() > nowDate.getTime() ? start : nowDate;
  const end = new Date(base.getTime());
  end.setMonth(end.getMonth() + (durationMonths || 12));
  return end.toISOString();
}

/** The anchor a fixed-year policy runs on, as {month, day}. */
function policyAnchor(policy: DuesPolicy): { month: number; day: number } {
  if (policy.termMode === "fixed_date") {
    const parsed = parseAnchor(policy.termAnchor);
    if (parsed) return parsed;
  }
  return { month: 1, day: 1 }; // calendar
}

/**
 * The first anchor STRICTLY after the given day, and the one before it.
 *
 * "Strictly" is what gives a member who joins ON the anchor a full year
 * instead of a term that ends the same afternoon. Comparison is by calendar
 * day, not timestamp, so joining at 6pm on July 1 still counts as July 1.
 */
function anchorWindow(
  policy: DuesPolicy,
  baseDayUtc: number
): { termStart: number; nextAnchor: number } {
  const { month, day } = policyAnchor(policy);
  const year = new Date(baseDayUtc).getUTCFullYear();
  const thisYear = anchorInYear(year, month, day);
  if (thisYear > baseDayUtc) {
    return { termStart: anchorInYear(year - 1, month, day), nextAnchor: thisYear };
  }
  return { termStart: thisYear, nextAnchor: anchorInYear(year + 1, month, day) };
}

/**
 * The end date a membership on this policy gets.
 *
 * anniversary — today's math, unchanged.
 * calendar / fixed_date — the last moment of the day before the next anchor,
 * so a January 3 join and a December 20 join end on the same December 31.
 * The base is `max(startDate, now)` for the same reason anniversary uses it:
 * an imported "member since 2019" must not produce a term that is already
 * over, and a deliberately future start must keep its own term.
 */
export function computeTermEnd(policy: DuesPolicy, startDate: string, now: string): string {
  if (policy.termMode === "anniversary") {
    return anniversaryTermEnd(startDate, policy.durationMonths, now);
  }
  const start = parseOrThrow(startDate, "start date");
  const nowDate = parseOrThrow(now, "current date");
  const base = start.getTime() > nowDate.getTime() ? start : nowDate;
  const { nextAnchor } = anchorWindow(policy, dayStart(base));
  // The day BEFORE the anchor, through its last millisecond: the term
  // covers December 31 itself, and the renewal cron's date() comparison
  // reads it as December 31.
  const endDay = new Date(nextAnchor - 24 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(
      endDay.getUTCFullYear(),
      endDay.getUTCMonth(),
      endDay.getUTCDate(),
      23,
      59,
      59,
      999
    )
  ).toISOString();
}

/**
 * What a FIRST-TIME member pays to join a fixed-year level partway through
 * the year. Renewals always pay full price, and so does anyone who has held
 * this level before — the caller decides that (it needs the database); this
 * function only knows the calendar.
 *
 *   half_year — full price up to the midpoint, ceil(price / 2) from it on.
 *               The midpoint is the anchor plus half the term in whole
 *               months, so a January-to-December year charges half from
 *               July 1, which is the sentence guilds already print.
 *   monthly   — ceil(price × monthsRemaining / durationMonths), where a
 *               partial month counts as a whole one (join October 15 and
 *               you pay for October, November and December).
 *
 * Always a whole number of cents inside [0, fullPriceCents].
 */
export function prorateCents(
  policy: DuesPolicy,
  fullPriceCents: number,
  startDate: string
): number {
  const full = Math.max(0, Math.round(fullPriceCents) || 0);
  if (policy.proration === "none" || policy.termMode === "anniversary" || full === 0) {
    return full;
  }
  const start = parseOrThrow(startDate, "start date");
  const startDay = dayStart(start);
  const { termStart } = anchorWindow(policy, startDay);
  const duration = policy.durationMonths;

  let cents: number;
  if (policy.proration === "half_year") {
    const midpoint = addMonthsClamped(termStart, Math.floor(duration / 2));
    cents = startDay >= midpoint ? Math.ceil(full / 2) : full;
  } else {
    // Whole anchor-months already gone by the time they joined.
    let elapsed = 0;
    while (elapsed + 1 < duration && addMonthsClamped(termStart, elapsed + 1) <= startDay) {
      elapsed++;
    }
    const monthsRemaining = duration - elapsed;
    cents = Math.ceil((full * monthsRemaining) / duration);
  }
  return Math.min(full, Math.max(0, cents));
}

/** "July 1" for {month: 7, day: 1}, clamped for the label year. */
function labelFor(month: number, day: number): string {
  const t = new Date(anchorInYear(LABEL_YEAR, month, day));
  return `${MONTH_NAMES[t.getUTCMonth()]} ${t.getUTCDate()}`;
}

function labelForUtc(utcMs: number): string {
  const t = new Date(utcMs);
  return `${MONTH_NAMES[t.getUTCMonth()]} ${t.getUTCDate()}`;
}

/**
 * The policy in plain words, shown under the radio buttons in the Levels
 * editor as the officer clicks and mirrored character-for-character in
 * public/admin.html (see the DUES POLICY block there; src/lib/dues.test.ts
 * runs one table through both copies).
 */
export function describePolicy(policy: DuesPolicy): string {
  const parts: string[] = [];

  if (policy.termMode === "anniversary") {
    const n = policy.durationMonths;
    parts.push(
      `The membership year starts the day someone joins and runs ${n} ${n === 1 ? "month" : "months"}.`
    );
  } else {
    const { month, day } = policyAnchor(policy);
    const anchorUtc = anchorInYear(LABEL_YEAR, month, day);
    parts.push(
      `The membership year runs ${labelFor(month, day)} to ${labelForUtc(anchorUtc - 24 * 60 * 60 * 1000)}.`
    );
    if (policy.proration === "half_year") {
      const midpoint = labelForUtc(addMonthsClamped(anchorUtc, Math.floor(policy.durationMonths / 2)));
      parts.push(`Someone who joins on or after ${midpoint} pays half for their first year.`);
      parts.push("Renewals always cost the full price.");
    } else if (policy.proration === "monthly") {
      parts.push("A new member pays only for the months left in the year.");
      parts.push("Renewals always cost the full price.");
    } else {
      parts.push("Everyone pays the full price, whenever they join.");
    }
  }

  if (policy.graceDays > 0) {
    parts.push(
      `Memberships stay active for ${policy.graceDays} ${policy.graceDays === 1 ? "day" : "days"} after they end.`
    );
  }

  return parts.join(" ");
}

/**
 * The moment a membership on this policy actually lapses: its end date plus
 * the grace period. With grace_days = 0 (every level that predates 0030)
 * this is the end date itself, which is exactly what the nightly job
 * compared against before.
 */
export function lapseDate(policy: DuesPolicy, endDate: string): string {
  const end = parseOrThrow(endDate, "end date");
  if (!policy.graceDays) return end.toISOString();
  return new Date(end.getTime() + policy.graceDays * 24 * 60 * 60 * 1000).toISOString();
}
