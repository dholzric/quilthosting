-- Task 8: the section renderer now serves every tenant site. Guilds that
-- already exist keep the classic guild.html shell until an admin opts in
-- (Website -> Design -> "Try the new design"), so their public site does not
-- change underneath them. New guilds get settings.site.renderer = "sections"
-- from the kit apply; a missing key means the new renderer.
--
-- settings_json is NOT NULL DEFAULT '{}' (0001), but json_set/json_extract
-- throw on a blank or malformed value and would abort the whole statement, so
-- a blank value is treated as '{}' and a malformed one is left untouched (the
-- app already reads it as {} everywhere; it renders with the new renderer,
-- which is the safe default for a row nobody can have customised).
UPDATE tenants
SET settings_json = json_set(coalesce(nullif(trim(settings_json), ''), '{}'), '$.site.renderer', 'legacy')
WHERE coalesce(tenant_type, 'guild') = 'guild'
  AND CASE
        WHEN json_valid(coalesce(nullif(trim(settings_json), ''), '{}'))
        THEN json_extract(coalesce(nullif(trim(settings_json), ''), '{}'), '$.site.renderer') IS NULL
        ELSE 0
      END;
