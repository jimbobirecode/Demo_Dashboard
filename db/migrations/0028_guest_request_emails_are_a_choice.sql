-- Whether a guest hears back the moment they ask for a change.
--
-- A guest who asks to move or cancel a booking got an immediate email saying
-- the club had the request. Nobody chose to send it: it went out with the
-- request itself, and the club's real answer followed later from the Requests
-- page. Two emails about one question, the first of which says nothing the
-- page the guest just submitted did not already say.
--
-- So it becomes a switch, kept beside the membership and trigger settings in
-- club_settings. It is OFF unless a club turns it on -- the acknowledgement
-- is the one that is being taken away, and a club that wants it back says so
-- on the Settings page.
--
-- The club's *answer* -- approved, declined, cancelled -- is not covered by
-- this. That one is sent because somebody pressed a button, and a guest whose
-- cancellation is agreed has to be told.

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0027: each statement checks the catalog first, so on a
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

-- What this club sends guests off its own bat, keyed as
-- server/src/lib/guest-email-settings.js names them. '{}' means the defaults,
-- which are the quiet ones.
SELECT pg_temp.ensure_column('club_settings', 'guest_email_settings', $$JSONB NOT NULL DEFAULT '{}'::jsonb$$);
SELECT pg_temp.ensure_comment('club_settings', 'guest_email_settings',
  'Emails this club sends guests without anybody pressing a button. {"requestReceived": true} acknowledges a change request the moment it arrives; absent or false means it does not.');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
