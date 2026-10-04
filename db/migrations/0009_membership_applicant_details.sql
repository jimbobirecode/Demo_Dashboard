-- Membership: more applicant details (membership contract v2).
--
-- The core API's waitlist and application forms now ask for a postcode
-- (separate from the permanent address), the other clubs the applicant
-- belongs to, and their CDH (Central Database of Handicaps) number. The
-- dashboard shows them on the application and in the CSV export. Every
-- column is nullable: rows from before this migration simply have none.
--
-- Shared contract with the core API: a change here is a change on both sides.

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

SELECT pg_temp.ensure_column('membership_applications', 'postcode', 'TEXT');
SELECT pg_temp.ensure_column('membership_applications', 'other_clubs', 'TEXT');
SELECT pg_temp.ensure_column('membership_applications', 'cdh_number', 'TEXT');

SELECT pg_temp.ensure_comment('membership_applications', 'postcode',
  'Postcode of the permanent address (address holds the rest)');
SELECT pg_temp.ensure_comment('membership_applications', 'other_clubs',
  'Names of other clubs the applicant belongs to (free text)');
SELECT pg_temp.ensure_comment('membership_applications', 'cdh_number',
  'CDH (Central Database of Handicaps) number, optional');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
