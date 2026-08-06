-- Austin Modern Quilt Guild — demo tenant mirrored from
-- https://austinmodernquiltguild.wildapricot.org/
-- Calendar-year $60 membership, Cherrywood meetings, sample members.

-- Tenant
INSERT INTO tenants (
  id, name, slug, plan, status, settings_json, created_at, updated_at
) VALUES (
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'Austin Modern Quilt Guild',
  'amqg',
  'pro',
  'active',
  '{"profile":{"description":"Support and encourage the growth and development of modern quilting through art, education, and community. Local chapter of the Modern Quilt Guild since 2012.","meeting_info":"Monthly general meetings (typically first Wednesday), 6:30 PM","location":"Cherrywood Center, 1605 E. 38 1/2 St, Austin, TX 78722","contact_email":"board@austinmqg.example","website":"https://austinmodernquiltguild.wildapricot.org","facebook":"https://www.facebook.com/groups/austinmqg","instagram":"https://www.instagram.com/austinmqg/","pinterest":"https://www.pinterest.com/AustinMQG/","donations_enabled":true},"custom_fields":[{"key":"years_quilting","label":"Years quilting","type":"select","options":["Brand new","1-5","5-10","10+"],"show_on_join":true},{"key":"mqg_member","label":"Also an MQG national member?","type":"select","options":["Yes","No","Not sure"],"show_on_join":true}],"source":"wildapricot-mirror","source_url":"https://austinmodernquiltguild.wildapricot.org/"}',
  datetime('now'),
  datetime('now')
);

-- Owner: dholzric@gmail.com
INSERT INTO tenant_users (tenant_id, user_id, role, created_at) VALUES (
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'e51d306c-7561-442b-8f5d-4ebff1a426c8',
  'owner',
  datetime('now')
);

-- Also grant Stephanie admin (mirrors test-guild)
INSERT INTO tenant_users (tenant_id, user_id, role, created_at) VALUES (
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'a17015fb-a882-4805-989b-a4de32c64066',
  'admin',
  datetime('now')
);

-- Membership levels (WA: General $60 calendar year ± auto-renew)
INSERT INTO membership_levels (
  id, tenant_id, name, description, price_cents, duration_months,
  renewal_type, benefits_json, is_public, sort_order, status, created_at, updated_at
) VALUES (
  'd1e2f3a4-5b6c-7d8e-9f0a-1b2c3d4e5f60',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'General Member',
  'Calendar-year membership (Jan 1 – Dec 31). Membership purchased in December is for the following year. No automatically recurring payments.',
  6000,
  12,
  'manual',
  '["Free monthly meetings","Workshops, retreats & special events","Modern quilting bees & sew-ins","Swaps & challenges","MQG member discounts & resources","QuiltCon submission eligibility","Vote in AMQG & MQG elections"]',
  1,
  0,
  'active',
  datetime('now'),
  datetime('now')
);

INSERT INTO membership_levels (
  id, tenant_id, name, description, price_cents, duration_months,
  renewal_type, benefits_json, is_public, sort_order, status, created_at, updated_at
) VALUES (
  'd1e2f3a4-5b6c-7d8e-9f0a-1b2c3d4e5f61',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'General Membership w/Auto-Renewal',
  'Same calendar-year benefits as General Member, with automatic renewal (recurring payments) each January 1.',
  6000,
  12,
  'auto',
  '["Free monthly meetings","Workshops, retreats & special events","Modern quilting bees & sew-ins","Swaps & challenges","MQG member discounts & resources","QuiltCon submission eligibility","Vote in AMQG & MQG elections","Automatic annual renewal"]',
  1,
  1,
  'active',
  datetime('now'),
  datetime('now')
);

-- Pages (published public site content)
INSERT INTO pages (
  id, tenant_id, slug, title, content_json, is_members_only, published,
  sort_order, page_type, show_in_nav, nav_label, created_at, updated_at
) VALUES (
  'e0a1b2c3-d4e5-4f60-a1b2-c3d4e5f60101',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'home',
  'Home',
  '{"html":"<h2>Welcome to the Austin Modern Quilt Guild</h2><p>The Austin MQG’s mission is to support and encourage the growth and development of modern quilting through art, education, and community. Since 2012, we have provided educational programming, exciting events, and community outreach opportunities to our members.</p><p>AMQG is a local guild of the <a href=\"https://www.modernquiltguild.com\" target=\"_blank\" rel=\"noopener\">Modern Quilt Guild</a>. Members receive both MQG and AMQG benefits.</p><p><strong>Meetings:</strong> Cherrywood Center · 1605 E. 38 ½ St, Austin, TX 78722 · typically 6:30 PM</p>"}',
  0, 1, 0, 'page', 1, 'Home',
  datetime('now'), datetime('now')
);

INSERT INTO pages (
  id, tenant_id, slug, title, content_json, is_members_only, published,
  sort_order, page_type, show_in_nav, nav_label, created_at, updated_at
) VALUES (
  'e0a1b2c3-d4e5-4f60-a1b2-c3d4e5f60102',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'about',
  'About Us',
  '{"html":"<h2>Welcome to the AMQG!</h2><p>The Austin MQG’s mission is to support and encourage the growth and development of modern quilting through art, education, and community. Since 2012, we have provided educational programming, exciting events, and community outreach opportunities to our members. We would love to have you in our group!</p><h3>In all things, our Guild strives to:</h3><ul><li>Develop and encourage the art of modern quilting.</li><li>Work with other guilds and groups with a similar purpose.</li><li>Encourage new quilters and other fiber artists interested in non-traditional and non-art fiber projects.</li><li>Offer educational opportunities through classes, workshops and sharing of information.</li><li>Support local community organizations through donation of modern quilting projects.</li></ul><h3>What we have to offer</h3><h4>Monthly meetings</h4><p>Members get free access to our monthly meetings. Learn, inspire, and show your latest project. Local, national, and international speakers present lectures and trunk shows several times a year.</p><h4>Workshops, retreats &amp; special events</h4><p>Workshops geared to modern quilters, multiple retreats each year, and special events.</p><h4>Modern quilting bees &amp; sew-ins</h4><p>Open quilting bees all over Austin (and virtually), plus one-day sew-ins.</p><h4>Swaps &amp; challenges</h4><p>Local and international swaps and challenges, including QuiltCon community outreach.</p><h4>Discounts &amp; resources</h4><p>MQG member discounts at shops and events, monthly webinars, and quarterly patterns from MQG members worldwide.</p><h4>Community</h4><p>Committees, co-host bees, community outreach, and sew-cializing — including our <a href=\"https://www.facebook.com/groups/austinmqg\" target=\"_blank\" rel=\"noopener\">Facebook group</a>.</p><h4>QuiltCon</h4><p>Members may submit quilts to the premier modern quilting show and enjoy discounts to attend.</p><h3>How to join</h3><p>Membership is open to any individual interested in modern quilting — all skill levels welcome. AMQG membership runs annually, January–December, for $60 (General Member, with optional auto-renewal).</p>"}',
  0, 1, 1, 'page', 1, 'About Us',
  datetime('now'), datetime('now')
);

INSERT INTO pages (
  id, tenant_id, slug, title, content_json, is_members_only, published,
  sort_order, page_type, show_in_nav, nav_label, created_at, updated_at
) VALUES (
  'e0a1b2c3-d4e5-4f60-a1b2-c3d4e5f60103',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'guild-meetings',
  'Our Guild Meetings',
  '{"html":"<h2>Monthly Guild Meetings</h2><p><strong>Each meeting includes:</strong></p><ul><li><strong>Guild business</strong> — updates on what’s going on, what’s coming up, and how members can get involved</li><li><strong>Programming</strong> — sew-ins, sew-lebrities, and other cool content from our VP of Programming</li><li><strong>Sew &amp; Tell</strong> — members share works-in-progress and finishes</li></ul><p><strong>Meeting location:</strong> <a href=\"https://maps.google.com/?q=Cherrywood+Center+1605+E+38+1%2F2+St+Austin+TX\" target=\"_blank\" rel=\"noopener\">Cherrywood Center</a>, 1605 E. 38 ½ Street, Austin, TX 78722</p><ul><li>Face masks optional</li><li>Stay home if you’re not feeling well — join virtually via Zoom credentials in reminder emails</li></ul><p>Timezone: America/Chicago</p>"}',
  0, 1, 2, 'page', 1, 'Meetings',
  datetime('now'), datetime('now')
);

INSERT INTO pages (
  id, tenant_id, slug, title, content_json, is_members_only, published,
  sort_order, page_type, show_in_nav, nav_label, created_at, updated_at
) VALUES (
  'e0a1b2c3-d4e5-4f60-a1b2-c3d4e5f60104',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'giving-back',
  'Giving Back',
  '{"html":"<h2>Community outreach</h2><p>AMQG supports local community organizations through donation of modern quilting projects, annual design challenges, and QuiltCon community outreach challenges. Patterns and inspiration for service projects are shared with members throughout the year.</p><p>(Content mirrored at a high level from the live Wild Apricot site — expand with partners and current challenges as needed.)</p>"}',
  0, 1, 3, 'page', 1, 'Giving Back',
  datetime('now'), datetime('now')
);

INSERT INTO pages (
  id, tenant_id, slug, title, content_json, is_members_only, published,
  sort_order, page_type, show_in_nav, nav_label, created_at, updated_at
) VALUES (
  'e0a1b2c3-d4e5-4f60-a1b2-c3d4e5f60105',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'contact',
  'Contact Us',
  '{"html":"<h2>Contact AMQG</h2><p><strong>Mailing / meeting address</strong><br/>Cherrywood Center<br/>1605 E. 38 ½ St.<br/>Austin, TX 78722</p><p>Find us on <a href=\"https://www.facebook.com/groups/austinmqg\" target=\"_blank\" rel=\"noopener\">Facebook</a>, <a href=\"https://www.instagram.com/austinmqg/\" target=\"_blank\" rel=\"noopener\">Instagram</a>, and <a href=\"https://www.pinterest.com/AustinMQG/\" target=\"_blank\" rel=\"noopener\">Pinterest</a>.</p><p>For board contact in this demo tenant, use your QuiltHosting admin account.</p>"}',
  0, 1, 4, 'page', 1, 'Contact',
  datetime('now'), datetime('now')
);

-- Events (from WA calendar: Sep / Oct / Nov 2026 general meetings)
INSERT INTO events (
  id, tenant_id, title, description, location, start_at, end_at,
  capacity, is_public, member_price_cents, non_member_price_cents,
  registration_open, waitlist_enabled, settings_json, created_at, updated_at
) VALUES (
  'f1a2b3c4-d5e6-4f70-a1b2-c3d4e5f60201',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'September 2 General Meeting',
  'Monthly AMQG general meeting: guild business, programming, and sew & tell. Members free; guests welcome (register for headcount). Hybrid Zoom available via reminder email.',
  'Cherrywood Community Room @ 1605 E 38 1/2 St, Austin, TX 78722',
  '2026-09-02T23:30:00.000Z',
  '2026-09-03T01:30:00.000Z',
  120, 1, 0, 0, 1, 1, '{}',
  datetime('now'), datetime('now')
);

INSERT INTO events (
  id, tenant_id, title, description, location, start_at, end_at,
  capacity, is_public, member_price_cents, non_member_price_cents,
  registration_open, waitlist_enabled, settings_json, created_at, updated_at
) VALUES (
  'f1a2b3c4-d5e6-4f70-a1b2-c3d4e5f60202',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'October 7 General Meeting',
  'Monthly AMQG general meeting: guild business, programming, and sew & tell.',
  'Cherrywood Community Room @ 1605 E 38 1/2 St, Austin, TX 78722',
  '2026-10-07T23:30:00.000Z',
  '2026-10-08T01:30:00.000Z',
  120, 1, 0, 0, 1, 1, '{}',
  datetime('now'), datetime('now')
);

INSERT INTO events (
  id, tenant_id, title, description, location, start_at, end_at,
  capacity, is_public, member_price_cents, non_member_price_cents,
  registration_open, waitlist_enabled, settings_json, created_at, updated_at
) VALUES (
  'f1a2b3c4-d5e6-4f70-a1b2-c3d4e5f60203',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'November 4 General Meeting',
  'Monthly AMQG general meeting: guild business, programming, and sew & tell.',
  'Cherrywood Community Room @ 1605 E 38 1/2 St, Austin, TX 78722',
  '2026-11-05T00:30:00.000Z',
  '2026-11-05T02:30:00.000Z',
  120, 1, 0, 0, 1, 1, '{}',
  datetime('now'), datetime('now')
);

INSERT INTO events (
  id, tenant_id, title, description, location, start_at, end_at,
  capacity, is_public, member_price_cents, non_member_price_cents,
  registration_open, waitlist_enabled, settings_json, created_at, updated_at
) VALUES (
  'f1a2b3c4-d5e6-4f70-a1b2-c3d4e5f60204',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'AMQG Quilt Camp 2026',
  'Annual quilt camp weekend — sew with quilty friends. Details and pricing mirror the live WA Quilt Camp page (demo placeholder).',
  'TBD — Austin area retreat venue',
  '2026-10-16T14:00:00.000Z',
  '2026-10-18T18:00:00.000Z',
  40, 1, 15000, 20000, 1, 1, '{}',
  datetime('now'), datetime('now')
);

-- Sample members + memberships (calendar year 2026)
INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES (
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60301',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'e51d306c-7561-442b-8f5d-4ebff1a426c8',
  'dholzric@gmail.com',
  'Dan',
  'Holzrichter',
  NULL,
  '{"city":"Austin","state":"TX","country":"US"}',
  '{"years_quilting":"10+","mqg_member":"Yes"}',
  'active',
  '2024-01-15T00:00:00.000Z',
  'Demo owner member',
  datetime('now'), datetime('now')
);

INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES (
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60302',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'a17015fb-a882-4805-989b-a4de32c64066',
  'sholzric@gmail.com',
  'Stephanie',
  'Holzrichter',
  NULL,
  '{"city":"Austin","state":"TX","country":"US"}',
  '{"years_quilting":"10+","mqg_member":"Yes"}',
  'active',
  '2023-03-01T00:00:00.000Z',
  'Demo admin member',
  datetime('now'), datetime('now')
);

INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES (
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60303',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  NULL,
  'maya.modern@example.com',
  'Maya',
  'Chen',
  '512-555-0142',
  '{"city":"Austin","state":"TX","country":"US","zip":"78722"}',
  '{"years_quilting":"5-10","mqg_member":"Yes"}',
  'active',
  '2022-06-10T00:00:00.000Z',
  'Sample active member (auto-renew)',
  datetime('now'), datetime('now')
);

INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES (
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60304',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  NULL,
  'jordan.piecer@example.com',
  'Jordan',
  'Reyes',
  '512-555-0198',
  '{"city":"Round Rock","state":"TX","country":"US"}',
  '{"years_quilting":"1-5","mqg_member":"No"}',
  'active',
  '2025-02-01T00:00:00.000Z',
  'Sample active member (manual renew)',
  datetime('now'), datetime('now')
);

INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES (
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60305',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  NULL,
  'alex.newquilter@example.com',
  'Alex',
  'Nguyen',
  NULL,
  '{"city":"Austin","state":"TX","country":"US"}',
  '{"years_quilting":"Brand new","mqg_member":"Not sure"}',
  'pending',
  NULL,
  'Pending join application',
  datetime('now'), datetime('now')
);

INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES (
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60306',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  NULL,
  'sam.lapsed@example.com',
  'Sam',
  'Brooks',
  NULL,
  '{"city":"Pflugerville","state":"TX","country":"US"}',
  '{"years_quilting":"5-10","mqg_member":"Yes"}',
  'lapsed',
  '2021-01-01T00:00:00.000Z',
  'Lapsed 2025 — good renewal target',
  datetime('now'), datetime('now')
);

-- Memberships
INSERT INTO memberships (
  id, tenant_id, member_id, level_id, start_date, end_date, status,
  amount_paid_cents, auto_renew, created_at, updated_at
) VALUES
(
  'b0c1d2e3-f4a5-4060-b1c2-d3e4f5a60401',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60301',
  'd1e2f3a4-5b6c-7d8e-9f0a-1b2c3d4e5f60',
  '2026-01-01', '2026-12-31', 'active', 6000, 0, datetime('now'), datetime('now')
),
(
  'b0c1d2e3-f4a5-4060-b1c2-d3e4f5a60402',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60302',
  'd1e2f3a4-5b6c-7d8e-9f0a-1b2c3d4e5f61',
  '2026-01-01', '2026-12-31', 'active', 6000, 1, datetime('now'), datetime('now')
),
(
  'b0c1d2e3-f4a5-4060-b1c2-d3e4f5a60403',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60303',
  'd1e2f3a4-5b6c-7d8e-9f0a-1b2c3d4e5f61',
  '2026-01-01', '2026-12-31', 'active', 6000, 1, datetime('now'), datetime('now')
),
(
  'b0c1d2e3-f4a5-4060-b1c2-d3e4f5a60404',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60304',
  'd1e2f3a4-5b6c-7d8e-9f0a-1b2c3d4e5f60',
  '2026-01-01', '2026-12-31', 'active', 6000, 0, datetime('now'), datetime('now')
),
(
  'b0c1d2e3-f4a5-4060-b1c2-d3e4f5a60405',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60306',
  'd1e2f3a4-5b6c-7d8e-9f0a-1b2c3d4e5f60',
  '2025-01-01', '2025-12-31', 'expired', 6000, 0, datetime('now'), datetime('now')
);

-- Sample paid dues payment for Maya
INSERT INTO payments (
  id, tenant_id, member_id, type, amount_cents, currency, status,
  description, related_id, created_at, updated_at
) VALUES (
  'c0d1e2f3-a4b5-4060-c1d2-e3f4a5b60501',
  'c8f4e2a1-9b3d-4e7f-a1c2-0d5e6f7a8b9c',
  'a0b1c2d3-e4f5-4060-a1b2-c3d4e5f60303',
  'membership',
  6000,
  'usd',
  'succeeded',
  '2026 General Membership w/Auto-Renewal',
  'b0c1d2e3-f4a5-4060-b1c2-d3e4f5a60403',
  '2026-01-03T15:22:00.000Z',
  '2026-01-03T15:22:00.000Z'
);
