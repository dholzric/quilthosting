-- Phase 4, Task B: household memberships — one payment, many members.
--
-- A quilt guild's most common January SKU is "one payment, two quilters at
-- the same address". Before this migration the only way to express it was
-- two paid memberships, or one membership and an off-books spouse who could
-- not sign in, appear in the directory, or register at member prices.
--
-- The MEMBERSHIP still belongs to the payer. A household is a separate fact:
-- a `households` row naming the payer, and one `household_members` row per
-- person. Membership for a non-payer is DERIVED — "they are in a household
-- whose payer has an active membership" — which is why nothing here
-- duplicates a memberships row per person. src/lib/households.ts owns that
-- derivation as a single SQL fragment (`activeMembershipFilter`) so the
-- roster, the directory, the portal, member pricing and the plan cap cannot
-- disagree about who is a member.
--
-- NOTHING IS INFERRED. A household exists because an officer, a join form,
-- or an import column said so — never because two rows share a surname or an
-- address. Guessing family structure from data is exactly the kind of error
-- a migration must not make.
--
-- Every column added here defaults to today's behavior: household_max = 1 is
-- an ordinary individual level, household_add_cents = 0 charges nothing
-- extra, and memberships.household_id stays NULL for every existing row. No
-- term, price or renewal date moves when this migration runs.

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- What the guild calls them on the roster ("The Alvarez household").
  name TEXT NOT NULL,
  -- The one person who pays and who owns the membership row. Exactly one per
  -- household by design; a second payer is explicitly out of scope (it would
  -- bring refund-splitting questions with it).
  payer_member_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_households_tenant ON households (tenant_id);
CREATE INDEX IF NOT EXISTS idx_households_payer ON households (tenant_id, payer_member_id);

CREATE TABLE IF NOT EXISTS household_members (
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  -- 'payer' | 'member'. The payer row is what ties the household back to the
  -- membership; every other row derives its membership from it.
  role TEXT NOT NULL DEFAULT 'member',
  added_at TEXT NOT NULL,
  PRIMARY KEY (household_id, member_id),
  -- A person belongs to at most ONE household. Without this a member could
  -- derive an active membership from two different payers and the plan cap
  -- would count them twice.
  UNIQUE (member_id)
);

-- household_max = 1 means "an ordinary individual level", which is every
-- level that existed before this migration. > 1 turns the public join form
-- into the household form: the payer plus up to household_max - 1 more
-- people, in one dialog, for one payment.
ALTER TABLE membership_levels ADD COLUMN household_max INTEGER NOT NULL DEFAULT 1;
-- A flat add-on per extra person, in cents. 0 = the household costs the same
-- as one membership, which is what a guild that just wants "couples join
-- together" wants.
ALTER TABLE membership_levels ADD COLUMN household_add_cents INTEGER NOT NULL DEFAULT 0;

-- Set when this single membership covers a household, so a renewal notice
-- and a treasurer's report can name the household the payment bought.
ALTER TABLE memberships ADD COLUMN household_id TEXT;
