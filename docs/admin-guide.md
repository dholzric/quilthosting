# Admin guide

Product HTML: [/docs/admin-guide.html](../public/docs/admin-guide.html)

## Sidebar

Dashboard · Members · Levels · Events · Store · Payments · Invoices · Email · Automations · Forms · Website · Blog · Forum · Documents · SMS · Chapters · API · Team · Settings

## Roles

`owner` · `admin` · `membership` · `events` · `viewer` — nav filtered by role.

## Importing your members

Members → Import lets you bring a member list in from a CSV export (Wild
Apricot or otherwise) without guessing at column names:

1. **Choose the file.** The importer reads every column in your CSV,
   including ones it doesn't recognize — nothing is silently dropped.
2. **Check the column table.** Each column shows an example value from your
   file and a dropdown for where it goes: a known member field (email,
   first name, last name, phone, status, notes, level, end/expiry date,
   joined date), **Import as custom field**, or **Do not import**. Common
   header spellings (`First`, `Membership Type`, `Renewal Date`, `Member
   Since`, etc.) are pre-matched automatically; check the table to confirm
   the guesses, especially if your file has unusual headers.
3. **Promote a column to a custom field** if it's guild-specific data (a
   guild number, a fabric-stash size, whatever your file has) that doesn't
   fit a built-in field — pick **Import as custom field** and it becomes a
   permanent custom field on every member going forward, not just this
   import.
4. **Read the warnings.** Below the column table, "What will happen" shows
   how many members will be created, updated, and skipped, plus anything
   worth double-checking: columns that won't be imported, two columns
   mapped to the same field, dates or statuses that couldn't be read,
   membership levels that don't exist yet, or free-plan seats that will
   land as pending instead of active. **Nothing is written to your guild
   until you press Import** — changing a column's mapping just re-checks
   the file and updates this preview.
5. **Press Import.** You'll see a summary (created / updated / skipped,
   memberships assigned, custom fields created). If any rows need your
   attention, a **Download N problem rows** button gives you a CSV of just
   those rows with the reason for each, so you can fix and re-import only
   the problems instead of re-running the whole file.

**Re-importing is safe against duplicates.** Rows are matched by email —
importing the same file again (or a corrected version of it) **updates**
existing members rather than creating duplicates, and any custom-field
values you've since entered by hand on a member are kept, not overwritten,
unless the re-imported file supplies a new value for that same field.
(One exception to "safe" — see the warning under
["Import finished with problems"](#import-finished-with-problems--what-a-partial-import-means)
about re-running a file whose errors include membership failures.)

### "Import finished with problems" — what a partial import means

Every import is recorded, and each one ends up in one of two everyday
states:

- **Complete** — nothing was lost. It does not mean nothing happened worth
  reading: a complete import can still tell you about decisions QuiltHosting
  made for you (see **"We chose your renewal dates"** below). Read the
  summary either way.
- **Partial** — *something in your file did not come through in full.* Your
  members were still imported; "partial" is not a crash and it is not a
  rollback. It's the importer refusing to tell you everything went fine
  when part of your data didn't make it.

An import is marked partial when any of these happened:

- Rows were **skipped** (no email address, a duplicate email inside the same
  file, or a row with a different number of columns than the header).
- A **membership couldn't be assigned** to someone the file said had one.
- A row named a **membership level that doesn't exist yet** in your guild —
  that person was imported, but with no membership.
- A **column you set to "Do not import"** actually had data in it. (An
  entirely empty ignored column is not counted — that's just noise in the
  export.)
- **Two columns pointed at the same field**, so one of them was ignored.
  This one counts *whether or not* the losing column had any data in it.
- A **date or status couldn't be read**, or a status in your file was
  overridden — e.g. a row marked "lapsed" that also names a level comes in
  as active.
- Some members were **held at your plan's active-member limit** (see below —
  this one is usually nothing to fix).

**What to do:** on the Members page, the **Recent imports** card lists your
50 most recent imports with when each ran, who ran it, the counts, and a
**Download errors** button. That CSV names the exact row numbers and the
reason for each one. Column-level notes (like "this column wasn't imported")
appear under the row in that card and at the bottom of the CSV, because they
aren't tied to any single row. (The card is the only place to reach those
downloads, so once an import falls past the 50 most recent, its error report
is no longer reachable — download anything you still need before then.)

Then fix those rows in your spreadsheet and **import the file again.**
Re-importing is the repair mechanism — members are matched by email, so rows
that already came through are updated in place rather than duplicated, and
you can safely re-import either the corrected full file or just the problem
rows.

⚠️ **Read the errors before you re-run — re-importing can make one thing
worse.** When a row assigns a membership to someone who *already* has an
active membership, that existing membership is expired first and the new one
written second. If the new one fails again (the same "membership couldn't be
assigned" error), that member is left with **no** active membership, where
before the re-import they had one. So if your error list contains membership
failures, work out why they failed before re-running the file — everything
else on this list is safe to re-import.

**What "partial" does not mean:** there is no undo. QuiltHosting cannot roll
a partial import back or resume it where it stopped, and it can't work out on
its own what's still missing. The fix is always: correct the file, import
again.

### "We chose your renewal dates" — a complete import can still have news

Most guild exports have a **Level** column and no renewal/expiry column at
all. A membership has to end *some* day, so when your file names a level but
gives no renewal date, **QuiltHosting picks one for you: one full term of
that level's duration, counted from the day you import.** A 12-month level
imported today renews a year from today.

That is not a loss — there was no date in your file to lose — so the import
still comes back **complete**. But it is a decision made on your behalf, so
the importer says so on screen and lists **every affected member with the
exact date chosen** in the same **Download problem rows** CSV. Skim it. If a
member's real renewal falls elsewhere, open that member and change their
renewal date.

⚠️ **A "Member Since" date does not set the renewal date.** If your file says
someone joined in 2019, that stays on their record as their join date — but
their renewal is still dated a full term from today, not from 2019. (Dating
the term from the join date is exactly what used to import an entire roster
as already-expired and lapse everyone overnight.) If your file *does* have a
renewal/expiry column, that column always wins — QuiltHosting never overrides
a date you supplied, even one in the past.

### Partial only because of your plan limit

The free plan allows 30 active members. The limit applies to making people
**newly** active — not to how big your file is.

**Re-importing members who are already active costs you nothing.** If you are
at 30 of 30 and you import your roster again — to fix phone numbers, to
renew everyone, whatever — those members are already active, so they are
asking for no new room. Nothing is held and **nobody is demoted by the plan
limit**.

That is a statement about the *plan limit only*, not a promise that any
re-import comes back with an empty report. Two things to know before you
re-run a roster:

- **A Level column re-activates people.** Naming a membership level on a row
  is an instruction to give that person a membership *now*, and it overrides
  whatever the Status column says — a row marked "lapsed" that also names a
  level comes back as **active**. If you want to leave lapsed members alone,
  blank out the Level cell for them (or delete the Level column) before
  re-importing.
- **A Level column with no renewal column moves renewal dates.** Every
  re-import re-dates those memberships to a full term from *that* day (see
  "We chose your renewal dates" above). Keep the renewal/expiry column in
  your file and QuiltHosting will use it instead.

**The roster QuiltHosting exports for you is safe to re-import on both
counts.** Members → Export writes the level and renewal date only for people
who have a **currently active** membership; a lapsed or cancelled member
exports with those two cells blank, so re-importing your own export does not
resurrect them, and active members carry their real renewal date back in
rather than being re-dated. (Earlier exports did carry a lapsed member's last
level, which on re-import reactivated them — if you have an old export saved,
clear the `level` cell on any lapsed or cancelled row before importing it.)

The limit bites when a file would make *more people active than you have room
for*: new members, or existing members you're bringing back from lapsed or
pending. Those extra people are still imported — they just don't get an
active membership. A **new** member held this way comes in as **pending**. An
**existing** member either keeps the status they already had or is set to
pending, depending on the row — either way the import never makes them
active.

The preview you see before importing counts this the same way, so if it says
nothing will be held, nothing will be held — **as long as your active-member
count hasn't changed in between.** The preview measures how much room you
have at the moment you press Preview. If someone joins, a membership lapses
overnight, or another admin imports while you're still looking at the
preview, the room has moved and the import will use the new number. Previewed
and imported in one sitting, the two agree; previewed before lunch and
imported after, re-run the preview.

Because those members aren't active, the import is recorded as partial. When
that's the *only* thing that happened, the result banner says so directly:
"Import complete — N member(s) are waiting on your plan's active-member
limit." **Nothing is wrong with your file.** Every row was imported and every
record is saved. Upgrade if you want those members active, or leave them as
they are.

One thing to know: in the **Recent imports** card, that same import is still
badged **partial** (amber). That's the same batch the banner just explained —
download its errors and you'll see every listed row is "held at the free-plan
limit."

## Highlights

- **Invoices:** multi-line, `INV-YYYY-#####`, print
- **Forms:** surveys with `show_if` conditionals
- **SMS:** optional Twilio in guild settings
- **Chapters:** parent/child Council structure
- **PWA:** offline event check-in queue
