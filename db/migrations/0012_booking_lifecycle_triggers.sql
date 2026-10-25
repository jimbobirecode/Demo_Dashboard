-- The booking lifecycle: one ledger row per email the ladder sends.
--
-- The ladder is a branching lifecycle rather than a mailing schedule. A
-- booking is taken, a payment link goes out, and what happens next depends on
-- whether the money arrives and when: paid, it climbs a ladder of
-- confirmations to the tee; unpaid, a different one towards cancellation, with
-- the way back onto the paid ladder being simply to pay. See
-- docs/BOOKING_LIFECYCLE.md for the grid as the club's spreadsheet drew it.
--
-- A ledger, not fifteen more nullable timestamps on bookings. The rungs are
-- configurable and the club will add more, and every one of them would
-- otherwise be another column, another entry in BOOKING_COLUMNS and another
-- migration. A row per (booking, rung) also records what the alternative
-- cannot: that a rung was skipped because the booking was already paid, or
-- held back because a person has to decide, or that the send failed and will
-- be tried again.
--
-- The no-double-send guarantee is the partial unique index below, not
-- application code: one 'sent', 'skipped', 'superseded' or 'held' row per
-- booking and rung, enforced by the database. Rows with outcome 'failed' sit
-- outside the index on purpose, so a failure can be recorded as many times as
-- it happens and the rung stays eligible to retry.

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

-- ---------------------------------------------------------------------------
-- The ledger.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.booking_trigger_sends') IS NULL THEN
    CREATE TABLE public.booking_trigger_sends (
        id           SERIAL PRIMARY KEY,
        club         TEXT NOT NULL,
        booking_id   TEXT NOT NULL,
        -- The rung, e.g. 'deposit_reminder_1'. Text rather than an enum: the
        -- rungs are configuration, and a club adding one must not need DDL.
        rung         TEXT NOT NULL,
        phase        TEXT NOT NULL,              -- 'payment' | 'balance' | 'communication'
        outcome      TEXT NOT NULL,              -- see the CHECK below
        -- The calendar day (in the club's zone) the rung fell due, so a run
        -- can say what it acted on without recomputing the whole ladder.
        due_on       DATE,
        detail       TEXT,                       -- why it was skipped, held or failed
        email_to     TEXT,                       -- who it went to, for the audit trail
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT booking_trigger_sends_outcome_check
          CHECK (outcome IN ('sent', 'skipped', 'superseded', 'held', 'failed'))
    );
  END IF;
END $$;

-- A booking's own rows, newest first: the drawer's lifecycle history, and what
-- the runner reads to know which rungs a booking has already had.
SELECT pg_temp.ensure_index('idx_booking_trigger_sends_booking',
  $ddl$CREATE INDEX idx_booking_trigger_sends_booking
          ON public.booking_trigger_sends (club, booking_id, created_at DESC)$ddl$);

-- THE no-double-send guarantee. One settled row per booking and rung; a
-- 'failed' row is outside the index so the rung can be retried, and so a
-- repeatedly failing send does not need a row it is forbidden to write.
--
-- Created strictly rather than through 0001's tolerant helper: the table is
-- new, so there are no existing rows to hold duplicates, and this index is
-- the guarantee itself. If it could not be created the deploy should stop,
-- not carry on warning while the ladder emails people twice.
SELECT pg_temp.ensure_index('idx_booking_trigger_sends_once',
  $ddl$CREATE UNIQUE INDEX idx_booking_trigger_sends_once
          ON public.booking_trigger_sends (club, booking_id, rung)
        WHERE outcome <> 'failed'$ddl$);

-- What a person has to decide: the rungs held back because auto-cancel is off.
SELECT pg_temp.ensure_index('idx_booking_trigger_sends_held',
  $ddl$CREATE INDEX idx_booking_trigger_sends_held
          ON public.booking_trigger_sends (club, created_at DESC)
        WHERE outcome = 'held'$ddl$);

SELECT pg_temp.ensure_comment('booking_trigger_sends', NULL,
  'One row per lifecycle email the ladder decided about, per booking and rung - see 0012 and docs/BOOKING_LIFECYCLE.md');
SELECT pg_temp.ensure_comment('booking_trigger_sends', 'outcome',
  'sent | skipped (condition not met) | superseded (passed while collapsing) | held (needs a person) | failed (will retry)');
SELECT pg_temp.ensure_comment('booking_trigger_sends', 'rung',
  'The rung of the ladder, e.g. deposit_reminder_1. Configuration, not an enum');

-- ---------------------------------------------------------------------------
-- When the ladder started for a booking.
--
-- The payment phase counts from the day the booking was taken, so it needs a
-- stamp that does not move. `updated_at` moves on every edit, and `created_at`
-- can be months before a booking the club only committed to last week. This
-- is set once, when the ladder first takes an interest in a booking, and is
-- the anchor every payment-phase rung is measured from.
--
-- It also keeps the ladder away from history: a booking the dashboard has had
-- for a year is anchored at the day the club switched the ladder on, not at
-- its own creation, so switching on cannot post-date a cancellation. The
-- catch-up horizon is the other half of that guard.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_column('bookings', 'lifecycle_started_at', 'TIMESTAMPTZ');

SELECT pg_temp.ensure_comment('bookings', 'lifecycle_started_at',
  'When the lifecycle ladder first took an interest in this booking; the anchor for every payment-phase rung - see 0012');

-- The runner's own query: bookings it has started and not finished with.
SELECT pg_temp.ensure_index('idx_bookings_lifecycle_started',
  $ddl$CREATE INDEX idx_bookings_lifecycle_started ON public.bookings (club, lifecycle_started_at)
        WHERE lifecycle_started_at IS NOT NULL$ddl$);

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
