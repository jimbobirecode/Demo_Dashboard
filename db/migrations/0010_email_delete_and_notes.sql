-- The mailbox: deleting an email, and notes on one.
--
-- Deleting is recoverable. An email is marked deleted (with who did it and
-- when) and leaves every Inbox list and count; a "Deleted" filter shows them
-- and puts one back. The row itself stays, because other things point at it:
-- a membership application's enquiry (membership_applications.source_message_id),
-- a guest request (booking_change_requests.email_message_id), the thread a
-- reply belongs to (email_messages.in_reply_to), and the Message-ID that stops
-- SendGrid delivering the same email twice. Erasing the row would break those
-- and lose the conversation log.
--
-- Notes are the team talking to itself about an email - "called her, she is
-- happy to move to the Tuesday" - each stamped with the user who wrote it.
-- Its own table rather than a text column: one row per note, so the stamp
-- cannot be edited into something else and the newest is a plain ORDER BY.
--
-- Both are the dashboard's own: the core API neither reads nor writes them.
-- It does re-process an inbound email left `queued` by a dying worker, so the
-- dashboard refuses to delete a row while the core API still has it in hand.

-- ---------------------------------------------------------------------------
-- Guards, as in 0004 and 0009: every statement checks the catalog first and
-- does nothing when its object already exists, so this file needs no
-- ownership of a table it would not change. The helpers live in pg_temp and
-- are dropped at the end.
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
-- Deleted, recoverably.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_column('email_messages', 'deleted_at', 'TIMESTAMPTZ');
SELECT pg_temp.ensure_column('email_messages', 'deleted_by', 'TEXT');

SELECT pg_temp.ensure_comment('email_messages', 'deleted_at',
  'Deleted from the mailbox at this time; NULL for every email still in it. The row is kept - see 0010');
SELECT pg_temp.ensure_comment('email_messages', 'deleted_by',
  'Dashboard username that deleted it from the mailbox');

-- The Inbox reads live rows only, so the existing idx_email_messages_inbox
-- (review_status = 'open') is narrowed by this one.
SELECT pg_temp.ensure_index('idx_email_messages_live',
  $ddl$CREATE INDEX idx_email_messages_live ON public.email_messages (club, review_status, created_at)
        WHERE deleted_at IS NULL$ddl$);
-- The Deleted filter: far fewer rows, and only ever read on its own.
SELECT pg_temp.ensure_index('idx_email_messages_deleted',
  $ddl$CREATE INDEX idx_email_messages_deleted ON public.email_messages (club, deleted_at)
        WHERE deleted_at IS NOT NULL$ddl$);

-- ---------------------------------------------------------------------------
-- Notes on an email.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.email_notes') IS NULL THEN
    CREATE TABLE public.email_notes (
        id          SERIAL PRIMARY KEY,
        club        TEXT NOT NULL,
        message_id  INTEGER NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
        note        TEXT NOT NULL,
        created_by  TEXT NOT NULL,              -- dashboard username, never 'bot'
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

SELECT pg_temp.ensure_index('idx_email_notes_message',
  $ddl$CREATE INDEX idx_email_notes_message ON public.email_notes (club, message_id, created_at)$ddl$);

SELECT pg_temp.ensure_comment('email_notes', NULL,
  'What the team wrote to itself about one email; one row per note, stamped with its author');
SELECT pg_temp.ensure_comment('email_notes', 'created_by',
  'Dashboard username that wrote the note (never the bot: notes are written by people)');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
