/**
 * Shapes of the dynamic data the site renderer can hand to sections.
 * Lives in its own file so the section renderers (sections/render.ts),
 * the system pages (pages/system.ts) and the loaders (data.ts) can be
 * built independently against one contract. `data.ts` re-exports these.
 */

export type SiteLevel = {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  duration_months: number;
  renewal_type: string;
};

export type SiteEvent = {
  id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  location: string | null;
  description: string | null;
  member_price_cents: number;
  non_member_price_cents: number;
  registration_open: number;
  capacity: number | null;
  /**
   * Seats already taken: confirmed, checked in, or holding an unexpired
   * payment hold — the same count POST /register enforces against, so
   * "3 spots left" cannot promise a seat registration would refuse.
   * Undefined when the loader did not ask for it.
   */
  seats_taken?: number;
  /**
   * Number of volunteer sign-up slots on the event. Only the single-event
   * loader (`LoadOpts.eventId`) fills it in; list loads leave it undefined.
   * The event detail stack shows a Volunteer block when it is > 0.
   */
  volunteer_slots?: number;
  /**
   * What an attendee has to bring — fabric, a machine, thread. Empty for the
   * events that need nothing, which is most meetings; a class is what this is
   * for. Stored in events.settings_json.bring.
   */
  bring?: string[];
};

export type SiteProduct = {
  id: string;
  name: string;
  price_cents: number;
  description: string | null;
  image_file_id: string | null;
  stock: number | null;
};

export type SitePost = {
  slug: string;
  title: string;
  published_at: string;
  excerpt: string;
};

export type SiteGallerySummary = {
  slug: string;
  title: string;
  cover_photo_id: string | null;
  count: number;
};

export type SiteGallery = {
  slug: string;
  title: string;
  description: string | null;
  photos: { id: string; caption: string | null }[];
};

export type SiteProfile = {
  description?: string;
  meeting_info?: string;
  location?: string;
  website?: string;
  email?: string;
  donations_enabled?: boolean;
  directory_public?: boolean;
};

/** A members-only shared file (staff upload) for the `documents` section. */
export type SiteDocument = {
  id: string;
  filename: string;
  size: number | null;
};

/**
 * One row of the public member directory: the same fields
 * `GET /public/:slug/directory` returns (`showcase` is the parsed
 * `members.showcase_json`, keys the portal writes).
 */
export type SiteDirectoryMember = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  bio: string | null;
  photo_file_id: string | null;
  showcase: { headline?: string; interests?: string; website?: string };
};

export type SiteData = {
  levels?: SiteLevel[];
  events?: SiteEvent[];
  products?: SiteProduct[];
  posts?: SitePost[];
  galleries?: SiteGallerySummary[];
  gallery?: SiteGallery;
  profile?: SiteProfile;
  /**
   * Loaded only when the caller says the viewer is a member
   * (`LoadOpts.memberView`); public HTML never sets it, and the `documents`
   * renderer shows a sign-in prompt while it is undefined.
   */
  documents?: SiteDocument[];
  /**
   * Public member directory. Loaded only when `settings.profile.directory_public`
   * is true (the same rule as the JSON endpoint); otherwise left undefined and
   * the `/directory` route renders the members-only stack.
   */
  directory?: SiteDirectoryMember[];
};

export type DataNeed = keyof SiteData;
