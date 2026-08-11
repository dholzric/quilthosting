-- Task 4 review, Finding C: the "Recent imports" card is supposed to show
-- who ran an import, not just when/what. import_batches had no actor at
-- all. Both columns are captured from the authenticated user AT IMPORT
-- TIME:
--   - actor_user_id: the durable identity, for any future "filter by user"
--     or audit-trail need.
--   - actor_email: a SNAPSHOT of the email as it was that day, not a live
--     join to users.email. A guild admin reading this a year from now needs
--     to recognize who ran the import even if that user's account email
--     has since changed (or the user was deleted) -- a live join would
--     silently rewrite history or go blank.
-- Both nullable: existing rows predate this column and must stay valid;
-- the UI renders a null actor_email as "—".
ALTER TABLE import_batches ADD COLUMN actor_user_id TEXT;
ALTER TABLE import_batches ADD COLUMN actor_email TEXT;
