// Starter website seeded for every new guild at POST /api/tenants.
//
// A brand-new guild used to land on an empty public site; these five pages
// give the admin something real to preview and edit on day one. Every block
// type used here is one the guild website builder in public/admin.html can
// render in its canvas (heading, text, button, divider, join_cta, spacer) --
// hero/faq/contact_form are business-site blocks that the guild builder only
// shows as a bare type name, and contact_form needs a `forms` row that does
// not exist yet.
//
// Slugs deliberately avoid guild.html's built-in routes ("join", "membership",
// "events", "calendar", "galleries", "photos"): a CMS page with one of those
// slugs is never rendered (applyRoute() handles the built-in first) and only
// adds a duplicate nav link. So "Join" lives at /why-join and "Events" at
// /meetings, next to the built-in Membership and Events views.
//
// Every prose block starts with SAMPLE_MARKER so the onboarding checklist can
// tell, from the database alone, whether the admin has replaced the sample
// copy yet (src/lib/onboarding.ts).

import { blocksToHtml, escapeHtml, parseBlocks, type PageBlock, type SiteTheme } from "./blocks";

/** Visible prefix on every sample paragraph. Detected with a LIKE in onboarding.ts. */
export const SAMPLE_MARKER = "Sample text — replace me:";

export type StarterPage = {
  slug: string;
  title: string;
  sort_order: number;
  blocks: PageBlock[];
};

export type StarterSiteInput = {
  /** Optional "City, ST" shown on Home and Contact. */
  city?: string | null;
  /** Optional free-text meeting schedule shown on Home and Meetings. */
  meetingInfo?: string | null;
};

/** Default guild theme in the legacy {primary, style, font} shape guild.html reads. */
export const STARTER_THEME: SiteTheme = {
  primary: "#b5501f",
  style: "classic",
  font: "system",
};

function sample(html: string): PageBlock {
  return { type: "text", html: `<p><em>${escapeHtml(SAMPLE_MARKER)}</em> ${html}</p>` };
}

export function starterPages(guildName: string, input: StarterSiteInput = {}): StarterPage[] {
  const name = escapeHtml(String(guildName || "our guild").trim() || "our guild");
  const city = escapeHtml(String(input.city || "").trim());
  const meeting = escapeHtml(String(input.meetingInfo || "").trim());
  const where = city ? ` in ${city}` : "";
  const meetingLine = meeting
    ? `We meet ${meeting}.`
    : "We meet on the second Tuesday of every month at 6:30 pm at the community center.";

  const raw: StarterPage[] = [
    {
      slug: "home",
      title: "Home",
      sort_order: 0,
      blocks: [
        { type: "heading", text: `Welcome to ${guildName}`, level: 1 },
        sample(
          `${name} is a community of quilters${where} who share a love of fabric, color, and craft. Whether you have been quilting for decades or are threading your first needle, you are welcome here.`
        ),
        sample(`${meetingLine} Guests are always welcome at their first meeting.`),
        {
          type: "join_cta",
          title: "Become a member",
          body: `${SAMPLE_MARKER} Membership includes monthly meetings, workshops, our newsletter, and a friendly group of quilters who are happy to help.`,
        },
      ],
    },
    {
      slug: "about",
      title: "About",
      sort_order: 1,
      blocks: [
        { type: "heading", text: `About ${guildName}`, level: 1 },
        sample(
          `Tell your story here. When was the guild founded, and by whom? What kinds of quilting do members enjoy — traditional, modern, art quilts, hand piecing?`
        ),
        { type: "heading", text: "What we do", level: 3 },
        sample(
          `Monthly programs with guest speakers, hands-on workshops, charity quilts for local hospitals and shelters, an annual quilt show, and retreats.`
        ),
        { type: "divider" },
        { type: "heading", text: "Our leadership", level: 3 },
        sample(`List your officers and committee chairs here so members know who to contact.`),
      ],
    },
    {
      slug: "why-join",
      title: "Why Join",
      sort_order: 2,
      blocks: [
        { type: "heading", text: `Why join ${guildName}?`, level: 1 },
        sample(
          `Members get monthly meetings and programs, discounted workshops, a lending library of books and rulers, our members-only newsletter, and the chance to show quilts in our annual show.`
        ),
        sample(
          `Dues are collected once a year. Choose a membership level below and pay online — you will receive a welcome email with everything you need to get started.`
        ),
        {
          type: "join_cta",
          title: "Ready to join?",
          body: `${SAMPLE_MARKER} Pick a membership level and you will be on the roster in minutes.`,
        },
      ],
    },
    {
      slug: "meetings",
      title: "Meetings",
      sort_order: 3,
      blocks: [
        { type: "heading", text: "Meetings & events", level: 1 },
        sample(`${meetingLine} Doors open thirty minutes early for show-and-tell setup and socializing.`),
        sample(
          `Describe a typical meeting: business updates, a program or speaker, show-and-tell, and door prizes. Add parking or accessibility notes here too.`
        ),
        { type: "button", label: "See upcoming events", href: "events", style: "secondary" },
      ],
    },
    {
      slug: "contact",
      title: "Contact",
      sort_order: 4,
      blocks: [
        { type: "heading", text: "Contact us", level: 1 },
        sample(
          `Email us at <a href="mailto:hello@example.com">hello@example.com</a> or come say hello at our next meeting${where}.`
        ),
        sample(`Mailing address: ${name}, P.O. Box 000, ${city || "Your Town, ST 00000"}.`),
        { type: "spacer", height: 16 },
        sample(`Follow us on Facebook and Instagram — add your links here.`),
      ],
    },
  ];
  // Round-trip through parseBlocks so what we persist is exactly what the
  // page editor would have written (field clamping, defaults), and a typo in
  // a block above surfaces as a dropped block in starterSite.test.ts.
  return raw.map((p) => ({ ...p, blocks: parseBlocks(p.blocks) }));
}

/** Column-order-matched row values for the `INSERT INTO pages` in tenants.ts. */
export function starterPageRow(page: StarterPage): {
  slug: string;
  title: string;
  content_json: string;
  blocks_json: string;
  sort_order: number;
} {
  return {
    slug: page.slug,
    title: page.title,
    content_json: JSON.stringify({ html: blocksToHtml(page.blocks) }),
    blocks_json: JSON.stringify(page.blocks),
    sort_order: page.sort_order,
  };
}

/** settings_json for a freshly created guild. */
export function starterSettingsJson(): string {
  return JSON.stringify({ theme: STARTER_THEME });
}
