-- The booking trigger workflow becomes the club's to set, not the deployer's.
--
-- 0026 gave every confirmed booking a ladder of timed emails, with the
-- deadlines and the three switches read from the environment. That is where a
-- deployer sets things, and nobody at the club can reach it: changing the
-- deposit window from 7 days to 10 meant a ticket, a redeploy and a restart,
-- for a number that belongs to the secretary.
--
-- So the settings move into club_settings, next to the membership ones, as one
-- JSONB column. A key that is present overrides the environment; one that is
-- absent inherits it, so an install that was configured by environment carries
-- on exactly as before until somebody saves something on the Settings page.
--
-- And one switch on the trade account. "Active -- a retired account keeps its
-- history but is never chased" is already the operator module's promise; this
-- is the finer one, for an account the club chooses not to chase while it is
-- still trading -- the partner who pays by standing order, the one with a
-- quarrel in progress. Default TRUE, so every existing account is chased
-- exactly as it was yesterday.

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0026: each statement checks the catalog first, so on a
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

-- The club's own view of the ladder: the switches and the deadlines, keyed as
-- server/src/lib/booking-triggers-domain.js names them (enabled, automatic,
-- autoCancel, depositDays, ...). '{}' means "whatever the environment says".
SELECT pg_temp.ensure_column('club_settings', 'trigger_settings', $$JSONB NOT NULL DEFAULT '{}'::jsonb$$);
SELECT pg_temp.ensure_comment('club_settings', 'trigger_settings',
  'The booking trigger workflow as this club has set it: switches and deadlines. Keys present here override the environment.');

-- Whether the ladder chases this account for money at all.
SELECT pg_temp.ensure_column('tour_operators', 'auto_chase', 'BOOLEAN NOT NULL DEFAULT TRUE');
SELECT pg_temp.ensure_comment('tour_operators', 'auto_chase',
  'FALSE takes this account out of the booking trigger workflow''s payment chase. Its guests still get the arrival emails.');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
