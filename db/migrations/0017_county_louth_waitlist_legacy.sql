-- County Louth: what its waitlist recorded that this schema does not.
--
-- The third and last of the County Louth legacy files (0015 and 0016 cover
-- bookings). Its waitlist table is close to this one, but carries six columns
-- more and one status this schema has never had:
--
--   legacy_status      the old status where this schema has no such state. Its
--                      vocabulary was Waiting / Notified / Converted /
--                      Cancelled / **Expired**; here it is the first four
--                      (server/src/lib/waitlist-domain.js). 31 of County
--                      Louth's 118 entries are Expired - the requested date
--                      passed without a tee time coming free - which loads as
--                      Cancelled, the only terminal, not-open state here. The
--                      word is kept so the distinction is still auditable.
--                      Leaving it as 'Expired' was not an option: every list
--                      and count filters on the four known statuses, so those
--                      31 would have been invisible.
--   guest_phone        a phone number for the party (80 of the 118 have one).
--                      A booking has contact_phone; a waitlist entry had
--                      nowhere to put it.
--   email_subject      the enquiry that created the entry. The core API writes
--   email_body         guest mail to email_messages now, but that table has no
--   email_from         waitlist linkage, so these would be orphaned rows in the
--   email_received_at  Inbox rather than context on the entry. 117 of 118 have
--                      them. (The old email_html column is empty for every
--                      County Louth row and is not carried across.)
--
-- Read-only history, as in 0015 and 0016: nothing in this dashboard writes any
-- of them. Every column is nullable, so a row from anywhere else has none.
--
-- One thing that is NOT legacy, and is reconstructed rather than dropped:
-- converted_booking_id. The old app recorded no link from an entry to the
-- booking it became, but it wrote the reference into the entry's notes
-- ("...BOOK-YYYYMMDD-XXXXXXXX..."), and all 8 of County Louth's Converted
-- entries have one. scripts/migrate-county-louth.mjs reads it back out, so the
-- Waitlist page's conversion reporting works on the real history. That mirrors
-- what migration 0001 already does in the other direction, recovering the link
-- from the booking's note.

-- ---------------------------------------------------------------------------
-- Guards. Every statement below checks the catalog first and does nothing
-- when its object already exists, so on a database that already has this
-- schema the file needs no ownership of the tables (ALTER TABLE and COMMENT
-- demand it even when they would change nothing). The helpers live in
-- pg_temp, last only for this session and are dropped at the end of the file.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.has_column(tbl text, col text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('public.' || quote_ident(tbl))
                    AND attname = col AND attnum > 0 AND NOT attisdropped)
$$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_column(tbl text, col text, definition text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT pg_temp.has_column(tbl, col) THEN
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I %s', tbl, col, definition);
  END IF;
END $$;

-- Comments are documentation: set when missing or different, and skipped with
-- a warning (never an error) when this role does not own the table.
CREATE OR REPLACE FUNCTION pg_temp.ensure_comment(tbl text, col text, body text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  rel regclass := to_regclass('public.' || quote_ident(tbl));
  current_text text;
BEGIN
  current_text := col_description(rel, (SELECT attnum FROM pg_attribute WHERE attrelid = rel AND attname = col));
  IF current_text IS NOT DISTINCT FROM body THEN
    RETURN;
  END IF;
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = rel), 'MEMBER') THEN
    RAISE WARNING 'not the owner of %, so its comment was left as it is', tbl;
    RETURN;
  END IF;
  EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', tbl, col, body);
END $$;

SELECT pg_temp.ensure_column('waitlist', 'legacy_status', 'VARCHAR(50)');
SELECT pg_temp.ensure_column('waitlist', 'guest_phone', 'VARCHAR(50)');
SELECT pg_temp.ensure_column('waitlist', 'email_subject', 'TEXT');
SELECT pg_temp.ensure_column('waitlist', 'email_body', 'TEXT');
SELECT pg_temp.ensure_column('waitlist', 'email_from', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('waitlist', 'email_received_at', 'TIMESTAMPTZ');

SELECT pg_temp.ensure_comment('waitlist', 'legacy_status',
  'Legacy (County Louth): the old status where this schema has none — set to ''Expired'' on entries loaded as Cancelled. Audit only; nothing reads it.');
SELECT pg_temp.ensure_comment('waitlist', 'guest_phone',
  'Legacy (County Louth): a phone number for the party. Read-only history; this dashboard does not collect one on a waitlist entry.');
SELECT pg_temp.ensure_comment('waitlist', 'email_subject',
  'Legacy (County Louth): subject of the enquiry that created this entry.');
SELECT pg_temp.ensure_comment('waitlist', 'email_body',
  'Legacy (County Louth): body of the enquiry that created this entry.');
SELECT pg_temp.ensure_comment('waitlist', 'email_from',
  'Legacy (County Louth): the address the enquiry came from (usually the same as guest_email).');
SELECT pg_temp.ensure_comment('waitlist', 'email_received_at',
  'Legacy (County Louth): when the enquiry arrived.');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
