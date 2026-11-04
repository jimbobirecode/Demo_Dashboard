-- County Louth: the columns its previous dashboard wrote that this schema has
-- no home for.
--
-- County Louth's bookings came from a Streamlit dashboard over its own Render
-- Postgres. Most of that table is a subset of `bookings` here and lands in the
-- matching column; `lead_name` becomes `guest_name`, and its free-text
-- `selected_tee_times` is converted to this schema's JSONB (see
-- docs/COUNTY_LOUTH_MIGRATION.md). Five columns have no equivalent at all, and
-- are added here so the migration is lossless and the history stays readable.
--
-- None of them is written by this dashboard. They are read-only history:
--
--   email_sent         one outbound-email type per booking. This schema records
--                      sends as timestamps per campaign (pre_arrival_email_sent_at,
--                      post_play_email_sent_at, operator_*_email_sent_at) and
--                      keeps the message itself in email_messages, so the old
--                      single-slot value cannot be mapped onto it without
--                      inventing a date.
--   is_tour_operator   a boolean flag on the booking. Trade here is a real
--                      account: bookings.tour_operator_id -> tour_operators,
--                      which carries the terms the flag never held. Staff
--                      re-link these on the Operators page; the flag is kept so
--                      they can see which rows to look at.
--   per_player_rate    the agreed rate behind that flag, for the same reason.
--   fb_requirements    food and beverage requests. This schema has
--                      caddie_requirements and special_requests but nothing for
--                      catering.
--   content            the raw body of the enquiry email. Mail lives in
--                      email_messages now, but County Louth's rows predate that
--                      table and some have no message to point at.
--   legacy_status      the status the old dashboard held, where this schema has
--                      no such state. Its pipeline was
--                      Inquiry -> Requested -> Confirmed -> Booked; here there is
--                      no Confirmed (migration 0005 retired it, and payment is
--                      tracked separately in payment_status), so a Confirmed row
--                      loads as Booked -- the club had confirmed it -- and keeps
--                      'Confirmed' here. Nothing reads it; it exists so the
--                      collapse can be audited or undone.
--
-- Every column is nullable: a row from anywhere else simply has none.

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

SELECT pg_temp.ensure_column('bookings', 'email_sent', 'VARCHAR(100)');
SELECT pg_temp.ensure_column('bookings', 'is_tour_operator', 'BOOLEAN');
SELECT pg_temp.ensure_column('bookings', 'per_player_rate', 'NUMERIC(10,2)');
SELECT pg_temp.ensure_column('bookings', 'fb_requirements', 'TEXT');
SELECT pg_temp.ensure_column('bookings', 'content', 'TEXT');
SELECT pg_temp.ensure_column('bookings', 'legacy_status', 'VARCHAR(50)');

SELECT pg_temp.ensure_comment('bookings', 'email_sent',
  'Legacy (County Louth): type of the one outbound email the old dashboard recorded. Read-only history; this dashboard stamps each campaign separately.');
SELECT pg_temp.ensure_comment('bookings', 'is_tour_operator',
  'Legacy (County Louth): the old dashboard''s trade flag. Read-only; trade is tour_operator_id here.');
SELECT pg_temp.ensure_comment('bookings', 'per_player_rate',
  'Legacy (County Louth): agreed per-player rate behind is_tour_operator. Read-only; terms live on tour_operators.');
SELECT pg_temp.ensure_comment('bookings', 'fb_requirements',
  'Legacy (County Louth): food and beverage requests. No equivalent column in this schema.');
SELECT pg_temp.ensure_comment('bookings', 'content',
  'Legacy (County Louth): raw body of the enquiry email, for rows that predate email_messages.');
SELECT pg_temp.ensure_comment('bookings', 'legacy_status',
  'Legacy (County Louth): the old dashboard''s status where this schema has none — set to ''Confirmed'' on rows loaded as Booked. Audit only; nothing reads it.');

-- Only County Louth's imported rows have any of these, so the index that makes
-- "which bookings still need linking to an operator account?" cheap is partial.
DO $$
BEGIN
  IF to_regclass('public.ix_bookings_legacy_tour_operator') IS NULL THEN
    EXECUTE 'CREATE INDEX ix_bookings_legacy_tour_operator
               ON public.bookings (club, date)
             WHERE is_tour_operator AND tour_operator_id IS NULL';
  END IF;
END $$;

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
