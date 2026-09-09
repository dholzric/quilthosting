import { describe, it, expect } from "vitest";
import { systemPageSections, formatEventWhen, descriptionToHtml, googleCalendarUrl, eventIcsPath, DONATE_AMOUNTS_CENTS } from "./system";
import type { SystemPageKind } from "./system";
import { DEFAULT_DESIGN } from "../design/tokens";
import type { Tenant } from "../../../types";
import type { SiteData, SiteEvent } from "../data.types";

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "t1",
    name: "Hill Country Quilt Guild",
    slug: "hillcountry",
    custom_domain: null,
    tenant_type: "guild",
    public_launched: 0,
    stripe_account_id: null,
    plan: "free",
    status: "active",
    settings_json: JSON.stringify({ timezone: "UTC" }),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Tenant;
}

const event: SiteEvent = {
  id: "ev_ABC123",
  title: "October Workshop: Paper Piecing",
  start_at: "2026-10-03T15:00:00Z",
  end_at: "2026-10-03T18:00:00Z",
  location: "Community Center, Room B",
  description: 'Bring your rotary cutter & a 12" ruler.\n\nLunch is on your own.',
  member_price_cents: 0,
  non_member_price_cents: 1500,
  registration_open: 1,
  capacity: 20,
};

function page(kind: SystemPageKind, data: SiteData = {}, param?: string, t: Tenant = tenant()) {
  return systemPageSections(kind, { tenant: t, design: DEFAULT_DESIGN, data, param });
}

const types = (r: { sections: { type: string }[] }) => r.sections.map((s) => s.type);

describe("systemPageSections: membership", () => {
  it("stacks hero + membership_levels + join_band, subtitle from profile", () => {
    const r = page("membership", { profile: { description: "A guild of 120 quilters in the Texas Hill Country." } });
    expect(r.title).toBe("Membership");
    expect(types(r)).toEqual(["hero", "membership_levels", "join_band"]);
    const hero = r.sections[0];
    if (hero.type !== "hero") throw new Error("hero");
    expect(hero.variant).toBe("minimal");
    expect(hero.title).toBe("Membership");
    expect(hero.subtitle).toBe("A guild of 120 quilters in the Texas Hill Country.");
    expect(r.status).toBeUndefined();
    expect(r.noindex).toBeUndefined();
  });

  it("inserts a faq when settings.membership_faq has items", () => {
    const t = tenant({
      settings_json: JSON.stringify({
        membership_faq: [
          { q: "When do dues renew?", a: "Every January." },
          { q: "Can I try a meeting first?", a: "Yes, <b>guests</b> are welcome once.<script>x()</script>" },
          { q: "", a: "dropped" },
        ],
      }),
    });
    const r = page("membership", {}, undefined, t);
    expect(types(r)).toEqual(["hero", "membership_levels", "faq", "join_band"]);
    const faq = r.sections[2];
    if (faq.type !== "faq") throw new Error("faq");
    expect(faq.items).toHaveLength(2);
    expect(faq.items[1].a).toContain("<b>guests</b>");
    expect(faq.items[1].a).not.toContain("<script");
  });

  it("has a plain subtitle when no profile description", () => {
    const r = page("membership");
    const hero = r.sections[0];
    if (hero.type !== "hero") throw new Error("hero");
    expect(hero.subtitle).toContain("Hill Country Quilt Guild");
  });
});

describe("systemPageSections: events / calendar", () => {
  it("events: hero + events list (limit 50) + calendar link", () => {
    const r = page("events");
    expect(r.title).toBe("Events");
    expect(types(r)).toEqual(["hero", "events", "cta"]);
    const list = r.sections[1];
    if (list.type !== "events") throw new Error("events");
    expect(list.variant).toBe("list");
    expect(list.limit).toBe(50);
    const cta = r.sections[2];
    if (cta.type !== "cta") throw new Error("cta");
    expect(cta.href).toBe("/calendar");
    expect(cta.kind).toBe("secondary");
  });

  it("calendar: a single events section in calendar variant", () => {
    const r = page("calendar");
    expect(r.title).toBe("Calendar");
    expect(types(r)).toEqual(["events"]);
    const cal = r.sections[0];
    if (cal.type !== "events") throw new Error("events");
    expect(cal.variant).toBe("calendar");
    expect(cal.heading).toBe("Calendar");
  });
});

describe("systemPageSections: event detail", () => {
  it("hero + rich_text + calendar links + pricing grid + register cta with the register-<id> convention", () => {
    const r = page("event", { events: [event] }, event.id);
    expect(r.title).toBe(event.title);
    expect(types(r)).toEqual(["hero", "rich_text", "rich_text", "feature_grid", "cta"]);

    const hero = r.sections[0];
    if (hero.type !== "hero") throw new Error("hero");
    expect(hero.variant).toBe("minimal");
    expect(hero.title).toBe(event.title);
    expect(hero.subtitle).toContain("October 3, 2026");
    expect(hero.subtitle).toContain("3:00 PM");
    expect(hero.subtitle).toContain("6:00 PM");
    expect(hero.subtitle).toContain("Community Center, Room B");

    const body = r.sections[1];
    if (body.type !== "rich_text") throw new Error("rich_text");
    expect(body.variant).toBe("prose");
    // sanitizeHtml canonicalizes text-node entities: `&amp;` stays, a quote is emitted literally.
    expect(body.html).toBe('<p>Bring your rotary cutter &amp; a 12" ruler.</p><p>Lunch is on your own.</p>');

    const grid = r.sections[3];
    if (grid.type !== "feature_grid") throw new Error("feature_grid");
    expect(grid.variant).toBe("icons");
    expect(grid.items.map((i) => [i.title, i.price])).toEqual([
      ["Members", "Free"],
      ["Non-members", "$15.00"],
    ]);

    const cta = r.sections[4];
    if (cta.type !== "cta") throw new Error("cta");
    expect(cta.label).toBe("Register");
    expect(cta.href).toBe("#");
    expect(cta.kind).toBe("primary");
    expect(cta.id).toBe("register-ev_ABC123");
  });

  it("calendar links: an origin-relative .ics download and a Google Calendar template URL, as secondary buttons", () => {
    const r = page("event", { events: [event] }, event.id);
    const links = r.sections[2];
    if (links.type !== "rich_text") throw new Error("rich_text");
    expect(links.id).toBe("event-calendar");
    expect(links.html).toContain('<a class="qh-btn qh-btn--secondary" href="/public/hillcountry/events/ev_ABC123/ics">Add to calendar</a>');
    expect(links.html).toContain(
      'href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=October%20Workshop%3A%20Paper%20Piecing&amp;dates=20261003T150000Z/20261003T180000Z&amp;location=Community%20Center%2C%20Room%20B&amp;details='
    );
    expect(links.html).toContain('target="_blank" rel="noopener noreferrer">Google Calendar</a>');
    // Sanitized like any rich_text: no id, no data-*, class kept.
    expect(links.html).not.toContain("<script");
  });

  it("volunteer block only when the event has volunteer slots: rich_text 'Volunteer' + cta volunteer-<id>", () => {
    const without = page("event", { events: [{ ...event, volunteer_slots: 0 }] }, event.id);
    expect(types(without)).toEqual(["hero", "rich_text", "rich_text", "feature_grid", "cta"]);
    const r = page("event", { events: [{ ...event, volunteer_slots: 3 }] }, event.id);
    expect(types(r)).toEqual(["hero", "rich_text", "rich_text", "feature_grid", "cta", "rich_text", "cta"]);
    const block = r.sections[5];
    if (block.type !== "rich_text") throw new Error("rich_text");
    expect(block.heading).toBe("Volunteer");
    expect(block.html).toContain("<p>");
    const cta = r.sections[6];
    if (cta.type !== "cta") throw new Error("cta");
    expect(cta.id).toBe("volunteer-ev_ABC123");
    expect(cta.href).toBe("#");
    expect(cta.kind).toBe("secondary");
  });

  it("omits the description rich_text when the event has none and the register cta when registration is closed", () => {
    const r = page("event", { events: [{ ...event, description: null, registration_open: 0 }] }, event.id);
    expect(types(r)).toEqual(["hero", "rich_text", "feature_grid"]);
  });

  it("falls back to not_found (404) when the event is missing", () => {
    const r = page("event", { events: [event] }, "nope");
    expect(r.status).toBe(404);
    expect(r.title).toBe("Page not found");
  });

  it("subtitle omits the end time and location when absent", () => {
    const r = page("event", { events: [{ ...event, end_at: null, location: null }] }, event.id);
    const hero = r.sections[0];
    if (hero.type !== "hero") throw new Error("hero");
    expect(hero.subtitle).not.toContain("–");
    expect(hero.subtitle).not.toContain("Community");
  });
});

describe("systemPageSections: galleries / gallery", () => {
  it("galleries: hero + linked cards from data", () => {
    const r = page("galleries", {
      galleries: [
        { slug: "show-2025", title: "2025 Quilt Show", cover_photo_id: "f1", count: 42 },
        { slug: "retreat", title: "Spring Retreat", cover_photo_id: null, count: 1 },
      ],
    });
    expect(r.title).toBe("Galleries");
    expect(types(r)).toEqual(["hero", "feature_grid"]);
    const grid = r.sections[1];
    if (grid.type !== "feature_grid") throw new Error("feature_grid");
    expect(grid.variant).toBe("cards");
    expect(grid.items.map((i) => [i.title, i.href, i.body])).toEqual([
      ["2025 Quilt Show", "/galleries/show-2025", "42 photos"],
      ["Spring Retreat", "/galleries/retreat", "1 photo"],
    ]);
  });

  it("galleries: explains when there are none yet", () => {
    const r = page("galleries", { galleries: [] });
    expect(types(r)).toEqual(["hero", "rich_text"]);
  });

  it("gallery: hero + gallery grid from photos + back link", () => {
    const r = page(
      "gallery",
      {
        gallery: {
          slug: "show-2025",
          title: "2025 Quilt Show",
          description: "Ribbon winners and member entries.",
          photos: [
            { id: "p1", caption: "Best in Show" },
            { id: "p2", caption: null },
          ],
        },
      },
      "show-2025"
    );
    expect(r.title).toBe("2025 Quilt Show");
    expect(types(r)).toEqual(["hero", "gallery", "cta"]);
    const hero = r.sections[0];
    if (hero.type !== "hero") throw new Error("hero");
    expect(hero.subtitle).toBe("Ribbon winners and member entries.");
    const g = r.sections[1];
    if (g.type !== "gallery") throw new Error("gallery");
    expect(g.variant).toBe("grid");
    expect(g.source).toBe("gallery");
    expect(g.gallerySlug).toBe("show-2025");
    expect(g.items).toEqual([
      { imageId: "p1", alt: "Best in Show", caption: "Best in Show" },
      { imageId: "p2", alt: "2025 Quilt Show", caption: undefined },
    ]);
    const cta = r.sections[2];
    if (cta.type !== "cta") throw new Error("cta");
    expect(cta.href).toBe("/galleries");
  });

  it("gallery: 404 when the slug does not match the loaded gallery", () => {
    const r = page("gallery", { gallery: { slug: "a", title: "A", description: null, photos: [] } }, "b");
    expect(r.status).toBe(404);
  });
});

describe("systemPageSections: blog / post", () => {
  it("blog: hero + blog_teaser limit 50", () => {
    const r = page("blog");
    expect(r.title).toBe("Blog");
    expect(types(r)).toEqual(["hero", "blog_teaser"]);
    const bt = r.sections[1];
    if (bt.type !== "blog_teaser") throw new Error("blog_teaser");
    expect(bt.limit).toBe(50);
  });

  it("post: hero (title, date) + rich_text lede from the excerpt", () => {
    const r = page(
      "post",
      { posts: [{ slug: "show-recap", title: "Show recap", published_at: "2026-05-02T12:00:00Z", excerpt: "Thanks to all 300 <visitors>." }] },
      "show-recap"
    );
    expect(r.title).toBe("Show recap");
    expect(types(r)).toEqual(["hero", "rich_text"]);
    const hero = r.sections[0];
    if (hero.type !== "hero") throw new Error("hero");
    expect(hero.subtitle).toContain("May 2, 2026");
    const lede = r.sections[1];
    if (lede.type !== "rich_text") throw new Error("rich_text");
    expect(lede.html).toBe("<p>Thanks to all 300 &lt;visitors&gt;.</p>");
  });

  it("post: hero only when the excerpt is empty", () => {
    const r = page("post", { posts: [{ slug: "s", title: "S", published_at: "2026-05-02T12:00:00Z", excerpt: "" }] }, "s");
    expect(types(r)).toEqual(["hero"]);
  });

  it("post: 404 when the slug is unknown", () => {
    expect(page("post", { posts: [] }, "missing").status).toBe(404);
  });
});

describe("systemPageSections: directory", () => {
  const members = [
    { id: "m1", first_name: "Ada", last_name: "Lovelace", bio: "Paper piecing & EPP.", photo_file_id: "f-ada", showcase: { headline: "Modern <quilter>", interests: "Hand quilting", website: "https://ada.example" } },
    { id: "m2", first_name: null, last_name: null, bio: null, photo_file_id: null, showcase: { website: "javascript:alert(1)" } },
  ];

  it("renders the members-only stack when the directory is not public", () => {
    const r = page("directory", { profile: { directory_public: false }, directory: members });
    expect(r.title).toBe("Members only");
    expect(r.noindex).toBe(true);
    expect(r.rawHtml).toBeUndefined();
    expect(page("directory", { directory: members }).title).toBe("Members only");
  });

  it("public: hero + rawHtml list with a search box, escaped names, photo, showcase fields, safe website only", () => {
    const r = page("directory", { profile: { directory_public: true }, directory: members });
    expect(r.title).toBe("Members");
    expect(r.noindex).toBeUndefined();
    expect(types(r)).toEqual(["hero"]);
    const raw = r.rawHtml ?? "";
    expect(raw).toContain('<section id="directory" class="qh-s ');
    expect(raw).toContain('<input type="search" data-directory-filter="directory-list"');
    expect(raw).toContain('data-directory-count>2 members</p>');
    expect(raw).toContain('id="directory-list"');
    expect(raw).toContain('<h3 class="qh-directory__name">Ada Lovelace</h3>');
    expect(raw).toContain('src="/public/hillcountry/member-photo/f-ada"');
    expect(raw).toContain("Modern &lt;quilter&gt;");
    expect(raw).toContain("Paper piecing &amp; EPP.");
    expect(raw).toContain("<strong>Interests:</strong> Hand quilting");
    expect(raw).toContain('<a href="https://ada.example" target="_blank" rel="noopener nofollow">Website</a>');
    expect(raw).toContain('<h3 class="qh-directory__name">Member</h3>');
    expect(raw).not.toContain("javascript:");
    expect((raw.match(/qh-directory__member/g) ?? []).length).toBe(2);
  });

  it("public but empty: explains instead of an empty grid", () => {
    const r = page("directory", { profile: { directory_public: true }, directory: [] });
    expect(types(r)).toEqual(["hero", "rich_text"]);
    expect(r.rawHtml).toBeUndefined();
  });
});

describe("systemPageSections: donate", () => {
  it("hero + where gifts go + a donate section with the suggested amounts, id 'donate'", () => {
    const r = page("donate", { profile: { description: "A guild of 120 quilters.", donations_enabled: true } });
    expect(r.title).toBe("Donate");
    expect(types(r)).toEqual(["hero", "rich_text", "donate"]);
    const hero = r.sections[0];
    if (hero.type !== "hero") throw new Error("hero");
    expect(hero.title).toBe("Support Hill Country Quilt Guild");
    const body = r.sections[1];
    if (body.type !== "rich_text") throw new Error("rich_text");
    expect(body.html).toContain("A guild of 120 quilters.");
    const strip = r.sections[2];
    if (strip.type !== "donate") throw new Error("donate");
    expect(strip.id).toBe("donate");
    expect(strip.amounts).toEqual([...DONATE_AMOUNTS_CENTS]);
    expect(strip.amounts).toEqual([1000, 2500, 5000, 10000]);
  });

  it("falls back to guild copy without a description and 404s when donations are off", () => {
    const r = page("donate", {});
    const body = r.sections[1];
    if (body.type !== "rich_text") throw new Error("rich_text");
    expect(body.html).toContain("Hill Country Quilt Guild is run by volunteers");
    expect(page("donate", { profile: { donations_enabled: false } }).status).toBe(404);
  });
});

describe("systemPageSections: members_only / not_found", () => {
  it("members_only: hero + rich_text + sign-in cta, noindex", () => {
    const r = page("members_only");
    expect(r.title).toBe("Members only");
    expect(r.noindex).toBe(true);
    expect(r.status).toBeUndefined();
    expect(types(r)).toEqual(["hero", "rich_text", "cta"]);
    const cta = r.sections[2];
    if (cta.type !== "cta") throw new Error("cta");
    expect(cta.label).toBe("Member sign-in");
    expect(cta.href).toBe("/portal?slug=hillcountry");
    expect(cta.kind).toBe("primary");
  });

  it("not_found: hero + home cta, status 404", () => {
    const r = page("not_found");
    expect(r.title).toBe("Page not found");
    expect(r.status).toBe(404);
    expect(types(r)).toEqual(["hero", "cta"]);
    const cta = r.sections[1];
    if (cta.type !== "cta") throw new Error("cta");
    expect(cta.href).toBe("/");
  });
});

describe("invariants", () => {
  const kinds: SystemPageKind[] = ["membership", "events", "event", "calendar", "galleries", "gallery", "blog", "post", "directory", "donate", "members_only", "not_found"];
  const data: SiteData = {
    events: [{ ...event, volunteer_slots: 2 }],
    posts: [{ slug: "p", title: "P", published_at: "2026-01-01T00:00:00Z", excerpt: "x" }],
    gallery: { slug: "g", title: "G", description: null, photos: [] },
    galleries: [],
    profile: { directory_public: true, donations_enabled: true },
    directory: [{ id: "m1", first_name: "Ada", last_name: null, bio: null, photo_file_id: null, showcase: {} }],
  };
  const paramFor = (kind: SystemPageKind) => (kind === "event" ? event.id : kind === "post" ? "p" : kind === "gallery" ? "g" : undefined);

  it("every section has a unique id and a complete style", () => {
    for (const kind of kinds) {
      const r = page(kind, data, paramFor(kind));
      expect(r.sections.length, kind).toBeGreaterThan(0);
      const ids = r.sections.map((s) => s.id);
      expect(new Set(ids).size, kind).toBe(ids.length);
      for (const s of r.sections) {
        expect(s.id, kind).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(Object.keys(s.style).sort()).toEqual(["align", "bg", "media", "spacing", "width"]);
      }
    }
  });

  it("never mutates DEFAULT_STYLE", () => {
    const r = page("membership");
    const style = r.sections[0].style as unknown as Record<string, string>;
    style.bg = "dark";
    expect(page("membership").sections[0].style.bg).not.toBe("dark");
  });

  it("copy contains no lorem", () => {
    for (const kind of kinds) {
      const r = page(kind, data, paramFor(kind));
      expect(JSON.stringify(r).toLowerCase(), kind).not.toContain("lorem");
    }
  });

  it("tolerates unparseable settings_json", () => {
    const r = page("membership", {}, undefined, tenant({ settings_json: "{not json" }));
    expect(types(r)).toEqual(["hero", "membership_levels", "join_band"]);
  });
});

describe("helpers", () => {
  it("formatEventWhen respects the tenant timezone", () => {
    expect(formatEventWhen(event, "America/Chicago")).toBe(
      "Saturday, October 3, 2026 · 10:00 AM – 1:00 PM · Community Center, Room B"
    );
    expect(formatEventWhen({ ...event, end_at: null, location: null }, "UTC")).toBe("Saturday, October 3, 2026 · 3:00 PM");
  });

  it("formatEventWhen spells out both dates for a multi-day event", () => {
    const s = formatEventWhen({ ...event, end_at: "2026-10-04T18:00:00Z", location: null }, "UTC");
    expect(s).toBe("Saturday, October 3, 2026, 3:00 PM – Sunday, October 4, 2026, 6:00 PM");
  });

  it("formatEventWhen survives an invalid timezone and an invalid date", () => {
    expect(formatEventWhen(event, "Not/AZone")).toContain("October 3, 2026");
    expect(formatEventWhen({ ...event, start_at: "garbage" }, "UTC")).toBe("Community Center, Room B");
  });

  it("googleCalendarUrl uses UTC basic dates, a 2-hour default end, and null for a bad start", () => {
    expect(googleCalendarUrl({ ...event, end_at: null, location: null, description: null })).toBe(
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=October%20Workshop%3A%20Paper%20Piecing&dates=20261003T150000Z/20261003T170000Z"
    );
    expect(googleCalendarUrl({ ...event, start_at: "garbage" })).toBeNull();
    expect(eventIcsPath("hill country", "ev/1")).toBe("/public/hill%20country/events/ev%2F1/ics");
  });

  it("descriptionToHtml escapes, wraps paragraphs on blank lines and keeps single newlines as breaks", () => {
    expect(descriptionToHtml("a <b>\nb\n\n\nc")).toBe("<p>a &lt;b&gt;<br>b</p><p>c</p>");
    expect(descriptionToHtml("   ")).toBe("");
    expect(descriptionToHtml("win\r\nline\r\n\r\ntwo")).toBe("<p>win<br>line</p><p>two</p>");
  });
});
