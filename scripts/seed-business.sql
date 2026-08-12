-- scripts/seed-business.sql — local dev fixture for the business renderer.
DELETE FROM pages WHERE tenant_id = 'tnt_demo_business';
DELETE FROM tenants WHERE id = 'tnt_demo_business';

INSERT INTO tenants (id, name, slug, custom_domain, plan, status, tenant_type, public_launched, settings_json)
VALUES (
  'tnt_demo_business', 'Stitch Studio Quilting', 'stitchstudio', 'stitchstudioquilting.test',
  'free', 'active', 'business', 1,
  '{"theme":{"primary":"#8a2060","accent":"#a04080","themeColor":"#c060a0"},"fonts":{"heading":"fraunces","body":"inter"},"business":{"name":"Stitch Studio Quilting","city":"Wimberley","state":"TX","phone":"512-555-0100"}}'
);

INSERT INTO pages (id, tenant_id, slug, title, blocks_json, published, sort_order, seo_description)
VALUES (
  'pg_demo_home', 'tnt_demo_business', 'home', 'Stitch Studio Quilting',
  '[{"type":"hero","eyebrow":"Longarm quilting since 2009","title":"Stitch Studio Quilting","subtitle":"Edge-to-edge and custom longarm quilting in Wimberley, Texas.","ctaLabel":"Request a quote","ctaHref":"/contact"},{"type":"service_cards","items":[{"icon":"✦","title":"Edge to Edge","body":"An allover design across the whole quilt."},{"icon":"✹","title":"Custom Longarm","body":"Designs chosen block by block."}]}]',
  1, 0, 'Longarm quilting, classes, patterns, and custom T-shirt quilts in Wimberley, Texas.'
);
