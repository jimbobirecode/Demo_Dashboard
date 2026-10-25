-- Handing a booked customer to an outside system.
--
-- When a booking reaches 'Booked' the customer and their round are POSTed as
-- JSON to whatever endpoint BOOKED_WEBHOOK_URL names (see
-- lib/booked-webhook-domain.js). This column is what stops that happening
-- twice: it is stamped once the receiver has accepted the booking, and a
-- booking carrying a stamp is never sent again.
--
-- It is also what makes the push reliable rather than best-effort. Four
-- different things move a booking to 'Booked' - a user in the dashboard, a
-- Stripe payment, a converted waitlist entry, a tee-sheet import - and the
-- core API writes the same column from its own process, where no dashboard
-- code runs at all. Rather than hang a notification off each of them and hope
-- none is ever added without one, the rule is written against the data: a
-- 'Booked' booking with no stamp has not been handed over yet, whoever booked
-- it, and the sweep in lib/booked-webhook-outbox.js picks it up. A failed or
-- missed POST is retried for the same reason, instead of losing the customer.
--
-- NULL on every existing row, which is correct: none of them has been sent.
-- The club decides whether its back catalogue is handed over (sweep them) or
-- only bookings from here on (stamp them once, see docs/BOOKED_CUSTOMER_WEBHOOK.md).

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

CREATE OR REPLACE FUNCTION pg_temp.ensure_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    EXECUTE ddl;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_comment(tbl text, col text, body text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  rel regclass := to_regclass('public.' || quote_ident(tbl));
  current_text text;
BEGIN
  IF col IS NULL THEN
    current_text := obj_description(rel, 'pg_class');
  ELSE
    current_text := col_description(rel, (SELECT attnum FROM pg_attribute WHERE attrelid = rel AND attname = col));
  END IF;
  IF current_text IS NOT DISTINCT FROM body THEN
    RETURN;
  END IF;
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = rel), 'MEMBER') THEN
    RAISE WARNING 'not the owner of %, so its comment was left as it is', tbl;
    RETURN;
  END IF;
  IF col IS NULL THEN
    EXECUTE format('COMMENT ON TABLE public.%I IS %L', tbl, body);
  ELSE
    EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', tbl, col, body);
  END IF;
END $$;

SELECT pg_temp.ensure_column('bookings', 'booked_webhook_sent_at', 'TIMESTAMPTZ');

SELECT pg_temp.ensure_comment('bookings', 'booked_webhook_sent_at',
  'Handed to BOOKED_WEBHOOK_URL at this time; NULL for a booking not sent yet. Stamped once - see 0011');

-- The sweep's query, and the only one that reads this column: the bookings
-- still owed a handover. Partial, because once a club is caught up the
-- index holds almost nothing, and that is exactly when the sweep runs most.
SELECT pg_temp.ensure_index('idx_bookings_booked_webhook_unsent',
  $ddl$CREATE INDEX idx_bookings_booked_webhook_unsent ON public.bookings (club, updated_at)
        WHERE status = 'Booked' AND booked_webhook_sent_at IS NULL$ddl$);

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
