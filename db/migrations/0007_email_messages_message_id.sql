-- Inbound email de-duplication and recovery for the core API.
--
-- The core API records each inbound email before answering SendGrid
-- (routed_to = 'queued', then 'processing' while a worker handles it). The
-- Message-ID gets a column of its own so a retried delivery of the same email
-- is refused by a unique index rather than by a lock and a lookup, and the
-- recovery sweep finds stranded rows through a small partial index.

-- ---------------------------------------------------------------------------
-- Guards. Every statement below checks the catalog first and does nothing
-- when its object already exists, so on a database that already has this
-- schema the file needs no ownership of the tables (ALTER TABLE, COMMENT and
-- CREATE INDEX all demand it even when they would change nothing). The
-- helpers live in pg_temp, last only for this session and are dropped at the
-- end of the file.
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
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I %s', tbl, col, definition);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    EXECUTE ddl;
  END IF;
END $$;

-- A unique index that existing duplicates would block: reported, not fatal.
-- Nothing is deleted to make room for it; resolve the rows by hand and add
-- the index in a later migration.
CREATE OR REPLACE FUNCTION pg_temp.ensure_unique_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    BEGIN
      EXECUTE ddl;
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'existing rows hold duplicates, so the unique index % was not created; resolve them and add it in a new migration', name;
    END;
  END IF;
END $$;

-- A CHECK constraint is added NOT VALID (enforced for every new or updated
-- row, existing rows not scanned), then validated. Rows that already break it
-- leave it NOT VALID with a warning instead of failing the deploy.
CREATE OR REPLACE FUNCTION pg_temp.ensure_check(tbl text, name text, expr text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = to_regclass('public.' || quote_ident(tbl)) AND conname = name) THEN
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID', tbl, name, expr);
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', tbl, name);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'existing rows of % break %; it is enforced for new rows but left NOT VALID', tbl, name;
    END;
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

SELECT pg_temp.ensure_column('email_messages', 'message_id', 'TEXT');

SELECT pg_temp.ensure_comment('email_messages', 'message_id',
  'Message-ID header of an inbound email; unique per club among inbound rows');

-- Every existing row has message_id NULL, so the index cannot meet duplicates
-- when it is created; ensure_unique_index still refuses to fail the deploy.
SELECT pg_temp.ensure_unique_index('uq_email_messages_inbound_message_id',
  $ddl$CREATE UNIQUE INDEX uq_email_messages_inbound_message_id ON public.email_messages (club, message_id) WHERE direction = 'inbound' AND message_id IS NOT NULL$ddl$);

SELECT pg_temp.ensure_index('idx_email_messages_pending',
  $ddl$CREATE INDEX idx_email_messages_pending ON public.email_messages (club, routed_to, created_at) WHERE direction = 'inbound' AND routed_to IN ('queued', 'processing')$ddl$);

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_check(text, text, text);
DROP FUNCTION pg_temp.ensure_unique_index(text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
