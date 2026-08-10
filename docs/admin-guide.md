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
   memberships assigned, custom fields created). If any rows were skipped,
   a **Download skipped rows** button gives you a CSV of just those rows
   with the reason for each, so you can fix and re-import only the
   failures instead of re-running the whole file.

**Re-importing is safe.** Rows are matched by email — importing the same
file again (or a corrected version of it) **updates** existing members
rather than creating duplicates, and any custom-field values you've since
entered by hand on a member are kept, not overwritten, unless the
re-imported file supplies a new value for that same field.

## Highlights

- **Invoices:** multi-line, `INV-YYYY-#####`, print
- **Forms:** surveys with `show_if` conditionals
- **SMS:** optional Twilio in guild settings
- **Chapters:** parent/child Council structure
- **PWA:** offline event check-in queue
