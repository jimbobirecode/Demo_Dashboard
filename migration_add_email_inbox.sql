-- Every email to and from a guest, and the Inbox of ones a person must answer.
--
-- The core API writes a row for each inbound email it receives, with what
-- Claude understood it to be (intent, summary, a drafted reply) and where it
-- was routed: answered automatically, turned into a change request, held in
-- the Inbox for a person, or ignored (auto-replies, spam). Every email sent to
-- a guest — by the bot or from this dashboard — is written here too, so a
-- booking carries its whole conversation.
--
-- Both services tolerate this table being absent: nothing is logged and
-- nothing breaks. Safe to run more than once; the dashboard picks it up within
-- 30 seconds, with no restart.

CREATE TABLE IF NOT EXISTS public.email_messages (
  id               SERIAL PRIMARY KEY,
  club             TEXT NOT NULL,
  direction        TEXT NOT NULL,             -- 'inbound' | 'outbound'
  booking_id       TEXT,

  from_email       TEXT,
  to_email         TEXT,
  subject          TEXT,
  body_text        TEXT,

  -- What the email was understood to be (inbound only).
  intent           TEXT,                      -- new_enquiry, booking_reply, change_request, cancellation, question, complaint, operator_request, not_booking, other
  summary          TEXT,
  extraction       JSONB,

  -- Where it went.
  routed_to        TEXT,                      -- auto_reply, booking_request, inbox, change_request, ignored
  change_request_id INTEGER,

  -- The Inbox: open until somebody replies or dismisses it.
  review_status    TEXT NOT NULL DEFAULT 'none', -- none | open | replied | dismissed
  review_reason    TEXT,
  draft_reply      TEXT,
  handled_at       TIMESTAMPTZ,
  handled_by       TEXT,

  -- Outbound: who sent it ('bot', 'Stripe', or a dashboard username) and what
  -- kind of email it was.
  sent_by          TEXT,
  kind             TEXT,                      -- availability, acknowledgement, payment_link, receipt, pre_arrival, post_play, reply, ...
  in_reply_to      INTEGER REFERENCES public.email_messages(id) ON DELETE SET NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_booking ON public.email_messages (club, booking_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_inbox ON public.email_messages (club, review_status, created_at)
  WHERE review_status = 'open';
CREATE INDEX IF NOT EXISTS idx_email_messages_from ON public.email_messages (club, lower(from_email));

COMMENT ON TABLE public.email_messages IS
  'Every guest email in and out; review_status = open is the dashboard Inbox';

-- Change requests that arrived by email rather than through the manage link.
DO $$
BEGIN
  IF to_regclass('public.booking_change_requests') IS NOT NULL THEN
    ALTER TABLE public.booking_change_requests
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'link',
      ADD COLUMN IF NOT EXISTS email_message_id INTEGER;
    COMMENT ON COLUMN public.booking_change_requests.source IS 'link (manage page) or email (read from a guest email)';
  END IF;
END $$;

SELECT 'Email inbox migration complete' AS status,
       COUNT(*) AS messages,
       COUNT(*) FILTER (WHERE review_status = 'open') AS open_in_inbox
  FROM public.email_messages;
