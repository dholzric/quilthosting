-- Austin Area Quilt Guild — demo tenant mirrored from https://www.aaqg.org/
-- Also Wild Apricot (custom domain), larger traditional guild + QuiltFest.

-- Tenant
INSERT INTO tenants (
  id, name, slug, plan, status, settings_json, created_at, updated_at
) VALUES (
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Austin Area Quilt Guild',
  'aaqg',
  'pro',
  'active',
  '{"profile":{"description":"Founded in 1978. Central Texas'' largest and oldest quilting guild — preserving the heritage of quilting and promoting excellence and education in quilt-making. 501(c)(3) non-profit.","meeting_info":"Usually first Monday: morning (doors 9:00, meeting 9:45) and evening hybrid (doors 6:00, meeting 6:45)","location":"Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703","mailing_address":"P.O. Box 5757, Austin, TX 78763","contact_email":"membership@aaqg.org","president_email":"president@aaqg.org","website":"https://www.aaqg.org","donations_enabled":true,"nonprofit":"501c3"},"custom_fields":[{"key":"age_band","label":"Membership age band","type":"select","options":["24 and under (Junior)","25-61 (Regular)","62+ (Senior)"],"show_on_join":true},{"key":"years_quilting","label":"Years quilting","type":"select","options":["Brand new","1-5","5-10","10-20","20+"],"show_on_join":true},{"key":"interests","label":"Interests","type":"text","show_on_join":true}],"source":"wildapricot-mirror","source_url":"https://www.aaqg.org/"}',
  datetime('now'),
  datetime('now')
);

INSERT INTO tenant_users (tenant_id, user_id, role, created_at) VALUES
(
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'e51d306c-7561-442b-8f5d-4ebff1a426c8',
  'owner',
  datetime('now')
),
(
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'a17015fb-a882-4805-989b-a4de32c64066',
  'admin',
  datetime('now')
);

-- Membership levels (from JoinRenew: Junior / Regular $40 / Senior $40)
INSERT INTO membership_levels (
  id, tenant_id, name, description, price_cents, duration_months,
  renewal_type, benefits_json, is_public, sort_order, status, created_at, updated_at
) VALUES
(
  'aaqg-level-junior-0001-0000-000000000001',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Junior',
  'Ages 24 and under. 1-year membership, manual renewal. Special junior rate (listed free on public join form).',
  0, 12, 'manual',
  '["Monthly morning & evening meetings","Show and Tell","Workshop discounts","Open sew days","Bees across Austin","Newsletter: The Quilting Quips","Member pin"]',
  1, 0, 'active', datetime('now'), datetime('now')
),
(
  'aaqg-level-regular-0001-0000-000000000002',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Regular',
  'Ages 25 to 61. Annual dues $40. 1-year membership, no auto-renew (payments via PayPal on live site).',
  4000, 12, 'manual',
  '["Monthly morning & evening meetings","Show and Tell","Workshop discounts","Open sew days","Bees across Austin","Newsletter: The Quilting Quips","Member pin","Retreats & bus trips"]',
  1, 1, 'active', datetime('now'), datetime('now')
),
(
  'aaqg-level-senior-00001-0000-000000000003',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Senior',
  'Ages 62 and older. Annual dues $40 (same as Regular on current join form). 1-year, manual renewal.',
  4000, 12, 'manual',
  '["Monthly morning & evening meetings","Show and Tell","Workshop discounts","Open sew days","Bees across Austin","Newsletter: The Quilting Quips","Member pin","Retreats & bus trips"]',
  1, 2, 'active', datetime('now'), datetime('now')
);

-- Pages
INSERT INTO pages (
  id, tenant_id, slug, title, content_json, is_members_only, published,
  sort_order, page_type, show_in_nav, nav_label, created_at, updated_at
) VALUES
(
  'aaqg-page-home-00001-0000-000000000001',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'home',
  'Home',
  '{"html":"<h2>Austin Area Quilt Guild</h2><p>Central Texas'' largest and oldest quilting guild. Founded in 1978. 501(c)(3) non-profit.</p><p><strong><a href=\"#\">Capital of Texas QuiltFest — Aug 20–23, 2026</a></strong> at Palmer Events Center. Quilt entries closed (entry goal reached).</p><h3>What members get</h3><ul><li><strong>Monthly meetings</strong> — free access; learn, inspire, show your latest project</li><li><strong>Lectures &amp; workshops</strong> — local and national speakers several times a year</li><li><strong>Retreats</strong> — full weekends sewing with friends</li><li><strong>Quilting bees</strong> — across Austin</li></ul><p><strong>Be our guest!</strong> Your first two meetings are free. At the third, we ask that you join.</p>"}',
  0, 1, 0, 'page', 1, 'Home', datetime('now'), datetime('now')
),
(
  'aaqg-page-about-0001-0000-000000000002',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'about',
  'About Us',
  '{"html":"<h2>About Us</h2><p>The Austin Area Quilt Guild (AAQG) was founded in 1978 and is dedicated to preserving the heritage of quilting and promoting excellence and education in the art of quilt-making. AAQG is a 501(c)(3) non-profit corporation. Membership is open to anyone interested in quilts — beginning, intermediate, and advanced quilters, as well as collectors and admirers. Dues are paid annually with special rates for juniors and seniors.</p><p>Monthly guild meetings are usually held the first Monday of the month at <strong>Westminster Presbyterian Church of Austin</strong>, 3208 Exposition Blvd, Austin, Texas. Meetings offer fellowship, speakers, programs, and Show and Tell. Non-members may attend twice as guests before joining.</p><p><strong>Mailing address:</strong><br/>Austin Area Quilt Guild<br/>P.O. Box 5757<br/>Austin, TX 78763</p>"}',
  0, 1, 1, 'page', 1, 'About Us', datetime('now'), datetime('now')
),
(
  'aaqg-page-meetings-01-0000-000000000003',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'guild-meetings',
  'Guild Meetings',
  '{"html":"<h2>Guild Meetings</h2><p>Usually the first Monday of the month at Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703.</p><ul><li><strong>Morning:</strong> doors 9:00 AM · meeting 9:45 AM</li><li><strong>Evening:</strong> hybrid (Zoom + in person) · doors 6:00 PM · meeting 6:45 PM</li></ul><p>Bring Show and Tell pieces. Evening Zoom Show and Tell photos due to president@aaqg.org by noon, seven days before the meeting (limit 2).</p>"}',
  0, 1, 2, 'page', 1, 'Meetings', datetime('now'), datetime('now')
),
(
  'aaqg-page-quiltfest-1-0000-000000000004',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'quiltfest-2026',
  '2026 QuiltFest',
  '{"html":"<h2>Capital of Texas QuiltFest 2026</h2><p>AAQG hosts a biennial quilt show run by guild members to raise money for our mission. Quilts may be entered to be judged or for display.</p><h3>When &amp; where</h3><ul><li><strong>Friday</strong> Aug 21, 2026 · 10am–5pm</li><li><strong>Saturday</strong> Aug 22, 2026 · 10am–5pm</li><li><strong>Sunday</strong> Aug 23, 2026 · 11am–3pm</li></ul><p><strong>Palmer Event Center</strong><br/>900 Barton Springs Road, Austin, TX 78704</p><h3>Highlights</h3><ul><li>Over 300 quilts on display</li><li>Member-made raffle quilt</li><li>Many vendors</li><li>Special exhibits &amp; demonstrations</li><li>Boutique &amp; silent auction</li></ul><p>Quilt entries are closed for 2026 — entry goal reached. Buy raffle tickets in the store.</p>"}',
  0, 1, 3, 'page', 1, 'QuiltFest', datetime('now'), datetime('now')
),
(
  'aaqg-page-service-001-0000-000000000005',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'community-service',
  'Community Service',
  '{"html":"<h2>Community Service</h2><p>AAQG members support the community through ongoing projects including:</p><ul><li><strong>Baby Bundles Project</strong></li><li><strong>Comfort Quilts Project</strong></li></ul><p>Volunteer opportunities are posted year-round for meetings, QuiltFest, and service sewing.</p>"}',
  0, 1, 4, 'page', 1, 'Service', datetime('now'), datetime('now')
),
(
  'aaqg-page-bees-00001-0000-000000000006',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'bees',
  'AAQG Bees',
  '{"html":"<h2>Quilting Bees</h2><p>Members are eligible to participate in quilting bees all over Austin. Bees are informal small groups that sew, socialize, and support each other — ask the Bee Coordinator (beecoordinator@aaqg.org) to find a group near you.</p>"}',
  0, 1, 5, 'page', 1, 'Bees', datetime('now'), datetime('now')
),
(
  'aaqg-page-contact-001-0000-000000000007',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'contact',
  'Contact Us',
  '{"html":"<h2>Contact Us</h2><p><strong>Email</strong></p><ul><li>General: president@aaqg.org</li><li>Programs: programselect@aaqg.org</li><li>Membership: membership@aaqg.org</li><li>Quilt conservation: conservation@aaqg.org</li><li>Advertising: advertising@aaqg.org</li><li>Newsletter: newsletter@aaqg.org</li><li>Bee coordinator: beecoordinator@aaqg.org</li></ul><p><strong>Meetings:</strong> Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703</p><p><strong>Mail:</strong> P.O. Box 5757, Austin, TX 78763</p>"}',
  0, 1, 6, 'page', 1, 'Contact', datetime('now'), datetime('now')
),
(
  'aaqg-page-hire-00001-0000-000000000008',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'quilters-for-hire',
  'Quilters for Hire',
  '{"html":"<h2>Quilters for Hire</h2><p>Member directory listing for longarmers, teachers, and services — modeled on the live AAQG page. In QuiltHosting this is a published page; a full job-board style directory would use member directory fields or a form.</p>"}',
  0, 1, 7, 'page', 1, 'For Hire', datetime('now'), datetime('now')
);

-- Events (meetings, workshops, open sew, QuiltFest)
INSERT INTO events (
  id, tenant_id, title, description, location, start_at, end_at,
  capacity, is_public, member_price_cents, non_member_price_cents,
  registration_open, waitlist_enabled, settings_json, created_at, updated_at
) VALUES
(
  'aaqg-evt-qf2026-0001-0000-000000000001',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'QuiltFest 2026 — Capital of Texas',
  'Biennial AAQG quilt show. Over 300 quilts, vendors, raffle quilt, boutique & silent auction. Public admission event (demo: register for volunteer interest / staff notes).',
  'Palmer Events Center, 900 Barton Springs Road, Austin, TX 78704',
  '2026-08-21T15:00:00.000Z',
  '2026-08-23T20:00:00.000Z',
  5000, 1, 0, 1500, 1, 0, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-ws-nina1-001-0000-000000000002',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Thread Painting Workshop — Nina Clotfelter',
  'Hands-on workshop with guest artist Nina Clotfelter.',
  'Austin Sewing, 1601 S. I-35 Frontage Road #300, Round Rock, TX 78664',
  '2026-09-12T14:00:00.000Z',
  '2026-09-12T21:00:00.000Z',
  20, 1, 7500, 9500, 1, 1, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-ws-nina2-001-0000-000000000003',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Chop It Like It''s Hot! Workshop — Nina Clotfelter',
  'Workshop with Nina Clotfelter at Austin Sewing.',
  'Austin Sewing, 1601 S. I-35 Frontage Road #300, Round Rock, TX 78664',
  '2026-09-13T14:00:00.000Z',
  '2026-09-13T21:00:00.000Z',
  20, 1, 7500, 9500, 1, 1, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-sep-am-0001-0000-000000000004',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'September MORNING Meeting: Nina Clotfelter',
  'Doors 9:00 · Meeting 9:45. Guest lecture: \"What If…\" — listening to your creative voice. In person only.',
  'Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703',
  '2026-09-14T14:00:00.000Z',
  '2026-09-14T17:00:00.000Z',
  200, 1, 0, 0, 1, 0, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-sep-pm-0001-0000-000000000005',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'September EVENING Meeting: Nina Clotfelter',
  'Hybrid. Doors 6:00 · Meeting 6:45. Lecture: THREADS — What''s the BIG deal? (WonderFil educator). Free table + Show and Tell.',
  'Hybrid: Zoom and Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703',
  '2026-09-14T23:00:00.000Z',
  '2026-09-15T01:30:00.000Z',
  250, 1, 0, 0, 1, 0, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-opensew-001-0000-000000000006',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Open Sew Day, South',
  'Open sew day for members and guests.',
  'Travis County Oak Hill Community Center, 8656 State Hwy 71, Austin, TX 78735',
  '2026-09-25T14:00:00.000Z',
  '2026-09-25T21:00:00.000Z',
  40, 1, 0, 1000, 1, 1, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-ws-dorene-01-0000-00000000007',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Animal Portraiture — Dorene Joyce',
  'Workshop with Dorene Joyce at Austin Sewing.',
  'Austin Sewing, 1601 S. I-35 Frontage Road #300, Round Rock, TX 78664',
  '2026-10-03T14:00:00.000Z',
  '2026-10-03T21:00:00.000Z',
  18, 1, 7500, 9500, 1, 1, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-oct-am-0001-0000-000000000008',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'October MORNING Meeting: Dorene Joyce',
  'Doors 9:00 · Meeting 9:45. Lecture: Threads of Inspiration — An AI Journey Through Creativity.',
  'Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703',
  '2026-10-05T14:00:00.000Z',
  '2026-10-05T17:00:00.000Z',
  200, 1, 0, 0, 1, 0, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-oct-pm-0001-0000-000000000009',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'October EVENING Meeting: Dorene Joyce',
  'Hybrid. Doors 6:00 · Meeting 6:45. Same AI creativity program as morning session.',
  'Hybrid: Zoom and Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703',
  '2026-10-05T23:00:00.000Z',
  '2026-10-06T02:00:00.000Z',
  250, 1, 0, 0, 1, 0, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-nov-pm-0001-0000-000000000010',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'November EVENING Meeting: Emma Jane Powell',
  'Hybrid. Lecture: Playful Palettes for Quilters — color tools from your stash.',
  'Hybrid: Zoom and Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703',
  '2026-11-10T00:00:00.000Z',
  '2026-11-10T02:30:00.000Z',
  250, 1, 0, 0, 1, 0, '{}',
  datetime('now'), datetime('now')
),
(
  'aaqg-evt-dec-pm-0001-0000-000000000011',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'December EVENING Holiday Social: Quilter''s Strip Poker!',
  'Holiday social. Bring at least 10 strips of 2.5\" fabric (12–24\") and a treat to share.',
  'Hybrid: Zoom and Westminster Presbyterian Church, 3208 Exposition Blvd, Austin, TX 78703',
  '2026-12-08T00:00:00.000Z',
  '2026-12-08T02:30:00.000Z',
  250, 1, 0, 0, 1, 0, '{}',
  datetime('now'), datetime('now')
);

-- Store: raffle ticket bundles + sponsorships (from AAQG Store)
INSERT INTO products (
  id, tenant_id, name, description, price_cents, inventory, is_active, sort_order, sku, taxable, created_at, updated_at
) VALUES
('aaqg-prod-tix6-0001-0000-000000000001', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'Digital Tickets — bundle of 6', 'QuiltFest raffle quilt digital tickets', 500, NULL, 1, 0, 'RAFFLE-6', 0, datetime('now'), datetime('now')),
('aaqg-prod-tix12-001-0000-000000000002', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'Digital Tickets — Bundle of 12', 'QuiltFest raffle quilt digital tickets', 1000, NULL, 1, 1, 'RAFFLE-12', 0, datetime('now'), datetime('now')),
('aaqg-prod-tix24-001-0000-000000000003', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'Digital Tickets — Bundle of 24', 'QuiltFest raffle quilt digital tickets', 2000, NULL, 1, 2, 'RAFFLE-24', 0, datetime('now'), datetime('now')),
('aaqg-prod-tix30-001-0000-000000000004', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'Digital Tickets — bundle of 30', 'QuiltFest raffle quilt digital tickets', 2500, NULL, 1, 3, 'RAFFLE-30', 0, datetime('now'), datetime('now')),
('aaqg-prod-tix60-001-0000-000000000005', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'Digital Tickets — Bundle of 60', 'QuiltFest raffle quilt digital tickets', 5000, NULL, 1, 4, 'RAFFLE-60', 0, datetime('now'), datetime('now')),
('aaqg-prod-tix90-001-0000-000000000006', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'Digital Tickets — Bundle of 90', 'QuiltFest raffle quilt digital tickets', 7500, NULL, 1, 5, 'RAFFLE-90', 0, datetime('now'), datetime('now')),
('aaqg-prod-tix120-01-0000-000000000007', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'Digital Tickets — Bundle of 120', 'QuiltFest raffle quilt digital tickets', 10000, NULL, 1, 6, 'RAFFLE-120', 0, datetime('now'), datetime('now')),
('aaqg-prod-spon-q1-01-0000-00000000008', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'QuiltFest Sponsorship: Quilt Level 1', 'Show sponsorship package', 20000, NULL, 1, 10, 'SPON-Q1', 0, datetime('now'), datetime('now')),
('aaqg-prod-spon-q2-01-0000-00000000009', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'QuiltFest Sponsorship: Quilt Level 2', 'Show sponsorship package', 25000, NULL, 1, 11, 'SPON-Q2', 0, datetime('now'), datetime('now')),
('aaqg-prod-spon-q4-01-0000-00000000010', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'QuiltFest Sponsorship: Quilt Level 4', 'Show sponsorship package', 35000, NULL, 1, 12, 'SPON-Q4', 0, datetime('now'), datetime('now')),
('aaqg-prod-spon-g1-01-0000-00000000011', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'QuiltFest Sponsorship Guild Level 1', 'Guild-level sponsorship', 40000, NULL, 1, 13, 'SPON-G1', 0, datetime('now'), datetime('now')),
('aaqg-prod-spon-g2-01-0000-00000000012', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'QuiltFest Sponsorship Guild Level 2', 'Guild-level sponsorship', 45000, NULL, 1, 14, 'SPON-G2', 0, datetime('now'), datetime('now')),
('aaqg-prod-spon-g3-01-0000-00000000013', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'QuiltFest Sponsorship Guild Level 3', 'Guild-level sponsorship', 50000, NULL, 1, 15, 'SPON-G3', 0, datetime('now'), datetime('now'));

-- Member groups (bees as groups)
INSERT INTO member_groups (id, tenant_id, name, description, created_at, updated_at) VALUES
('aaqg-grp-bees-north-0000000000000001', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'North Austin Bee', 'Sample bee — northwest Austin sew group', datetime('now'), datetime('now')),
('aaqg-grp-bees-south-0000000000000002', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'South Austin Bee', 'Sample bee — Oak Hill / south sew group', datetime('now'), datetime('now')),
('aaqg-grp-board-00001-0000000000000003', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'Board of Directors', 'AAQG board (demo group)', datetime('now'), datetime('now')),
('aaqg-grp-qf-vol-0001-0000000000000004', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'QuiltFest Volunteers', '2026 show volunteers', datetime('now'), datetime('now'));

-- Forms: volunteer signup + quilt entry interest
INSERT INTO forms (
  id, tenant_id, name, slug, description, form_type, fields_json, is_public, published, created_at, updated_at
) VALUES
(
  'aaqg-form-volunteer-0000000000000001',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'Volunteer Interest',
  'volunteer',
  'Sign up to help with meetings, service projects, or QuiltFest.',
  'survey',
  '[{"key":"name","label":"Name","type":"text","required":true},{"key":"email","label":"Email","type":"email","required":true},{"key":"areas","label":"Where can you help?","type":"select","options":["Meetings","Baby Bundles","Comfort Quilts","QuiltFest","Hospitality","Other"],"required":true},{"key":"notes","label":"Notes","type":"textarea","required":false}]',
  1, 1, datetime('now'), datetime('now')
),
(
  'aaqg-form-entry-00001-000000000000002',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'QuiltFest Entry Interest (demo)',
  'quiltfest-entry',
  '2026 entries are closed on the live site — this form is a demo of show entry collection.',
  'survey',
  '[{"key":"maker","label":"Maker name","type":"text","required":true},{"key":"email","label":"Email","type":"email","required":true},{"key":"title","label":"Quilt title","type":"text","required":true},{"key":"width_in","label":"Width (inches)","type":"number","required":true},{"key":"height_in","label":"Height (inches)","type":"number","required":true},{"key":"judged","label":"Enter for judging?","type":"select","options":["Judged","Display only"],"required":true}]',
  1, 1, datetime('now'), datetime('now')
);

-- Sample members
INSERT INTO members (
  id, tenant_id, user_id, email, first_name, last_name, phone,
  address_json, custom_fields_json, status, joined_at, notes, created_at, updated_at
) VALUES
(
  'aaqg-mem-dan-00001-0000-000000000001',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'e51d306c-7561-442b-8f5d-4ebff1a426c8',
  'dholzric@gmail.com', 'Dan', 'Holzrichter', NULL,
  '{"city":"Austin","state":"TX","country":"US"}',
  '{"age_band":"25-61 (Regular)","years_quilting":"10-20"}',
  'active', '2020-01-01T00:00:00.000Z', 'Demo owner', datetime('now'), datetime('now')
),
(
  'aaqg-mem-steph-001-0000-000000000002',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'a17015fb-a882-4805-989b-a4de32c64066',
  'sholzric@gmail.com', 'Stephanie', 'Holzrichter', NULL,
  '{"city":"Austin","state":"TX","country":"US"}',
  '{"age_band":"25-61 (Regular)","years_quilting":"20+"}',
  'active', '2018-03-01T00:00:00.000Z', 'Demo admin', datetime('now'), datetime('now')
),
(
  'aaqg-mem-pat-00001-0000-000000000003',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  NULL, 'pat.piecer@example.com', 'Pat', 'Morrison', '512-555-0101',
  '{"city":"Austin","state":"TX","zip":"78703"}',
  '{"age_band":"62+ (Senior)","years_quilting":"20+","interests":"traditional, applique"}',
  'active', '2010-05-01T00:00:00.000Z', 'Long-time senior member', datetime('now'), datetime('now')
),
(
  'aaqg-mem-riley-001-0000-000000000004',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  NULL, 'riley.junior@example.com', 'Riley', 'Santos', NULL,
  '{"city":"Cedar Park","state":"TX"}',
  '{"age_band":"24 and under (Junior)","years_quilting":"1-5"}',
  'active', '2025-09-01T00:00:00.000Z', 'Junior member', datetime('now'), datetime('now')
),
(
  'aaqg-mem-leslie-01-0000-000000000005',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  NULL, 'leslie.longarm@example.com', 'Leslie', 'Grant', '512-555-0177',
  '{"city":"Round Rock","state":"TX"}',
  '{"age_band":"25-61 (Regular)","years_quilting":"10-20","interests":"longarm for hire"}',
  'active', '2019-11-12T00:00:00.000Z', 'Listed on Quilters for Hire (demo)', datetime('now'), datetime('now')
),
(
  'aaqg-mem-guest-001-0000-000000000006',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  NULL, 'guest.visitor@example.com', 'Casey', 'Visitor', NULL,
  '{"city":"Austin","state":"TX"}',
  '{"years_quilting":"Brand new"}',
  'pending', NULL, 'Attended 1 free guest meeting', datetime('now'), datetime('now')
),
(
  'aaqg-mem-lapsed-01-0000-000000000007',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  NULL, 'former.member@example.com', 'Fran', 'Weaver', NULL,
  '{"city":"Pflugerville","state":"TX"}',
  '{"age_band":"62+ (Senior)","years_quilting":"20+"}',
  'lapsed', '2015-01-01T00:00:00.000Z', 'Did not renew 2026', datetime('now'), datetime('now')
);

INSERT INTO memberships (
  id, tenant_id, member_id, level_id, start_date, end_date, status,
  amount_paid_cents, auto_renew, created_at, updated_at
) VALUES
('aaqg-ms-dan-00001-0000-000000000001', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'aaqg-mem-dan-00001-0000-000000000001', 'aaqg-level-regular-0001-0000-000000000002', '2026-01-01', '2026-12-31', 'active', 4000, 0, datetime('now'), datetime('now')),
('aaqg-ms-steph-001-0000-000000000002', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'aaqg-mem-steph-001-0000-000000000002', 'aaqg-level-regular-0001-0000-000000000002', '2026-01-01', '2026-12-31', 'active', 4000, 0, datetime('now'), datetime('now')),
('aaqg-ms-pat-00001-0000-000000000003', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'aaqg-mem-pat-00001-0000-000000000003', 'aaqg-level-senior-00001-0000-000000000003', '2026-01-01', '2026-12-31', 'active', 4000, 0, datetime('now'), datetime('now')),
('aaqg-ms-riley-001-0000-000000000004', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'aaqg-mem-riley-001-0000-000000000004', 'aaqg-level-junior-0001-0000-000000000001', '2026-01-01', '2026-12-31', 'active', 0, 0, datetime('now'), datetime('now')),
('aaqg-ms-leslie-01-0000-000000000005', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'aaqg-mem-leslie-01-0000-000000000005', 'aaqg-level-regular-0001-0000-000000000002', '2026-01-01', '2026-12-31', 'active', 4000, 0, datetime('now'), datetime('now')),
('aaqg-ms-fran-00001-0000-000000000006', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', 'aaqg-mem-lapsed-01-0000-000000000007', 'aaqg-level-senior-00001-0000-000000000003', '2025-01-01', '2025-12-31', 'expired', 4000, 0, datetime('now'), datetime('now'));

INSERT INTO member_group_members (group_id, member_id, tenant_id, created_at) VALUES
('aaqg-grp-board-00001-0000000000000003', 'aaqg-mem-dan-00001-0000-000000000001', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', datetime('now')),
('aaqg-grp-board-00001-0000000000000003', 'aaqg-mem-steph-001-0000-000000000002', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', datetime('now')),
('aaqg-grp-bees-north-0000000000000001', 'aaqg-mem-pat-00001-0000-000000000003', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', datetime('now')),
('aaqg-grp-bees-south-0000000000000002', 'aaqg-mem-leslie-01-0000-000000000005', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', datetime('now')),
('aaqg-grp-qf-vol-0001-0000000000000004', 'aaqg-mem-steph-001-0000-000000000002', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', datetime('now')),
('aaqg-grp-qf-vol-0001-0000000000000004', 'aaqg-mem-pat-00001-0000-000000000003', 'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d', datetime('now'));

INSERT INTO payments (
  id, tenant_id, member_id, type, amount_cents, currency, status,
  description, related_id, created_at, updated_at
) VALUES
(
  'aaqg-pay-pat-00001-0000-000000000001',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'aaqg-mem-pat-00001-0000-000000000003',
  'membership', 4000, 'usd', 'succeeded',
  '2026 Senior membership',
  'aaqg-ms-pat-00001-0000-000000000003',
  '2026-01-08T14:00:00.000Z', '2026-01-08T14:00:00.000Z'
),
(
  'aaqg-pay-tix-00001-0000-000000000002',
  'a9c8b7d6-e5f4-4a3b-9c8d-7e6f5a4b3c2d',
  'aaqg-mem-leslie-01-0000-000000000005',
  'store', 1000, 'usd', 'succeeded',
  'Digital Tickets — Bundle of 12',
  'aaqg-prod-tix12-001-0000-000000000002',
  '2026-03-15T18:30:00.000Z', '2026-03-15T18:30:00.000Z'
);
