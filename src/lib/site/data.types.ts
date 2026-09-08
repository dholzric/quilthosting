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

export type SiteData = {
  levels?: SiteLevel[];
  events?: SiteEvent[];
  products?: SiteProduct[];
  posts?: SitePost[];
  galleries?: SiteGallerySummary[];
  gallery?: SiteGallery;
  profile?: SiteProfile;
};

export type DataNeed = keyof SiteData;
