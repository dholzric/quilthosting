// src/lib/site/timezone.test.ts
//
// Event times are stored as UTC instants, so a guild that has never chosen a
// zone still needs one to display them in. UTC is nobody's clock — it printed
// a 12:25 pm meeting as 5:25 pm on a live guild's site — so the default is
// Central, which is right for most of these guilds and off by an hour or two
// when it is not.
import { describe, it, expect } from "vitest";
import { DEFAULT_TIMEZONE, readTimeZone } from "./timezone";
import { formatEventDate } from "./sections/render";

describe("the default display time zone", () => {
  it("is Central, not UTC", () => {
    expect(DEFAULT_TIMEZONE).toBe("America/Chicago");
  });

  it("is what a guild with no setting gets", () => {
    for (const settings of [null, undefined, "", "{oops", "{}", '{"timezone":""}', '{"timezone":"   "}', "[]"]) {
      expect(readTimeZone(settings), String(settings)).toBe(DEFAULT_TIMEZONE);
    }
  });

  it("never overrides a guild's own choice", () => {
    expect(readTimeZone('{"timezone":"America/New_York"}')).toBe("America/New_York");
    expect(readTimeZone('{"timezone":" Europe/London "}')).toBe("Europe/London");
  });

  it("turns the stored instant into the hour the officer typed", () => {
    // 12:25 pm entered in Texas is stored as 17:25Z; the site used to print 5:25 PM.
    expect(formatEventDate("2026-09-25T17:25:00.000Z", readTimeZone("{}"))).toBe("Fri, Sep 25 · 12:25 PM");
  });
});
