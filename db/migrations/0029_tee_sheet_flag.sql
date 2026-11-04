-- A booking paid online still has to be put on the tee sheet by hand.
--
-- A direct customer now pays on the booking form, through Stripe, and the
-- payment moves the booking from Requested to Booked by itself. Nobody at
-- the club has touched it at that point -- and the tee sheet lives in the
-- club's own system, which the dashboard cannot write to. So the booking is
-- flagged when a payment books it, and stays flagged until somebody marks it
-- entered.
--
--   tee_sheet_status   NULL         nothing asked of anybody (every booking
--                                   before this, and any the club confirmed
--                                   itself -- they put those on as they go)
--                      'to_enter'   booked by a payment; put it on the sheet
--                      'entered'    on the sheet, by tee_sheet_entered_by
--                                   at tee_sheet_entered_at

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0028.
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

SELECT pg_temp.ensure_column('bookings', 'tee_sheet_status',
  $$TEXT CHECK (tee_sheet_status IS NULL OR tee_sheet_status IN ('to_enter', 'entered'))$$);
SELECT pg_temp.ensure_column('bookings', 'tee_sheet_entered_at', 'TIMESTAMPTZ');
SELECT pg_temp.ensure_column('bookings', 'tee_sheet_entered_by', 'TEXT');

DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
