-- Let the email bot write to this database again.
--
-- County Louth's bot (jimbobirecode/TeeMailSG) is the service that reads the
-- club's mailbox and creates bookings, waitlist entries and a record of every
-- inbound email. When it was repointed at this database it silently stopped
-- writing anything at all: not one booking, waitlist entry or email landed.
-- Every one of its inserts names a column this schema does not have, and the
-- bot wraps each in `except Exception`, logs it and carries on returning 200 to
-- SendGrid — so nothing was lost loudly.
--
-- Migrations 0015-0017 were validated against what the dashboard *reads*. The
-- writer was never checked, and three of these breakages are a rename I made
-- for tidiness, which is the expensive kind of tidy.
--
-- This file closes the gap from the schema side wherever the dashboard does not
-- already have its own column for the same thing:
--
--   intent / urgency / confidence  added, and 0016's enquiry_* copied into them.
--                                  0016 added that prefix to avoid confusion
--                                  with email_messages.intent; the bot writes
--                                  the unprefixed names, and nothing here reads
--                                  either, so the prefix bought nothing and cost
--                                  every booking.
--
--                                  Copied rather than renamed, which is what
--                                  this file did first: a rename takes
--                                  enquiry_intent away, and 0016 replayed on a
--                                  database that already has the schema then
--                                  tries to ADD COLUMN it back, which needs
--                                  ownership of bookings and fails for a role
--                                  that owns nothing. The migrate integration
--                                  test covers exactly that and caught it. So
--                                  enquiry_* stays, frozen, holding the history
--                                  as 0016 wrote it, and the unprefixed columns
--                                  are what the bot writes from here on.
--   message_id                     the Message-ID of the email that created the
--                                  booking. 0015 dropped it as empty; it is
--                                  empty only because the old export predated
--                                  the bot setting it.
--   club_name                      the club's name as the bot knows it. Dropped
--                                  by 0015 as branding, which it is — but the
--                                  bot writes it, and a column it can write
--                                  costs less than a release of the bot.
--   waitlist.email_html            0017 took the text part and dropped the HTML
--                                  because every migrated row's was empty. The
--                                  bot still sends it.
--   inbound_emails                 the bot's own audit trail of every message it
--                                  receives, created here from its schema.sql.
--                                  See the note at the bottom: this is NOT what
--                                  the dashboard's Inbox reads.
--
-- Three columns are deliberately NOT added, because this schema already has the
-- same thing under its own name and the dashboard reads that one. Adding a
-- second column would make the bot's writes invisible on screen, which is worse
-- than failing. The bot is changed to write these instead:
--
--   dates      -> golf_dates     (JSONB array -> TEXT[])
--   lead_name  -> guest_name
--   lead_phone -> contact_phone

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

-- The names the bot writes.
SELECT pg_temp.ensure_column('bookings', 'intent', 'VARCHAR(50)');
SELECT pg_temp.ensure_column('bookings', 'urgency', 'VARCHAR(50)');
SELECT pg_temp.ensure_column('bookings', 'confidence', 'NUMERIC(3,2)');

-- Carry 0016's history across, once. Guarded on IS NULL so a re-run copies
-- nothing and never overwrites what the bot has since written, and so this
-- needs only UPDATE rather than ownership of the table.
DO $$
BEGIN
  IF pg_temp.has_column('bookings', 'enquiry_intent') THEN
    UPDATE public.bookings SET intent = enquiry_intent
     WHERE intent IS NULL AND enquiry_intent IS NOT NULL;
    UPDATE public.bookings SET urgency = enquiry_urgency
     WHERE urgency IS NULL AND enquiry_urgency IS NOT NULL;
    UPDATE public.bookings SET confidence = enquiry_confidence
     WHERE confidence IS NULL AND enquiry_confidence IS NOT NULL;
  END IF;
END $$;

SELECT pg_temp.ensure_column('bookings', 'message_id', 'VARCHAR(500)');
SELECT pg_temp.ensure_column('bookings', 'club_name', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('waitlist', 'email_html', 'TEXT');

SELECT pg_temp.ensure_comment('bookings', 'intent',
  'Written by the email bot: what it took the enquiry to be. 0016''s enquiry_intent was copied in and is frozen.');
SELECT pg_temp.ensure_comment('bookings', 'urgency',
  'Written by the email bot: how soon the party wanted to play, as it read the enquiry.');
SELECT pg_temp.ensure_comment('bookings', 'confidence',
  'Written by the email bot: 0..1, its confidence in that reading.');
SELECT pg_temp.ensure_comment('bookings', 'message_id',
  'Written by the email bot: Message-ID of the email that created this booking.');
SELECT pg_temp.ensure_comment('bookings', 'club_name',
  'Written by the email bot: the club''s name as it knows it. Display here comes from CLUB_FULL_NAME, not this.');
SELECT pg_temp.ensure_comment('waitlist', 'email_html',
  'Written by the email bot: HTML part of the enquiry that created this entry, where there was one.');

-- ---------------------------------------------------------------------------
-- The bot's audit trail of every message it receives, from its own schema.sql.
--
-- This is NOT the dashboard's Inbox. The Inbox reads email_messages, which the
-- bot does not write, so mail landing here does not appear on screen. Keeping
-- the table means the bot works and nothing is lost while that is decided;
-- carrying these rows into email_messages is a separate piece of work.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inbound_emails (
    id SERIAL PRIMARY KEY,
    message_id VARCHAR(255) UNIQUE,
    from_email VARCHAR(255) NOT NULL,
    to_email VARCHAR(255),
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    headers TEXT,
    received_at TIMESTAMP DEFAULT NOW(),
    processed BOOLEAN DEFAULT FALSE,
    email_type VARCHAR(50),
    waitlist_id VARCHAR(50),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

DO $$
BEGIN
  IF to_regclass('public.ix_inbound_emails_received') IS NULL THEN
    EXECUTE 'CREATE INDEX ix_inbound_emails_received ON public.inbound_emails (received_at DESC)';
  END IF;
  IF to_regclass('public.ix_inbound_emails_from') IS NULL THEN
    EXECUTE 'CREATE INDEX ix_inbound_emails_from ON public.inbound_emails (lower(from_email))';
  END IF;
END $$;

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
