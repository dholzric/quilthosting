-- Two new demo guilds for custom-domain testing (not AMQG/AAQG).
-- Domains already on Cloudflare for SaaS: autoquilt.com, hailhaus.com

-- Unlink domains from WA mirrors
UPDATE tenants SET custom_domain = NULL, updated_at = datetime('now') WHERE slug IN ('amqg', 'aaqg');

-- ═══════════════════════════════════════════════════════════
-- AutoQuilt — modern quilting software / guild-style demo
-- custom domain: autoquilt.com
-- ═══════════════════════════════════════════════════════════
INSERT INTO tenants (
  id, name, slug, custom_domain, plan, status, settings_json, created_at, updated_at
) VALUES (
  'aq-tenant-0001-0000-0000-000000000001',
  'AutoQuilt',
  'autoquilt',
  'autoquilt.com',
  'pro',
  'active',
  '{"profile":{"description":"Demo guild for AutoQuilt — custom-domain + membership test site (not a real organization).","meeting_info":"Online meetups, 2nd Thursday 7pm CT","location":"Austin, TX (virtual-friendly)","contact_email":"hello@autoquilt.com","donations_enabled":true,"website":"https://www.autoquilt.com"},"custom_fields":[{"key":"machine_type","label":"Sewing machine / longarm","type":"text","show_on_join":true}],"source":"custom-domain-test"}',
  datetime('now'),
  datetime('now')
);

INSERT INTO tenant_users (tenant_id, user_id, role, created_at) VALUES
('aq-tenant-0001-0000-0000-000000000001', 'e51d306c-7561-442b-8f5d-4ebff1a426c8', 'owner', datetime('now')),
('aq-tenant-0001-0000-0000-000000000001', 'a17015fb-a882-4805-989b-a4de32c64066', 'admin', datetime('now'));

INSERT INTO membership_levels (
  id, tenant_id, name, description, price_cents, duration_months,
  renewal_type, benefits_json, is_public, sort_order, status, created_at, updated_at
) VALUES
(
  'aq-level-basic-0001-0000-000000000001',
  'aq-tenant-0001-0000-0000-000000000001',
  'Maker',
  'Annual membership — newsletter, open sew, member rates on workshops.',
  4500, 12, 'manual',
  '["Monthly open sew","Workshop discounts","Member directory"]',
  1, 0, 'active', datetime('now'), datetime('now')
),
(
  'aq-level-pro-00001-0000-000000000002',
  'aq-tenant-0001-0000-0000-000000000001',
  'Maker + Auto-Renew',
  'Same benefits with automatic annual renewal.',
  4500, 12, 'auto',
  '["Monthly open sew","Workshop discounts","Member directory","Auto-renew"]',
  1, 1, 'active', datetime('now'), datetime('now')
);

INSERT INTO pages (
  id, tenant_id, slug, title, content_json, is_members_only, published,
  sort_order, page_type, show_in_nav, nav_label, created_at, updated_at
) VALUES
(
  'aq-page-home-00001-0000-000000000001',
  'aq-tenant-0001-0000-0000-000000000001',
  'home',
  'Home',
  '{"html":"<h2>Welcome to AutoQuilt</h2><p>This is a <strong>QuiltHosting demo site</strong> on a real custom domain (<code>autoquilt.com</code>). Use it to test memberships, events, and the public guild experience.</p><p>Not affiliated with any real guild — seed data only.</p>"}',
  0, 1, 0, 'page', 1, 'Home', datetime('now'), datetime('now')
),
(
  'aq-page-about-0001-0000-000000000002',
  'aq-tenant-0001-0000-0000-000000000001',
  'about',
  'About',
  '{"html":"<h2>About this demo</h2><p>AutoQuilt is a stand-in tenant for validating custom domains, free subdomains, and multi-tenant admin. Content is fictional.</p>"}',
  0, 1, 1, 'page', 1, 'About', datetime('now'), datetime('now')
);

INSERT INTO events (
  id, tenant_id, title, description, location, start_at, end_at,
  capacity, is_public, member_price_cents, non_member_price_cents,
  registration_open, waitlist_enabled, settings_json, created_at, updated_at
) VALUES
(
  'aq-evt-meet-00001-0000-000000000001',
  'aq-tenant-0001-0000-0000-000000000001',
  'September Open Sew (Virtual)',
  'Demo event for registration testing. Bring a WIP.',
  'Zoom (link in confirmation)',
  '2026-09-10T00:00:00.000Z',
  '2026-09-10T02:00:00.000Z',
  50, 1, 0, 500, 1, 1, '{}',
  datetime('now'), datetime('now')
),
(
  'aq-evt-ws-000001-0000-000000000002',
  'aq-tenant-0001-0000-0000-000000000001',
  'Foundation Paper Piecing Workshop',
  'Hands-on workshop demo with paid registration.',
  'Austin-area classroom TBD',
  '2026-10-04T14:00:00.000Z',
  '2026-10-04T21:00:00.000Z',
  16, 1, 5500, 7500, 1, 1, '{}',
  datetime('now'), datetime('now')
);

INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES
(
  'aq-mem-dan-00001-0000-000000000001',
  'aq-tenant-0001-0000-0000-000000000001',
  'e51d306c-7561-442b-8f5d-4ebff1a426c8',
  'dholzric@gmail.com', 'Dan', 'Holzrichter', NULL,
  '{"city":"Austin","state":"TX"}', '{}', 'active', '2026-01-01T00:00:00.000Z', 'Owner',
  datetime('now'), datetime('now')
),
(
  'aq-mem-sample-01-0000-000000000002',
  'aq-tenant-0001-0000-0000-000000000001',
  NULL, 'pat.maker@example.com', 'Pat', 'Maker', NULL,
  '{"city":"Round Rock","state":"TX"}', '{"machine_type":"Domestic"}', 'active',
  '2026-02-01T00:00:00.000Z', 'Sample member', datetime('now'), datetime('now')
);

INSERT INTO memberships (
  id, tenant_id, member_id, level_id, start_date, end_date, status,
  amount_paid_cents, auto_renew, created_at, updated_at
) VALUES
(
  'aq-ms-dan-00001-0000-000000000001',
  'aq-tenant-0001-0000-0000-000000000001',
  'aq-mem-dan-00001-0000-000000000001',
  'aq-level-pro-00001-0000-000000000002',
  '2026-01-01', '2026-12-31', 'active', 4500, 1, datetime('now'), datetime('now')
),
(
  'aq-ms-pat-00001-0000-000000000002',
  'aq-tenant-0001-0000-0000-000000000001',
  'aq-mem-sample-01-0000-000000000002',
  'aq-level-basic-0001-0000-000000000001',
  '2026-01-01', '2026-12-31', 'active', 4500, 0, datetime('now'), datetime('now')
);

INSERT INTO products (
  id, tenant_id, name, description, price_cents, inventory, is_active, sort_order, sku, taxable, created_at, updated_at
) VALUES
(
  'aq-prod-pin-0001-0000-000000000001',
  'aq-tenant-0001-0000-0000-000000000001',
  'Demo enamel pin',
  'Store test SKU',
  1200, 50, 1, 0, 'PIN-1', 1, datetime('now'), datetime('now')
);

-- ═══════════════════════════════════════════════════════════
-- Hailhaus — second custom-domain demo guild
-- custom domain: hailhaus.com
-- ═══════════════════════════════════════════════════════════
INSERT INTO tenants (
  id, name, slug, custom_domain, plan, status, settings_json, created_at, updated_at
) VALUES (
  'hh-tenant-0001-0000-0000-000000000001',
  'Hailhaus',
  'hailhaus',
  'hailhaus.com',
  'pro',
  'active',
  '{"profile":{"description":"Demo guild for Hailhaus — second custom-domain test tenant on QuiltHosting.","meeting_info":"1st Monday, 6:30pm","location":"Central Texas","contact_email":"hello@hailhaus.com","donations_enabled":true,"website":"https://www.hailhaus.com"},"custom_fields":[{"key":"interests","label":"Interests","type":"text","show_on_join":true}],"source":"custom-domain-test"}',
  datetime('now'),
  datetime('now')
);

INSERT INTO tenant_users (tenant_id, user_id, role, created_at) VALUES
('hh-tenant-0001-0000-0000-000000000001', 'e51d306c-7561-442b-8f5d-4ebff1a426c8', 'owner', datetime('now')),
('hh-tenant-0001-0000-0000-000000000001', 'a17015fb-a882-4805-989b-a4de32c64066', 'admin', datetime('now'));

INSERT INTO membership_levels (
  id, tenant_id, name, description, price_cents, duration_months,
  renewal_type, benefits_json, is_public, sort_order, status, created_at, updated_at
) VALUES
(
  'hh-level-reg-00001-0000-000000000001',
  'hh-tenant-0001-0000-0000-000000000001',
  'Regular',
  'Calendar-year style demo membership.',
  3500, 12, 'manual',
  '["Meetings","Newsletter","Events"]',
  1, 0, 'active', datetime('now'), datetime('now')
),
(
  'hh-level-family-01-0000-000000000002',
  'hh-tenant-0001-0000-0000-000000000001',
  'Household',
  'Two adults at the same address (demo tier).',
  5500, 12, 'manual',
  '["Meetings","Newsletter","Events","Two member cards"]',
  1, 1, 'active', datetime('now'), datetime('now')
);

INSERT INTO pages (
  id, tenant_id, slug, title, content_json, is_members_only, published,
  sort_order, page_type, show_in_nav, nav_label, created_at, updated_at
) VALUES
(
  'hh-page-home-00001-0000-000000000001',
  'hh-tenant-0001-0000-0000-000000000001',
  'home',
  'Home',
  '{"html":"<h2>Hailhaus</h2><p>Second <strong>QuiltHosting custom-domain demo</strong> on <code>hailhaus.com</code>. Independent from AutoQuilt and from the Austin WA mirror guilds.</p>"}',
  0, 1, 0, 'page', 1, 'Home', datetime('now'), datetime('now')
),
(
  'hh-page-about-0001-0000-000000000002',
  'hh-tenant-0001-0000-0000-000000000001',
  'about',
  'About',
  '{"html":"<h2>About Hailhaus (demo)</h2><p>Use this site to compare multi-tenant behavior: separate members, levels, events, and branding on its own domain.</p>"}',
  0, 1, 1, 'page', 1, 'About', datetime('now'), datetime('now')
);

INSERT INTO events (
  id, tenant_id, title, description, location, start_at, end_at,
  capacity, is_public, member_price_cents, non_member_price_cents,
  registration_open, waitlist_enabled, settings_json, created_at, updated_at
) VALUES
(
  'hh-evt-meet-00001-0000-000000000001',
  'hh-tenant-0001-0000-0000-000000000001',
  'October General Meeting',
  'Demo meeting for Hailhaus tenant.',
  'Community room TBD',
  '2026-10-06T23:30:00.000Z',
  '2026-10-07T01:30:00.000Z',
  80, 1, 0, 0, 1, 0, '{}',
  datetime('now'), datetime('now')
);

INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES
(
  'hh-mem-dan-00001-0000-000000000001',
  'hh-tenant-0001-0000-0000-000000000001',
  'e51d306c-7561-442b-8f5d-4ebff1a426c8',
  'dholzric@gmail.com', 'Dan', 'Holzrichter', NULL,
  '{"city":"Austin","state":"TX"}', '{}', 'active', '2026-01-01T00:00:00.000Z', 'Owner',
  datetime('now'), datetime('now')
),
(
  'hh-mem-sample-01-0000-000000000002',
  'hh-tenant-0001-0000-0000-000000000001',
  NULL, 'rivers.stitch@example.com', 'River', 'Stitch', NULL,
  '{"city":"Austin","state":"TX"}', '{"interests":"improv"}', 'active',
  '2026-03-01T00:00:00.000Z', 'Sample', datetime('now'), datetime('now')
);

INSERT INTO memberships (
  id, tenant_id, member_id, level_id, start_date, end_date, status,
  amount_paid_cents, auto_renew, created_at, updated_at
) VALUES
(
  'hh-ms-dan-00001-0000-000000000001',
  'hh-tenant-0001-0000-0000-000000000001',
  'hh-mem-dan-00001-0000-000000000001',
  'hh-level-reg-00001-0000-000000000001',
  '2026-01-01', '2026-12-31', 'active', 3500, 0, datetime('now'), datetime('now')
),
(
  'hh-ms-river-001-0000-000000000002',
  'hh-tenant-0001-0000-0000-000000000001',
  'hh-mem-sample-01-0000-000000000002',
  'hh-level-family-01-0000-000000000002',
  '2026-01-01', '2026-12-31', 'active', 5500, 0, datetime('now'), datetime('now')
);
