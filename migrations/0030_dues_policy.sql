-- Phase 4, Task A: a membership level carries a dues policy.
--
-- A quilt guild sells a membership YEAR, not "twelve months from whenever
-- you signed up". These four columns let a level say which year it means,
-- what a member pays who joins partway through it, and how long a lapsed
-- member keeps their card before the nightly job flips them to lapsed.
--
-- Every default reproduces TODAY's behavior exactly: term_mode
-- 'anniversary' with no proration and no grace period is the term
-- computeMembershipEnd has always produced, so no existing level, member,
-- price or renewal date moves when this migration runs. A level changes
-- behavior only when an officer edits it in Admin -> Levels, and the editor
-- says in plain words that existing members keep the dates they have.
--
-- term_mode   'anniversary' (the term starts the day they join)
--             'calendar'    (January 1 - December 31; term_anchor stays NULL)
--             'fixed_date'  (term_anchor 'MM-DD', e.g. '07-01' for a July
--                            year running July 1 - June 30)
-- term_anchor 'MM-DD' for fixed_date only. February 29 is allowed and is
--             clamped to February 28 in non-leap years.
-- proration   'none'      everyone pays full price whenever they join
--             'half_year' half price from the midpoint of the year on
--             'monthly'   pay for the months left in the year
--             First term only; renewals always pay full price. Meaningless
--             for 'anniversary', where the term already starts on payment
--             day (src/lib/dues.ts normalizes it away).
-- grace_days  days after end_date before src/lib/renewals.ts lapses the
--             membership. 0 = today's behavior (lapse the day after).
--
-- SQLite has no ALTER TABLE ... ADD COLUMN with a non-constant default, and
-- these are all constants, so each statement rewrites no rows.
ALTER TABLE membership_levels ADD COLUMN term_mode TEXT NOT NULL DEFAULT 'anniversary';
ALTER TABLE membership_levels ADD COLUMN term_anchor TEXT;
ALTER TABLE membership_levels ADD COLUMN proration TEXT NOT NULL DEFAULT 'none';
ALTER TABLE membership_levels ADD COLUMN grace_days INTEGER NOT NULL DEFAULT 0;
