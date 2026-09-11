// Capacity on the public site.
//
// Guilds cap classes and retreats. Until now the cap was enforced but never
// shown: the site put a Register button on a full event, the member filled in
// the form, and the conditional INSERT in POST /register refused the seat.
// These tests hold the two halves together — what the page SAYS about spots,
// and what registration will actually ALLOW.
import { describe, it, expect } from "vitest";
import { renderSection } from "./sections/render";
import { fixtureContext, fixtureData } from "./sections/fixtures";
import { SEAT_COUNT_SQL, SEAT_COUNT_CORRELATED_SQL } from "../fulfillment";
import type { SiteEvent } from "./data.types";
import type { Section } from "./sections/schema";
import { DEFAULT_STYLE } from "./sections/schema";

function render(events: SiteEvent[], variant: "cards" | "list" | "next_up" = "cards"): string {
  const section = {
    type: "events",
    variant,
    heading: "Events",
    style: DEFAULT_STYLE,
    id: "ev",
  } as unknown as Section;
  return renderSection(section, fixtureContext({ data: { ...fixtureData, events } }));
}

const base: SiteEvent = {
  id: "ev1",
  title: "Paper piecing workshop",
  start_at: "2026-10-01T09:00:00",
  end_at: null,
  location: "Studio",
  description: "A full day class.",
  member_price_cents: 4500,
  non_member_price_cents: 5500,
  registration_open: 1,
  capacity: null,
};

describe("the seat count shown and the seat count enforced are one expression", () => {
  // The whole point of the correlated copy is that it counts a seat exactly
  // the way the registration guard does. If someone widens one predicate and
  // not the other, the site starts promising seats registration will refuse.
  const normalize = (sql: string) =>
    sql.replace(/event_id = \S+ AND tenant_id = \S+/, "SCOPE").replace(/\s+/g, " ").trim();

  it("the read-path expression matches the write-path expression", () => {
    expect(normalize(SEAT_COUNT_CORRELATED_SQL)).toBe(normalize(SEAT_COUNT_SQL));
  });

  it("both count confirmed, checked-in and unexpired held seats", () => {
    for (const sql of [SEAT_COUNT_SQL, SEAT_COUNT_CORRELATED_SQL]) {
      expect(sql).toContain("'registered'");
      expect(sql).toContain("'checked_in'");
      expect(sql).toContain("pending_payment");
      expect(sql).toContain("hold_expires_at");
    }
  });
});

describe("events with limited space", () => {
  it("shows both numbers, not just the remainder", () => {
    // "8 left" does not say whether the room holds 10 or 200.
    const html = render([{ ...base, capacity: 20, seats_taken: 12 }]);
    expect(html).toContain("8 of 20 spots left");
  });

  it("marks an event nearly gone so it reads differently from a half-empty one", () => {
    expect(render([{ ...base, capacity: 20, seats_taken: 17 }])).toContain("qh-event__spots--low");
    expect(render([{ ...base, capacity: 20, seats_taken: 5 }])).not.toContain("qh-event__spots--low");
  });

  it("replaces Register with Full once the seats are gone", () => {
    const full = render([{ ...base, capacity: 16, seats_taken: 16 }]);
    expect(full).toContain("Full — 16 spots");
    expect(full).not.toContain("data-register=");
    // The event is still readable; only the action goes.
    expect(full).toContain("Details");
  });

  it("never shows a negative count when a hold pushes the count over", () => {
    const over = render([{ ...base, capacity: 10, seats_taken: 13 }]);
    expect(over).toContain("Full");
    expect(over).not.toMatch(/-\d+ of/);
  });

  it("says nothing at all for an event with no cap", () => {
    const html = render([{ ...base, capacity: null, seats_taken: 99 }]);
    expect(html).not.toContain("qh-event__spots");
    expect(html).toContain("data-register=");
  });

  it("says nothing when the loader did not fetch a seat count", () => {
    // A capacity with no count is not enough to claim a number.
    const html = render([{ ...base, capacity: 20 }]);
    expect(html).not.toContain("spots left");
    expect(html).toContain("data-register=");
  });

  it("keeps Register off an event whose registration is closed, cap or no cap", () => {
    expect(render([{ ...base, registration_open: 0, capacity: 20, seats_taken: 1 }])).not.toContain("data-register=");
    expect(render([{ ...base, registration_open: 0 }])).not.toContain("data-register=");
  });

  it("shows the line in every events layout", () => {
    for (const variant of ["cards", "list", "next_up"] as const) {
      expect(render([{ ...base, capacity: 20, seats_taken: 12 }], variant), variant).toContain("8 of 20 spots left");
    }
  });
});
