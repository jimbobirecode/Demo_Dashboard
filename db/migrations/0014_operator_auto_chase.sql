-- Whether the lifecycle ladder may chase a trade account for money.
--
-- The operator module already decides most of how an account is chased: its
-- deposit percentage, when the deposit and the balance fall due, and whether
-- the account is active at all ("a retired account keeps its history but is
-- never chased"). The one thing it could not say was "this account pays by
-- invoice on its own cycle - send it the confirmations, but do not send it
-- payment reminders". That is this column.
--
-- Default TRUE, so every existing account is chased exactly as before. Off,
-- the account's bookings still receive the run-up-to-the-tee emails (the
-- confirmation, the arrival details, the thank you); they stop receiving the
-- payment and balance phases, and a lapse on them is never cancelled by the
-- ladder. The money is still shown as owed in the drawer and the statement.

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

SELECT pg_temp.ensure_column('tour_operators', 'auto_chase', 'BOOLEAN NOT NULL DEFAULT TRUE');

SELECT pg_temp.ensure_comment('tour_operators', 'auto_chase',
  'Whether the lifecycle ladder sends this account payment and balance reminders. Off, it still gets the run-up-to-the-tee emails - see 0014');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
