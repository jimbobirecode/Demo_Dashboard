-- Record when a booking became Booked, because the deposit clock starts there.
--
-- A tour operator's deposit is payable within the club's invoice terms of the
-- booking being confirmed -- "30% deposit, net 7 days" means 30% within seven
-- days of booking. 0024 fixed the deposit falling due after the round, but had
-- to count those seven days from the enquiry arriving, because that is the only
-- date the table holds. An enquiry answered three weeks later makes that three
-- weeks wrong, always in the same direction: the deposit reads as overdue
-- before anybody had agreed to anything.
--
-- No column records it. customer_confirmed_at is empty on all 539 of County
-- Louth's booked rounds, and updated_at is last-touched-by-anything: 442 of
-- those 539 carry 2026-10-11, the day the database was migrated to Supabase.
--
-- So: a column of its own, stamped by a trigger rather than by the dashboard,
-- because the status is also set by the email bot and by imports. Whoever
-- moves a booking to Booked, the date is recorded.
--
-- Only on UPDATE, never on INSERT. A row that arrives already Booked -- the
-- bot writing a confirmed booking, a tee sheet imported -- is booked at the
-- moment it is written, which `timestamp` already holds; stamping NOW() on
-- an import would date a year of history to the afternoon it was loaded.
--
-- Nothing is backfilled. The 539 rows already booked have no record of when,
-- and inventing one would be worse than the fallback they have: paymentState
-- reads invoiced_at, then booked_at, then timestamp, so they carry on exactly
-- as they do today and every booking confirmed from now on is right.

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0024: each statement checks the catalog first, so on a
-- database that already has this schema the file needs no ownership of the
-- tables. The helpers live in pg_temp and are dropped at the end.
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

CREATE OR REPLACE FUNCTION pg_temp.ensure_function(sig text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  existing oid := to_regprocedure(sig);
BEGIN
  IF existing IS NULL
     OR pg_has_role(current_user, (SELECT proowner FROM pg_proc WHERE oid = existing), 'MEMBER') THEN
    EXECUTE ddl;
  ELSE
    RAISE WARNING 'not the owner of %, so it was left as it is', sig;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_trigger(name text, tbl text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = name AND tgrelid = to_regclass('public.' || quote_ident(tbl))) THEN
    EXECUTE ddl;
  END IF;
END $$;

SELECT pg_temp.ensure_column('bookings', 'booked_at', 'TIMESTAMPTZ');

-- ---------------------------------------------------------------------------
-- The stamp.
--
-- 'Confirmed' is the retired spelling of Booked that older rows still carry,
-- so a row moving from Confirmed to Booked is not a booking being made.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_function('public.bookings_stamp_booked_at()', $fn$
CREATE OR REPLACE FUNCTION public.bookings_stamp_booked_at() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF lower(COALESCE(NEW.status, '')) IN ('booked', 'confirmed')
     AND lower(COALESCE(OLD.status, '')) NOT IN ('booked', 'confirmed')
     AND NEW.booked_at IS NULL THEN
    NEW.booked_at := NOW();
  END IF;
  RETURN NEW;
END $body$
$fn$);

SELECT pg_temp.ensure_function('public.bookings_stamp_booked_at()', $c$
COMMENT ON FUNCTION public.bookings_stamp_booked_at() IS
  'Stamps bookings.booked_at the first time a booking reaches Booked, whoever moved it there.'
$c$);

SELECT pg_temp.ensure_trigger('trg_bookings_booked_at', 'bookings',
  $ddl$CREATE TRIGGER trg_bookings_booked_at
         BEFORE UPDATE ON public.bookings
         FOR EACH ROW EXECUTE FUNCTION public.bookings_stamp_booked_at()$ddl$);

DROP FUNCTION pg_temp.ensure_trigger(text, text, text);
DROP FUNCTION pg_temp.ensure_function(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
