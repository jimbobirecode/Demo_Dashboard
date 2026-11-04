-- The booking trigger workflow: one row per lifecycle step that has fired.
--
-- The club's booking journey is a ladder of timed steps -- ask for the deposit,
-- chase it, warn, cancel; then confirm, remind, welcome, thank -- and each rung
-- must be climbed exactly once per booking. Until now the two guest campaigns
-- each had a stamp column of their own on `bookings`
-- (pre_arrival_email_sent_at, post_play_email_sent_at), which works for two and
-- does not for fifteen: every new step would be another nullable timestamp on
-- the widest table in the database, and none of them could say what address it
-- went to, what it cost, or why a step was skipped rather than sent.
--
-- So a ledger instead. One row per (booking, step) that has happened, carrying
-- the outcome, so the engine's question -- "which rungs has this booking
-- already climbed?" -- is one index scan, and the club can read back the whole
-- journey of a booking in the order it happened.
--
-- The outcomes are deliberately more than sent/failed:
--
--   sent        an email went out
--   cancelled   the booking was cancelled by the lapse step
--   skipped     the step did not apply (a guest with no address, a booking
--               outside the payment ledger)
--   superseded  the step fell due while a later one on the same ladder also
--               did, so the later one went instead. Recorded rather than
--               dropped: the rung is climbed, and must never fire late.
--   cleared     a person took it off the list by hand without emailing
--   failed      the send was attempted and refused. NOT unique -- a failure
--               is retried on the next run, and each attempt is kept.
--
-- The partial unique index is the guard that matters: a step that reached a
-- settled outcome can never fire twice, whoever runs the sweep and however
-- often. Failures are left out of it on purpose, so they retry.

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
-- First, move the RETIRED ladder's table of the same name out of the way.
--
-- This dashboard previously had its own Booking Lifecycle ladder, at migrations
-- 0012-0014, and it kept its ledger in a table also called
-- `booking_trigger_sends` -- with different columns: `rung` and `phase` where
-- this one has `step` and `flow`, `email_to` for `to_email`, `created_at` for
-- `sent_at`, and no `subject` or `sent_by`.
--
-- So on a database that ran the old ladder, the guarded CREATE below finds a
-- table already there, leaves it alone, and then the index on (club,
-- booking_id, step) fails with "column step does not exist" -- which is
-- exactly what happened the first time this was applied to such a database.
-- Every test passed, because a test starts from an empty database and never
-- sees the old table at all.
--
-- The old ledger is renamed rather than dropped: it is a record of emails that
-- really were sent to real guests, and this file has no business destroying it.
-- Its primary key and sequence are renamed with it, because the CREATE below
-- would otherwise collide on `booking_trigger_sends_pkey`. Nothing reads the
-- renamed table; it is kept so the history is still there to be read.
--
-- A database that never ran the old ladder -- a fresh install, or
-- Dashboard_Beta's own -- has nothing of the kind, and this does nothing.
DO $$
DECLARE
  retired  text := 'booking_trigger_sends_retired_lifecycle';
  -- Resolved ONCE, into a regclass. The conditions below then test this
  -- variable and never cast the name again: `'public.x'::regclass` raises on a
  -- table that does not exist, and SQL does not promise to short-circuit AND,
  -- so guarding such a cast with `to_regclass(...) IS NOT NULL` in the same
  -- expression is not a guard at all -- it raised on every fresh database,
  -- which is every database except the one this block is for.
  ledger   regclass := to_regclass('public.booking_trigger_sends');
  has_step boolean;
BEGIN
  -- No table of that name: a fresh install, or Dashboard_Beta's own database.
  IF ledger IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = ledger
       AND attname  = 'step'
       AND attnum > 0
       AND NOT attisdropped
  ) INTO has_step;

  -- Already this file's table: nothing to do, and nothing to move aside.
  IF has_step THEN
    RETURN;
  END IF;

  -- Never overwrite an earlier rescue: a second one gets a dated name.
  IF to_regclass('public.' || quote_ident(retired)) IS NOT NULL THEN
    retired := retired || to_char(NOW(), '_YYYYMMDDHH24MISS');
  END IF;

  IF to_regclass('public.booking_trigger_sends_pkey') IS NOT NULL THEN
    EXECUTE format('ALTER INDEX public.booking_trigger_sends_pkey RENAME TO %I', retired || '_pkey');
  END IF;
  IF to_regclass('public.booking_trigger_sends_id_seq') IS NOT NULL THEN
    EXECUTE format('ALTER SEQUENCE public.booking_trigger_sends_id_seq RENAME TO %I', retired || '_id_seq');
  END IF;
  EXECUTE format('ALTER TABLE public.booking_trigger_sends RENAME TO %I', retired);

  RAISE WARNING 'the retired Booking Lifecycle ledger was kept as public.%; this file now owns booking_trigger_sends', retired;
END $$;

DO $$
BEGIN
  IF to_regclass('public.booking_trigger_sends') IS NULL THEN
    CREATE TABLE public.booking_trigger_sends (
        id         BIGSERIAL PRIMARY KEY,
        club       TEXT        NOT NULL,
        booking_id TEXT        NOT NULL,

        -- The rung: a step id from server/src/lib/booking-triggers-domain.js
        -- ('deposit_request', 'final_details', ...). Text rather than an enum
        -- so adding a step is a code change, not a migration.
        step       TEXT        NOT NULL,
        -- Which ladder the booking was read against when it fired, for the
        -- club's own reading back: 'tour_operator' or 'visitor'.
        flow       TEXT,

        -- The calendar day the step fell due, which is not the day it ran: a
        -- sweep that was switched off over a weekend catches up on Monday, and
        -- the difference between the two is the thing worth seeing.
        due_on     DATE,
        sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        outcome    TEXT        NOT NULL DEFAULT 'sent',
        to_email   TEXT,
        subject    TEXT,
        -- Why, in the engine's own words: the condition that matched, the
        -- reason it was skipped, or the error the mail service gave back.
        detail     TEXT,
        -- Who ran it: a staff username, or 'schedule' for the sweep.
        sent_by    TEXT
    );
  END IF;
END $$;

-- A settled step is climbed once and once only. 'failed' is outside the index
-- so a refused send is retried on the next run.
SELECT pg_temp.ensure_index('idx_booking_trigger_sends_step',
  $ddl$CREATE UNIQUE INDEX idx_booking_trigger_sends_step
         ON public.booking_trigger_sends (club, booking_id, step)
       WHERE outcome <> 'failed'$ddl$);

-- How the engine reads it: every step already climbed, for a club's bookings.
SELECT pg_temp.ensure_index('idx_booking_trigger_sends_club',
  $ddl$CREATE INDEX idx_booking_trigger_sends_club
         ON public.booking_trigger_sends (club, booking_id, sent_at DESC)$ddl$);

-- How the page reads it: what the workflow did lately, newest first.
SELECT pg_temp.ensure_index('idx_booking_trigger_sends_recent',
  $ddl$CREATE INDEX idx_booking_trigger_sends_recent
         ON public.booking_trigger_sends (club, sent_at DESC)$ddl$);

SELECT pg_temp.ensure_comment('booking_trigger_sends', NULL,
  'One row per booking lifecycle step that has fired: what went out, when it was due, and how it went.');
SELECT pg_temp.ensure_comment('booking_trigger_sends', 'due_on',
  'The day the step fell due, which may be earlier than sent_at if the sweep was catching up.');
SELECT pg_temp.ensure_comment('booking_trigger_sends', 'outcome',
  'sent, cancelled, skipped, superseded, cleared or failed. Only failed may repeat.');

DROP FUNCTION IF EXISTS pg_temp.ensure_index(text, text);
DROP FUNCTION IF EXISTS pg_temp.ensure_comment(text, text, text);
