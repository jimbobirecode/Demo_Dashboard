-- The booking lifecycle ladder, as a club's own setting rather than the
-- deployment's.
--
-- 0012 built the ladder and read every switch and day count from the
-- environment. That makes the club ask whoever deploys for a change to its
-- own chasing cadence, which is the wrong way round: the deposit window and
-- the reminder days are the club's commercial policy, not an operational
-- detail of the server.
--
-- So the settings move into club_settings beside the membership ones, one row
-- per club, and the environment becomes the default a club inherits until it
-- saves anything of its own. An install already running on environment
-- variables therefore behaves exactly as it did, and keeps doing so until
-- somebody edits the settings in the dashboard.
--
-- Shape (every key optional; an absent key means "inherit"):
--   {
--     "enabled": false, "deadlines": false, "scheduled": false,
--     "autoCancel": false, "visitorDunning": true,
--     "catchUpDays": 3,
--     "depositWindowDays": 7, "depositReminderDay": 5, "depositRescueDay": 10,
--     "balanceDueDaysBeforePlay": 60, "balanceNoticeLeadDays": 10,
--     "confirmationDaysBeforePlay": 30, "finalDetailsDaysBeforePlay": 10,
--     "postPlayDaysAfterPlay": 1
--   }
--
-- Validated in lib/booking-triggers-domain.js before it is written, never
-- here: a CHECK constraint on a JSONB document would have to be rewritten
-- every time a rung is added, and could only repeat what the validator
-- already says in better words.
--
-- A note on the contract with the core API, which 0008 records for this
-- table: this column is the dashboard's alone. The core API neither reads nor
-- writes it, and adding it changes nothing it selects.

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

-- club_settings may not exist on an install that has never run 0008 to
-- completion (it is created there). Guarded so this file is still a no-op
-- rather than an error in that case.
DO $$
BEGIN
  IF to_regclass('public.club_settings') IS NULL THEN
    RAISE WARNING 'club_settings does not exist, so lifecycle_settings was not added; run 0008 first';
  ELSE
    PERFORM pg_temp.ensure_column('club_settings', 'lifecycle_settings', $def$JSONB NOT NULL DEFAULT '{}'::jsonb$def$);
  END IF;
END $$;

DO $$
BEGIN
  IF pg_temp.has_column('club_settings', 'lifecycle_settings') THEN
    PERFORM pg_temp.ensure_comment('club_settings', 'lifecycle_settings',
      'This club''s booking lifecycle settings; an absent key inherits the environment, then the defaults - see 0013');
  END IF;
END $$;

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
