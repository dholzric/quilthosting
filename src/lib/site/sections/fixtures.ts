/**
 * Sample sections and sample site data for the section renderers.
 *
 * One fixture per section type and per variant, written in real quilt-guild
 * vocabulary (a fictional Hill Country Quilt Guild in Kerrville, TX) so the
 * render tests, the kit preview tooling, and the admin editor's "insert a
 * sample" affordance all exercise realistic copy. Nothing here is shipped to
 * a tenant page automatically; kits carry their own copy under the
 * `SAMPLE_MARKER` rule from `src/lib/starterSite.ts`.
 */

import { DEFAULT_STYLE } from "./schema";
import type { Section, SectionStyle } from "./schema";
import { DEFAULT_DESIGN } from "../design/tokens";
import type { SiteData } from "../data.types";
import type { RenderContext } from "./render";

export type SectionFixture = { name: string; section: Section };

const style = (over: Partial<SectionStyle> = {}): SectionStyle => ({ ...DEFAULT_STYLE, ...over });

// ---------------------------------------------------------------------------
// Sample dynamic data (what Task 6's loaders would hand the renderer)
// ---------------------------------------------------------------------------

export const fixtureData: SiteData = {
  levels: [
    {
      id: "lvl_individual",
      name: "Individual",
      description: "Monthly meetings, the newsletter, library access, and member pricing on workshops.",
      price_cents: 4000,
      duration_months: 12,
      renewal_type: "manual",
    },
    {
      id: "lvl_household",
      name: "Household",
      description: "Two adults at one address. One newsletter, two votes.",
      price_cents: 6000,
      duration_months: 12,
      renewal_type: "manual",
    },
    {
      id: "lvl_student",
      name: "Student",
      description: "Full-time students with a school ID.",
      price_cents: 1500,
      duration_months: 12,
      renewal_type: "auto",
    },
  ],
  events: [
    {
      id: "ev_sept_meeting",
      title: "September guild meeting: Show and tell",
      start_at: "2026-09-12T09:00:00",
      end_at: "2026-09-12T11:30:00",
      location: "First Methodist Church fellowship hall",
      description: "Bring a finished quilt or a top in progress. Coffee at 8:30.",
      member_price_cents: 0,
      non_member_price_cents: 0,
      registration_open: 1,
      capacity: null,
    },
    {
      id: "ev_fpp_workshop",
      title: "Foundation paper piecing workshop with Ann Reyes",
      start_at: "2026-09-26T09:30:00",
      end_at: "2026-09-26T15:30:00",
      location: "Guild studio, 1210 Water St",
      description: "A full-day class. Bring a rotary cutter, a small ruler, and an add-a-quarter ruler.",
      member_price_cents: 4500,
      non_member_price_cents: 6500,
      registration_open: 1,
      capacity: 16,
      seats_taken: 14,
    },
    {
      id: "ev_fall_retreat",
      title: "Fall retreat at Mo-Ranch",
      start_at: "2026-10-16T15:00:00",
      end_at: "2026-10-18T12:00:00",
      location: "Mo-Ranch, Hunt, TX",
      description: "Two nights, three days of uninterrupted sewing. Meals included.",
      member_price_cents: 28500,
      non_member_price_cents: 32500,
      registration_open: 1,
      capacity: 40,
      seats_taken: 31,
    },
  ],
  products: [
    {
      id: "prod_raffle_ticket",
      name: "2026 raffle quilt ticket",
      price_cents: 500,
      description: "One chance at the 2026 opportunity quilt, a 90-inch Ocean Waves in indigo and cream.",
      image_file_id: "img_raffle_2026",
      stock: null,
    },
    {
      id: "prod_guild_pin",
      name: "Guild enamel pin",
      price_cents: 800,
      description: "One-inch hard enamel pin of the guild's Texas Star logo.",
      image_file_id: "img_pin",
      stock: 42,
    },
    {
      id: "prod_show_catalog",
      name: "2025 quilt show catalog",
      price_cents: 1200,
      description: "Full-color catalog of every entry from the 2025 biennial show.",
      image_file_id: null,
      stock: 0,
    },
  ],
  posts: [
    {
      slug: "september-newsletter",
      title: "September newsletter: retreat sign-ups open",
      published_at: "2026-09-01T12:00:00",
      excerpt: "Retreat registration opens to members on the 5th. Also inside: the raffle quilt schedule and a new block of the month.",
    },
    {
      slug: "2025-show-ribbons",
      title: "Ribbon winners from the 2025 show",
      published_at: "2026-08-14T12:00:00",
      excerpt: "Best of Show went to a hand-quilted Baltimore Album that took four years to finish.",
    },
  ],
  galleries: [
    { slug: "2025-quilt-show", title: "2025 quilt show", cover_photo_id: "ph_show_01", count: 48 },
    { slug: "charity-quilts", title: "Charity quilts", cover_photo_id: "ph_charity_01", count: 23 },
  ],
  gallery: {
    slug: "2025-quilt-show",
    title: "2025 quilt show",
    description: "Every entry from the biennial show at the Hill Country Youth Event Center.",
    photos: [
      { id: "ph_show_01", caption: "Best of Show: Baltimore Album, hand quilted" },
      { id: "ph_show_02", caption: "Modern category: Improv curves in solids" },
      { id: "ph_show_03", caption: null },
      { id: "ph_show_04", caption: "Viewer's choice: Dear Jane reproduction" },
    ],
  },
  documents: [
    { id: "doc_bylaws", filename: "HCQG bylaws (revised 2025).pdf", size: 184320 },
    { id: "doc_minutes_aug", filename: "Board minutes, August 2026.pdf", size: 61440 },
    { id: "doc_show_entry", filename: "2027 show entry form.pdf", size: null },
  ],
  profile: {
    description: "A guild of about two hundred quilters in the Texas Hill Country, meeting since 1987.",
    meeting_info: "Second Tuesday of every month, 6:30 PM",
    location: "First Methodist Church, 321 Thompson Dr, Kerrville, TX",
    website: "https://hillcountryquiltguild.org",
    email: "hello@hillcountryquiltguild.org",
    donations_enabled: true,
    directory_public: false,
  },
};

/** A render context over the sample data, on a business-style absolute base URL. */
export function fixtureContext(over: Partial<RenderContext> = {}): RenderContext {
  return {
    slug: "hcqg",
    baseUrl: "https://hillcountryquiltguild.org",
    design: DEFAULT_DESIGN,
    data: fixtureData,
    imgUrl: (id, w) => `https://hillcountryquiltguild.org/img/${id}${w ? `?w=${w}` : ""}`,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Sections: one per type and per variant
// ---------------------------------------------------------------------------

export const SECTION_FIXTURES: SectionFixture[] = [
  // hero -------------------------------------------------------------------
  {
    name: "hero/image",
    section: {
      type: "hero",
      id: "hero-image",
      variant: "image",
      eyebrow: "Kerrville, Texas",
      title: "Hill Country Quilt Guild",
      subtitle: "Two hundred quilters, one meeting a month, and a show every other spring.",
      ctaLabel: "Join the guild",
      ctaHref: "/membership",
      secondaryLabel: "See upcoming events",
      secondaryHref: "/events",
      style: style({ bg: "image", imageId: "hero_show_floor", imageFocal: [0.5, 0.35], align: "left" }),
    },
  },
  {
    name: "hero/split",
    section: {
      type: "hero",
      id: "hero-split",
      variant: "split",
      eyebrow: "Since 1987",
      title: "Come sew with us",
      subtitle: "Guests are welcome at any meeting. Your first one is free.",
      ctaLabel: "Plan a visit",
      ctaHref: "/meetings",
      style: style({ imageId: "hero_meeting", media: "right" }),
    },
  },
  {
    name: "hero/pattern",
    section: {
      type: "hero",
      id: "hero-pattern",
      variant: "pattern",
      title: "2027 Biennial Quilt Show",
      subtitle: "April 9 through 11 at the Hill Country Youth Event Center. Entries open in January.",
      ctaLabel: "Enter a quilt",
      ctaHref: "/show",
      style: style({ bg: "pattern", align: "center", spacing: "airy" }),
    },
  },
  {
    name: "hero/minimal",
    section: {
      type: "hero",
      id: "hero-minimal",
      variant: "minimal",
      title: "Membership",
      subtitle: "Dues run January through December and include every regular meeting.",
      style: style({ align: "center" }),
    },
  },
  {
    name: "hero/stats",
    section: {
      type: "hero",
      id: "hero-stats",
      variant: "stats",
      title: "What we did last year",
      stats: [
        { value: "212", label: "Members" },
        { value: "340", label: "Charity quilts donated" },
        { value: "11", label: "Workshops" },
        { value: "$9,400", label: "Raised for the food bank" },
      ],
      style: style({ bg: "tint", align: "center" }),
    },
  },

  // rich_text --------------------------------------------------------------
  {
    name: "rich_text/prose",
    section: {
      type: "rich_text",
      id: "about-prose",
      variant: "prose",
      heading: "About the guild",
      html:
        "<p>The Hill Country Quilt Guild was organized in 1987 by eleven quilters who met in the back room of a Kerrville fabric shop. Today about two hundred members meet monthly for programs, show and tell, and a lot of coffee.</p>" +
        "<p>We are a 501(c)(3). Charity quilts go to the Kerrville State Hospital, foster families through CASA, and the Kerr County Fire Department.</p>",
      style: style(),
    },
  },
  {
    name: "rich_text/two_column",
    section: {
      type: "rich_text",
      id: "bylaws-summary",
      variant: "two_column",
      heading: "How the guild is run",
      html:
        "<p>Officers are elected each November and serve a calendar year. The board meets the first Monday of the month at 5:30 PM and any member may attend.</p>" +
        "<p>Committees cover programs, workshops, the newsletter, charity quilts, the library, hospitality, and the biennial show. Sign-up sheets circulate at the January meeting.</p>" +
        "<p>Dues are set by the board and approved by a vote of the membership. Current bylaws are available from the secretary.</p>",
      style: style({ width: "wide" }),
    },
  },
  {
    name: "rich_text/with_image",
    section: {
      type: "rich_text",
      id: "history-with-image",
      variant: "with_image",
      heading: "Our first raffle quilt",
      html:
        "<p>The 1989 raffle quilt, a scrappy Ocean Waves, raised $1,140 and paid for the guild's first library shelf. It still hangs in the fellowship hall where we meet.</p>",
      style: style({ imageId: "hist_ocean_waves", media: "left" }),
    },
  },

  // image ------------------------------------------------------------------
  {
    name: "image/single",
    section: {
      type: "image",
      id: "image-single",
      variant: "single",
      items: [{ imageId: "img_raffle_2026", alt: "The 2026 raffle quilt, an Ocean Waves in indigo and cream", caption: "2026 raffle quilt, pieced by the Tuesday bee and quilted by Marla Ortiz." }],
      style: style(),
    },
  },
  {
    name: "image/full_bleed",
    section: {
      type: "image",
      id: "image-full-bleed",
      variant: "full_bleed",
      items: [{ imageId: "img_show_hall", alt: "Rows of quilts hanging in the show hall" }],
      style: style({ width: "full", spacing: "tight", imageFocal: [0.5, 0.6] }),
    },
  },
  {
    name: "image/duo",
    section: {
      type: "image",
      id: "image-duo",
      variant: "duo",
      items: [
        { imageId: "img_charity_stack", alt: "A stack of finished charity quilts", caption: "Ready for delivery to CASA." },
        { url: "https://images.example.org/hcqg/sew-day.jpg", alt: "Members at a charity sew day", caption: "March sew day." },
      ],
      style: style(),
    },
  },

  // feature_grid -----------------------------------------------------------
  {
    name: "feature_grid/cards",
    section: {
      type: "feature_grid",
      id: "benefits-cards",
      variant: "cards",
      heading: "What membership includes",
      items: [
        { icon: "🧵", title: "Monthly programs", body: "Guest lecturers, trunk shows, and demonstrations at every regular meeting." },
        { icon: "📚", title: "Lending library", body: "Over four hundred books and patterns, checked out for a month at a time." },
        { icon: "✂️", title: "Member workshop pricing", body: "Save $20 or more on every workshop, and get first pick of seats." },
        { icon: "🏆", title: "Show entry", body: "Enter the biennial show at the member rate.", href: "/show" },
      ],
      style: style({ bg: "tint" }),
    },
  },
  {
    name: "feature_grid/icons",
    section: {
      type: "feature_grid",
      id: "services-icons",
      variant: "icons",
      heading: "Longarm services",
      items: [
        { icon: "〰️", title: "Edge-to-edge quilting", body: "Allover pantograph designs.", price: "from 2¢ per square inch" },
        { icon: "✦", title: "Custom quilting", body: "Block-by-block designs planned with you.", price: "from 5¢ per square inch" },
        { icon: "▭", title: "Binding", body: "Machine-applied and hand-finished.", price: "$0.35 per inch" },
      ],
      style: style(),
    },
  },
  {
    name: "feature_grid/numbered",
    section: {
      type: "feature_grid",
      id: "how-to-join",
      variant: "numbered",
      heading: "How to join",
      items: [
        { title: "Come to a meeting", body: "Guests are welcome at any regular meeting; your first is free." },
        { title: "Pick a level", body: "Individual, household, or student. Dues run January through December." },
        { title: "Pay online or at the door", body: "Card online, or cash and check at the membership table." },
      ],
      style: style({ width: "narrow" }),
    },
  },

  // faq --------------------------------------------------------------------
  {
    name: "faq",
    section: {
      type: "faq",
      id: "membership-faq",
      heading: "Questions about membership",
      items: [
        { q: "Do I need to be an experienced quilter?", a: "<p>No. About a third of our members started quilting after they joined. Beginner-friendly workshops run every spring.</p>" },
        { q: "When are dues due?", a: "<p>Dues are due by the January meeting. New members who join after July 1 pay half.</p>" },
        { q: "Can I bring a guest?", a: "<p>Yes. Guests may attend two meetings before joining.</p>" },
      ],
      style: style({ width: "narrow" }),
    },
  },

  // testimonials -----------------------------------------------------------
  {
    name: "testimonials/grid",
    section: {
      type: "testimonials",
      id: "member-voices",
      variant: "grid",
      items: [
        { quote: "I moved here knowing no one. Six months later I had a bee, a retreat roommate, and a finished king-size quilt.", author: "Denise M., member since 2019" },
        { quote: "The library alone is worth the dues.", author: "Rosa T." },
        { quote: "My daughter and I joined on the household level and it is the one thing we do together every month.", author: "Kim and Abby L." },
      ],
      style: style({ bg: "tint" }),
    },
  },
  {
    name: "testimonials/single",
    section: {
      type: "testimonials",
      id: "customer-voice",
      variant: "single",
      items: [{ quote: "She quilted my grandmother's top forty years after it was pieced, and it looks like it was always meant to be finished this way.", author: "Carol H., Fredericksburg" }],
      style: style({ align: "center", spacing: "airy" }),
    },
  },

  // gallery ----------------------------------------------------------------
  {
    name: "gallery/grid manual",
    section: {
      type: "gallery",
      id: "gallery-grid",
      variant: "grid",
      source: "manual",
      items: [
        { imageId: "ph_show_01", alt: "Baltimore Album quilt, hand quilted", caption: "Best of Show, 2025" },
        { imageId: "ph_show_02", alt: "Improvisational curved-piecing quilt in solids", caption: "Modern category" },
        { imageId: "ph_show_04", alt: "Dear Jane reproduction quilt", caption: "Viewer's choice" },
        { url: "https://images.example.org/hcqg/log-cabin.jpg", alt: "Scrappy log cabin quilt" },
      ],
      style: style({ width: "wide" }),
    },
  },
  {
    name: "gallery/masonry manual",
    section: {
      type: "gallery",
      id: "gallery-masonry",
      variant: "masonry",
      source: "manual",
      items: [
        { imageId: "ph_charity_01", alt: "Stack of charity quilts", caption: "Delivered to CASA in March" },
        { imageId: "ph_charity_02", alt: "Twin-size charity quilt in blues" },
        { imageId: "ph_charity_03", alt: "Members tying a charity quilt" },
      ],
      style: style(),
    },
  },
  {
    name: "gallery/grid from a gallery",
    section: {
      type: "gallery",
      id: "gallery-from-data",
      variant: "grid",
      source: "gallery",
      gallerySlug: "2025-quilt-show",
      items: [],
      style: style({ width: "wide" }),
    },
  },

  // events -----------------------------------------------------------------
  {
    name: "events/cards",
    section: { type: "events", id: "events-cards", variant: "cards", heading: "Upcoming events", limit: 3, style: style() },
  },
  {
    name: "events/list",
    section: { type: "events", id: "events-list", variant: "list", heading: "All upcoming events", limit: 50, style: style({ width: "narrow" }) },
  },
  {
    name: "events/calendar",
    section: { type: "events", id: "events-calendar", variant: "calendar", heading: "Calendar", limit: 50, style: style({ width: "wide" }) },
  },
  {
    name: "events/next_up",
    section: { type: "events", id: "events-next", variant: "next_up", heading: "Next meeting", limit: 1, style: style({ bg: "tint" }) },
  },

  // membership_levels ------------------------------------------------------
  {
    name: "membership_levels/cards",
    section: { type: "membership_levels", id: "levels-cards", variant: "cards", heading: "Choose a membership", style: style() },
  },
  {
    name: "membership_levels/compact",
    section: { type: "membership_levels", id: "levels-compact", variant: "compact", heading: "Dues", style: style({ width: "narrow" }) },
  },

  // join_band --------------------------------------------------------------
  {
    name: "join_band",
    section: {
      type: "join_band",
      id: "join-band",
      title: "Become a member",
      body: "Dues are $40 a year. Join online in two minutes or at the membership table at any meeting.",
      ctaLabel: "Join the guild",
      style: style({ bg: "brand", align: "center" }),
    },
  },

  // meeting_info -----------------------------------------------------------
  {
    name: "meeting_info",
    section: {
      type: "meeting_info",
      id: "meeting-info",
      heading: "When and where we meet",
      when: "Second Tuesday of every month, 6:30 PM. Doors open at 6:00 for social time.",
      where: "First Methodist Church fellowship hall",
      address: "321 Thompson Dr, Kerrville, TX 78028",
      mapUrl: "https://maps.google.com/?q=321+Thompson+Dr+Kerrville+TX",
      note: "Park in the lot off Thompson Drive and enter through the side door marked Fellowship Hall. The room is step-free.",
      style: style(),
    },
  },

  // store_teaser -----------------------------------------------------------
  {
    name: "store_teaser",
    section: { type: "store_teaser", id: "store-teaser", heading: "From the guild store", limit: 4, style: style() },
  },

  // blog_teaser ------------------------------------------------------------
  {
    name: "blog_teaser",
    section: { type: "blog_teaser", id: "blog-teaser", heading: "Newsletter and news", limit: 3, style: style({ width: "narrow" }) },
  },

  // contact ----------------------------------------------------------------
  {
    name: "contact with form",
    section: { type: "contact", id: "contact-form", heading: "Get in touch", formSlug: "contact", showDetails: true, style: style() },
  },
  {
    name: "contact details only",
    section: { type: "contact", id: "contact-details", heading: "Find us", showDetails: true, style: style({ width: "narrow" }) },
  },

  // quote_cta --------------------------------------------------------------
  {
    name: "quote_cta",
    section: {
      type: "quote_cta",
      id: "quote-longarm",
      projectType: "longarm",
      heading: "Get a longarm quote",
      submitLabel: "Send my measurements",
      style: style({ bg: "tint" }),
    },
  },

  // cta --------------------------------------------------------------------
  {
    name: "cta primary",
    section: { type: "cta", id: "cta-primary", label: "See the full calendar", href: "/calendar", kind: "primary", style: style({ align: "center" }) },
  },
  {
    name: "cta secondary",
    section: { type: "cta", id: "cta-secondary", label: "Read the bylaws", href: "https://hillcountryquiltguild.org/bylaws.pdf", kind: "secondary", style: style() },
  },

  // divider, spacer, embed -------------------------------------------------
  { name: "divider", section: { type: "divider", id: "divider", style: style({ spacing: "tight" }) } },
  { name: "spacer", section: { type: "spacer", id: "spacer", height: 48, style: style() } },
  {
    name: "embed",
    section: {
      type: "embed",
      id: "embed-video",
      html: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="2025 show walkthrough" allowfullscreen></iframe>',
      style: style({ width: "narrow" }),
    },
  },

  // ---- Phase 2 -------------------------------------------------------------

  // timeline ---------------------------------------------------------------
  {
    name: "timeline",
    section: {
      type: "timeline",
      id: "guild-history",
      heading: "Forty years of the guild",
      items: [
        { year: "1987", title: "Eleven quilters in a fabric shop back room", body: "The first meetings were around a cutting table at Creations on Water Street." },
        { year: "1989", title: "First raffle quilt", body: "A scrappy Ocean Waves raised $1,140 and bought the first library shelf." },
        { year: "1995", title: "First biennial show", body: "Sixty-two quilts at the Kerr County fairgrounds." },
        { year: "2008", title: "501(c)(3) status", body: "Charity quilts for the state hospital and CASA became a standing committee." },
        { year: "2026", title: "Two hundred members", body: "The largest guild in the Hill Country." },
      ],
      style: style({ width: "narrow" }),
    },
  },

  // quote ------------------------------------------------------------------
  {
    name: "quote",
    section: {
      type: "quote",
      id: "pull-quote",
      quote: "Nobody here cares whether your points match. They care whether you came back.",
      author: "Marla Ortiz, president 2019–2021",
      style: style({ bg: "tint", align: "center", spacing: "airy" }),
    },
  },

  // officers ---------------------------------------------------------------
  {
    name: "officers",
    section: {
      type: "officers",
      id: "board",
      heading: "2026 officers",
      items: [
        { name: "Ann Reyes", role: "President", email: "president@hillcountryquiltguild.org", imageId: "officer_ann" },
        { name: "Denise Moore", role: "Vice president, programs", email: "programs@hillcountryquiltguild.org" },
        { name: "Kim Lee", role: "Treasurer", imageId: "officer_kim" },
        { name: "Rosa Trevino", role: "Secretary" },
        { name: "Carol Hanson", role: "Charity quilts chair", email: "charity@hillcountryquiltguild.org" },
      ],
      style: style(),
    },
  },

  // benefits ---------------------------------------------------------------
  {
    name: "benefits",
    section: {
      type: "benefits",
      id: "member-benefits",
      heading: "What your dues include",
      items: [
        { title: "Eleven monthly programs", body: "Trunk shows, lectures and demonstrations, September through July." },
        { title: "The lending library", body: "Four hundred books and patterns, one month at a time." },
        { title: "Member workshop pricing", body: "At least $20 off every workshop, and first pick of seats." },
        { title: "The newsletter", body: "Monthly, by email, with the block of the month." },
        { title: "Retreat and show entry at member rates" },
      ],
      style: style({ width: "narrow" }),
    },
  },

  // event_spotlight --------------------------------------------------------
  {
    name: "event_spotlight",
    section: {
      type: "event_spotlight",
      id: "retreat-spotlight",
      eventId: "ev_fall_retreat",
      heading: "Fall retreat",
      style: style({ bg: "tint" }),
    },
  },

  // projects ---------------------------------------------------------------
  {
    name: "projects",
    section: {
      type: "projects",
      id: "community-projects",
      heading: "Where the charity quilts go",
      items: [
        { title: "Kerrville State Hospital", body: "Lap quilts for every new patient on the long-term unit.", imageId: "proj_hospital", stat: "140 quilts in 2025", href: "/charity" },
        { title: "CASA of the Hill Country", body: "A quilt for every child entering foster care in Kerr County.", imageId: "proj_casa", stat: "96 quilts in 2025" },
        { title: "Kerr County Fire Department", body: "Comfort quilts carried on the engines for house-fire calls.", stat: "24 quilts in 2025" },
      ],
      style: style(),
    },
  },

  // sponsors ---------------------------------------------------------------
  {
    name: "sponsors",
    section: {
      type: "sponsors",
      id: "show-sponsors",
      heading: "2027 show sponsors",
      items: [
        { name: "Creations Fabric", imageId: "logo_creations", href: "https://creationsfabric.example" },
        { name: "Hill Country Longarm", imageId: "logo_hcl", href: "https://hclongarm.example" },
        { name: "Guadalupe Bank", imageId: "logo_gbank" },
        { name: "Schreiner University" },
      ],
      style: style({ bg: "tint", align: "center" }),
    },
  },

  // newsletter_signup ------------------------------------------------------
  {
    name: "newsletter_signup",
    section: {
      type: "newsletter_signup",
      id: "newsletter",
      heading: "Get the newsletter",
      body: "Once a month: the program, the block of the month, and retreat and show dates. No selling your address.",
      buttonLabel: "Sign me up",
      style: style({ bg: "brand", align: "center" }),
    },
  },

  // services ---------------------------------------------------------------
  {
    name: "services/cards",
    section: {
      type: "services",
      id: "services-cards",
      variant: "cards",
      heading: "Longarm services",
      items: [
        { title: "Edge-to-edge quilting", body: "Allover pantograph designs from a library of two hundred.", price: "2¢", unit: "per square inch" },
        { title: "Custom quilting", body: "Block-by-block designs planned with you at drop-off.", price: "from 5¢", unit: "per square inch" },
        { title: "Binding", body: "Machine-applied, hand-finished on request.", price: "35¢", unit: "per linear inch" },
        { title: "Backing prep and batting", body: "Seaming, pressing, and 80/20 cotton batting.", price: "$18", unit: "per yard" },
      ],
      style: style(),
    },
  },
  {
    name: "services/table",
    section: {
      type: "services",
      id: "services-table",
      variant: "table",
      heading: "Price list",
      items: [
        { title: "Edge-to-edge", body: "Pantograph, one thread color", price: "2¢", unit: "per sq in" },
        { title: "Semi-custom", body: "Pantograph plus stitched borders", price: "3.5¢", unit: "per sq in" },
        { title: "Custom", body: "Ruler work, feathers, block-by-block", price: "5–8¢", unit: "per sq in" },
        { title: "Rush (under 10 days)", body: "When the schedule allows", price: "+25%" },
      ],
      style: style({ width: "narrow" }),
    },
  },

  // portfolio --------------------------------------------------------------
  {
    name: "portfolio/grid",
    section: {
      type: "portfolio",
      id: "portfolio-grid",
      variant: "grid",
      heading: "Recent work",
      items: [
        { imageId: "pf_ocean_waves", title: "Ocean Waves", caption: "Custom quilting, 90 × 90" },
        { imageId: "pf_tshirt", title: "Schreiner tee-shirt quilt", caption: "Edge-to-edge, swirl pantograph" },
        { imageId: "pf_baltimore", title: "Baltimore Album", caption: "Custom, feathers and cross-hatching" },
        { url: "https://images.example.org/hcqg/log-cabin.jpg", title: "Log cabin", caption: "Edge-to-edge" },
      ],
      style: style({ width: "wide" }),
    },
  },
  {
    name: "portfolio/featured",
    section: {
      type: "portfolio",
      id: "portfolio-featured",
      variant: "featured",
      heading: "This month's finish",
      items: [
        { imageId: "pf_dear_jane", title: "Dear Jane", caption: "169 blocks, custom quilted over three weeks for a client in Fredericksburg." },
        { imageId: "pf_ocean_waves", title: "Ocean Waves" },
        { imageId: "pf_tshirt", title: "Tee-shirt quilt" },
      ],
      style: style(),
    },
  },

  // hours_location ---------------------------------------------------------
  {
    name: "hours_location",
    section: {
      type: "hours_location",
      id: "studio-hours",
      heading: "Studio hours",
      hours: [
        { day: "Tuesday – Friday", open: "10 AM – 5 PM" },
        { day: "Saturday", open: "10 AM – 2 PM" },
        { day: "Sunday – Monday", open: "Closed" },
      ],
      address: "1210 Water St, Suite B, Kerrville, TX 78028",
      mapUrl: "https://maps.google.com/?q=1210+Water+St+Kerrville+TX",
      phone: "(830) 555-0147",
      email: "studio@hillcountryquiltguild.org",
      note: "Drop-offs by appointment outside these hours. Park behind the building.",
      style: style({ bg: "tint" }),
    },
  },

  // process ----------------------------------------------------------------
  {
    name: "process",
    section: {
      type: "process",
      id: "how-it-works",
      heading: "How longarm quilting works",
      items: [
        { title: "Send your measurements", body: "Width and height of the top, and whether you want edge-to-edge or custom." },
        { title: "Drop off or ship", body: "Top, backing at least 8 inches larger, and batting if you have it." },
        { title: "We quilt it", body: "Two to three weeks for edge-to-edge; custom is scheduled at drop-off." },
        { title: "Pick up and bind", body: "Trimmed and ready for binding, or bound by us for 35¢ an inch." },
      ],
      style: style({ width: "narrow" }),
    },
  },

  // documents --------------------------------------------------------------
  {
    name: "documents",
    section: { type: "documents", id: "member-documents", heading: "Member documents", limit: 10, style: style({ width: "narrow" }) },
  },

  // donate -----------------------------------------------------------------
  {
    name: "donate",
    section: {
      type: "donate",
      id: "donate",
      heading: "Support the charity quilt program",
      body: "Every $25 covers batting and backing for one lap quilt. The guild is a 501(c)(3); gifts are tax deductible.",
      amounts: [1000, 2500, 5000, 10000],
      style: style({ bg: "brand", align: "center" }),
    },
  },
];

/** The fixture sections in order, for callers that just want a stack. */
export function fixtureSections(): Section[] {
  return SECTION_FIXTURES.map((f) => f.section);
}
