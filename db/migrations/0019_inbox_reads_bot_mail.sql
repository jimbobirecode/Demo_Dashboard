-- Make the Inbox show the mail the bot receives.
--
-- Two tables hold inbound email and nothing joined them:
--
--   inbound_emails   the bot's own audit trail. Migration 0018 created it from
--                    the bot's schema so the bot could write at all. The bot
--                    inserts a row the moment SendGrid hands it a message,
--                    with email_type 'unknown', then updates that type once it
--                    has worked out what the message was.
--   email_messages   what this dashboard reads. The Inbox, a booking's
--                    conversation and every count come from here. The bot does
--                    not write it, and the core API that normally does is not
--                    in front of this club's mailbox.
--
-- So every email the club received landed in a table no screen reads, and the
-- Inbox stayed empty while mail arrived. 0018's own comment said joining the
-- two was separate work; this is that work.
--
-- A trigger rather than a bot release, because the bot needs no knowledge of
-- this dashboard's schema to keep working, and because a trigger cannot be
-- half-deployed: the moment it exists, mail appears.
--
-- WHAT THE CLUB SEES
--
-- Every inbound email is mirrored, so nothing is invisible. Only the ones that
-- need a person are left OPEN in the Inbox:
--
--   * A brand new row is open, because the bot has not classified it yet. Mail
--     appears on screen within a second of arriving rather than after the bot
--     finishes thinking, which is the whole point for a club watching an inbox.
--   * When the bot then settles on a type it handled itself (a booking
--     request, a cancellation, a waitlist opt-in), the row drops to 'none':
--     filed, searchable, in the booking's conversation, out of the queue.
--   * When the bot could not handle it ('unknown', 'error', or a bare
--     error_message), it stays open with the reason, which is the case the
--     club must never miss.
--
-- Anything a person has already dealt with is never reopened or re-filed: the
-- trigger leaves any row with handled_at set exactly as it is.

-- Anything a person has already dealt with keeps its place in the queue: the
-- trigger updates what the email IS, never where a handled one SITS.

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0018, for the same reason and against a different
-- statement. CREATE OR REPLACE FUNCTION is not a no-op on a function that
-- already exists: it demands ownership of it, and fails outright for a role
-- that owns nothing. Production meets this file with the schema already in
-- place, created by whoever created it, which is exactly that case - and the
-- migrate integration test covers it, which is how this was caught.
--
-- So each definition below is applied when it is missing, replaced when this
-- role owns it, and otherwise left alone with a warning rather than failing
-- the deploy. Nothing is lost by skipping: if the function is already there,
-- somebody already installed this migration.
--
-- The helpers live in pg_temp, which this role always owns, last only for
-- this session, and are dropped at the end of the file.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.ensure_function(sig text, ddl text) RETURNS void
LANGUAGE plpgsql AS $helper$
DECLARE
  existing oid := to_regprocedure(sig);
BEGIN
  IF existing IS NULL
     OR pg_has_role(current_user, (SELECT proowner FROM pg_proc WHERE oid = existing), 'MEMBER') THEN
    EXECUTE ddl;
  ELSE
    RAISE WARNING 'not the owner of %, so it was left as it is', sig;
  END IF;
END $helper$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_function_comment(sig text, body text) RETURNS void
LANGUAGE plpgsql AS $helper$
DECLARE
  existing oid := to_regprocedure(sig);
BEGIN
  IF existing IS NULL THEN
    RETURN;
  END IF;
  IF obj_description(existing, 'pg_proc') IS NOT DISTINCT FROM body THEN
    RETURN;
  END IF;
  IF NOT pg_has_role(current_user, (SELECT proowner FROM pg_proc WHERE oid = existing), 'MEMBER') THEN
    RAISE WARNING 'not the owner of %, so its comment was left as it is', sig;
    RETURN;
  END IF;
  EXECUTE format('COMMENT ON FUNCTION %s IS %L', sig, body);
END $helper$;

-- A trigger needs ownership of its TABLE, not of itself, and CREATE TRIGGER
-- has no IF NOT EXISTS. Created when absent, recreated when this role owns
-- the table so an updated definition deploys, skipped otherwise.
CREATE OR REPLACE FUNCTION pg_temp.ensure_trigger(tbl text, trg text, ddl text) RETURNS void
LANGUAGE plpgsql AS $helper$
DECLARE
  rel      regclass := to_regclass('public.' || quote_ident(tbl));
  present  boolean;
  owned    boolean;
BEGIN
  IF rel IS NULL THEN
    RAISE WARNING 'there is no table %, so trigger % was not created', tbl, trg;
    RETURN;
  END IF;
  present := EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = rel AND tgname = trg AND NOT tgisinternal);
  owned   := pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = rel), 'MEMBER');

  IF present AND NOT owned THEN
    RAISE WARNING 'not the owner of %, so trigger % was left as it is', tbl, trg;
    RETURN;
  END IF;
  IF present THEN
    EXECUTE format('DROP TRIGGER %I ON public.%I', trg, tbl);
  END IF;
  EXECUTE ddl;
END $helper$;

-- ---------------------------------------------------------------------------
-- The club every mirrored row belongs to.
--
-- inbound_emails has no club column: the bot serves one club per deployment
-- and never needed one. Every query in this dashboard is scoped to the signed
-- in user's dashboard_users.customer_id, so a mirrored row carries that value
-- or no screen will ever show it. 'baltray' is County Louth's, and it is what
-- all 1,825 bookings, the waitlist and the operators carry.
--
-- Resolved from the data rather than written in, so this stays correct if the
-- club identifier is ever changed: the single distinct club already in
-- bookings, falling back to the literal on an empty database.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_function('public.inbox_mirror_club()', $ddl$
CREATE OR REPLACE FUNCTION public.inbox_mirror_club() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT club FROM public.bookings
      GROUP BY club ORDER BY count(*) DESC LIMIT 1),
    'baltray')
$$
$ddl$);
SELECT pg_temp.ensure_function_comment('public.inbox_mirror_club()',
  'The club identifier mirrored inbound email is filed under. Must equal dashboard_users.customer_id or no screen shows it.');

-- ---------------------------------------------------------------------------
-- The bot's email_type, in this schema's vocabulary.
--
-- email_messages.intent is one of new_enquiry, booking_reply, change_request,
-- cancellation, question, complaint, operator_request, not_booking, other
-- (migration 0004). The bot's types are its own; anything with no counterpart
-- here becomes 'other' rather than a value nothing understands.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_function('public.inbox_intent_of(text)', $ddl$
CREATE OR REPLACE FUNCTION public.inbox_intent_of(email_type text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(coalesce(email_type, ''))
    WHEN 'new_booking'        THEN 'new_enquiry'
    WHEN 'booking_request'    THEN 'new_enquiry'
    WHEN 'cancellation'       THEN 'cancellation'
    WHEN 'modification'       THEN 'change_request'
    WHEN 'staff_confirmation' THEN 'booking_reply'
    WHEN 'waitlist_optin'     THEN 'other'
    WHEN 'season_closed'      THEN 'other'
    ELSE 'other'
  END
$$
$ddl$);
-- An address the dashboard can match on.
--
-- The bot stores the From header as it arrived, so most are 'Name <addr>'
-- rather than an address. A booking's conversation is found by
-- lower(from_email) = the guest's address, so the header form matches nothing
-- and the email never joins its own thread. Taken apart here as well as in the
-- bot, because rows already written this way have to read correctly too.
SELECT pg_temp.ensure_function('public.inbox_bare_address(text)', $ddl$
CREATE OR REPLACE FUNCTION public.inbox_bare_address(header text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(lower(trim(COALESCE(
    substring(header FROM '<([^<>]+)>'),   -- 'Name <addr>'
    header                                 -- already bare
  ))), '')
$$
$ddl$);
SELECT pg_temp.ensure_function_comment('public.inbox_bare_address(text)',
  'The address out of a From/To header, so lower(from_email) matches a guest address.');

-- ---------------------------------------------------------------------------
-- The mirror itself.
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
  -- A message with no Message-ID cannot be de-duplicated or re-found when the
  -- bot updates its type, and the unique index this upsert needs is on
  -- (club, message_id). Mirroring it would create a duplicate on every update,
  -- so it is left in inbound_emails alone. The bot sets one on every message
  -- SendGrid delivers; this is the malformed case, not the normal one.
  IF NEW.message_id IS NULL OR btrim(NEW.message_id) = '' THEN
    RETURN NULL;
  END IF;

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

  -- File it against its booking where there is one. Migration 0018 gave
  -- bookings the message_id of the email that created it, which is exactly
  -- this join, so the email shows up in the booking's own conversation.
  SELECT b.booking_id INTO v_booking
    FROM public.bookings b
   WHERE b.club = v_club AND b.message_id = NEW.message_id
   LIMIT 1;

  SELECT id, review_status, handled_at, booking_id
    INTO v_existing
    FROM public.email_messages
   WHERE club = v_club AND direction = 'inbound' AND message_id = NEW.message_id
   LIMIT 1;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.email_messages
      (club, direction, message_id, booking_id, from_email, to_email, subject,
       body_text, intent, routed_to, review_status, review_reason, created_at)
    VALUES
      (v_club, 'inbound', NEW.message_id, v_booking, v_from,
       public.inbox_bare_address(NEW.to_email), NEW.subject, NEW.body_text,
       v_intent, 'inbox',
       CASE WHEN v_open THEN 'open' ELSE 'none' END, v_reason,
       COALESCE(NEW.received_at, NEW.created_at, NOW()))
    ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;

  -- It is already mirrored, and the bot has refined what it knows.
  --
  -- What the email IS (its intent, its booking, its text) is always brought up
  -- to date: that is the bot's to say, and a stale classification is just
  -- wrong. Where it SITS is not. A row a person has dealt with keeps its
  -- status, and a replied or dismissed one is never pulled back into the
  -- queue - a club that has answered an email does not want it returned.
  --
  -- review_reason always says what the bot currently reports, on a handled row
  -- too: it is a note about the email, not a place in the queue. That clears
  -- the 'Just arrived' placeholder once the bot has stopped thinking, and lets
  -- a later failure show on an answered email without reopening it.
  UPDATE public.email_messages
     SET intent        = v_intent,
         booking_id    = COALESCE(v_existing.booking_id, v_booking),
         subject       = COALESCE(NEW.subject, subject),
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
SELECT pg_temp.ensure_function_comment('public.inbox_mirror_inbound_email()',
  'Mirrors the email bot''s inbound_emails rows into email_messages, which is what the Inbox reads.');

SELECT pg_temp.ensure_trigger('inbound_emails', 'trg_inbox_mirror_inbound_email', $trg$
CREATE TRIGGER trg_inbox_mirror_inbound_email
  AFTER INSERT OR UPDATE OF email_type, error_message, subject, body_text
  ON public.inbound_emails
  FOR EACH ROW EXECUTE FUNCTION public.inbox_mirror_inbound_email()
$trg$);

-- ---------------------------------------------------------------------------
-- Anything the bot wrote before the trigger existed.
--
-- Empty when this first runs (the bot had been discarding everything), but
-- this file must also be correct on a database where mail arrived between
-- 0018 and now.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_club text := public.inbox_mirror_club();
  moved  integer;
BEGIN
  INSERT INTO public.email_messages
    (club, direction, message_id, booking_id, from_email, to_email, subject,
     body_text, intent, routed_to, review_status, review_reason, created_at)
  SELECT
    v_club, 'inbound', ie.message_id, b.booking_id,
    public.inbox_bare_address(ie.from_email),
    public.inbox_bare_address(ie.to_email),
    ie.subject, ie.body_text,
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
      ON b.club = v_club AND b.message_id = ie.message_id
   WHERE ie.message_id IS NOT NULL AND btrim(ie.message_id) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.email_messages em
        WHERE em.club = v_club AND em.direction = 'inbound'
          AND em.message_id = ie.message_id)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved > 0 THEN
    RAISE NOTICE 'mirrored % inbound email(s) the bot had written before this trigger existed', moved;
  END IF;
END $$;

DROP FUNCTION pg_temp.ensure_trigger(text, text, text);
DROP FUNCTION pg_temp.ensure_function_comment(text, text);
DROP FUNCTION pg_temp.ensure_function(text, text);
