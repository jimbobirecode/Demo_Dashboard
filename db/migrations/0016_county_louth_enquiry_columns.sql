-- County Louth: what its enquiry pipeline recorded that this schema does not.
--
-- A companion to 0015. That file was written against a reconstruction of the old
-- schema; the pg_dump of the live table turned out to carry more than the old
-- dashboard ever selected, because the same email bot wrote it. These are the
-- columns with real data in them and no home here:
--
--   enquiry_intent      what the language model took the enquiry to be
--                       (booking_request, pricing_inquiry, booking_cancellation,
--                       booking_modification, general_inquiry, booking). Set on
--                       every row. email_messages.intent holds the same idea for
--                       a message, but a booking here has no such column.
--   enquiry_urgency     how soon the party wanted to play, as the model read it
--                       (urgent, soon, flexible, unknown). Set on every row.
--   enquiry_confidence  0..1, how sure the model was of its reading. Set on
--                       every row. Useful for finding the enquiries worth
--                       re-reading by hand.
--   is_corporate        a corporate booking rather than a society or a pair.
--   company_name        the company, when there was one.
--   lead_email          the address on the booking form, where guest_email came
--                       off the email envelope. Usually the same; sometimes the
--                       form has the better one.
--   fb_pre_play         'Yes'/'No': food and beverage before play. The free-text
--   fb_post_play        fb_requirements (0015) spells both out in prose; these
--                       are the flags behind it, and are what you would filter on.
--
-- Read-only history, like 0015's columns: nothing in this dashboard writes them.
-- Every column is nullable, so a row from anywhere else simply has none.
--
-- Three more of the dump's columns are NOT here, because this schema already has
-- somewhere better for them, and scripts/migrate-county-louth.mjs puts them there:
--
--   dates       -> golf_dates   (the requested dates; 569 of County Louth's rows
--                                hold two, and 63 of them differ from `date`)
--   lead_phone  -> contact_phone
--   lead_name   -> guest_name
--
-- And several are dropped on purpose: `club_name` (branding, which CLUB_FULL_NAME
-- now spells), `message_id`/`confirmation_message_id` (empty for County Louth, and
-- mail lives in email_messages), `payment_method`/`stripe_session_id`/
-- `payment_intent_id`/`payment_date`/`deposit_percentage`/`total_paid` (the old
-- payment attempt: every County Louth row reads 'pending' with nothing collected,
-- so they carry no information this schema's payment_status does not), and
-- `cancellation_requested_at`/`modification_requested_at` (empty; guest requests
-- are rows in booking_change_requests here).

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

SELECT pg_temp.ensure_column('bookings', 'enquiry_intent', 'VARCHAR(50)');
SELECT pg_temp.ensure_column('bookings', 'enquiry_urgency', 'VARCHAR(50)');
SELECT pg_temp.ensure_column('bookings', 'enquiry_confidence', 'NUMERIC(3,2)');
SELECT pg_temp.ensure_column('bookings', 'is_corporate', 'BOOLEAN');
SELECT pg_temp.ensure_column('bookings', 'company_name', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('bookings', 'lead_email', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('bookings', 'fb_pre_play', 'VARCHAR(10)');
SELECT pg_temp.ensure_column('bookings', 'fb_post_play', 'VARCHAR(10)');

SELECT pg_temp.ensure_comment('bookings', 'enquiry_intent',
  'Legacy (County Louth): what the language model took the enquiry to be. Read-only history.');
SELECT pg_temp.ensure_comment('bookings', 'enquiry_urgency',
  'Legacy (County Louth): how soon the party wanted to play, as the model read it. Read-only history.');
SELECT pg_temp.ensure_comment('bookings', 'enquiry_confidence',
  'Legacy (County Louth): 0..1, the model''s confidence in its reading of the enquiry. Read-only history.');
SELECT pg_temp.ensure_comment('bookings', 'is_corporate',
  'Legacy (County Louth): a corporate booking rather than a society or a pair. Read-only history.');
SELECT pg_temp.ensure_comment('bookings', 'company_name',
  'Legacy (County Louth): the company on a corporate booking. Read-only history.');
SELECT pg_temp.ensure_comment('bookings', 'lead_email',
  'Legacy (County Louth): the address given on the booking form, where guest_email came off the email envelope.');
SELECT pg_temp.ensure_comment('bookings', 'fb_pre_play',
  'Legacy (County Louth): ''Yes''/''No'' — food and beverage before play. fb_requirements spells it out in prose.');
SELECT pg_temp.ensure_comment('bookings', 'fb_post_play',
  'Legacy (County Louth): ''Yes''/''No'' — food and beverage after play. fb_requirements spells it out in prose.');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
