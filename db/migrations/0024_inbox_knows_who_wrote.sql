-- Keep the name of the person who wrote, so the Inbox can say who an email is
-- from rather than borrowing a name from somewhere else.
--
-- The Inbox had no name of its own for a sender: email_messages holds only a
-- bare from_email. So the dashboard filled the gap with the linked booking's
-- guest_name -- and at County Louth that column holds the LEAD GOLFER named
-- inside the enquiry, not the person who sent it. Most enquiries come from
-- tour operators, so an email from bookings@halcyongolftravel.com was listed,
-- headed and greeted as "Lori Corrion": a guest who has never written to the
-- club and is not reading the reply.
--
-- The sender's own name was there all along. inbound_emails.from_email keeps
-- the From header exactly as it arrived -- 'Adam Gordon <adam@...>' -- which
-- is deliberate: that table is the record of what was delivered. 0019 takes
-- the address out of it for matching and throws the display name away.
--
-- So: keep the display name too, in a column of its own, and let the lead
-- golfer go back to being what it is -- a name on the party, not a
-- correspondent.

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0022: each statement checks the catalog first, so on a
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

CREATE OR REPLACE FUNCTION pg_temp.ensure_function(sig text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  existing oid := to_regprocedure(sig);
BEGIN
  IF existing IS NULL
     OR pg_has_role(current_user, (SELECT proowner FROM pg_proc WHERE oid = existing), 'MEMBER') THEN
    EXECUTE ddl;
  ELSE
    RAISE WARNING 'not the owner of %, so it was left as it is', sig;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The name on a From header, when the sender's client put a real one there.
--
-- Three shapes are deliberately read as "no name", because showing them would
-- be worse than showing the address:
--
--   <normcook59@gmail.com>                     nothing before the brackets
--   "dave@ramaley.com" <dave@ramaley.com>      the address, repeated as a name
--   =?UTF-8?B?Tm9ybSBDb29r?= <...>             an encoded word, not yet text
--
-- The last one is decoded by the mail client, not by us. Decoding RFC 2047 in
-- SQL is a job with no end to it, and '=?UTF-8?B?...' on screen is less use
-- than the address, so it is left alone.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_function('public.inbox_display_name(text)', $ddl$
CREATE OR REPLACE FUNCTION public.inbox_display_name(header text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN name = '' THEN NULL
           WHEN name LIKE '=?%' THEN NULL
           WHEN lower(name) = COALESCE(public.inbox_bare_address(header), '') THEN NULL
           ELSE name
         END
    FROM (SELECT btrim(btrim(btrim(split_part(COALESCE(header, ''), '<', 1)), '"')) AS name
           WHERE COALESCE(header, '') ~ '<[^<>]+>') named
$$
$ddl$);

SELECT pg_temp.ensure_function('public.inbox_display_name(text)', $c$
COMMENT ON FUNCTION public.inbox_display_name(text) IS
  'The display name out of a From/To header, or NULL when it carries none worth showing.'
$c$);

-- Who wrote, in their own words. NULL where the header carried no name, which
-- is the dashboard's cue to identify the email by its address instead.
SELECT pg_temp.ensure_column('email_messages', 'from_name', 'TEXT');

-- ---------------------------------------------------------------------------
-- The mirror, now keeping the name as well as the address.
--
-- Unchanged from 0020 but for v_name and the two places it is written. The
-- name is refreshed on an update the same way the subject is: the bot can
-- revise the row it stored, and the header it stored it from is the only
-- place either comes from.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_function('public.inbox_mirror_inbound_email()', $trgfn$
CREATE OR REPLACE FUNCTION public.inbox_mirror_inbound_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_club      text := public.inbox_mirror_club();
  v_type      text := lower(coalesce(NEW.email_type, 'unknown'));
  v_intent    text := public.inbox_intent_of(NEW.email_type);
  v_from      text := public.inbox_bare_address(NEW.from_email);
  v_name      text := public.inbox_display_name(NEW.from_email);
  v_booking   text;
  v_open      boolean;
  v_reason    text;
  v_existing  record;
BEGIN
  -- Does it need a person?
  IF NEW.error_message IS NOT NULL AND btrim(NEW.error_message) <> '' THEN
    v_open   := true;
    v_reason := 'The email bot could not process this: ' || NEW.error_message;
  ELSIF v_type IN ('unknown', '', 'error') THEN
    v_open   := true;
    v_reason := CASE WHEN v_type = 'error'
                     THEN 'The email bot failed on this one.'
                     ELSE 'Just arrived - the email bot has not classified it yet.' END;
  ELSE
    v_open   := false;
    v_reason := NULL;
  END IF;

  -- File it against its booking, when the bot recorded which email made one.
  IF NEW.message_id IS NOT NULL AND btrim(NEW.message_id) <> '' THEN
    SELECT b.booking_id INTO v_booking
      FROM public.bookings b
     WHERE b.club = v_club AND b.message_id = NEW.message_id
     LIMIT 1;
  END IF;

  SELECT id, review_status, handled_at, booking_id
    INTO v_existing
    FROM public.email_messages
   WHERE club = v_club AND direction = 'inbound' AND source_inbound_id = NEW.id
   LIMIT 1;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.email_messages
      (club, direction, source_inbound_id, message_id, booking_id, from_email,
       from_name, to_email, subject, body_text, intent, routed_to,
       review_status, review_reason, created_at)
    VALUES
      (v_club, 'inbound', NEW.id, NULLIF(btrim(coalesce(NEW.message_id, '')), ''),
       v_booking, v_from, v_name, public.inbox_bare_address(NEW.to_email),
       -- A subject is what the Inbox lists an email by, so an empty one gets
       -- something a person can act on rather than a blank row.
       NULLIF(btrim(coalesce(NEW.subject, '')), ''),
       NEW.body_text, v_intent, 'inbox',
       CASE WHEN v_open THEN 'open' ELSE 'none' END, v_reason,
       COALESCE(NEW.received_at, NEW.created_at, NOW()))
    ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;

  -- Already mirrored, and the bot has refined what it knows. What the email
  -- IS is brought up to date; where a handled one SITS is not, and a replied
  -- or dismissed one is never pulled back into the queue.
  UPDATE public.email_messages
     SET intent        = v_intent,
         message_id    = COALESCE(message_id, NULLIF(btrim(coalesce(NEW.message_id, '')), '')),
         booking_id    = COALESCE(v_existing.booking_id, v_booking),
         from_name     = COALESCE(v_name, from_name),
         subject       = COALESCE(NULLIF(btrim(coalesce(NEW.subject, '')), ''), subject),
         body_text     = COALESCE(NEW.body_text, body_text),
         review_status = CASE
                           WHEN v_existing.handled_at IS NOT NULL
                             OR v_existing.review_status IN ('replied', 'dismissed')
                             THEN v_existing.review_status
                           WHEN v_open THEN 'open'
                           ELSE 'none'
                         END,
         review_reason = v_reason
   WHERE id = v_existing.id;

  RETURN NULL;
END $fn$
$trgfn$);

SELECT pg_temp.ensure_function('public.inbox_mirror_inbound_email()', $c$
COMMENT ON FUNCTION public.inbox_mirror_inbound_email() IS
  'Mirrors the email bot inbound_emails rows into email_messages, matched on inbound_emails.id. Every row is mirrored, with or without a Message-ID, and keeps the sender''s name as well as their address.'
$c$);

-- ---------------------------------------------------------------------------
-- Every email already in the Inbox, named from the header it came from.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  named integer;
BEGIN
  UPDATE public.email_messages em
     SET from_name = public.inbox_display_name(ie.from_email)
    FROM public.inbound_emails ie
   WHERE em.source_inbound_id = ie.id
     AND em.from_name IS NULL
     AND public.inbox_display_name(ie.from_email) IS NOT NULL;

  GET DIAGNOSTICS named = ROW_COUNT;
  IF named > 0 THEN
    RAISE NOTICE 'named the sender of % email(s) already in the Inbox', named;
  END IF;
END $$;

DROP FUNCTION pg_temp.ensure_function(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
