-- Phase 2 Task B: responsive image variants and per-image metadata.
--
-- The editor resizes an uploaded image in the browser (WebP + JPEG at
-- 480/960/1600/2400) and POSTs them to /files/:id/variants; the server
-- re-sniffs every part and stores them in R2 under `${r2_key}/w<w>.<ext>`.
--   width, height  -- pixel size of the ORIGINAL (client-declared, bounded)
--   variants_json  -- [{ w, format: "webp"|"jpeg", key, bytes }]
--   focal_json     -- [x, y] in 0..1, the point crops keep in view
--   alt            -- alt text for <img> (<= 200 chars)
-- All nullable: every existing row keeps working with no variants.
ALTER TABLE files ADD COLUMN width INTEGER;
ALTER TABLE files ADD COLUMN height INTEGER;
ALTER TABLE files ADD COLUMN variants_json TEXT;
ALTER TABLE files ADD COLUMN focal_json TEXT;
ALTER TABLE files ADD COLUMN alt TEXT;
