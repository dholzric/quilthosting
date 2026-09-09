// src/lib/site/timezone.ts
// The time zone a guild's event times are displayed in.
//
// Event times are stored as UTC instants — the admin converts what the
// officer typed with toISOString() — so every screen that shows one has to
// name a zone. A guild sets its own in Settings → Guild, and the first-run
// wizard fills it in from the creator's browser, so this default only applies
// to a guild that has never said.
//
// It is deliberately NOT "UTC". UTC is nobody's clock: it published a 12:25 pm
// meeting as 5:25 pm, which is worse than a considered guess. QuiltHosting is
// a Texas company and its guilds are US-central far more often than not, so
// Central is the guess that is right most often and off by an hour or two
// when it is wrong.
//
// Date-only values (a membership end date, a month label) are not instants and
// are still formatted in UTC; shifting those would roll the day backwards.

/** IANA zone used when a guild has not chosen one. */
export const DEFAULT_TIMEZONE = "America/Chicago";

/** `settings.timezone`, or the default when unset or unreadable. */
export function readTimeZone(settingsJson: string | null | undefined): string {
  try {
    const tz = (JSON.parse(settingsJson || "{}") || {}).timezone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}
