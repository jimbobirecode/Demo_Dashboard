-- Stop dropping inbound email that arrives without a Message-ID.
--
-- 0019 mirrors the bot's inbound_emails rows into email_messages, which is
-- what the Inbox reads, and matched the two by Message-ID. When a row had
-- none it was skipped outright, on the reasoning that it "cannot be
-- de-duplicated or re-found when the bot updates its type", and that this was
-- "the malformed case, not the normal one".
--
-- The first real email to arrive after 0019 went live had no Message-ID, and
-- was dropped. It was a perfectly ordinary message: body, HTML and sender all
-- present, delivered to the club's address by SendGrid Inbound Parse. What was
-- missing was the webhook's `headers` field, which is where the bot reads the
-- Message-ID from -- so the header never reached it, and the email never
-- reached the Inbox. Nothing failed anywhere: the bot stored it, the trigger
-- declined it, and the club saw an empty Inbox.
--
-- The reasoning was sound and the conclusion was wrong. The Message-ID is a
-- header the sender controls, so it is not something to depend on to find our
-- own row again. inbound_emails.id is ours, always there, and unique.
--
-- So: match on the source row, keep the Message-ID as what it honestly is
-- (the sender's header, or nothing), and mirror every email either way.

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0019: each statement checks the catalog first, so on a
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
-- Which inbound_emails row a mirrored message came from.
--
-- This is the join 0019 should have used. It is our own key rather than the
-- sender's, so it is always there, and it stays stable while the bot updates
-- the row's type.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_column('email_messages', 'source_inbound_id', 'INTEGER');

SELECT pg_temp.ensure_index('uq_email_messages_source_inbound',
  $ddl$CREATE UNIQUE INDEX uq_email_messages_source_inbound
         ON public.email_messages (club, source_inbound_id)
      WHERE source_inbound_id IS NOT NULL$ddl$);

-- Rows 0019 already mirrored were matched by Message-ID; give them their
-- source id so the trigger finds them the new way and does not duplicate.
UPDATE public.email_messages em
   SET source_inbound_id = ie.id
  FROM public.inbound_emails ie
 WHERE em.source_inbound_id IS NULL
   AND em.direction = 'inbound'
   AND em.message_id IS NOT NULL
   AND ie.message_id = em.message_id;

-- ---------------------------------------------------------------------------
-- The mirror, matching on the source row and keeping everything.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_function('public.inbox_mirror_inbound_email()', $trgfn$
CREATE OR REPLACE FUNCTION public.inbox_mirror_inbound_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_club      text := public.inbox_mirror_club();
  v_type      text := lower(coalesce(NEW.email_type, 'unknown'));
  v_intent    text := public.inbox_intent_of(NEW.email_type);
  v_from      text := public.inbox_bare_address(NEW.from_email);
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
       to_email, subject, body_text, intent, routed_to, review_status,
       review_reason, created_at)
    VALUES
      (v_club, 'inbound', NEW.id, NULLIF(btrim(coalesce(NEW.message_id, '')), ''),
       v_booking, v_from, public.inbox_bare_address(NEW.to_email),
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

-- ---------------------------------------------------------------------------
-- Everything 0019 declined, and anything that arrived before either file.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_club text := public.inbox_mirror_club();
  moved  integer;
BEGIN
  INSERT INTO public.email_messages
    (club, direction, source_inbound_id, message_id, booking_id, from_email,
     to_email, subject, body_text, intent, routed_to, review_status,
     review_reason, created_at)
  SELECT
    v_club, 'inbound', ie.id, NULLIF(btrim(coalesce(ie.message_id, '')), ''),
    b.booking_id,
    public.inbox_bare_address(ie.from_email),
    public.inbox_bare_address(ie.to_email),
    NULLIF(btrim(coalesce(ie.subject, '')), ''),
    ie.body_text,
    public.inbox_intent_of(ie.email_type), 'inbox',
    CASE WHEN COALESCE(btrim(ie.error_message), '') <> ''
           OR lower(COALESCE(ie.email_type, 'unknown')) IN ('unknown', '', 'error')
         THEN 'open' ELSE 'none' END,
    CASE WHEN COALESCE(btrim(ie.error_message), '') <> ''
         THEN 'The email bot could not process this: ' || ie.error_message
         WHEN lower(COALESCE(ie.email_type, 'unknown')) IN ('unknown', '', 'error')
         THEN 'The email bot did not classify this one.'
         END,
    COALESCE(ie.received_at, ie.created_at, NOW())
    FROM public.inbound_emails ie
    LEFT JOIN public.bookings b
      ON b.club = v_club AND ie.message_id IS NOT NULL AND b.message_id = ie.message_id
   WHERE NOT EXISTS (
       SELECT 1 FROM public.email_messages em
        WHERE em.club = v_club AND em.direction = 'inbound'
          AND em.source_inbound_id = ie.id)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved > 0 THEN
    RAISE NOTICE 'brought % inbound email(s) into the Inbox that had been skipped for want of a Message-ID', moved;
  END IF;
END $$;

SELECT pg_temp.ensure_function('public.inbox_mirror_inbound_email()', $c$
COMMENT ON FUNCTION public.inbox_mirror_inbound_email() IS
  'Mirrors the email bot inbound_emails rows into email_messages, matched on inbound_emails.id. Every row is mirrored, with or without a Message-ID.'
$c$);

DROP FUNCTION pg_temp.ensure_function(text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
