-- Room to record what Claude made of an inbound email.
--
-- email_messages already has the columns the Inbox reads for this: `intent`,
-- `summary` and `draft_reply` (migration 0004), and the page has always been
-- built to show them -- it even tells the reader "Claude has written a draft
-- from the club's own information". At County Louth nothing ever wrote them,
-- because the service that does it on the demo (the core API) is not the one
-- in front of this club's mailbox; the bot is, and it only records a type.
--
-- So every email arrived classified as 'other', with no summary and no draft,
-- and the club read each one from scratch. This file adds only the bookkeeping
-- the triage pass needs to be safe to run on a schedule:
--
--   triaged_at       when it was last looked at, so a sweep does not pay to
--                    classify the same email every minute.
--   triage_attempts  so a message that makes the model fail -- a malformed
--                    body, something too long -- is retried a few times and
--                    then left alone, rather than retried for ever at cost.
--   triage_error     what went wrong on the last attempt, so a run of
--                    failures can be diagnosed from the database rather than
--                    from whatever is left of the logs.
--
-- Nothing here changes what the Inbox shows. The pass that fills the columns
-- is server/src/lib/inbox-triage.js.

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0020: each statement checks the catalog first, so on a
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

CREATE OR REPLACE FUNCTION pg_temp.ensure_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    EXECUTE ddl;
  END IF;
END $$;

SELECT pg_temp.ensure_column('email_messages', 'triaged_at', 'TIMESTAMPTZ');
SELECT pg_temp.ensure_column('email_messages', 'triage_attempts', 'INTEGER NOT NULL DEFAULT 0');
SELECT pg_temp.ensure_column('email_messages', 'triage_error', 'TEXT');

-- The sweep's own query: inbound, still in the mailbox, not yet looked at and
-- not given up on. Partial, so it stays small however much mail accumulates.
SELECT pg_temp.ensure_index('ix_email_messages_untriaged',
  $ddl$CREATE INDEX ix_email_messages_untriaged
         ON public.email_messages (club, created_at)
      WHERE direction = 'inbound' AND triaged_at IS NULL AND triage_attempts < 3$ddl$);

DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
